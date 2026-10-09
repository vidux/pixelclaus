---
name: windows-portability
description: Keeping PixelClaus code and tests working on Windows as well as Linux/macOS (CI runs both) - symlinks in tests (use junctions), dynamic imports of absolute paths (file URLs), path assertions (basename, drive letters), replacing files that another reader holds open (renameReplacing), re-creating a just-deleted lock file (EPERM on a pending delete), sharp keeping files locked, temp-dir cleanup, renames across drives (EXDEV), CRLF checkouts, Node loader hooks, and how to tell a Windows-only failure from a real regression. Use when a test fails only on Windows, when writing tests that touch the filesystem or spawn processes, or when changing storage code.
---

# Windows portability in PixelClaus

CI runs the suite on `ubuntu-latest` and `windows-latest` ([ci.yml](../../../.github/workflows/ci.yml)).
Each row below happened in this repo; the fix column points to where it is solved.

| Symptom | Cause | Fix (and where) |
| --- | --- | --- |
| `EPERM … rename 'x.tmp' -> 'project.json'` | Windows can't replace a file that another handle (an agent reading it, antivirus, the indexer) has open | Use `writeFileAtomic` or `renameReplacing` from `server/src/storage/fs-utils.ts`; they retry EPERM/EACCES/EBUSY for ~2.5 s. Never call `fs.rename` onto an existing file directly. |
| `EPERM` creating a file with `flag: 'wx'` (e.g. the project `.lock`) | The previous holder just deleted it and Windows still has the delete pending; about 3% of rapid hand-offs hit this | Treat `isWindowsBusy(e)` (`fs-utils.ts`) like EEXIST and retry, as `ProjectStore.lock` does. Throw the real error if it never clears. Test: "the project lock survives rapid hand-offs" in `concurrency.test.ts`. |
| `EPERM: operation not permitted, symlink` | Symlinks need admin or Developer Mode | In tests: `symlinkSync(target, path, 'junction')` (directories, absolute target; the type is ignored on other platforms). See `hardening.test.ts`. |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'd:'` | `import "D:\\…"` in generated code | Import `pathToFileURL(p).href` (`core/test/qa/guards-recheck.test.ts`). |
| Path assertions fail | `p.split('/')`, regexes like `/- (\/\S+)/` | `basename(p)` and `join`; regex `((?:[A-Za-z]:)?[\\/]\S+)` (`qa/mcp-qa.test.ts`). |
| `EPERM` deleting a temp data dir in `afterAll` | `sharp(path)`: libvips caches open files | `sharp(readFileSync(path))`, plus `rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50})` (`test/helpers.ts`). Server code already passes buffers to sharp. |
| `EXDEV: cross-device link not permitted` | Renaming from the C: temp dir into a repo on D: | Stage files next to the destination (`examples/showcase.ts` `exportAs`). |
| `prettier --check` or the generated-docs test fails on a fresh clone | `core.autocrlf=true` checked the files out as CRLF | `.gitattributes` forces LF. If a clone predates it: `git rm --cached -r . && git reset --hard` (this rewrites the working tree; commit or stash first). |
| `DEP0205 module.register() is deprecated` | Loader hooks registered with `register()` (Node 26) | `server/src/compute/worker-dev.mjs` uses `registerHooks()` when present and `register()` otherwise; the resolve hook in `dev-resolve.mjs` is synchronous, so it works with both. |
| A test hangs until its timeout after a write error | The loop flag was only reset on success | Reset it in `finally` (`concurrency.test.ts`, "reads during saves"). |
| `does not provide an export named …` from a CLI test | The CLI tests run `src/cli.ts`, which imports workspace packages from `dist/`, and that build is stale | `npm run build`. |

## Is it Windows, or a regression?

1. Run only that file: `npx vitest run <name>`. A timeout that only happens in the full run is load;
   repeat the full run 2-3 times before chasing it.
2. Compare against an untouched `HEAD` in a scratch copy without touching your git stage:
   `git archive HEAD | tar -x -C <scratch>` (archive applies `core.autocrlf`, so expect CRLF there), then
   `npm ci && npm run build && npx vitest run`, and diff the `FAIL` lines.
3. On Windows, Git Bash heredocs can eat backslashes in `perl`/`sed` replacements. Use an editor or a
   script file for backslash-heavy edits.
