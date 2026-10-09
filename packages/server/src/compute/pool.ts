/**
 * Compute pool: runs CPU-heavy tasks (previews, exports, analysis) on worker threads so one agent's
 * export never freezes the event loop that every other agent's requests go through. Tasks queue FIFO
 * and spread over up to `size` workers (started lazily, kept unref'd while idle). `size: 0` runs tasks
 * inline on the main thread (debugging, single-core hosts).
 */
import { Worker } from 'node:worker_threads';
import { PixelClausError } from '@pixelclaus/core';
import { runTask, type ComputeTask, type TaskResults } from './tasks.js';
import { defaultPoolSize } from './size.js';
import { fromWireError, type WireError } from './wire.js';

export { defaultPoolSize };

export interface PoolOptions {
  /** Worker threads (0 = run inline). Default: CPUs − 1, clamped to 2..8. */
  size?: number;
  /** A task running longer than this is aborted and its worker replaced (ms, default 120 s). */
  taskTimeoutMs?: number;
}

export interface PoolStats {
  size: number;
  started: number;
  busy: number;
  queued: number;
  completed: number;
  failed: number;
}

/** Lower runs first. Interactive previews never wait behind a long export. */
export type Priority = 0 | 1 | 2 | 3;

const DEFAULT_PRIORITY: Record<ComputeTask['kind'], Priority> = {
  render: 0,
  frame: 1,
  analyze: 1,
  busy: 1,
  'pxc-encode': 1,
  'pxc-decode': 1,
  export: 2,
};

interface Job {
  priority: Priority;
  task: ComputeTask;
  transfer: ArrayBuffer[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker;
  /** The worker finished loading its modules (the task timeout only counts from then on). */
  ready: boolean;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

function workerEntry(): URL {
  // From TypeScript sources (tsx, vitest) a tiny bootstrap loads tsx + source resolution; built code
  // loads the compiled worker directly.
  return import.meta.url.endsWith('.ts')
    ? new URL('./worker-dev.mjs', import.meta.url)
    : new URL('./worker.js', import.meta.url);
}

export class ComputePool {
  readonly size: number;
  private readonly timeoutMs: number;
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private closed = false;
  private counts = { completed: 0, failed: 0 };

  constructor(opts: PoolOptions = {}) {
    this.size = opts.size ?? defaultPoolSize();
    this.timeoutMs = opts.taskTimeoutMs ?? 120_000;
  }

  /**
   * Run a task; resolves with its result or rejects with the task's error. Priority defaults by kind:
   * previews 0, frames/analysis 1, exports 2 (pass 3 for background work such as thumbnails).
   */
  run<K extends ComputeTask['kind']>(
    task: Extract<ComputeTask, { kind: K }>,
    transfer: ArrayBuffer[] = [],
    priority: Priority = DEFAULT_PRIORITY[task.kind],
  ): Promise<TaskResults[K]> {
    if (this.closed) return Promise.reject(new PixelClausError('INTERNAL', 'Compute pool is closed'));
    if (this.size === 0) {
      return runTask(task).then(
        (r) => {
          this.counts.completed++;
          return r as TaskResults[K];
        },
        (e) => {
          this.counts.failed++;
          throw e;
        },
      );
    }
    return new Promise<TaskResults[K]>((resolve, reject) => {
      const job: Job = { priority, task, transfer, resolve: resolve as (v: unknown) => void, reject };
      // keep the queue ordered by (priority, arrival)
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1]!.priority > priority) i--;
      this.queue.splice(i, 0, job);
      this.pump();
    });
  }

