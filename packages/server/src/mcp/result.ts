/**
 * Tool result helpers: compact text, JSON, PNG images, warnings, and agent-friendly errors.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isPixelClausError } from '@pixelclaus/core';
import { toBase64 } from '@pixelclaus/formats';
import { ZodError } from 'zod';

type Content = CallToolResult['content'][number];

export class Reply {
  private parts: Content[] = [];
  private lines: string[] = [];

  line(s: string): this {
    this.lines.push(s);
    return this;
  }

  lines_(list: readonly string[]): this {
    this.lines.push(...list);
    return this;
  }

  /** Compact JSON block with an optional label. */
  json(value: unknown, label?: string): this {
    const s = compactJson(value);
    this.lines.push(label ? `${label}: ${s}` : s);
    return this;
  }

  warnings(ws: readonly string[] | undefined): this {
    if (ws?.length) {
      this.lines.push('warnings:');
      for (const w of ws) this.lines.push(`- ${w}`);
    }
    return this;
  }

  image(png: Uint8Array): this {
    this.flush();
    this.parts.push({ type: 'image', data: toBase64(png), mimeType: 'image/png' });
    return this;
  }

  private flush(): void {
    if (this.lines.length) {
      this.parts.push({ type: 'text', text: this.lines.join('\n') });
      this.lines = [];
    }
  }

  build(): CallToolResult {
    this.flush();
    if (!this.parts.length) this.parts.push({ type: 'text', text: 'ok' });
    return { content: this.parts };
  }
}

/** JSON without quotes around simple keys, short arrays inline — readable and token-cheap. */
export function compactJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === 'number' && !Number.isInteger(val) ? Math.round(val * 1000) / 1000 : val,
  );
}

export function rect(r: { x: number; y: number; w: number; h: number } | null | undefined): string {
  return r ? `${r.x},${r.y} ${r.w}x${r.h}` : 'none';
}

export function errorResult(e: unknown): CallToolResult {
  let text: string;
  if (isPixelClausError(e)) {
    text = `Error [${e.code}]: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}`;
  } else if (e instanceof ZodError) {
    text = `Error [INVALID_ARGUMENT]: ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
  } else {
    text = `Error [INTERNAL]: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Wrap a handler so thrown errors become tool errors the agent can read and act on. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return errorResult(e);
    }
  };
}
