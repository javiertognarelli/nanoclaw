/**
 * Ollama provider — container-side implementation.
 *
 * Uses Ollama's OpenAI-compatible API (/v1/chat/completions) so we can
 * reuse the OpenAI SDK without additional dependencies. The host-side
 * ollama.ts passes OPENAI_BASE_URL and OPENAI_API_KEY into the container
 * environment.
 *
 * Design decisions:
 *   - No streaming mid-turn push (Ollama doesn't support server-sent-events
 *     on the completions endpoint reliably across all models). The full
 *     response is returned as a single 'result' event.
 *   - No continuation (stateless — each turn is a fresh completion call
 *     with the full history reconstructed from messages_in context).
 *   - MCP tools are NOT supported via the native MCP protocol here —
 *     tool calls are formatted as structured text and parsed from the
 *     response. For CONDUCTOR (Claude/OpenRouter), full MCP is used.
 *   - 'activity' events are emitted periodically during the HTTP wait
 *     so the heartbeat doesn't time out on slow models.
 *
 * To enable: append `import './ollama.js';` to providers/index.ts
 */
import { randomUUID } from 'crypto';
import { registerProviderFactory } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderOptions, QueryInput, ProviderEvent } from './types.js';

const HEARTBEAT_INTERVAL_MS = 5_000;

function log(msg: string): void {
  console.error(`[ollama] ${msg}`);
}

function createOllamaProvider(options: ProviderOptions): AgentProvider {
  const env = options.env || process.env;
  const baseUrl = env.OPENAI_BASE_URL || 'http://host-gateway:11434/v1';
  const apiKey = env.OPENAI_API_KEY || 'ollama';
  const defaultModel = env.OLLAMA_MODEL || 'qwen3.5:14b';

  log(`Ollama provider init — baseUrl: ${baseUrl}, model: ${defaultModel}`);

  return {
    supportsNativeSlashCommands: false,

    isSessionInvalid(_err: unknown): boolean {
      // Ollama is stateless — no session continuations to invalidate.
      return false;
    },

    query(input: QueryInput): AgentQuery {
      // Conversation history: system prompt + user message(s).
      const systemPrompt = [
        options.assistantName ? `You are ${options.assistantName}, a scientific research assistant.` : '',
        input.systemContext?.instructions ?? '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: input.prompt });

      // Pending follow-up pushes while the request is in-flight.
      const pendingPushes: string[] = [];
      let aborted = false;
      const abortController = new AbortController();

      const queryObj: AgentQuery = {
        push(message: string): void {
          pendingPushes.push(message);
        },
        end(): void {
          // No-op — Ollama is request/response, not streaming input.
        },
        abort(): void {
          aborted = true;
          abortController.abort();
        },
        events: (async function* (): AsyncIterable<ProviderEvent> {
          // Unique continuation per query (stateless but required by poll-loop).
          const continuation = `ollama-${randomUUID()}`;
          yield { type: 'init', continuation };

          // Heartbeat timer — emit activity every N seconds while waiting.
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
          const activityQueue: ProviderEvent[] = [];
          heartbeatTimer = setInterval(() => {
            activityQueue.push({ type: 'activity' });
          }, HEARTBEAT_INTERVAL_MS);

          try {
            // Flush any queued activity events.
            const flushActivity = function* () {
              while (activityQueue.length > 0) {
                yield activityQueue.shift()!;
              }
            };

            let allMessages = [...messages];
            let attempt = 0;

            while (!aborted) {
              attempt++;
              if (attempt > 1) {
                // Add pending follow-ups as additional user messages.
                const followUp = pendingPushes.splice(0).join('\n\n');
                if (!followUp) break; // No more input — done.
                allMessages = [...allMessages, { role: 'user', content: followUp }];
              }

              yield* flushActivity();
              log(`Sending to Ollama (attempt ${attempt}, model: ${defaultModel})`);

              let responseText: string;
              try {
                const resp = await fetch(`${baseUrl}/chat/completions`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify({
                    model: defaultModel,
                    messages: allMessages,
                    stream: false,
                    temperature: 0.2, // Low temperature — accuracy over creativity.
                  }),
                  signal: abortController.signal,
                });

                yield* flushActivity();

                if (!resp.ok) {
                  const errText = await resp.text().catch(() => '');
                  throw new Error(`Ollama HTTP ${resp.status}: ${errText.slice(0, 200)}`);
                }

                const data = (await resp.json()) as {
                  choices?: Array<{ message?: { content?: string } }>;
                };
                responseText = data.choices?.[0]?.message?.content ?? '';
              } catch (err) {
                if (aborted) break;
                const msg = err instanceof Error ? err.message : String(err);
                log(`Error: ${msg}`);
                yield { type: 'error', message: msg, retryable: true };
                break;
              }

              yield* flushActivity();
              log(`Response received (${responseText.length} chars)`);
              yield { type: 'result', text: responseText };

              // Check for follow-up pushes that arrived during the request.
              if (pendingPushes.length === 0) break;
              // Add assistant's response to history for context.
              allMessages = [...allMessages, { role: 'assistant', content: responseText }];
            }
          } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }
        })(),
      };

      return queryObj;
    },
  };
}

registerProviderFactory('ollama', createOllamaProvider);