  stats(): PoolStats {
    return {
      size: this.size,
      started: this.slots.length,
      busy: this.slots.filter((s) => s.job).length,
      queued: this.queue.length,
      ...this.counts,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0))
      job.reject(new PixelClausError('INTERNAL', 'Compute pool closed'));
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
  }

  /**
   * Hand queued jobs to free workers. Batch work (exports, thumbnails: priority ≥ 2) may occupy at most
   * size − 1 workers, so one worker always stays available for previews and analysis.
   */
  private pump(): void {
    while (this.queue.length) {
      const batchBusy = this.slots.filter((s) => s.job && s.job.priority >= 2).length;
      const batchCap = Math.max(1, this.size - 1);
      const idx = this.queue.findIndex((j) => j.priority < 2 || batchBusy < batchCap);
      if (idx < 0) return;
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const [job] = this.queue.splice(idx, 1);
      this.dispatch(slot, job!);
    }
  }

  /** Start every worker now (servers call this at startup so the first preview is not a cold start). */
  async warm(): Promise<void> {
    if (this.size === 0) return;
    while (this.slots.length < this.size) this.spawn();
    await Promise.all(this.slots.map(() => this.run({ kind: 'busy', busyMs: 0 }, [], 1)));
  }

  private spawn(): Slot {
    const worker = new Worker(workerEntry(), { name: 'pixelclaus-compute' });
    const slot: Slot = { worker, ready: false, job: null, timer: null };
    worker.on('message', (msg: { ready?: boolean; ok: boolean; result?: unknown; error?: WireError }) => {
      if (msg.ready) {
        slot.ready = true;
        if (slot.job && !slot.timer) this.startTimer(slot);
        return;
      }
      const job = slot.job;
      this.finish(slot);
      if (!job) return;
      if (msg.ok) {
        this.counts.completed++;
        job.resolve(msg.result);
      } else {
        this.counts.failed++;
        job.reject(fromWireError(msg.error!));
      }
      this.pump();
    });
    const crash = (why: string) => {
      const job = slot.job;
      this.finish(slot);
      this.slots = this.slots.filter((s) => s !== slot);
      if (job) {
        this.counts.failed++;
        job.reject(
          new PixelClausError(
            'INTERNAL',
            `Compute worker failed: ${why}`,
            'Retry the call; if it keeps failing, simplify the request (fewer frames, smaller scale)',
          ),
        );
      }
      if (!this.closed) this.pump();
    };
    worker.on('error', (e) => crash(e.message));
    worker.on('exit', (code) => {
      if (this.slots.includes(slot)) crash(`exited with code ${code}`);
    });
    worker.unref();
    this.slots.push(slot);
    return slot;
  }

  private dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    slot.worker.ref(); // keep the process alive while work is in flight
    if (slot.ready) this.startTimer(slot);
    try {
      slot.worker.postMessage(job.task, job.transfer);
    } catch (e) {
      this.finish(slot);
      job.reject(e);
    }
  }

  private startTimer(slot: Slot): void {
    slot.timer = setTimeout(() => {
      const j = slot.job;
      this.finish(slot);
      this.slots = this.slots.filter((s) => s !== slot);
      void slot.worker.terminate();
      if (j) {
        this.counts.failed++;
        j.reject(
          new PixelClausError(
            'LIMIT',
            `Task '${j.task.kind}' took longer than ${(this.timeoutMs / 1000).toFixed(1)} s and was stopped`,
            'Split the work (fewer frames per export, smaller scale or region)',
          ),
        );
      }
      this.pump();
    }, this.timeoutMs);
    slot.timer.unref();
  }

  private finish(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.worker.unref();
  }
}

const shared = new Map<string, ComputePool>();

/**
 * One pool per process and configuration: every service instance (stdio session, HTTP sessions,
 * tests) shares the same workers instead of starting its own.
 */
export function sharedPool(opts: PoolOptions = {}): ComputePool {
  const size = opts.size ?? defaultPoolSize();
  const key = `${size}:${opts.taskTimeoutMs ?? 120_000}`;
  let pool = shared.get(key);
  if (!pool) {
    pool = new ComputePool({ ...opts, size });
    shared.set(key, pool);
  }
  return pool;
}
