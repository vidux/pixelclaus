/**
 * Generates the tool reference (docs/mcp-tools.md) and the guide pages (docs/guides/*.md) from the live
 * MCP server definition, so the docs never drift from the schemas the agent actually sees.
 *
 *   npm run docs        (tsx packages/server/scripts/gen-docs.ts)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, createServices } from '../src/index.js';
import { GUIDE, SERVER_INSTRUCTIONS } from '../src/mcp/guide.js';

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema | Schema[];
  prefixItems?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema | boolean;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  maxItems?: number;
};

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function range(s: Schema): string {
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  let lo: string | undefined;
  if (s.minimum !== undefined) lo = String(s.minimum);
  else if (s.exclusiveMinimum !== undefined)
    lo = t === 'integer' ? String(s.exclusiveMinimum + 1) : `>${s.exclusiveMinimum}`;
  const hi = s.maximum !== undefined ? String(s.maximum) : undefined;
  if (lo === undefined && hi === undefined) return '';
  if (lo !== undefined && hi !== undefined) return ` ${lo}..${hi}`;
  if (lo !== undefined) return lo.startsWith('>') ? ` ${lo}` : ` ≥${lo}`;
  return ` ≤${hi}`;
}

/** Compact, human-readable type of a JSON Schema node. */
function typeOf(s: Schema | undefined, depth = 0): string {
  if (!s) return 'any';
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' | ');
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return alts.map((a) => typeOf(a, depth)).join(' | ');
  if (Array.isArray(s.type)) return s.type.map((x) => typeOf({ ...s, type: x }, depth)).join(' | ');
  const t = s.type;
  if (t === 'array') {
    if (s.prefixItems) return `[${s.prefixItems.map((p) => typeOf(p, depth + 1)).join(', ')}]`;
    if (Array.isArray(s.items)) return `[${s.items.map((p) => typeOf(p, depth + 1)).join(', ')}]`;
    const inner = typeOf(s.items, depth + 1);
    return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
  }
  if (t === 'object') {
    if (s.properties) {
      if (depth > 1) return 'object';
      const req = new Set(s.required ?? []);
      return `{${Object.keys(s.properties)
        .map((k) => `${k}${req.has(k) ? '' : '?'}`)
        .join(', ')}}`;
    }
    if (s.additionalProperties && typeof s.additionalProperties === 'object')
      return `Record<string, ${typeOf(s.additionalProperties, depth + 1)}>`;
    return 'object';
  }
  return `${t ?? 'any'}${range(s)}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function paramTable(schema: Schema): string[] {
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  const lines = ['| Parameter | Type | Req | Notes |', '| --- | --- | --- | --- |'];
  for (const [k, p] of Object.entries(props)) {
    const type = k === 'ops' && p.type === 'array' ? 'op[] — see Draw ops below' : typeOf(p);
    lines.push(`| \`${k}\` | ${cell(type)} | ${req.has(k) ? '✓' : ''} | ${cell(p.description ?? '')} |`);
  }
  return lines;
}

/** The draw op union gets one sub-table per op. */
function drawOps(schema: Schema): string[] {
  const ops = schema.properties?.ops;
  const variants = (Array.isArray(ops?.items) ? ops.items : (ops?.items?.anyOf ?? ops?.items?.oneOf)) ?? [];
  const out: string[] = [
    '',
    '#### Draw ops',
    '',
    'Every op also accepts `layer`, `frame`, `ink` and `clip` overrides.',
    '',
  ];
  out.push('| op | Fields (`?` = optional) | Notes |', '| --- | --- | --- |');
  for (const v of variants) {
    const name = String(v.properties?.op?.const ?? '?');
    const req = new Set(v.required ?? []);
    const fields = Object.entries(v.properties ?? {})
      .filter(([k]) => !['op', 'layer', 'frame', 'ink', 'clip'].includes(k))
      .map(
        ([k, p]) =>
          `\`${k}${req.has(k) ? '' : '?'}\`: ${typeOf(p, 1)}${p.description ? ` — ${p.description}` : ''}`,
      );
    out.push(`| \`${name}\` | ${cell(fields.join('<br>'))} | ${cell(v.description ?? '')} |`);
  }
  return out;
}

