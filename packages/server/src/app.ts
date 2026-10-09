/**
 * Wiring of services (used by the CLI, HTTP app and tests).
 */
import { sharedPool } from './compute/pool.js';
import { loadConfig, type ServerConfig } from './config.js';
import type { ToolContext } from './mcp/context.js';
import { ExportService } from './services/export-service.js';
import { ImportService } from './services/import-service.js';
import { ProjectService } from './services/project-service.js';

export interface AppServices extends ToolContext {
  config: ServerConfig;
}

export async function createServices(overrides: Partial<ServerConfig> = {}): Promise<AppServices> {
  const config = loadConfig(overrides);
  const compute = sharedPool({ size: config.computeThreads });
  const projects = new ProjectService(config, compute);
  await projects.init();
  return {
    config,
    compute,
    projects,
    exporter: new ExportService(projects, compute),
    importer: new ImportService(projects),
  };
}
