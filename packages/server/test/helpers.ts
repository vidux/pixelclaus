import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, createServices, type AppServices } from '../src/index.js';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pixelclaus-test-'));
}

export async function services(dir = tempDir()): Promise<AppServices> {
  const svc = await createServices({ dataDir: dir, cacheSize: 4 });
  // the process-wide compute pool starts its workers once (like the CLI does at startup), so the first
  // render/export of a test does not pay the worker start-up (slow from TypeScript sources)
  await svc.compute.warm();
  return svc;
}

export interface TestClient {
  client: Client;
  services: AppServices;
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ text: string; images: string[]; isError: boolean; raw: CallToolResult }>;
  close: () => Promise<void>;
}

export async function mcpClient(dir = tempDir()): Promise<TestClient> {
  const svc = await services(dir);
  const server = createMcpServer(svc);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return {
    client,
    services: svc,
    call: async (name, args = {}) => {
      const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = raw.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n');
      const images = raw.content.filter((c) => c.type === 'image').map((c) => (c as { data: string }).data);
      return { text, images, isError: !!raw.isError, raw };
    },
    close: async () => {
      await client.close();
      // Windows: a file still held by the indexer or antivirus makes rm fail with EPERM for a moment
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}