async function main(): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), 'pixelclaus-docs-'));
  const svc = await createServices({ dataDir: data });
  const server = createMcpServer(svc);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'docs', version: '1' });
  await client.connect(b);
  const { tools } = await client.listTools();
  const { resourceTemplates } = await client.listResourceTemplates();
  const { resources } = await client.listResources();
  const { prompts } = await client.listPrompts();
  const bytes = JSON.stringify(tools).length;

  const md: string[] = [
    '# MCP tool reference',
    '',
    '> Generated by `npm run docs` from the live server definition — do not edit by hand.',
    '',
    `PixelClaus exposes **${tools.length} tools** (tool list ≈ ${Math.round(bytes / 1024)} KB of JSON Schema), plus resources and prompts.`,
    'The server instructions sent to every client:',
    '',
    '```text',
    SERVER_INSTRUCTIONS,
    '```',
    '',
    '## Contents',
    '',
    ...tools.map((t) => `- [\`${t.name}\`](#${t.name.replace(/_/g, '_')}) — ${t.title ?? ''}`),
    '- [Resources](#resources) · [Prompts](#prompts) · [Errors](#errors)',
    '',
  ];
  for (const t of tools) {
    const ann = t.annotations ?? {};
    const flags = [
      ann.readOnlyHint ? 'read-only' : 'mutates',
      ann.destructiveHint ? 'destructive' : '',
      ann.idempotentHint ? 'idempotent' : '',
    ]
      .filter(Boolean)
      .join(', ');
    md.push(`## ${t.name}`, '', `**${t.title ?? t.name}** · _${flags}_`, '', t.description ?? '', '');
    md.push(...paramTable(t.inputSchema as Schema));
    if (t.name === 'draw') md.push(...drawOps(t.inputSchema as Schema));
    md.push('');
  }
  md.push('## Resources', '', '| URI | Name | Description |', '| --- | --- | --- |');
  for (const r of resources) md.push(`| \`${r.uri}\` | ${r.name} | ${cell(r.description ?? '')} |`);
  for (const r of resourceTemplates)
    md.push(`| \`${r.uriTemplate}\` | ${r.name} | ${cell(r.description ?? '')} |`);
  md.push('', '## Prompts', '', '| Prompt | Description | Arguments |', '| --- | --- | --- |');
  for (const p of prompts)
    md.push(
      `| \`${p.name}\` | ${cell(p.description ?? '')} | ${(p.arguments ?? []).map((x) => `\`${x.name}${x.required ? '' : '?'}\``).join(', ')} |`,
    );
  md.push(
    '',
    '## Errors',
    '',
    'Every failure is a tool result with `isError: true` and text of the form',
    '',
    '```text',
    'Error [CODE]: what went wrong',
    'Hint: what to do next (valid names, ranges, the exact call that fixes it)',
    '```',
    '',
    'Codes: `INVALID_ARGUMENT`, `NOT_FOUND`, `LOCKED`, `CONFLICT`, `UNSUPPORTED`, `LIMIT`, `INTERNAL`. Schema-validation failures use the same',
    'shape. Mutations are atomic: an error in op 7 of a draw batch rolls back ops 0–6 as well.',
    '',
  );
  writeFileSync(join(ROOT, 'docs', 'mcp-tools.md'), md.join('\n'));

  mkdirSync(join(ROOT, 'docs', 'guides'), { recursive: true });
  const index = [
    '# Guides',
    '',
    '> Generated from `packages/server/src/mcp/guide.ts` (served by the `guide` tool and `pixelclaus://guide/{topic}`).',
    '',
  ];
  for (const [topic, text] of Object.entries(GUIDE)) {
    writeFileSync(join(ROOT, 'docs', 'guides', `${topic}.md`), `${text.trim()}\n`);
    index.push(`- [${topic}](${topic}.md) — ${text.split('\n')[0]!.replace(/^#\s*/, '')}`);
  }
  writeFileSync(join(ROOT, 'docs', 'guides', 'README.md'), index.join('\n') + '\n');

  await client.close();
  rmSync(data, { recursive: true, force: true });
  console.log(`wrote docs/mcp-tools.md (${tools.length} tools) and ${Object.keys(GUIDE).length} guide pages`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
