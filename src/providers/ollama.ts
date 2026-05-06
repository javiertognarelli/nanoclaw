/**
 * Ollama provider — host-side container config.
 *
 * Ollama runs on the host (or a dedicated LAN server) and serves local
 * language models (qwen2.5, phi4, deepseek-coder, etc.) via an OpenAI-
 * compatible API at http://localhost:11434.
 *
 * The container needs:
 *   - OLLAMA_BASE_URL  — where to reach the Ollama server from inside the
 *                        container. Defaults to http://host-gateway:11434
 *                        (Docker's host-gateway alias for 172.17.0.1).
 *   - OLLAMA_MODEL     — which model to run (e.g. "qwen2.5:14b"). Set per
 *                        agent group in container.json: { "provider": "ollama",
 *                        "ollamaModel": "phi4:14b" }
 *
 * No API key is needed for local Ollama. If you expose Ollama publicly you
 * should add OLLAMA_API_KEY via OneCLI secrets and read it here.
 *
 * To enable: append `import './ollama.js';` to src/providers/index.ts
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const DEFAULT_OLLAMA_URL = 'http://host-gateway:11434';

registerProviderContainerConfig('ollama', (ctx) => {
  const dotenv = readEnvFile(['OLLAMA_BASE_URL', 'OLLAMA_MODEL']);

  const baseUrl =
    ctx.hostEnv.OLLAMA_BASE_URL ||
    dotenv.OLLAMA_BASE_URL ||
    DEFAULT_OLLAMA_URL;

  const env: Record<string, string> = {
    OLLAMA_BASE_URL: baseUrl,
    // OpenAI-compat shim: the agent-runner uses the OpenAI SDK pointed at Ollama.
    OPENAI_BASE_URL: `${baseUrl}/v1`,
    // Placeholder key — Ollama ignores it but the OpenAI SDK requires a non-empty value.
    OPENAI_API_KEY: 'ollama',
  };

  // Per-group model override via container.json is handled inside the
  // container (agent-runner reads container.json). But we also pass the
  // global default here so the runner has it as a fallback env var.
  const globalModel = ctx.hostEnv.OLLAMA_MODEL || dotenv.OLLAMA_MODEL;
  if (globalModel) {
    env.OLLAMA_MODEL = globalModel;
  }

  return { env };
});
