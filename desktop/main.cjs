// NoVoc desktop shell (Electron).
// The app itself is unchanged: this spawns the very same server.js and points
// a window at it. Heavy work (encoding) is the ffmpeg child process, exactly
// as in `npm start`.
'use strict';
const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app')     // asar:false → plain dir
  : path.join(__dirname, '..');                  // dev: novoc/ root

// Writable locations. Inside an AppImage the bundle is mounted read-only, so
// outputs and settings must live in the user's home.
const DATA_DIR = path.join(app.getPath('documents'), 'NoVoc');
const FFMPEG = app.isPackaged
  ? path.join(process.resourcesPath, 'ffmpeg')
  : path.join(__dirname, 'vendor', 'ffmpeg');

fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG_FILE = path.join(DATA_DIR, 'novoc-desktop.log');
const serverTail = []; // last ~40 lines of server output, shown on the error page

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

function noteServerOutput(chunk) {
  for (const l of chunk.toString().split('\n')) {
    const t = l.trim();
    if (!t) continue;
    serverTail.push(t);
    if (serverTail.length > 40) serverTail.shift();
    try { fs.appendFileSync(LOG_FILE, `[server] ${t}\n`); } catch {}
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForServer(port, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/caps`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('NoVoc server did not come up in time');
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',           // this binary, plain-node mode
      PORT: String(port),
      NOVOC_DATA: DATA_DIR,
      NOVOC_FFMPEG: FFMPEG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', noteServerOutput);
  child.stderr.on('data', noteServerOutput);
  child.on('error', (e) => logLine('server spawn failed: ' + e.message));
  child.on('exit', (code) => {
    if (!appQuitting) {
      logLine('server exited with code ' + code);
      app.exit(code || 0);
    }
  });
  return child;
}

function errorPage(reason) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><meta charset="utf-8"><title>NoVoc</title>
<style>body{background:#0d0a14;color:#e8e0f5;font:15px/1.6 system-ui;padding:48px;max-width:860px;margin:auto}
h1{color:#c084fc;font-size:22px}pre{background:#171024;border:1px solid #3b2a5e;border-radius:8px;
padding:14px;overflow:auto;font-size:12px;color:#b9a8d8}</style>
<h1>⚠ NoVoc server did not start</h1>
<p>${esc(reason)}</p>
<p>The app process quit, but the internal server did not come up. Recent server output:</p>
<pre>${esc(serverTail.join('\n') || '(no output captured)')}</pre>
<p>Full log: <code>${esc(LOG_FILE)}</code><br>
Restart NoVoc; if it keeps failing, start it from a terminal to see everything:
<code>${esc(app.isPackaged ? process.execPath : 'electron .')}</code></p>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

let server = null;
let window_ = null;
let appQuitting = false;

// ---- single instance ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window_) { if (window_.isMinimized()) window_.restore(); window_.focus(); }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    logLine(`NoVoc ${app.getVersion()} starting (electron ${process.versions.electron}, ffmpeg: ${FFMPEG})`);
    const port = await freePort();
    server = startServer(port);
    const url = `http://127.0.0.1:${port}`;

    // NOVOC_SMOKE=1: no window, no display needed — verify server + bundled
    // ffmpeg come up, then exit. Used to test the packaged AppImage headlessly.
    if (process.env.NOVOC_SMOKE === '1') {
      try {
        const caps = await waitForServer(port);
        const dataOk = fs.existsSync(path.join(DATA_DIR, 'out'));
        console.log('SMOKE OK', JSON.stringify({ caps: caps.caps, dataDir: DATA_DIR, outDirCreated: dataOk }));
        app.exit(0);
      } catch (e) {
        console.error('SMOKE FAIL', e.message);
        app.exit(1);
      }
      return;
    }

    window_ = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1000,
      minHeight: 700,
      backgroundColor: '#0d0a14',
      title: 'NoVoc',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });

    // Never load before the server is actually listening — that race once left
    // an RPM install staring at a blank violet window.
    try {
      await waitForServer(port);
    } catch (e) {
      logLine('startup wait failed: ' + e.message);
      await window_.loadURL(errorPage(e.message)).catch(() => {});
      return;
    }

    // Any target=_blank / external link opens in the user's real browser
    window_.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
    window_.webContents.on('did-finish-load', () => logLine('page loaded: ' + window_.webContents.getURL()));
    // Self-heal: if the page ever fails (server hiccup), retry, then explain.
    window_.webContents.on('did-fail-load', (ev, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || appQuitting || failedUrl.startsWith('data:')) return;
      logLine(`did-fail-load ${code} ${desc} — retrying`);
      setTimeout(() => {
        if (!window_ || appQuitting) return;
        window_.loadURL(url).catch(() => window_ && window_.loadURL(errorPage(`${code} ${desc}`)).catch(() => {}));
      }, 1500);
    });

    try {
      await window_.loadURL(url);
    } catch (e) {
      logLine('initial load failed: ' + e.message);
      await window_.loadURL(errorPage(e.message)).catch(() => {});
    }
    window_.on('closed', () => { window_ = null; app.quit(); });
  });
}

app.on('before-quit', () => {
  appQuitting = true;
  if (server) { try { server.kill(); } catch {} }
});
