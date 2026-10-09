import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ComputePool } from '../compute/pool.js';
import type { ExportService } from '../services/export-service.js';
import type { ImportService } from '../services/import-service.js';
import type { ProjectService } from '../services/project-service.js';

export interface ToolContext {
  /** Worker pool for CPU-heavy, read-only work (previews, exports, analysis). */
  compute: ComputePool;
  projects: ProjectService;
  exporter: ExportService;
  importer: ImportService;
}

export type Registrar = (server: McpServer, ctx: ToolContext) => void;

/** Standard tool annotations. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const MUTATES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
