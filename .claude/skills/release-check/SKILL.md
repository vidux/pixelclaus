---
name: release-check
description: The full check before opening a pull request, tagging a release or pushing PixelClaus anywhere public - the CI gate in order (lint, format, typecheck, build, test), generated docs in sync, Markdown link and image check (check-links.mjs beside this file), secret and local-path scan, a clean-copy npm ci run of exactly what would be pushed, smoke tests of the built stdio and HTTP servers, and gallery reproducibility. Use when asked "is this ready to merge/release/publish?" or before pushing.
---

# Release check

Do the checks and report the results. Don't commit, tag or push unless the user asks.

## 1. The CI gate, locally

Run in this order, the same as [ci.yml](../../../.github/workflows/ci.yml). The CLI tests need the
build.

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test
```

All 41 test files must pass. Run the suite twice if anything timing-related fails; see the
`windows-portability` skill for Windows-only failures.

## 2. Docs

- `npm run docs`, then `git status docs/`: there should be no diff. If there is one, the tool docs were
  stale; keep the regenerated files.
- `node .claude/skills/release-check/check-links.mjs`: checks every relative link, `src=`/`href=` and
  `#anchor` in tracked and new Markdown files, and must report 0 problems.
- Check the README's claims against the code: tool count (`docs/mcp-tools.md` header), lint rule
  count (`LINT_RULES`), test count, Node version (`engines` in `package.json`, and the
  `engines` of vitest/vite in `package-lock.json`).
- New public behaviour is described in `docs/architecture.md` / `formats.md` / `viewer.md`, and the
  devlog has an entry.

## 3. Secrets and local data

```bash
git grep -nIE "AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_|github_pat_|xox[abpr]-|-----BEGIN [A-Z ]*PRIVATE KEY" -- . ':!package-lock.json'
git grep -nIE "[A-Za-z]:\\\\Users\\\\|/Users/[a-z]|/home/[a-z]" -- . ':!package-lock.json'
git log --all -p | grep -cE "ghp_|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY"   # history is published too
npm audit
```

Also look at untracked files that are about to be added (`git status --short --untracked-files=all`).
`.pixelclaus/`, `/data/` and `tmp/` are ignored for a reason: never add project data.

## 4. Clean copy of exactly what would be pushed

```bash
EXP=<scratch>/release-check && mkdir -p "$EXP"
git ls-files -z --cached --others --exclude-standard | xargs -0 cp --parents -t "$EXP"
cd "$EXP" && npm ci && npm run lint && npm run format:check && npm run typecheck && npm run build && npm test
```

`npm ci` fails if `package-lock.json` drifted from the `package.json` files. Delete the copy afterwards;
its `node_modules` is large.

## 5. Smoke tests of the built server (from the copy)

- **stdio + art:** `npm run showcase -- <scratch>/out` must finish, and `cmp` each file against
  `docs/images/`. The drawing is deterministic, so any difference means rendering or export output
  changed. If that change is intended, regenerate `docs/images/`.
- **HTTP:** `PIXELCLAUS_DATA=<scratch>/data node packages/server/dist/cli.js serve --port 7431`, then:
  - `GET /` has the title `PixelClaus Viewer`;
  - `POST /mcp` with `initialize` returns `serverInfo.name` `pixelclaus` and an `mcp-session-id` header;
  - a `tools/call` to `project_create` with that session id works;
  - `GET /api/projects` lists the new project.

  Stop the server afterwards. On Windows, `Get-NetTCPConnection -LocalPort 7431 -State Listen` gives the
  PID; check its command line before `Stop-Process`.

## 6. Report

Pass or fail per section, with numbers. List the files changed during the check (they need `git add`)
and any new untracked files that the push needs (images, workflows). Also cover the git-side items:
remote, branch, and the commit author email GitHub will show.
