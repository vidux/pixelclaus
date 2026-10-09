import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tempDir } from './helpers.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const built = `${root}packages/server/dist/cli.js`;
const coreBuilt =
  existsSync(`${root}packages/core/dist/index.js`) && existsSync(`${root}packages/formats/dist/index.js`);

describe.skipIf(!coreBuilt)('stdio transport (real process)', () => {
  it('speaks MCP over stdio without polluting stdout', async () => {
    const dir = tempDir();
    const args = existsSync(built)
      ? [built, 'mcp', '--data', dir]
      : ['--import', 'tsx', `${root}packages/server/src/cli.ts`, 'mcp', '--data', dir];
    const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(24);
    const r = (await client.callTool({
      name: 'project_create',
      arguments: { name: 'cli', width: 4, height: 4 },
    })) as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toMatch(/created cli/);
    await client.close();
  }, 30000);
});
