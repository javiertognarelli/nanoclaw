import path from 'path';
import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  const folder = 'admin';
  const name = 'ADMIN';

  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: name,
      folder,
      agent_provider: process.env.OLLAMA_MODEL ? 'ollama' : null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }

  initGroupFilesystem(ag, {
    provider: process.env.OLLAMA_MODEL ? 'ollama' : undefined,
    // Note: We don't specify ollamaModel so it falls back to the global OLLAMA_MODEL
    // This is crucial to prevent VRAM exhaustion. Reusing the same model means Ollama
    // only loads weights into VRAM once.
    instructions:
      `# ${name} (CALENDARIUS)\n\n` +
      `You are ${name}, the administrative and scheduling assistant of the Locus Agent OS. ` +
      'You are responsible for managing the user\'s calendar, scheduling tasks, and writing administrative documents (like quotes). ' +
      'Always be precise with times and dates, and confirm actions after using your calendar tools.',
  });

  console.log('Init ADMIN complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
