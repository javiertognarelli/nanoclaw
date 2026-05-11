/**
 * init-conductor-agent.ts
 *
 * Sets up the CONDUCTOR agent — the orchestrating "brain" of the Locus AgentOS.
 * CONDUCTOR directs the other agents (ARCHIVIST, SCRIBE, ARBITER, ADMIN) and
 * serves as the primary user-facing interface for complex multi-agent tasks.
 *
 * Usage (with service stopped or running alongside it):
 *   pnpm exec tsx scripts/init-conductor-agent.ts
 *
 * Environment variables (optional):
 *   OLLAMA_MODEL  — model to use (e.g. "qwen3:14b"). Falls back to the global
 *                   default. CONDUCTOR benefits from the largest model available.
 *
 * Wiring created:
 *   CONDUCTOR → ARCHIVIST  (research queries)
 *   CONDUCTOR → SCRIBE     (writing tasks)
 *   CONDUCTOR → ADMIN      (scheduling tasks)
 *   ARCHIVIST → CONDUCTOR  (research results)
 *   SCRIBE    → CONDUCTOR  (draft results)
 *   ADMIN     → CONDUCTOR  (schedule confirmations)
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import {
  createDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import type { AgentGroup } from '../src/types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Wire A → B (idempotent) */
function wireIfMissing(
  from: AgentGroup,
  toName: string,
  toGroup: AgentGroup,
  now: string,
): void {
  const existing = getDestinationByName(from.id, toName);
  if (!existing) {
    createDestination({
      agent_group_id: from.id,
      local_name: toName,
      target_type: 'agent',
      target_id: toGroup.id,
      created_at: now,
    });
    console.log(`  Wired ${from.name} → ${toName}`);
  } else {
    console.log(`  Wiring already exists: ${from.name} → ${toName}`);
  }
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  // ── CONDUCTOR ──────────────────────────────────────────────────────────────
  const conductorFolder = 'conductor';
  const conductorName = 'CONDUCTOR';
  let conductorAg: AgentGroup | undefined = getAgentGroupByFolder(conductorFolder);

  if (!conductorAg) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: conductorName,
      folder: conductorFolder,
      agent_provider: process.env.OLLAMA_MODEL ? 'ollama' : null,
      created_at: now,
    });
    conductorAg = getAgentGroupByFolder(conductorFolder)!;
    console.log(`Created agent group: ${conductorAg.id} (${conductorFolder})`);
  } else {
    console.log(`Reusing agent group: ${conductorAg.id} (${conductorFolder})`);
  }

  initGroupFilesystem(conductorAg, {
    provider: process.env.OLLAMA_MODEL ? 'ollama' : undefined,
    instructions:
      `# ${conductorName}\n\n` +
      `You are ${conductorName}, the central orchestrator of the Locus Agent OS — ` +
      'a specialized scientific research assistant platform.\n\n' +
      '## Your Role\n\n' +
      'You are the primary interface between the user and the agent team. ' +
      'You receive user requests, decompose them into sub-tasks, delegate to ' +
      'the appropriate specialist agents, and synthesize their outputs into ' +
      'coherent, actionable responses.\n\n' +
      '## Your Team\n\n' +
      '- **ARCHIVIST**: Scientific literature search and bibliography. ' +
      'Delegate research questions, paper searches, and citation tasks using ' +
      '`<message to="ARCHIVIST">...</message>`.\n' +
      '- **SCRIBE**: Academic writing and document drafting. ' +
      'Delegate writing tasks (introductions, methods, reviews) using ' +
      '`<message to="SCRIBE">...</message>`. SCRIBE will coordinate with ARBITER internally.\n' +
      '- **ADMIN**: Calendar, scheduling, and administrative documents. ' +
      'Delegate scheduling and organization tasks using ' +
      '`<message to="ADMIN">...</message>`.\n\n' +
      '## Orchestration Principles\n\n' +
      '1. **Decompose**: Break complex requests into parallel or sequential sub-tasks.\n' +
      '2. **Delegate**: Always use the most specialized agent for each sub-task.\n' +
      '3. **Synthesize**: Combine results from multiple agents into a single, coherent response.\n' +
      '4. **Confirm**: Before executing multi-step workflows, briefly confirm the plan with the user.\n' +
      '5. **Quality-gate**: If a result from a subordinate agent is unsatisfactory, ' +
      'provide corrective feedback and re-delegate rather than passing on poor work.\n\n' +
      '## Communication\n\n' +
      'Speak directly to the user in the final response. ' +
      'Do not expose internal agent-to-agent messages in your replies unless the user asks. ' +
      'Use clear, concise academic language appropriate for a research context.',
  });

  // ── Resolve peer agents (must already be initialized) ───────────────────────
  const archivistAg = getAgentGroupByFolder('archivist');
  const scribeAg = getAgentGroupByFolder('scribe');
  const arbiterAg = getAgentGroupByFolder('arbiter');
  const adminAg = getAgentGroupByFolder('admin');

  const missing: string[] = [];
  if (!archivistAg) missing.push('archivist (run init-archivist-agent.ts first)');
  if (!scribeAg) missing.push('scribe (run init-scribe-and-arbiter.ts first)');
  if (!adminAg) missing.push('admin (run init-admin-agent.ts first)');

  if (missing.length > 0) {
    console.warn('\n⚠️  The following agents are not yet initialized:');
    for (const m of missing) console.warn(`   - ${m}`);
    console.warn('   CONDUCTOR will be created but some wirings will be skipped.\n');
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  console.log('\nWiring bidirectional connections...');

  if (archivistAg) {
    wireIfMissing(conductorAg, 'ARCHIVIST', archivistAg, now);
    wireIfMissing(archivistAg, 'CONDUCTOR', conductorAg, now);
  }

  if (scribeAg) {
    wireIfMissing(conductorAg, 'SCRIBE', scribeAg, now);
    wireIfMissing(scribeAg, 'CONDUCTOR', conductorAg, now);
  }

  if (arbiterAg) {
    // ARBITER can also report issues directly to CONDUCTOR if needed
    wireIfMissing(conductorAg, 'ARBITER', arbiterAg, now);
    wireIfMissing(arbiterAg, 'CONDUCTOR', conductorAg, now);
  }

  if (adminAg) {
    wireIfMissing(conductorAg, 'ADMIN', adminAg, now);
    wireIfMissing(adminAg, 'CONDUCTOR', conductorAg, now);
  }

  console.log('\n✅ CONDUCTOR init complete.');
  console.log(`   Agent group: ${conductorAg.id} @ groups/${conductorFolder}`);
  console.log('\nNext steps:');
  console.log('  1. Start the Locus service: pnpm start');
  console.log('  2. Wire CONDUCTOR to a chat channel (e.g. CLI) with init-cli-agent.ts');
  console.log('     or route messages directly via the service API.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
