/**
 * Dev/test only: resolve @pixelclaus/* to package sources so compute workers started from TypeScript
 * sources (tsx, vitest) do not depend on a build. Production workers load dist/compute/worker.js.
 */
const SOURCES = {
  '@pixelclaus/core': new URL('../../../core/src/index.ts', import.meta.url).href,
  '@pixelclaus/formats': new URL('../../../formats/src/index.ts', import.meta.url).href,
};

// Synchronous so it works both as a registerHooks() hook and as a module.register() loader.
export function resolve(specifier, context, next) {
  const mapped = SOURCES[specifier];
  if (mapped) return { url: mapped, shortCircuit: true };
  return next(specifier, context);
}
