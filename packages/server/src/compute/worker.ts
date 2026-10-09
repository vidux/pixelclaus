/**
 * Compute worker entry: receives one task at a time from the pool and posts back the result or a
 * serialised error.
 */
import { parentPort, threadId } from 'node:worker_threads';
import { runTask, type ComputeTask } from './tasks.js';
import { toWireError } from './wire.js';

if (!parentPort) throw new Error('compute worker must run as a worker thread');
const port = parentPort;

port.on('message', (task: ComputeTask) => {
  runTask(task, threadId).then(
    (result) => port.postMessage({ ok: true, result }),
    (e: unknown) => port.postMessage({ ok: false, error: toWireError(e) }),
  );
});

// modules are loaded: the pool starts timing tasks from here
port.postMessage({ ready: true });
