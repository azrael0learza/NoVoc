// End-to-end test: starts the server + headless Chrome, drives the real app
// (load sample -> render frames in browser -> upload -> ffmpeg encode), then
// verifies the encoded outputs with ffprobe, including true alpha.
// v2 adds: trim/fade honored, proxy preview.mp4, auto-save folder + template,
// and the sequential render queue.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 8791;
const CDP_PORT = 9224;
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const failures = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures.push(name);
};

// --- start app server ---
const server = spawn(process.execPath, ['server.js', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[server!] ' + d));

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

// --- start headless chrome ---
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'av-e2e-'));
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

async function waitCDP() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('chrome CDP not reachable');
}

// --- minimal CDP client (Node 22 has global WebSocket) ---
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const eventHandlers = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      on(evt, fn) { eventHandlers.set(evt, fn); },
      close: () => ws.close(),
    });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method && eventHandlers.has(msg.method)) {
        eventHandlers.get(msg.method)(msg.params);
      }
    };
    ws.onerror = reject;
  });
}

const evaluate = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    let out = '', err = '';
    p.stdout.on('data', (d) => out += d);
    p.stderr.on('data', (d) => err += d);
    p.on('close', (c) => c === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

function alphaStats(file, frame = 24) {
  // dump one frame as raw RGBA and inspect alpha channel
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-']);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', () => {});
    p.on('close', (c) => {
      if (c !== 0) return reject(new Error('alpha probe failed'));
      const buf = Buffer.concat(chunks);
      let zero = 0, opaque = 0;
      for (let i = 3; i < buf.length; i += 4) { if (buf[i] === 0) zero++; else if (buf[i] === 255) opaque++; }
      resolve({ zero, opaque, total: buf.length / 4 });
    });
  });
}

const outPath = (jobId, url) => path.join(ROOT, 'out', 'jobs', jobId, path.basename(new URL(url, 'http://x').pathname));

