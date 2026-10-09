/**
 * Dev/test bootstrap for compute workers: TypeScript via tsx + source resolution for @pixelclaus/*,
 * then the real worker module. Not used by the built server (dist/compute/worker.js is loaded directly).
 */
import * as nodeModule from 'node:module';
import { register as registerTsx } from 'tsx/esm/api';
import { resolve } from './dev-resolve.mjs';

registerTsx();
// module.register() is deprecated from Node 26 (DEP0205); registerHooks() exists from Node 22.15.
if (nodeModule.registerHooks) nodeModule.registerHooks({ resolve });
else nodeModule.register(new URL('./dev-resolve.mjs', import.meta.url));
await import('./worker.ts');
