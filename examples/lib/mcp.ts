/**
 * A tiny MCP client for the example scripts: starts the built `pixelclaus mcp` server over stdio on a
 * throwaway data directory and wraps the calls an agent makes (call, render-and-save, lint, export).
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface Session {
  call(tool: string, args: Record<string, unknown>): Promise<{ text: string; images: string[] }>;
  /** Render a view; save it to the preview folder (if any) and, as `keep`, to the output folder. */
  look(name: string, args: Record<string, unknown>, keep?: string): Promise<void>;
  lint(project: string): Promise<void>;
  /** Export, then move the written files to the output folder under `names` (exports add suffixes). */
  exportAs(project: string, names: string[], args: Record<string, unknown>): Promise<string[]>;
  close(): Promise<void>;
}

export async function connect(name: string, out: string, preview?: string): Promise<Session> {
  const data = mkdtempSync(join(tmpdir(), `pixelclaus-${name}-`));
  mkdirSync(out, { recursive: true });
  if (preview) mkdirSync(preview, { recursive: true });

  const client = new Client({ name, version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('packages/server/dist/cli.js'), 'mcp', '--data', data],
      stderr: 'inherit',
    }),
  );

  const call: Session['call'] = async (tool, args) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    const text = r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    if (r.isError) throw new Error(`${tool} failed:\n${text}`);
    const images = r.content.flatMap((c) => (c.type === 'image' ? [c.data] : []));
    return { text, images };
  };

  return {
    call,
    async look(view, args, keep) {
      const { text, images } = await call('render', args);
      const png = Buffer.from(images[0]!, 'base64');
      if (keep) writeFileSync(join(out, keep), png);
      if (!preview) return;
      writeFileSync(join(preview, `${view}.png`), png);
      writeFileSync(join(preview, `${view}.txt`), text);
    },
    async lint(project) {
      const { text } = await call('analyze', { project, kind: 'lint', frames: 'all' });
      console.log(`--- lint ${project}\n${text}`);
    },
    async exportAs(project, names, args) {
      const staging = mkdtempSync(join(out, '.export-')); // same drive as `out`, so rename works
      const { text } = await call('export', { project, outputDir: staging, ...args });
      const files = [...text.matchAll(/^- (.+?) \(/gm)].map((m) => m[1]!);
      if (files.length !== names.length) throw new Error(`expected ${names.length} file(s):\n${text}`);
      files.forEach((f, i) => renameSync(f, join(out, names[i]!)));
      rmSync(staging, { recursive: true, force: true });
      return text.split('\n').filter((l) => !l.startsWith('- '));
    },
    async close() {
      await client.close();
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
