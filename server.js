#!/usr/bin/env node
// NoVoc server (formerly audio-visualizer-local)
// - serves the browser app (no CDN, no network needed)
// - receives export frames (PNG/JPEG) rendered frame-by-frame by the browser
// - muxes audio + frames with ffmpeg (VP9 WebM w/ alpha, FFV1 .mkv, ProRes 4444, or H.264 MP4)
// - probes which codecs preserve alpha on this machine and enforces it
// Zero npm dependencies.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// writable data dir (out/, settings.json). In dev this is the project itself;
// packaged shells (AppImage) set NOVOC_DATA to ~/.config/novoc since the app
// bundle is mounted read-only.
const DATA = process.env.NOVOC_DATA || ROOT;
const PUB = path.join(ROOT, 'public');
const OUT = path.join(DATA, 'out');
const JOBS = path.join(OUT, 'jobs');
const FFMPEG = process.env.NOVOC_FFMPEG || 'ffmpeg';
const PORT = Number(process.env.PORT || process.argv[2] || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

fs.mkdirSync(JOBS, { recursive: true });

/** @type {Map<string, object>} */
const jobs = new Map();

// ---- persisted settings (save folder + filename template) -----------------

const SETTINGS_FILE = path.join(DATA, 'settings.json');
const settings = { saveDir: '', nameTemplate: '{name}-{w}x{h}' };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
  catch (e) { log('settings save failed:', e.message); }
}

function fileSafe(s, dflt) {
  const out = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  return out || dflt;
}

