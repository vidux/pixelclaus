/**
 * MCP server assembly: tools, resources and prompts.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toBase64 } from '@pixelclaus/formats';
import { docPayload } from '../compute/snapshot.js';
import type { ToolContext } from './context.js';
import { overviewLines } from './format.js';
import { GUIDE, GUIDE_TOPICS, SERVER_INSTRUCTIONS } from './guide.js';
import { registerIoTools } from './tools/io.js';
import { registerPixelTools } from './tools/pixels.js';
import { registerProjectTools } from './tools/project.js';
import { registerStructureTools } from './tools/structure.js';
import { registerViewTools } from './tools/view.js';

export const SERVER_NAME = 'pixelclaus';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'PixelClaus — pixel art & sprite animation' },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerProjectTools(server, ctx);
  registerStructureTools(server, ctx);
  registerPixelTools(server, ctx);
  registerViewTools(server, ctx);
  registerIoTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  uniformErrors(server);
  return server;
}

/**
 * Argument-validation failures are produced by the SDK before our handlers run; give them the same
 * "Error [CODE]: message / Hint:" shape as every other tool error so the agent sees one format.
 * (Patches McpServer's internal createToolError; tests pin the behaviour across SDK upgrades.)
 */
function uniformErrors(server: McpServer): void {
  const target = server as unknown as { createToolError?: (message: string) => CallToolResult };
  if (typeof target.createToolError !== 'function') return;
  target.createToolError = (message: string): CallToolResult => {
    const plain = message.replace(/^MCP error -?\d+: /, '');
    const m = /^Input validation error: Invalid arguments for tool (\S+): ([\s\S]*)$/.exec(plain);
    const text = plain.startsWith('Error [')
      ? plain
      : m
        ? `Error [INVALID_ARGUMENT]: ${m[2]} (tool ${m[1]})\nHint: check the parameter types in the tool schema; guide has examples`
        : `Error [INVALID_ARGUMENT]: ${plain}`;
    return { isError: true, content: [{ type: 'text', text }] };
  };
}

function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'guide',
    new ResourceTemplate('pixelclaus://guide/{topic}', {
      list: async () => ({
        resources: GUIDE_TOPICS.map((t) => ({
          uri: `pixelclaus://guide/${t}`,
          name: `guide: ${t}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'PixelClaus guide',
      description: 'Workflows and reference for using PixelClaus',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const topic = String(vars.topic);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: GUIDE[topic] ?? `Unknown topic. Topics: ${GUIDE_TOPICS.join(', ')}`,
          },
        ],
      };
    },
  );

  server.registerResource(
    'projects',
    'pixelclaus://projects',
    { title: 'Projects', description: 'All PixelClaus projects (JSON)', mimeType: 'application/json' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await ctx.projects.list(), null, 1),
        },
      ],
    }),
  );

  server.registerResource(
    'project',
    new ResourceTemplate('pixelclaus://projects/{id}', {
      list: async () => ({
        resources: (await ctx.projects.list()).map((p) => ({
          uri: `pixelclaus://projects/${p.id}`,
          name: p.name,
          mimeType: 'text/plain',
        })),
      }),
    }),
    {
      title: 'Project overview',
      description: 'Layers, frames, tags, palette of one project',
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const r = await ctx.projects.read(String(vars.id), (doc) =>
        overviewLines(doc, { palette: true }).join('\n'),
      );
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: r.value }] };
    },
  );

  server.registerResource(
    'project-preview',
    new ResourceTemplate('pixelclaus://projects/{id}/preview.png', { list: undefined }),
    { title: 'Project preview', description: 'Annotated PNG preview of frame 0', mimeType: 'image/png' },
    async (uri, vars) => {
      const r = await ctx.projects.read(String(vars.id), (doc) => docPayload(doc, { frames: [0] }));
      const out = await ctx.compute.run(
        { kind: 'render', doc: r.value.payload, req: { view: 'composite' } },
        r.value.transfer,
      );
      return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: toBase64(out.png) }] };
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'sprite_workflow',
    {
      title: 'Design a sprite',
      description: 'Step-by-step plan for drawing a high-quality static sprite with PixelClaus',
      argsSchema: {
        subject: z.string().describe('What to draw'),
        size: z.string().optional().describe('e.g. 32x32'),
        palette: z.string().optional(),
      },
    },
    ({ subject, size, palette }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Design a pixel-art sprite of: ${subject}. Canvas ${size ?? '32x32'}, palette ${palette ?? 'endesga-32'}.\n\nFollow this workflow with the PixelClaus tools, rendering and checking after every step:\n\n${GUIDE.sprite}\n\nASCII reference:\n${GUIDE.ascii}`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'animation_workflow',
    {
      title: 'Animate a sprite',
      description: 'Plan and build a sprite animation (idle, walk, attack…) with timing checks',
      argsSchema: {
        project: z.string().describe('Project id/name'),
        action: z.string().describe('e.g. walk cycle, idle, attack'),
        frames: z.string().optional(),
      },
    },
    ({ project, action, frames }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Animate project "${project}": ${action}${frames ? ` in ${frames} frames` : ''}.\n\n${GUIDE.animation}`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'tileset_workflow',
    {
      title: 'Make seamless tiles',
      description: 'Create tiling textures / tilesets and check seams',
      argsSchema: { theme: z.string().describe('e.g. grass, stone floor'), tileSize: z.string().optional() },
    },
    ({ theme, tileSize }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Create a seamless ${tileSize ?? '16x16'} tile: ${theme}.\n\n${GUIDE.tileset}\n\n${GUIDE.sprite}`,
          },
        },
      ],
    }),
  );
}
