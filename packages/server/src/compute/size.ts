import { availableParallelism } from 'node:os';

/** Default compute threads: CPUs − 1 (the main thread keeps one), clamped to 2..8. */
export function defaultPoolSize(): number {
  return Math.max(2, Math.min(8, availableParallelism() - 1));
}
