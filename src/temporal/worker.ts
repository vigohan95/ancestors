import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import * as activities from './activities.js';

export const TASK_QUEUE = 'ancestors';

async function run() {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
    activities,
    maxConcurrentActivityTaskExecutions: 1,   // one local model, one review at a time
  });
  console.log(`[worker] listening on task queue "${TASK_QUEUE}" (pid ${process.pid}) — kill me any time, the haunting survives`);
  await worker.run();
}

run().catch(e => { console.error(e); process.exit(1); });
