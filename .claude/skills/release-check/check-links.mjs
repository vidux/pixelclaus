// Checks relative links, image sources and #anchors in the repo's Markdown files (tracked and new).
// Usage: node .claude/skills/release-check/check-links.mjs [repoRoot]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const root = process.argv[2] ?? '.';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, '');
// GitHub heading ids: lowercase, keep letters, digits, spaces, - and _, spaces become -
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');

const anchorCache = new Map();
function anchors(path) {
  if (!anchorCache.has(path)) {
    const found = new Set();
    const counts = new Map();
    for (const m of stripCode(readFileSync(path, 'utf8')).matchAll(/^#{1,6}\s+(.*)$/gm)) {
      const base = slug(m[1]);
      const n = counts.get(base) ?? 0;
      found.add(n ? `${base}-${n}` : base);
      counts.set(base, n + 1);
    }
    anchorCache.set(path, found);
  }
  return anchorCache.get(path);
}

let problems = 0;
for (const rel of files) {
  const path = join(root, rel);
  const text = stripCode(readFileSync(path, 'utf8'));
  const targets = [
    ...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g),
    ...text.matchAll(/\b(?:src|href)="([^"]+)"/g),
  ];
  for (const [, target] of targets) {
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    const [filePart, anchor] = target.split('#');
    const dest = filePart ? normalize(join(dirname(path), decodeURI(filePart))) : path;
    if (filePart && !existsSync(dest)) {
      console.log(`MISSING FILE   ${rel}: ${target}`);
      problems++;
    } else if (anchor && dest.endsWith('.md') && !anchors(dest).has(anchor)) {
      console.log(`MISSING ANCHOR ${rel}: ${target}`);
      problems++;
    }
  }
}
console.log(`checked ${files.length} markdown files, ${problems} problem(s)`);
process.exitCode = problems ? 1 : 0;
