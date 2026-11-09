// Smoke-tests the PACKAGED AppImage (not the source): confirms the bundle
// boots, reaches its codec probe, uses the bundled ffmpeg, and writes to a
// user-writable data dir. Runs headless via the shell's NOVOC_SMOKE mode.
//
//   node test/appimage-smoke.mjs [path/to/NoVoc-*.AppImage]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dist = path.join(process.cwd(), 'dist');
const img = process.argv[2] ||
  fs.readdirSync(dist).filter((f) => f.endsWith('.AppImage')).sort()
    .map((f) => path.join(dist, f)).pop();
if (!img || !fs.existsSync(img)) { console.error('no AppImage found in dist/ — run: npm run dist'); process.exit(1); }

// No FUSE on many minimal systems (incl. Fedora 43 here): run extract-and-run.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novoc-appimage-data-'));
console.log('appimage:', img);
console.log('data dir:', dataDir);

const child = spawn(img, ['--appimage-extract-and-run', '--no-sandbox', '--ozone-platform=headless', '--disable-gpu'], {
  env: { ...process.env, NOVOC_SMOKE: '1', HOME: dataDir, XDG_DOCUMENTS_DIR: path.join(dataDir, 'Documents') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const grab = (b) => { out += b.toString(); process.stdout.write(b); };
child.stdout.on('data', grab);
child.stderr.on('data', grab);

const timer = setTimeout(() => { console.error('\nTIMEOUT — appimage did not exit'); child.kill('SIGKILL'); }, 90000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const m = out.match(/SMOKE OK (\{.*\})/);
  let pass = code === 0 && !!m;
  if (pass) {
    const j = JSON.parse(m[1]);
    const capsOk = j.caps && (j.caps.ffv1Alpha === true && j.caps.proresAlpha === true);
    const outOk = j.outDirCreated === true;
    console.log('\ncaps:', JSON.stringify(j.caps));
    console.log('outDirCreated:', j.outDirCreated, '| dataDir:', j.dataDir);
    pass = capsOk && outOk;
    console.log(pass ? '\nAPPIMAGE SMOKE: all checks passed' : '\nAPPIMAGE SMOKE: FAILED');
  } else {
    console.log('\nAPPIMAGE SMOKE: FAILED (exit ' + code + ', smoke line ' + (m ? 'found' : 'missing') + ')');
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
});
