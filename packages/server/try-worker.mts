import { Worker } from 'node:worker_threads';
const t0 = Date.now();
const w = new Worker(new URL('./src/compute/worker-dev.mjs', import.meta.url));
w.on('error', (e) => console.error('ERR', e));
w.on('message', (m) => {
  console.log('png bytes', m, 'after', Date.now() - t0, 'ms');
  w.terminate();
});
w.postMessage(16);
