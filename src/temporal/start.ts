import { Connection, Client } from '@temporalio/client';
import { hauntRepo, stateQuery } from './workflows.js';

const repo = process.argv[2];
if (!repo) { console.error('usage: npm run haunt -- <owner/repo> [limit] [rounds]'); process.exit(1); }
const limit = Number(process.argv[3] ?? 3);
const rounds = Number(process.argv[4] ?? 1);

async function main() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection });
  const workflowId = `haunt-${repo.replace('/', '-')}-${Date.now()}`;
  const handle = await client.workflow.start(hauntRepo, { taskQueue: 'ancestors', workflowId, args: [{ repo, limit, rounds }] });
  console.log(`[haunt] started ${workflowId}`);
  console.log(`[haunt] watch it at http://localhost:8233/namespaces/default/workflows/${workflowId}`);
  if (process.argv.includes('--wait')) {
    const timer = setInterval(async () => {
      try { const s = await handle.query(stateQuery); console.log(`[haunt] round ${s.round}, reviewed ${s.reviewed.length}, current PR #${s.current ?? '-'}`); } catch { /* not yet */ }
    }, 30000);
    const result = await handle.result();
    clearInterval(timer);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
