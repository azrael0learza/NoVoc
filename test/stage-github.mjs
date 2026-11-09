// Assembles github/ — the exact folder tree to upload to GitHub.
// Allowlist on purpose: anything NOT listed here stays local, and the script
// prints what it left behind so new files are never uploaded by accident.
//
//   npm run stage
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'github');

const INCLUDE = {
  // loose files
  'README.md': 'file', 'LICENSE': 'file', 'package.json': 'file', '.gitignore': 'file',
  'package-lock.json': 'file', // pins dev-dep versions so `npm ci` reproduces the build
  'server.js': 'file',
  // folders with optional filters (return false to skip a file)
  'public': 'dir',
  'logo': 'dir',
  'docs': 'dir',
  'test': { dirFilter: (rel) => /\.(mjs|sh)$/.test(rel) },      // no generated .wav files
  'desktop': { dirFilter: (rel) => rel === 'main.cjs' },        // never vendor/ffmpeg (176 MB > GitHub limit)
};

function copyTree(src, dest, filter) {
  let n = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), rel = path.relative(ROOT, s);
    if (ent.isDirectory()) { n += copyTree(s, path.join(dest, ent.name), filter); continue; }
    if (filter && !filter(path.relative(dest0base, s))) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(s, path.join(dest, ent.name)); n++;
  }
  return n;
}
let dest0base = '';

// wipe staging contents (keep github/.git if the user ever initializes it there)
if (fs.existsSync(OUT)) {
  for (const e of fs.readdirSync(OUT)) if (e !== '.git') fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
} else fs.mkdirSync(OUT, { recursive: true });

let copied = 0, skipped = [];
for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const name = ent.name;
  if (['github', 'node_modules', 'dist', 'out', '.git'].includes(name)) continue;
  const rule = INCLUDE[name];
  if (!rule) { skipped.push(name + (ent.isDirectory() ? '/' : '')); continue; }
  const s = path.join(ROOT, name), d = path.join(OUT, name);
  if (rule === 'file' || (ent.isDirectory() && rule === 'dir')) {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(s, d, { recursive: true }); copied++;
  } else if (ent.isDirectory()) {
    dest0base = s; copied += copyTree(s, d, rule.dirFilter);
  } else skipped.push(name + ' (expected ' + (typeof rule === 'string' ? rule : 'dir') + ')');
}

// verify + report
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
const files = walk(OUT, []);
const big = files.filter((f) => fs.statSync(f).size > 90 * 1024 * 1024);
const total = files.reduce((a, f) => a + fs.statSync(f).size, 0);
for (const req of ['README.md', 'LICENSE', 'package.json', 'server.js', 'logo/icon-512.png'])
  if (!files.some((f) => f === path.join(OUT, req))) { console.error('MISSING required staged file: ' + req); process.exit(1); }
if (files.some((f) => path.basename(f) === 'settings.json' || path.basename(f) === 'ffmpeg')) {
  console.error('STAGING BUG: local-only file leaked into github/'); process.exit(1);
}
console.log('github/ staged: ' + files.length + ' files, ' + (total / 1024 / 1024).toFixed(1) + ' MB');
if (big.length) { console.error('TOO BIG for GitHub (>90 MB):'); big.forEach((f) => console.error('  ' + path.relative(OUT, f))); process.exit(1); }
console.log('left OUT of github/ (local only): ' + skipped.join(', '));
