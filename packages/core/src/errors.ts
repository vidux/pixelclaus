/**
 * User-facing error type. Messages are written for an AI agent: say what went wrong and, via `hint`,
 * what to do next.
 */
export type ErrorCode =
  'NOT_FOUND' | 'INVALID_ARGUMENT' | 'CONFLICT' | 'LOCKED' | 'UNSUPPORTED' | 'LIMIT' | 'INTERNAL';

export class PixelClausError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, hint?: string, details?: unknown) {
    super(message);
    this.name = 'PixelClausError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  /** Message + hint in one line, convenient for tool responses. */
  override toString(): string {
    return this.hint ? `${this.message}. Hint: ${this.hint}` : this.message;
  }
}

export function isPixelClausError(e: unknown): e is PixelClausError {
  return e instanceof PixelClausError;
}

export function invalidArg(message: string, hint?: string): PixelClausError {
  return new PixelClausError('INVALID_ARGUMENT', message, hint);
}

export function unsupported(message: string, hint?: string): PixelClausError {
  return new PixelClausError('UNSUPPORTED', message, hint);
}

/** Levenshtein distance (small strings only). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/** Suggest the closest candidates to `ref` (case-insensitive). */
export function suggest(ref: string, candidates: readonly string[], max = 3): string[] {
  const r = ref.toLowerCase();
  return candidates
    .map((c) => ({ c, d: editDistance(r, c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(x.c.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.c);
}

export function notFound(
  kind: string,
  ref: string | number,
  available: readonly string[] = [],
): PixelClausError {
  const close = typeof ref === 'string' ? suggest(ref, available) : [];
  const parts: string[] = [];
  if (close.length) parts.push(`Did you mean: ${close.join(', ')}?`);
  if (available.length) {
    const list =
      available.length > 30 ? [...available.slice(0, 30), `… (${available.length} total)`] : available;
    parts.push(`Available: ${list.join(', ')}`);
  } else {
    parts.push(`There are no ${kind}s yet.`);
  }
  return new PixelClausError('NOT_FOUND', `${kind} '${ref}' not found`, parts.join(' '));
}