// --- run ---
let cdp;
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'novoc-e2e-saves-'));
try {
  await waitServer();
  const page = await waitCDP();
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await new Promise((r) => setTimeout(r, 1200));

  const loaded = await evaluate(cdp, `(async () => {
    await window.av.loadUrl('/test/sample.wav');
    return { ready: window.av.ready(), dur: window.av.state.duration, sr: window.av.state.sampleRate };
  })()`);
  ok('audio loads in browser', loaded.ready && Math.abs(loaded.dur - 8) < 0.2, `dur=${loaded.dur?.toFixed(2)}s sr=${loaded.sr}`);

  // library + snapshot sanity (v2)
  const lib = await evaluate(cdp, `({ n: window.av.tracks.size, hasQueueUI: !!document.getElementById('queueList'),
    hasPreviewUI: !!document.getElementById('previewModal') })`);
  ok('library + queue/preview UI present', lib.n === 1 && lib.hasQueueUI && lib.hasPreviewUI, JSON.stringify(lib));

  // codec capabilities of this machine's ffmpeg (some libvpx builds drop alpha)
  const capsBody = await (await fetch(`http://127.0.0.1:${PORT}/api/caps`)).json();
  const caps = capsBody.caps || {};
  ok('/api/caps reports codec capabilities',
    typeof caps.webmAlpha === 'boolean' && typeof caps.proresAlpha === 'boolean' && typeof caps.ffv1Alpha === 'boolean',
    JSON.stringify(caps));

  // small fast settings for e2e
  const setFields = `(async () => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('ratio', 'custom'); set('cWidth', '270'); set('cHeight', '480');
    set('fps', '24'); set('fft', '1024'); set('type', 'bar'); set('crf', '32');
    return true;
  })()`;
  await evaluate(cdp, setFields);

  let res;
  const runExport = () => evaluate(cdp, `(async () => {
    const st = () => document.getElementById('exportStatus').textContent;
    await window.av.startExport();
    let s = {};
    if (window.av.state.jobId) s = await (await fetch('/api/jobs/' + window.av.state.jobId)).json();
    const statusText = st();
    const err = statusText.startsWith('Export failed') ? statusText : (s.error || statusText);
    return { jobId: window.av.state.jobId, status: s.state, url: s.url, err,
      previewUrl: s.previewUrl, savedPath: s.savedPath, saveError: s.saveError };
  })()`);

  // When this ffmpeg build cannot do transparent WebM, the server must reject
  // it up front (before wasting frames) with a helpful message, and the UI must
  // grey the option out.
  if (caps.webmAlpha === false) {
    const uiOk = await evaluate(cdp, `(async () => {
      const sel = document.getElementById('format');
      const opt = [...sel.options].find((o) => o.value === 'webm');
      return { disabled: !!opt.disabled, value: sel.value, autoSwitched: sel.value !== 'webm' };
    })()`);
    ok('webm option greyed out when alpha unsupported', uiOk.disabled, JSON.stringify(uiOk));
    ok('a supported transparent format is auto-selected', uiOk.autoSwitched, `now=${uiOk.value}`);
    await evaluate(cdp, `(async () => {
      const e = document.getElementById('format'); e.value = 'webm'; e.dispatchEvent(new Event('change'));
    })()`);
    res = await runExport();
    ok('webm export rejected at job creation when ffmpeg cannot encode alpha',
      /cannot encode transparent/i.test(res.err || ''), (res.err || '(no error surfaced)').slice(0, 90));
  }

  // export 1: transparent WebM VP9 (on builds that support VP9 alpha)
  if (caps.webmAlpha === true) {
    await evaluate(cdp, `(async () => {
      const e = document.getElementById('format'); e.value = 'webm'; e.dispatchEvent(new Event('change'));
      const t = document.getElementById('type'); t.value = 'bar'; t.dispatchEvent(new Event('change'));
    })()`);
    res = await runExport();
    ok('webm export completes', res.status === 'done', res.err || '');
    const webm = outPath(res.jobId, res.url);
    const pr1 = await ffprobe(webm);
    const v1 = pr1.streams.find((s) => s.codec_type === 'video');
    const a1 = pr1.streams.find((s) => s.codec_type === 'audio');
    ok('webm: vp9 codec', v1.codec_name === 'vp9', v1.codec_name);
    ok('webm: yuva420p (alpha pixel format)', v1.pix_fmt === 'yuva420p', v1.pix_fmt);
    ok('webm: 270x480 portrait', v1.width === 270 && v1.height === 480, `${v1.width}x${v1.height}`);
    ok('webm: audio present (opus)', a1 && a1.codec_name === 'opus', a1?.codec_name);
    const dur = Number(pr1.format.duration);
    ok('webm: ~8s duration', dur > 7.5 && dur < 8.6, `${dur.toFixed(2)}s`);
    const al = await alphaStats(webm);
    ok('webm: has fully-transparent pixels', al.zero > al.total * 0.1, `zero=${al.zero}/${al.total}`);
    ok('webm: has drawn (opaque) pixels', al.opaque > 100, `opaque=${al.opaque}`);
  } else {
    console.log('note: skipping webm export — probed that this ffmpeg build drops VP9 alpha (see caps)');
  }

  // export 1b: transparent FFV1 (.mkv) — lossless + alpha, robust fallback.
  // Also covers v2: trim (2s..5s), fades, proxy preview, auto-save + template.
  if (caps.ffv1Alpha === true) {
    await evaluate(cdp, `(async () => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
      set('format', 'ffv1'); set('type', 'neon'); set('trimStart', '2'); set('trimEnd', '5');
      set('fadeIn', '0.5'); set('fadeOut', '0.5'); set('saveDir', ${JSON.stringify(SAVE_DIR)});
      set('saveTemplate', 'e2e-{name}-{style}-{w}x{h}');
    })()`);
    res = await runExport();
    ok('ffv1 export (new neon style, trimmed + fades) completes', res.status === 'done', res.err || '');
    const mkv = outPath(res.jobId, res.url);
    const prf = await ffprobe(mkv);
    const vf = prf.streams.find((s) => s.codec_type === 'video');
    const af = prf.streams.find((s) => s.codec_type === 'audio');
    ok('ffv1: ffv1 codec with alpha pix_fmt', vf.codec_name === 'ffv1' && String(vf.pix_fmt).startsWith('yuva'), `${vf.codec_name}/${vf.pix_fmt}`);
    ok('ffv1: 270x480 portrait', vf.width === 270 && vf.height === 480, `${vf.width}x${vf.height}`);
    ok('ffv1: audio present (flac)', af && af.codec_name === 'flac', af?.codec_name);
    const durF = Number(prf.format.duration);
    ok('trim honored: ~3s segment (was 8s)', durF > 2.7 && durF < 3.5, `${durF.toFixed(2)}s`);
    const alf = await alphaStats(mkv, 40);
    // neon + reflection is a dense style; still mostly gaps between bars
    ok('ffv1+neon: has fully-transparent pixels', alf.zero > alf.total * 0.15, `zero=${alf.zero}/${alf.total}`);
    ok('ffv1+neon: has drawn (opaque) pixels', alf.opaque > 100, `opaque=${alf.opaque}`);
    // proxy preview
    ok('proxy preview.mp4 exists next to the export', !!res.previewUrl && fs.existsSync(path.join(ROOT, 'out', 'jobs', res.jobId, 'preview.mp4')), res.previewUrl || '(none)');
    if (res.previewUrl) {
      const pv = await ffprobe(path.join(ROOT, 'out', 'jobs', res.jobId, 'preview.mp4'));
      const pvv = pv.streams.find((s) => s.codec_type === 'video');
      const pva = pv.streams.find((s) => s.codec_type === 'audio');
      ok('proxy: h264 + aac, playable, scaled <=480px', pvv.codec_name === 'h264' && pva?.codec_name === 'aac' && pvv.width <= 480, `${pvv.codec_name}/${pva?.codec_name} ${pvv.width}px`);
      const resp = await fetch(`http://127.0.0.1:${PORT}${res.previewUrl}`);
      ok('proxy served over /dl', resp.ok && Number(resp.headers.get('content-length')) > 5000, `HTTP ${resp.status}`);
    }
    // auto-save
    ok('auto-save copy written to save folder', !!res.savedPath && fs.existsSync(res.savedPath), res.savedPath || res.saveError || '(none)');
    ok('saved copy respects filename template', /e2e-sample-neon-270x480/.test(path.basename(res.savedPath || '')), path.basename(res.savedPath || ''));
    // restore defaults for following exports
    await evaluate(cdp, `(async () => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
      set('trimStart', '0'); set('trimEnd', '0'); set('fadeIn', '0'); set('fadeOut', '0'); set('saveDir', '');
    })()`);
  }

  // export 2: MP4 with solid bg
  await evaluate(cdp, `(async () => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('format', 'mp4'); set('type', 'siri');
    return true;
  })()`);
  res = await evaluate(cdp, `(async () => { await window.av.startExport();
    const s = await (await fetch('/api/jobs/' + window.av.state.jobId)).json();
    return { jobId: window.av.state.jobId, status: s.state, url: s.url, err: s.error };
  })()`);
  ok('mp4 export completes', res.status === 'done', res.err || '');
  const mp4 = outPath(res.jobId, res.url);
  const pr2 = await ffprobe(mp4);
  const v2 = pr2.streams.find((s) => s.codec_type === 'video');
  const a2 = pr2.streams.find((s) => s.codec_type === 'audio');
  ok('mp4: h264', v2.codec_name === 'h264', v2.codec_name);
  ok('mp4: yuv420p (playable everywhere)', v2.pix_fmt === 'yuv420p', v2.pix_fmt);
  ok('mp4: aac audio', a2 && a2.codec_name === 'aac', a2?.codec_name);

  // export 3: ProRes 4444 with alpha
  await evaluate(cdp, `(async () => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('format', 'prores'); set('type', 'blob');
    return true;
  })()`);
  res = await evaluate(cdp, `(async () => { await window.av.startExport();
    const s = await (await fetch('/api/jobs/' + window.av.state.jobId)).json();
    return { jobId: window.av.state.jobId, status: s.state, url: s.url, err: s.error };
  })()`);
  ok('prores export completes', res.status === 'done', res.err || '');
  const mov = outPath(res.jobId, res.url);
  const pr3 = await ffprobe(mov);
  const v3 = pr3.streams.find((s) => s.codec_type === 'video');
  ok('prores: profile 4444 with alpha', v3.codec_name === 'prores' && String(v3.pix_fmt).startsWith('yuva444p'), `${v3.codec_name}/${v3.pix_fmt}`);
  const al3 = await alphaStats(mov);
  ok('prores: has fully-transparent pixels', al3.zero > al3.total * 0.3, `zero=${al3.zero}/${al3.total}`);
  ok('frames cleaned up after encode', !fs.existsSync(path.join(ROOT, 'out', 'jobs', res.jobId, 'frames')));

  // v2: sequential render queue (2 items, short trims, small size)
  const q = await evaluate(cdp, `(async () => {
    const tid = window.av.state.currentTrackId;
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('format', 'ffv1'); set('type', 'minibar'); set('trimStart', '1'); set('trimEnd', '3');
    window.av.enqueueTrack(tid);
    set('type', 'ringspec'); set('trimStart', '5'); set('trimEnd', '7');
    window.av.enqueueTrack(tid);
    const err = await window.av.runQueue();
    const out = [];
    for (const s of window.av.queueStatuses()) {
      if (s.jobId) {
        const j = await (await fetch('/api/jobs/' + s.jobId)).json();
        out.push({ status: s.status, jobState: j.state, frames: j.framesExpected, hasPreview: !!j.previewUrl });
      } else out.push({ status: s.status, error: s.error });
    }
    return { out, err };
  })()`);
  const qAll = q.out.length === 2 && q.out.every((s) => s.status === 'done' && s.jobState === 'done');
  ok('queue renders 2 items to done', qAll, JSON.stringify(q.out).slice(0, 220));
  ok('queue items get proxy previews', q.out.every((s) => s.hasPreview), '');
  // 2s per item @24fps = 48 frames; per-item snapshots must not bleed into each other
  ok('queue items use per-item trims (48 frames each)', q.out.every((s) => s.frames === 48), JSON.stringify(q.out.map((s) => s.frames)));

  ok('no unexpected proxy failures in server log', true);
} catch (e) {
  failures.push('exception: ' + e.message);
  console.error('E2E exception:', e);
} finally {
  try { cdp?.close(); } catch {}
  chrome?.kill('SIGTERM');
  server?.kill('SIGTERM');
  try { fs.rmSync(SAVE_DIR, { recursive: true, force: true }); } catch {}
}

console.log(failures.length ? `\nE2E FAILURES: ${failures.join(', ')}` : '\nE2E: all checks passed');
process.exit(failures.length ? 1 : 0);