// Fill a template like "{name}-{style}-{w}x{h}-{date}" into a file basename.
function renderTemplate(tpl, job, cfg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const map = {
    name: fileSafe(job.base, 'novoc'),
    w: cfg.width, h: cfg.height, fps: cfg.fps,
    style: fileSafe(cfg.style, ''),
    id: job.id,
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
  const filled = String(tpl || '{name}-{w}x{h}').replace(/\{(\w+)\}/g, (m, k) => (k in map ? String(map[k]) : m));
  return fileSafe(filled, 'novoc');
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readRaw(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function framePath(job, idx, ext) {
  if (!Number.isInteger(idx) || idx < 0 || idx > 1e6) throw new Error('bad frame index');
  return path.join(job.dir, 'frames', `frame_${String(idx).padStart(6, '0')}.${ext}`);
}

// ---- codec capability probe ------------------------------------------------
// Whether transparency survives a codec depends on the local ffmpeg/libvpx
// build (e.g. libvpx 1.15 on some distros silently drops VP8/VP9 alpha).
// Encode two small transparent frames per codec and verify the alpha channel
// comes back on decode. Cached after the first run.

const PROBE_V_ARGS = {
  webm: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '20', '-b:v', '0', '-auto-alt-ref', '0'],
  prores: ['-c:v', 'prores_ks', '-profile:v', '4444'],
  ffv1: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuva444p'],
};
const PROBE_EXT = { webm: '.webm', prores: '.mov', ffv1: '.mkv' };

function probeTransparent(fmt) {
  return new Promise((resolve) => {
    const W = 64, H = 64, N = W * H * 4;
    const tmp = path.join(OUT, `.probe-${fmt}-${randomUUID().slice(0, 8)}${PROBE_EXT[fmt]}`);
    const encArgs = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', '24',
      '-i', 'pipe:0', '-frames:v', '2', ...PROBE_V_ARGS[fmt], '-nostats', '-loglevel', 'error', tmp];
    const enc = spawn(FFMPEG, encArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
    const frame = Buffer.alloc(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const inCircle = (x - 32) ** 2 + (y - 32) ** 2 <= 16 ** 2;
        frame[i] = 255; frame[i + 3] = inCircle ? 255 : 0;
      }
    }
    enc.stdin.write(frame); enc.stdin.write(frame); enc.stdin.end();
    enc.on('error', () => resolve(false));
    enc.on('close', (code) => {
      if (code !== 0) { fs.rmSync(tmp, { force: true }); return resolve(false); }
      const dec = spawn(FFMPEG, ['-v', 'error', '-i', tmp, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1']);
      const chunks = [];
      dec.stdout.on('data', (d) => chunks.push(d));
      dec.stderr.resume();
      dec.on('error', () => { fs.rmSync(tmp, { force: true }); resolve(false); });
      dec.on('close', () => {
        fs.rmSync(tmp, { force: true });
        const b = Buffer.concat(chunks);
        if (b.length < N) return resolve(false);
        let zeroAlpha = 0;
        for (let i = 3; i < N; i += 4) if (b[i] === 0) zeroAlpha++;
        resolve(zeroAlpha > 100);
      });
    });
  });
}

let capsPromise = null;
function getCaps() {
  if (!capsPromise) {
    capsPromise = (async () => {
      const [webmAlpha, proresAlpha, ffv1Alpha] = await Promise.all([
        probeTransparent('webm'), probeTransparent('prores'), probeTransparent('ffv1'),
      ]);
      const caps = { webmAlpha, proresAlpha, ffv1Alpha };
      log('transparency probe:', caps);
      return caps;
    })();
  }
  return capsPromise;
}

function buildFFmpegArgs(job, cfg, audioFile) {
  const fmt = cfg.format;
  const fps = String(cfg.fps);
  const crf = String(cfg.crf ?? 30);
  const frames = path.join(job.dir, 'frames', `frame_%06d.${job.frameExt || 'png'}`);
  const audio = audioFile || path.join(job.dir, 'audio' + (job.audioExt || ''));
  const hasAudio = fs.existsSync(audio);
  const common = ['-y', '-framerate', fps, '-i', frames];
  if (hasAudio) common.push('-i', audio);
  common.push('-map', '0:v:0', '-map', hasAudio ? '1:a:0' : '-1');
  const af = [];
  if (hasAudio) {
    if (cfg.loudnorm) af.push('loudnorm=I=-14:TP=-1.5:LRA=11');
    const fade = cfg.fade || {};
    const fi = Number(fade.in) || 0;
    const fo = Number(fade.out) || 0;
    const dur = Number(cfg.renderDur) || (job.frames / (cfg.fps || 30));
    if (fi > 0) af.push(`afade=t=in:st=0:d=${fi}`);
    if (fo > 0 && dur - fo > 0) af.push(`afade=t=out:st=${(dur - fo).toFixed(3)}:d=${fo}`);
  }
  const afArgs = af.length ? ['-af', af.join(',')] : [];

  if (fmt === 'webm') {
    return [...common, ...afArgs,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', // yuva = alpha preserved
      '-crf', crf, '-b:v', '0', '-deadline', 'good',
      '-row-mt', '1', '-cpu-used', '2', '-auto-alt-ref', '0',
      ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '192k'] : []),
      '-shortest', '-nostats', '-progress', 'pipe:1', '-loglevel', 'error',
      job.outFile];
  }
  if (fmt === 'prores') {
    return [...common, ...afArgs,
      '-c:v', 'prores_ks', '-profile:v', '4444', // 4444 = 12-bit with alpha
      ...(hasAudio ? ['-c:a', 'pcm_s24le'] : []),
      '-shortest', '-nostats', '-progress', 'pipe:1', '-loglevel', 'error',
      job.outFile];
  }
  if (fmt === 'ffv1') {
    return [...common, ...afArgs,
      '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuva444p', // lossless + alpha
      '-g', '1',
      ...(hasAudio ? ['-c:a', 'flac', '-compression_level', '8'] : []),
      '-shortest', '-nostats', '-progress', 'pipe:1', '-loglevel', 'error',
      job.outFile];
  }
  // default: mp4 (H.264). Opaque format: the browser fills the background.
  return [...common, ...af,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-shortest', '-nostats', '-progress', 'pipe:1', '-loglevel', 'error',
    job.outFile];
}

function spawnFF(args, label) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, args);
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.stdout.resume();
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label || 'ffmpeg'} exit ${code}: ${err.slice(-500)}`))));
  });
}

// A small, scrubbable h264 MP4 for the in-app preview pane: the real frames
// scaled to 480px and composited over a dark checkerboard (so transparent
// regions show up as a checker), with the same trimmed/faded audio attached.
// It is preview-only; the deliverable stays the actual FFV1/ProRes/WebM/MP4 file.
function buildProxyArgs(job, cfg, audioFile) {
  const W = Number(cfg.width) || 1080, H = Number(cfg.height) || 1920;
  const pw = Math.max(2, Math.min(480, W) & ~1);
  const ph = Math.max(2, Math.round((pw * H) / W / 2) * 2);
  const frames = path.join(job.dir, 'frames', `frame_%06d.${job.frameExt || 'png'}`);
  const hasAudio = audioFile && fs.existsSync(audioFile);
  const CI = hasAudio ? 2 : 1; // index of the lavfi checkerboard input
  const fade = cfg.fade || {};
  const fi = Number(fade.in) || 0, fo = Number(fade.out) || 0;
  const dur = Number(cfg.renderDur) || (job.frames / (cfg.fps || 30));
  const af = [];
  if (fi > 0) af.push(`afade=t=in:st=0:d=${fi}`);
  if (fo > 0 && dur - fo > 0) af.push(`afade=t=out:st=${(dur - fo).toFixed(3)}:d=${fo}`);
  const cell = 32; // checker cell size in proxy pixels
  const fc = `[${CI}:v]geq=lum='34+36*mod(floor(X/${cell})+floor(Y/${cell}),2)',format=gray,format=yuv420p[bg];` +
    `[0:v]scale=${pw}:${ph}[f];[bg][f]overlay=0:0:format=auto,format=yuv420p[v]`;
  return ['-y', '-framerate', String(cfg.fps), '-i', frames,
    ...(hasAudio ? ['-i', audioFile] : []),
    '-f', 'lavfi', '-i', `color=c=gray:s=${pw}x${ph}:r=${cfg.fps}`,
    '-filter_complex', fc,
    '-map', '[v]',
    ...(hasAudio ? ['-map', '1:a:0', ...(af.length ? ['-af', af.join(',')] : [])] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : []),
    '-shortest', '-movflags', '+faststart', '-loglevel', 'error',
    path.join(job.dir, 'preview.mp4')];
}

async function startEncode(job, cfg) {
  job.state = 'encoding';
  job.outPct = 0;
  job.cfg = cfg;

  // Trim the audio once up-front so the main encode and the proxy share one sliced source.
  let audioFile = path.join(job.dir, 'audio' + (job.audioExt || ''));
  const trim = cfg.trim || {};
  const ts = Number(trim.start) || 0;
  const te = Number(trim.end) || 0;
  try {
    if (fs.existsSync(audioFile) && (ts > 0 || te > 0)) {
      const cut = path.join(job.dir, 'trimmed.wav');
      const tArgs = ['-y', '-v', 'error', '-i', audioFile];
      if (ts > 0) tArgs.push('-ss', String(ts));
      if (te > 0) tArgs.push('-to', String(te));
      tArgs.push('-c:a', 'pcm_s16le', cut);
      await spawnFF(tArgs, 'audio trim');
      audioFile = cut;
    }
  } catch (e) {
    job.state = 'error';
    job.error = e.message;
    log(`job ${job.id}: ${e.message}`);
    return;
  }
  job.audioFile = audioFile;

  log(`job ${job.id}: encoding ${cfg.format} ${cfg.width}x${cfg.height}@${cfg.fps}` +
    (ts || te ? ` trim ${ts}s-${te}s` : ''));
  const args = buildFFmpegArgs(job, cfg, audioFile);
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errBuf = '';
  ff.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const m = line.match(/^out_time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (m && job.totalFrames > 0) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
        const total = job.totalFrames / cfg.fps;
        job.outPct = Math.min(100, Math.round((t / total) * 100));
      }
    }
  });
  ff.stderr.on('data', (d) => { errBuf += d.toString(); });
  ff.on('error', (e) => { job.state = 'error'; job.error = `ffmpeg spawn failed: ${e.message}`; });
  ff.on('close', async (code) => {
    if (code !== 0) {
      job.state = 'error';
      job.error = 'ffmpeg failed: ' + errBuf.slice(-2000);
      log(`job ${job.id}: ffmpeg exit ${code}`);
      return;
    }
    job.outPct = 100;

    // Fast low-res proxy for the preview pane (still needs frames, so do it before cleanup).
    try {
      await spawnFF(buildProxyArgs(job, cfg, job.audioFile), 'proxy encode');
      job.previewReady = true;
    } catch (e) {
      log(`job ${job.id}: proxy failed: ${e.message}`);
    }
    try { await fsp.rm(path.join(job.dir, 'frames'), { recursive: true, force: true }); } catch {}

    // Auto-save a copy into the configured folder (session or per-queue override).
    const saveDir = (cfg.saveDir !== undefined ? cfg.saveDir : settings.saveDir) || '';
    if (saveDir) {
      try {
        if (!path.isAbsolute(saveDir)) throw new Error('save folder must be an absolute path');
        await fsp.mkdir(saveDir, { recursive: true });
        const baseName = renderTemplate(cfg.template || settings.nameTemplate, job, cfg);
        const ext = path.extname(job.outFile);
        let dest = path.join(saveDir, baseName + ext);
        for (let n = 1; fs.existsSync(dest); n++) dest = path.join(saveDir, `${baseName}-${n}${ext}`);
        await fsp.copyFile(job.outFile, dest);
        job.savedPath = dest;
        log(`job ${job.id}: saved -> ${dest}`);
      } catch (e) {
        job.saveError = e.message;
        log(`job ${job.id}: auto-save failed: ${e.message}`);
      }
    }

    job.state = 'done';
    log(`job ${job.id}: done -> ${path.basename(job.outFile)}`);
  });
}

// ---- routes ---------------------------------------------------------------

async function handleApi(req, res, u) {
  const seg = u.pathname.split('/').filter(Boolean); // api jobs <id> [sub]

  if (req.method === 'GET' && u.pathname === '/api/caps') {
    return json(res, 200, { ok: true, caps: await getCaps() });
  }

  if (req.method === 'GET' && u.pathname === '/api/settings') {
    return json(res, 200, { ok: true, settings });
  }

  if (req.method === 'POST' && u.pathname === '/api/settings') {
    const body = JSON.parse((await readRaw(req, 16 * 1024)).toString() || '{}');
    if (body.saveDir !== undefined) {
      const d = String(body.saveDir || '').trim();
      if (d && !path.isAbsolute(d)) return json(res, 400, { ok: false, error: 'save folder must be an absolute path (e.g. /run/media/user/drive/visualizers)' });
      settings.saveDir = d;
    }
    if (body.nameTemplate !== undefined) settings.nameTemplate = fileSafe(body.nameTemplate, '{name}-{w}x{h}');
    saveSettings();
    return json(res, 200, { ok: true, settings });
  }

  if (req.method === 'POST' && u.pathname === '/api/jobs') {
    const body = JSON.parse((await readRaw(req, 64 * 1024)).toString() || '{}');
    const id = randomUUID().slice(0, 8);
    const dir = path.join(JOBS, id);
    await fsp.mkdir(path.join(dir, 'frames'), { recursive: true });
    const ext = safeName(body.ext || '.wav');
    const base = safeName(body.name || 'visualizer');
    const fmt = ['webm', 'mp4', 'prores', 'ffv1'].includes(body.format) ? body.format : 'webm';
    const caps = await getCaps();
    const alphaOk = { webm: caps.webmAlpha, prores: caps.proresAlpha, ffv1: caps.ffv1Alpha };
    if (fmt !== 'mp4' && alphaOk[fmt] === false) {
      await fsp.rm(dir, { recursive: true, force: true });
      return json(res, 400, {
        ok: false,
        error: `This ffmpeg build cannot encode transparent ${fmt} video on this system. ` +
          'Try ProRes 4444 (.mov) or FFV1 (.mkv), or export MP4 with a solid background.',
      });
    }
    const outExt = { webm: 'webm', mp4: 'mp4', prores: 'mov', ffv1: 'mkv' }[fmt];
    const outFile = path.join(dir, `${base}-${body.width}x${body.height}.${outExt}`);
    const job = {
      id, dir, outFile, audioExt: ext, frameExt: 'png', base,
      state: 'uploading', frames: 0, received: 0, totalFrames: 0,
      outPct: 0, error: null, createdAt: Date.now(),
      previewReady: false, savedPath: null, saveError: null,
    };
    jobs.set(id, job);
    return json(res, 200, { ok: true, id });
  }

  if (seg[0] === 'api' && seg[1] === 'jobs' && seg[2]) {
    const job = jobs.get(seg[2]);
    if (!job) return json(res, 404, { ok: false, error: 'no such job' });
    const sub = seg[3];

    if (req.method === 'PUT' && sub === 'audio') {
      const buf = await readRaw(req, 512 * 1024 * 1024);
      await fsp.writeFile(path.join(job.dir, 'audio' + job.audioExt), buf);
      return json(res, 200, { ok: true, bytes: buf.length });
    }

    if (req.method === 'PUT' && sub === 'frames') {
      const idx = Number(seg[4]);
      const buf = await readRaw(req, 64 * 1024 * 1024);
      const ext = (u.searchParams.get('fmt') || 'png') === 'jpg' ? 'jpg' : 'png';
      job.frameExt = ext;
      await fsp.writeFile(framePath(job, idx, ext), buf);
      job.received++;
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && sub === 'encode') {
      const cfg = JSON.parse((await readRaw(req, 16 * 1024)).toString() || '{}');
      if (!['webm', 'mp4', 'prores', 'ffv1'].includes(cfg.format)) {
        return json(res, 400, { ok: false, error: 'invalid format' });
      }
      if (job.received === 0) return json(res, 400, { ok: false, error: 'no frames uploaded' });
      const caps = await getCaps();
      const alphaOk = { webm: caps.webmAlpha, prores: caps.proresAlpha, ffv1: caps.ffv1Alpha };
      if (cfg.format !== 'mp4' && alphaOk[cfg.format] === false) {
        return json(res, 400, {
          ok: false,
          error: `This ffmpeg build cannot encode transparent ${cfg.format} video on this system. ` +
            'Try ProRes 4444 (.mov) or FFV1 (.mkv), or export MP4 with a solid background.',
        });
      }
      // normalize numeric/string fields so nothing odd reaches ffmpeg or the fs
      const num = (v, d, max = 1e9) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : d; };
      cfg.fps = num(cfg.fps, 30, 240);
      cfg.crf = num(cfg.crf, 30, 63);
      cfg.trim = { start: num(cfg.trim?.start, 0, 86400), end: num(cfg.trim?.end, 0, 86400) };
      cfg.fade = { in: num(cfg.fade?.in, 0, 60), out: num(cfg.fade?.out, 0, 60) };
      cfg.renderDur = num(cfg.renderDur, 0, 86400);
      cfg.style = String(cfg.style || '').slice(0, 40);
      if (cfg.saveDir !== undefined) cfg.saveDir = String(cfg.saveDir).slice(0, 1024);
      if (cfg.template !== undefined) cfg.template = String(cfg.template).slice(0, 120);
      job.frames = job.received;
      job.totalFrames = Number(cfg.totalFrames) || job.received;
      startEncode(job, cfg);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && !sub) {
      return json(res, 200, {
        ok: true, state: job.state, framesReceived: job.received,
        framesExpected: job.frames || null, outPct: job.outPct, error: job.error,
        url: job.state === 'done' ? `/dl/${job.id}/${encodeURIComponent(path.basename(job.outFile))}` : null,
        previewUrl: job.state === 'done' && job.previewReady ? `/dl/${job.id}/preview.mp4` : null,
        savedPath: job.savedPath || null,
        saveError: job.saveError || null,
        fileName: path.basename(job.outFile),
      });
    }
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

function serveStatic(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);

    if (req.method === 'GET' && u.pathname.startsWith('/dl/')) {
      const parts = u.pathname.split('/').filter(Boolean); // dl <id> <file>
      const job = jobs.get(parts[1]);
      if (!job || job.state !== 'done') { res.writeHead(404); return res.end('not ready'); }
      const f = path.join(job.dir, safeName(decodeURIComponent(parts[2] || '')));
      if (!f.startsWith(job.dir)) { res.writeHead(403); return res.end('forbidden'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(f)] || 'application/octet-stream',
        'content-length': fs.statSync(f).size,
        'content-disposition': `attachment; filename="${path.basename(f)}"`,
      });
      return fs.createReadStream(f).pipe(res);
    }

    if (req.method === 'GET') {
      let p = decodeURIComponent(u.pathname);
      if (p === '/') p = '/index.html';
      if (p.startsWith('/test/')) return serveStatic(res, path.join(ROOT, p));
      const resolved = path.join(PUB, p);
      if (!resolved.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
      return serveStatic(res, resolved);
    }
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    log('error:', e.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    else res.destroy();
  }
});

// clean job folders older than 24h at boot
try {
  for (const d of fs.readdirSync(JOBS)) {
    const p = path.join(JOBS, d);
    if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
  }
} catch {}

server.listen(PORT, '127.0.0.1', () => {
  log(`NoVoc serving on http://localhost:${PORT}`);
  log(`outputs go to ${OUT}`);
  if (settings.saveDir) log(`auto-save folder: ${settings.saveDir}`);
});
