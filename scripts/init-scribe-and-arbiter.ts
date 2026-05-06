import path from 'path';
import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { createDestination, getDestinationByName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import type { AgentGroup } from '../src/types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  // --- SCRIBE ---
  let scribeFolder = 'scribe';
  let scribeName = 'SCRIBE';
  let scribeAg: AgentGroup | undefined = getAgentGroupByFolder(scribeFolder);
  
  if (!scribeAg) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: scribeName,
      folder: scribeFolder,
      agent_provider: process.env.OLLAMA_MODEL ? 'ollama' : null,
      created_at: now,
    });
    scribeAg = getAgentGroupByFolder(scribeFolder)!;
    console.log(`Created agent group: ${scribeAg.id} (${scribeFolder})`);
  } else {
    console.log(`Reusing agent group: ${scribeAg.id} (${scribeFolder})`);
  }

  initGroupFilesystem(scribeAg, {
    provider: process.env.OLLAMA_MODEL ? 'ollama' : undefined,
    instructions:
      `# ${scribeName}\n\n` +
      `You are ${scribeName}, the elite scientific writer for the Locus Agent OS. ` +
      'Your responsibility is to draft high-quality, academically rigorous articles, reports, and literature reviews in Markdown format. ' +
      'IMPORTANT: When drafting a section, you must send it to ARBITER for peer review using <message to="ARBITER">... draft ...</message>. ' +
      'Wait for ARBITER\'s feedback, incorporate the corrections, and only then deliver the final polished text to the user or the CONDUCTOR.',
  });

  // --- ARBITER ---
  let arbiterFolder = 'arbiter';
  let arbiterName = 'ARBITER';
  let arbiterAg: AgentGroup | undefined = getAgentGroupByFolder(arbiterFolder);

  if (!arbiterAg) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: arbiterName,
      folder: arbiterFolder,
      agent_provider: process.env.OLLAMA_MODEL ? 'ollama' : null,
      created_at: now,
    });
    arbiterAg = getAgentGroupByFolder(arbiterFolder)!;
    console.log(`Created agent group: ${arbiterAg.id} (${arbiterFolder})`);
  } else {
    console.log(`Reusing agent group: ${arbiterAg.id} (${arbiterFolder})`);
  }

  initGroupFilesystem(arbiterAg, {
    provider: process.env.OLLAMA_MODEL ? 'ollama' : undefined,
    instructions:
      `# ${arbiterName}\n\n` +
      `You are ${arbiterName}, the strict and rigorous peer reviewer for the Locus Agent OS. ` +
      'Your role is to critically analyze drafts sent to you by SCRIBE. You act as "Reviewer 2". ' +
      'Check for logical consistency, scientific rigor, tone, formatting, and accuracy. ' +
      'Provide your actionable feedback directly back to SCRIBE using <message to="SCRIBE">... feedback ...</message>. ' +
      'Do not rewrite the text yourself; simply provide the critique for SCRIBE to execute.',
  });

  // --- WIRING (Agent-to-Agent Permissions) ---
  const scribeToArbiter = getDestinationByName(scribeAg.id, 'ARBITER');
  if (!scribeToArbiter) {
    createDestination({
      agent_group_id: scribeAg.id,
      local_name: 'ARBITER',
      target_type: 'agent',
      target_id: arbiterAg.id,
      created_at: now,
    });
    console.log(`Wired SCRIBE -> ARBITER`);
  }

  const arbiterToScribe = getDestinationByName(arbiterAg.id, 'SCRIBE');
  if (!arbiterToScribe) {
    createDestination({
      agent_group_id: arbiterAg.id,
      local_name: 'SCRIBE',
      target_type: 'agent',
      target_id: scribeAg.id,
      created_at: now,
    });
    console.log(`Wired ARBITER -> SCRIBE`);
  }

  // Also wire CONDUCTOR to both? We can let the user or conductor wire them later via /allow command.
  // For now, the sibling connection is the most critical.

  console.log('Init SCRIBE & ARBITER complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
