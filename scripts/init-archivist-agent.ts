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

  const folder = 'archivist';
  const name = 'ARCHIVIST';

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
    instructions:
      `# ${name}\n\n` +
      `You are ${name}, the lead research and bibliography specialist of the Locus Agent OS. ` +
      'You are responsible for searching scientific literature, retrieving paper abstracts, and helping the user organize their research. ' +
      'Use the openalex_search tool to find papers and openalex_get_work to get full details. ' +
      'Always cite your sources with Title, Authors, and DOI when summarizing literature.',
  });

  console.log('Init ARCHIVIST complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
