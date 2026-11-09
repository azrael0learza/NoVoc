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

async function waitForServer(port, timeoutMs = 15000) {
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',           // this binary, plain-node mode
      PORT: String(port),
      NOVOC_DATA: DATA_DIR,
      NOVOC_FFMPEG: FFMPEG,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => {
    if (!appQuitting) app.exit(code || 0);
  });
  return child;
}

let server = null;
let window_ = null;

// ---- single instance ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window_) { if (window_.isMinimized()) window_.restore(); window_.focus(); }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const port = await freePort();
    server = startServer(port);

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
    await window_.loadURL(`http://127.0.0.1:${port}`);
    // any target=_blank / external link opens in the user's real browser
    window_.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    window_.on('closed', () => { window_ = null; app.quit(); });
  });
}

let appQuitting = false;
app.on('before-quit', () => {
  appQuitting = true;
  if (server) { try { server.kill(); } catch {} }
});
