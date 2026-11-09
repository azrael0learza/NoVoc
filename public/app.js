// NoVoc app: preview + offline export + library + render queue.
// Preview and export run the SAME spectrum math (SpectrumAnalyzer over the
// pre-decoded PCM) and the SAME renderers, so what you preview is exactly
// what gets encoded — the difference is only that export steps time in
// fixed 1/fps increments and uploads each PNG frame to the local ffmpeg
// backend instead of recording the screen in real time.

import { TYPES, HINTS, makeRenderer } from '/lib/visualizers.js';
import { SpectrumAnalyzer, getWave, BAND_COUNT } from '/lib/spectrum.js';

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of ['file', 'fileInfo', 'type', 'styleHint', 'color', 'color2', 'gradient', 'glow',
  'barWidth', 'gap', 'lineWidth', 'sensitivity', 'smoothing', 'fft', 'ratio', 'customRow',
  'cWidth', 'cHeight', 'fps', 'format', 'crf', 'bgRow', 'bgcolor', 'loudnorm', 'exportBtn',
  'framesBar', 'encodeBar', 'exportStatus', 'exportLink', 'stage', 'cv', 'playBtn', 'stopBtn',
  'time', 'seek', 'guides', 'prevg',
  'trimStart', 'trimEnd', 'trimFull', 'trimClear', 'trimMarkStart', 'trimMarkEnd', 'trimInfo',
  'fadeIn', 'fadeOut', 'saveDir', 'saveTemplate', 'saveSettingsBtn', 'saveStatus',
  'library', 'libCount', 'dropZone', 'queueList', 'queueHint', 'runQueueBtn', 'clearDoneBtn',
  'capsNote', 'previewModal', 'previewVideo', 'previewTitle', 'previewMeta',
  'previewDownload', 'previewRedo', 'previewClose']) els[id] = $(id);

const cv = els.cv;
const pctx = cv.getContext('2d');
const exportCanvas = document.createElement('canvas');
const ectx = exportCanvas.getContext('2d');

const state = {
  // current editor track (mirrors tracks.get(currentTrackId))
  pcm: null, sampleRate: 0, duration: 0, baseName: 'visualizer',
  currentTrackId: null,
  playing: false, startCtxTime: 0, offset: 0, src: null, actx: null,
  previewChain: null, renderer: null, lastPreviewT: -1,
  previewScale: 1, exporting: false, jobId: null,
};

// ---- library & queue state ----
const tracks = new Map(); // id -> {id, name, baseName, ext, bytes, pcm, sr, dur, addedAt}
let trackSeq = 1;
const queue = []; // {qid, trackId, snap, status, frames, encode, jobId, info, error}
let queueSeq = 1;
let queueRunner = null; // promise while running

// ---------- helpers ----------

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function params() {
  return {
    color: els.color.value,
    color2: els.color2.value,
    gradient: els.gradient.checked,
    glow: els.glow.checked,
    barWidth: +els.barWidth.value,
    gap: +els.gap.value,
    lineWidth: +els.lineWidth.value,
  };
}

function analysisSettings() {
  return {
    fftSize: +els.fft.value,
    sensitivity: +els.sensitivity.value,
    smoothing: +els.smoothing.value,
  };
}

const WAVE_LEN = 240;
const waveBuf = new Float32Array(WAVE_LEN);

// shared frame builder: preview + export must use this exact path
function buildFrameFrom(pcm, sampleRate, analysis, an, t, dt, index) {
  const startIdx = Math.floor(t * sampleRate);
  an.setFftSize(analysis.fftSize);
  an.smoothing = analysis.smoothing;
  const bands = an.process(pcm, startIdx, analysis.sensitivity);
  getWave(pcm, startIdx + Math.floor(analysis.fftSize / 2), analysis.fftSize, waveBuf);
  const s = an.stats();
  return { bands, wave: waveBuf, ...s, time: t, index, dt };
}

function buildFrame(an, t, dt, index) {
  return buildFrameFrom(state.pcm, state.sampleRate, analysisSettings(), an, t, dt, index);
}

// multiply band/wave/stats values by a gain (used for visual fades)
function applyGain(frame, g) {
  if (g >= 1) return frame;
  for (let i = 0; i < frame.bands.length; i++) frame.bands[i] *= g;
  for (let i = 0; i < frame.wave.length; i++) frame.wave[i] *= g;
  for (const k of ['bass', 'mid', 'high', 'level']) {
    if (typeof frame[k] === 'number') frame[k] *= g;
  }
  return frame;
}

function drawGuides(ctx, W, H) {
  if (!els.guides.checked || H <= W) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = 'rgba(255,80,80,0.8)';
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  const sx = state.previewScale, k = Math.min(1, W / 1080);
  const top = 110 * k * sx, bottom = 250 * k * sx, right = 120 * k * sx, left = 32 * k * sx;
  ctx.strokeRect(left, top, W - right - left, H - top - bottom);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,80,80,0.75)';
  ctx.font = `${Math.max(11, 14 * k * sx)}px system-ui`;
  ctx.fillText('TikTok/Reels UI safe area', left + 6, top - 6);
  ctx.restore();
}

// ---------- audio decode & library ----------

async function decodeBytes(bytes) {
  const oac = new OfflineAudioContext(2, 132, 44100);
  const buf = await oac.decodeAudioData(bytes.slice(0));
  const sr = buf.sampleRate;
  const n = buf.length;
  const pcm = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) pcm[i] += d[i] / buf.numberOfChannels;
  }
  return { pcm, sr, dur: buf.duration };
}

async function addToLibrary(file) {
  const bytes = await file.arrayBuffer();
  const m = /\.([a-z0-9]+)$/i.exec(file.name);
  const ext = '.' + (m ? m[1].toLowerCase() : 'wav');
  const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'visualizer';
  let dec;
  try {
    dec = await decodeBytes(bytes);
  } catch (e) {
    els.fileInfo.textContent = ` — could not decode ${file.name} (${e.message})`;
    return null;
  }
  const t = { id: 't' + trackSeq++, name: file.name, baseName, ext, bytes, pcm: dec.pcm, sr: dec.sr, dur: dec.dur, addedAt: Date.now() };
  tracks.set(t.id, t);
  renderLibrary();
  if (!state.currentTrackId) loadTrack(t.id);
  return t;
}

function loadTrack(id) {
  const t = tracks.get(id);
  if (!t) return;
  stopPlay();
  state.currentTrackId = id;
  state.pcm = t.pcm;
  state.sampleRate = t.sr;
  state.duration = t.dur;
  state.baseName = t.baseName;
  state.offset = 0;
  state.lastPreviewT = -1;
  state.previewChain = null;
  state.renderer = null;
  els.trimEnd.value = String(Math.round(t.dur * 10) / 10);
  els.trimStart.value = '0';
  els.seek.max = String(Math.floor(t.dur * 100));
  els.playBtn.disabled = els.exportBtn.disabled = false;
  for (const b of ['trimMarkStart', 'trimMarkEnd', 'trimFull', 'trimClear']) els[b].disabled = false;
  els.exportStatus.textContent = '';
  els.exportLink.innerHTML = '';
  updateTrimInfo();
  renderStatic();
  renderLibrary();
}

function currentTrim() {
  const dur = state.duration;
  let s = Math.max(0, +els.trimStart.value || 0);
  let e = +els.trimEnd.value || 0;
  if (!dur) return { start: 0, end: 0, len: 0 };
  if (e <= 0 || e > dur) e = dur;
  if (s >= e) s = 0;
  return { start: s, end: e, len: e - s };
}

// Human-friendly whole-unit breakdown: 67 -> "1 minute 7 seconds",
// 120 -> "2 minutes", 45 -> "45 seconds". Complements the precise
// decimal-seconds numbers already shown.
function humanDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
  if (s || !parts.length) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

function updateTrimInfo() {
  if (!state.duration) { els.trimInfo.textContent = 'No track loaded — trim applies to the loaded track only.'; return; }
  const tr = currentTrim();
  const fps = +els.fps.value || 30;
  const human = humanDuration(tr.len);
  const cut = state.duration - tr.len;
  els.trimInfo.textContent =
    `Segment: ${tr.start.toFixed(1)}s → ${tr.end.toFixed(1)}s (${tr.len.toFixed(1)}s · ${Math.round(tr.len * fps)} frames @${fps}fps)` +
    ` · ${human}` +
    (cut > 0.05 ? ` · ${humanDuration(cut)} cut away` : ' — full length');
}

// ---------- preview ----------

function fitPreview() {
  const [W, H] = exportSize();
  const box = els.stage.getBoundingClientRect();
  const pad = 16;
  const s = Math.min((box.width - pad) / W, (box.height - pad) / H);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.style.width = `${Math.floor(W * s)}px`;
  cv.style.height = `${Math.floor(H * s)}px`;
  cv.width = Math.max(2, Math.floor(W * s * dpr));
  cv.height = Math.max(2, Math.floor(H * s * dpr));
  state.previewScale = s * dpr;
  renderStatic();
}

function renderStatic() {
  if (!state.pcm) { pctx.clearRect(0, 0, cv.width, cv.height); return; }
  const [W, H] = exportSize();
  const s = state.previewScale;
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, cv.width, cv.height);
  pctx.setTransform(s, 0, 0, s, 0, 0);
  drawPreviewAt(state.offset);
}

function ensureChain() {
  if (!state.previewChain || state.previewChain.fftSize !== +els.fft.value || state.previewChain.smoothing !== +els.smoothing.value) {
    state.previewChain = new SpectrumAnalyzer(state.sampleRate, +els.fft.value, { smoothing: +els.smoothing.value });
    state.previewChain.fftSize = +els.fft.value;
    if (!state.renderer) state.renderer = makeRenderer(els.type.value, params());
  }
  return state.previewChain;
}

function drawPreviewAt(t) {
  if (!state.pcm) return;
  const [W, H] = exportSize();
  const an = ensureChain();
  const dt = Math.max(1 / 60, Math.min(0.1, t - state.lastPreviewT)) || 1 / 60;
  if (t < state.lastPreviewT - 0.01) { an.reset(); } // seek backwards
  state.lastPreviewT = t;
  const frame = buildFrame(an, Math.min(t, state.duration), dt, Math.round(t * 60));
  if (!state.renderer || state.renderer._type !== els.type.value) {
    state.renderer = makeRenderer(els.type.value, params());
    state.renderer._type = els.type.value;
  }
  state.renderer.draw(pctx, W, H, frame);
  drawGuides(pctx, W, H);
}

let raf = 0;
function previewLoop() {
  if (!state.playing) return;
  const t = state.offset + (state.actx.currentTime - state.startCtxTime);
  if (t >= state.duration) { stopPlay(); return; }
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, cv.width, cv.height);
  pctx.setTransform(state.previewScale, 0, 0, state.previewScale, 0, 0);
  drawPreviewAt(t);
  els.time.textContent = `${fmtTime(t)} / ${fmtTime(state.duration)}`;
  els.seek.value = String(Math.floor(t * 100));
  raf = requestAnimationFrame(previewLoop);
}

function play() {
  if (!state.pcm || state.playing) return;
  if (!state.actx) state.actx = new AudioContext();
  state.actx.resume();
  state.src = state.actx.createBufferSource();
  const buf = state.actx.createBuffer(1, state.pcm.length, state.sampleRate);
  buf.copyToChannel(state.pcm, 0);
  state.src.buffer = buf;
  state.src.connect(state.actx.destination);
  state.src.onended = () => { if (state.playing) stopPlay(); };
  state.src.start(0, state.offset);
  state.startCtxTime = state.actx.currentTime;
  state.playing = true;
  els.playBtn.textContent = '⏸ Pause';
  previewLoop();
}

function stopPlay() {
  if (state.playing) state.offset += state.actx.currentTime - state.startCtxTime;
  state.playing = false;
  if (state.src) { try { state.src.onended = null; state.src.stop(); } catch {} state.src = null; }
  state.offset = Math.min(state.offset, state.duration);
  els.playBtn.textContent = '▶ Play';
  els.time.textContent = `${fmtTime(state.offset)} / ${fmtTime(state.duration)}`;
  cancelAnimationFrame(raf);
  renderStatic();
}

// ---------- export sizes / format ----------

const RATIO_SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

function exportSizeFor(snap) {
  if (snap.ratio === 'custom') {
    const w = Math.max(16, Math.min(3840, Math.round(snap.cWidth / 2) * 2));
    const h = Math.max(16, Math.min(3840, Math.round(snap.cHeight / 2) * 2));
    return [w, h];
  }
  return RATIO_SIZES[snap.ratio] || RATIO_SIZES['9:16'];
}

function exportSize() { return exportSizeFor(snapshot()); }

function updateFormatUI() {
  const opaque = els.format.value === 'mp4';
  els.bgRow.hidden = !opaque;
}

// Ask the backend which codecs actually preserve transparency on this
// machine's ffmpeg build (some libvpx builds silently drop WebM alpha) and
// grey out anything unusable, picking a working default instead.
const caps = { webmAlpha: true, proresAlpha: true, ffv1Alpha: true };

async function detectCodecCaps() {
  try {
    const r = await fetch('/api/caps');
    if (!r.ok) return;
    const body = await r.json();
    if (body && body.caps) Object.assign(caps, body.caps);
  } catch {
    return; // server without /api/caps: assume everything works
  }
  const okFor = { webm: caps.webmAlpha, prores: caps.proresAlpha, ffv1: caps.ffv1Alpha, mp4: true };
  for (const opt of els.format.options) {
    const ok = okFor[opt.value] !== false;
    opt.disabled = !ok;
    if (!ok) {
      if (!opt.dataset.unsupported) {
        opt.text += ' — not supported by this ffmpeg';
        opt.dataset.unsupported = '1';
      }
      opt.title = 'This ffmpeg build drops the alpha channel for this codec. Use ProRes 4444 (.mov) or FFV1 (.mkv), or export MP4 with a solid background.';
    }
  }
  if (opt_selectedDisabled()) {
    const first = [...els.format.options].find((o) => !o.disabled && o.value !== 'mp4')
      || [...els.format.options].find((o) => !o.disabled);
    if (first) els.format.value = first.value;
  }
  const marks = (n, ok) => `${n} ${ok ? '✓' : '✗'}`;
  els.capsNote.textContent = `Codec probe on this machine: ${marks('transparent WebM', caps.webmAlpha)} · ${marks('FFV1', caps.ffv1Alpha)} · ${marks('ProRes', caps.proresAlpha)} — greyed-out formats are unavailable here.`;
  updateFormatUI();
}

function opt_selectedDisabled() {
  const o = els.format.selectedOptions[0];
  return !!(o && o.disabled);
}

// ---------- settings snapshot ----------

function snapshot() {
  return {
    type: els.type.value,
    params: params(),
    analysis: analysisSettings(),
    ratio: els.ratio.value,
    cWidth: +els.cWidth.value,
    cHeight: +els.cHeight.value,
    fps: +els.fps.value,
    format: els.format.value,
    crf: +els.crf.value,
    bgcolor: els.bgcolor.value,
    loudnorm: els.loudnorm.checked,
    trim: currentTrim(),
    fade: { in: Math.max(0, +els.fadeIn.value || 0), out: Math.max(0, +els.fadeOut.value || 0) },
    saveDir: els.saveDir.value.trim(),
    template: els.saveTemplate.value.trim() || '{name}-{w}x{h}',
  };
}

// ---------- export core (shared by single export and queue) ----------

async function uploadFrame(jobId, idx, blob) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`/api/jobs/${jobId}/frames/${idx}?fmt=png`, { method: 'PUT', body: blob });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
}

async function toBlob(canvas, type, q) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, q));
}

// Renders every frame for (snap, track) and submits the encode job.
// prog = { frames(pct), status(text) }. Resolves once ffmpeg encoding has STARTED
// (ffmpeg then runs in the background; pollJob tracks completion).
async function renderTrackFrames(snap, track, prog) {
  const [W, H] = exportSizeFor(snap);
  const fps = snap.fps;
  let start = snap.trim.start, end = snap.trim.end;
  if (end <= 0 || end > track.dur) end = track.dur;
  if (start >= end) start = 0;
  const totalFrames = Math.max(1, Math.round((end - start) * fps));
  const renderDur = totalFrames / fps;

  const createRes = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: track.baseName, ext: track.ext, format: snap.format, width: W, height: H }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.ok) throw new Error(createJson.error || `job creation failed (HTTP ${createRes.status})`);
  const jobId = createJson.id;

  await fetch(`/api/jobs/${jobId}/audio`, { method: 'PUT', body: track.bytes.slice(0) });

  exportCanvas.width = W;
  exportCanvas.height = H;
  const an = new SpectrumAnalyzer(track.sr, snap.analysis.fftSize, { smoothing: snap.analysis.smoothing });
  an.fftSize = snap.analysis.fftSize;
  const renderer = makeRenderer(snap.type, snap.params);
  renderer.reset();
  const opaque = snap.format === 'mp4';
  const fi = snap.fade.in, fo = snap.fade.out;

  const inflight = new Set();
  const MAXP = 6;
  const waitSlot = async () => {
    while (inflight.size >= MAXP) await Promise.race(inflight);
  };

  for (let i = 0; i < totalFrames; i++) {
    const t = start + i / fps;
    const frame = buildFrameFrom(track.pcm, track.sr, snap.analysis, an, t, 1 / fps, i);
    if (fi > 0 || fo > 0) {
      const tl = t - start;
      let g = 1;
      if (fi > 0) g = Math.min(g, tl / fi);
      if (fo > 0) g = Math.min(g, (renderDur - tl) / fo);
      applyGain(frame, Math.max(0, Math.min(1, g)));
    }
    ectx.setTransform(1, 0, 0, 1, 0, 0);
    if (opaque) {
      ectx.fillStyle = snap.bgcolor;
      ectx.fillRect(0, 0, W, H);
    } else {
      ectx.clearRect(0, 0, W, H);
    }
    renderer.draw(ectx, W, H, frame);
    const blob = await toBlob(exportCanvas, 'image/png');
    await waitSlot();
    const p = uploadFrame(jobId, i, blob).finally(() => inflight.delete(p));
    inflight.add(p);
    prog.frames(Math.round(((i + 1) / totalFrames) * 100));
    if (i % 60 === 0) {
      prog.status(`Rendering frame ${i + 1}/${totalFrames}…`);
      await new Promise((r) => setTimeout(r)); // let the UI breathe
    }
  }
  await Promise.all(inflight);

  prog.status('Encoding with ffmpeg (backend)…');
  const encRes = await fetch(`/api/jobs/${jobId}/encode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fps, format: snap.format, crf: snap.crf, loudnorm: snap.loudnorm,
      totalFrames, width: W, height: H,
      trim: { start, end }, renderDur,
      fade: snap.fade,
      saveDir: snap.saveDir, template: snap.template,
      style: snap.type,
    }),
  });
  const encJson = await encRes.json();
  if (!encJson.ok) throw new Error(encJson.error || 'encode rejected');
  return { jobId, totalFrames, renderDur };
}

async function pollJob(jobId, prog) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const s = await (await fetch(`/api/jobs/${jobId}`)).json();
    prog.encode(s.outPct || 0);
    if (s.state === 'done') return s;
    if (s.state === 'error') throw new Error(s.error || 'encode failed');
    prog.status(`ffmpeg encoding… ${s.outPct}%`);
  }
}

const FMT_LABEL = { webm: 'WebM', ffv1: 'FFV1 .mkv', prores: 'ProRes .mov', mp4: 'MP4' };

// ---------- single export ----------

async function startExport() {
  if (state.exporting || !state.currentTrackId) return;
  const track = tracks.get(state.currentTrackId);
  if (!track) return;
  state.exporting = true;
  els.exportBtn.disabled = true;
  els.exportLink.innerHTML = '';
  els.framesBar.style.width = '0%';
  els.encodeBar.style.width = '0%';
  const t0 = Date.now();
  const prog = {
    frames: (p) => { els.framesBar.style.width = `${p}%`; },
    encode: (p) => { els.encodeBar.style.width = `${p}%`; },
    status: (txt) => { els.exportStatus.textContent = txt; },
  };
  try {
    els.exportStatus.textContent = 'Starting…';
    const snap = snapshot();
    const { jobId } = await renderTrackFrames(snap, track, prog);
    state.jobId = jobId;
    const s = await pollJob(jobId, prog);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    els.exportStatus.textContent = `Done in ${secs}s.`;
    const where = s.savedPath ? `saved to <code>${s.savedPath}</code>` : `also in out/jobs/${jobId}/`;
    els.exportLink.innerHTML =
      `<a href="${s.url}">⬇ Download ${FMT_LABEL[snap.format] || snap.format.toUpperCase()}</a>` +
      ` · <a href="#" class="hint" data-preview="${jobId}">▶ preview render</a> <span class="hint">(${where})</span>`;
    els.exportLink.querySelector('[data-preview]').addEventListener('click', (e) => {
      e.preventDefault();
      openPreviewForJob(null, s);
    });
    if (s.saveError) els.exportStatus.textContent += ` (auto-save warning: ${s.saveError})`;
  } catch (e) {
    console.error(e);
    els.exportStatus.textContent = `Export failed: ${e.message}`;
  } finally {
    state.exporting = false;
    els.exportBtn.disabled = false;
  }
}

// ---------- library UI ----------

function renderLibrary() {
  els.libCount.textContent = tracks.size ? `(${tracks.size})` : '';
  els.library.innerHTML = '';
  for (const t of [...tracks.values()].sort((a, b) => a.addedAt - b.addedAt)) {
    const div = document.createElement('div');
    div.className = 'item' + (t.id === state.currentTrackId ? ' active' : '');
    div.innerHTML =
      `<div class="title"><span class="name" title="${t.name}">${t.name}</span>` +
      `<span class="meta">${fmtTime(t.dur)}</span></div>` +
      `<div class="btns"></div>`;
    const btns = div.querySelector('.btns');
    const mk = (label, fn, cls = 'ghost') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      btns.appendChild(b);
      return b;
    };
    mk('Load', () => loadTrack(t.id));
    mk('+ Queue', () => enqueueTrack(t.id));
    mk('✕', () => {
      if (t.id === state.currentTrackId) { stopPlay(); state.currentTrackId = null; state.pcm = null; renderStatic(); renderLibrary(); }
      tracks.delete(t.id);
      renderLibrary();
    });
    els.library.appendChild(div);
  }
}

async function addFiles(files) {
  const audio = [...files].filter((f) => f.type.startsWith('audio') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
  els.fileInfo.textContent = ' — decoding…';
  let last = null;
  for (const f of audio) last = await addToLibrary(f);
  els.fileInfo.textContent = '';
  if (last) updateTrimInfo();
}

// ---------- queue ----------

function enqueueTrack(trackId) {
  const t = tracks.get(trackId);
  if (!t) return;
  const snap = snapshot();
  if (snap.trim.end <= 0 || snap.trim.end > t.dur) snap.trim.end = t.dur;
  if (snap.trim.start >= snap.trim.end) snap.trim.start = 0;
  queue.push({
    qid: 'q' + queueSeq++, trackId, snap,
    status: 'queued', frames: 0, encode: 0, jobId: null,
    info: null, error: null,
  });
  renderQueue();
}

function renderQueue() {
  const pending = queue.filter((q) => q.status === 'queued').length;
  const busy = queue.filter((q) => q.status === 'rendering' || q.status === 'encoding').length;
  const done = queue.filter((q) => q.status === 'done').length;
  const failed = queue.filter((q) => q.status === 'error').length;
  els.queueHint.textContent = queue.length ? `${done} done · ${pending} waiting · ${busy} active${failed ? ` · ${failed} failed` : ''}` : '';
  els.runQueueBtn.disabled = pending === 0 || !!queueRunner;
  els.clearDoneBtn.disabled = !queue.some((q) => q.status === 'done' || q.status === 'error');
  els.queueList.innerHTML = '';
  for (const q of queue) {
    const t = tracks.get(q.trackId);
    const div = document.createElement('div');
    div.className = `item s-${q.status}`;
    const snap = q.snap;
    const [W, H] = exportSizeFor(snap);
    let statusText = '';
    if (q.status === 'queued') statusText = 'waiting';
    else if (q.status === 'rendering') statusText = `rendering ${q.frames}%`;
    else if (q.status === 'encoding') statusText = `ffmpeg ${q.encode}%`;
    else if (q.status === 'done') statusText = '✓ done' + (q.info?.savedPath ? ' (auto-saved)' : '');
    else if (q.status === 'error') statusText = `✗ ${q.error || 'failed'}`;
    div.innerHTML =
      `<div class="title"><span class="name" title="${t ? t.name : '?'}">${t ? t.name : '?'}</span>` +
      `<span class="pill">${snap.type} · ${FMT_LABEL[snap.format] || snap.format} · ${W}×${H}</span></div>` +
      `<div class="barwrap"><div style="width:${q.status === 'rendering' ? q.frames : q.status === 'encoding' || q.status === 'done' ? 100 : q.frames}%"></div></div>` +
      `<div class="status ${q.status === 'done' ? 'ok' : q.status === 'error' ? 'err' : ''}">${statusText}</div>` +
      `<div class="btns"></div>`;
    const btns = div.querySelector('.btns');
    const mk = (label, fn, cls = 'ghost', dis = false) => {
      const b = document.createElement('button');
      b.className = cls; b.textContent = label; b.disabled = dis;
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };
    if (q.status === 'done') {
      mk('▶ Preview', () => openPreviewForJob(q, q.info), 'primary');
      mk('⬇', () => { if (q.info?.url) location.href = q.info.url; });
      mk('↻ Redo', () => { q.status = 'queued'; q.frames = 0; q.encode = 0; q.error = null; renderQueue(); runQueue(); });
    } else if (q.status === 'error') {
      mk('↻ Retry', () => { q.status = 'queued'; q.error = null; renderQueue(); runQueue(); });
      mk('✕', () => { queue.splice(queue.indexOf(q), 1); renderQueue(); });
    } else if (q.status === 'queued') {
      mk('✕', () => { queue.splice(queue.indexOf(q), 1); renderQueue(); });
    }
    els.queueList.appendChild(div);
  }
}

async function runQueue() {
  if (queueRunner) return;
  const pending = queue.filter((q) => q.status === 'queued');
  if (!pending.length) return;
  els.runQueueBtn.disabled = true;
  let firstError = null;
  queueRunner = (async () => {
    const encoding = []; // background pollers (overlap next item's rendering)
    for (const q of pending) {
      const t = tracks.get(q.trackId);
      if (!t) { q.status = 'error'; q.error = 'track removed from library'; continue; }
      q.status = 'rendering';
      renderQueue();
      try {
        const prog = {
          frames: (p) => { q.frames = p; if (p % 10 < 3) renderQueue(); },
          encode: (p) => { q.encode = p; },
          status: () => {},
        };
        const { jobId } = await renderTrackFrames(q.snap, t, prog);
        q.jobId = jobId;
        q.status = 'encoding';
        renderQueue();
        encoding.push(
          pollJob(jobId, { frames: () => {}, encode: (p) => { q.encode = p; }, status: () => {} })
            .then((s) => { q.info = s; q.status = 'done'; })
            .catch((e) => { q.error = e.message; q.status = 'error'; firstError = firstError || e.message; })
            .finally(() => renderQueue()),
        );
      } catch (e) {
        q.status = 'error';
        q.error = e.message;
        firstError = firstError || e.message;
        renderQueue();
      }
    }
    await Promise.all(encoding);
    queueRunner = null;
    renderQueue();
    return firstError;
  })();
  const err = await queueRunner;
  return err;
}

function clearDone() {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].status === 'done' || queue[i].status === 'error') queue.splice(i, 1);
  }
  renderQueue();
}

// ---------- preview modal ----------

let previewQueueItem = null;

function openPreviewForJob(q, info) {
  if (!info) return;
  previewQueueItem = q || null;
  els.previewTitle.textContent = q ? `Preview — ${tracks.get(q.trackId)?.name || ''}` : 'Render preview';
  els.previewVideo.src = info.previewUrl || '';
  els.previewVideo.hidden = !info.previewUrl;
  els.previewDownload.href = info.url || '#';
  const bits = [];
  if (info.fileName) bits.push(info.fileName);
  if (info.savedPath) bits.push(`saved: ${info.savedPath}`);
  if (info.saveError) bits.push(`auto-save warning: ${info.saveError}`);
  if (!info.previewUrl) bits.push('(proxy preview unavailable)');
  els.previewMeta.textContent = bits.join(' · ');
  els.previewRedo.hidden = !q;
  els.previewModal.hidden = false;
  if (info.previewUrl) els.previewVideo.play().catch(() => {});
}

function closePreview() {
  els.previewModal.hidden = true;
  els.previewVideo.pause();
  els.previewVideo.removeAttribute('src');
  els.previewVideo.load();
  previewQueueItem = null;
}

els.previewClose.addEventListener('click', closePreview);
els.previewModal.addEventListener('click', (e) => { if (e.target === els.previewModal) closePreview(); });
els.previewRedo.addEventListener('click', () => {
  const q = previewQueueItem;
  closePreview();
  if (q) { q.status = 'queued'; q.frames = 0; q.encode = 0; q.error = null; renderQueue(); runQueue(); }
});

// ---------- save settings ----------

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const body = await r.json();
    if (body.ok) {
      els.saveDir.value = body.settings.saveDir || '';
      els.saveTemplate.value = body.settings.nameTemplate || '{name}-{w}x{h}';
    }
  } catch { /* first run: defaults stay */ }
}

els.saveSettingsBtn.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveDir: els.saveDir.value.trim(), nameTemplate: els.saveTemplate.value.trim() }),
    });
    const body = await r.json();
    els.saveStatus.textContent = body.ok ? 'saved ✓' : body.error || 'failed';
    els.saveStatus.style.color = body.ok ? 'var(--ok)' : 'var(--err)';
  } catch (e) {
    els.saveStatus.textContent = e.message;
    els.saveStatus.style.color = 'var(--err)';
  }
});

// ---------- wiring ----------

for (const [v, label] of TYPES) {
  const o = document.createElement('option');
  o.value = v; o.textContent = label;
  els.type.appendChild(o);
}
els.type.value = 'bar';

function refreshStyleHint() {
  els.styleHint.textContent = HINTS[els.type.value] || '';
}

function bindRange(id, fmtFn) {
  const el = els[id];
  const out = document.querySelector(`output[for="${id}"]`);
  const upd = () => { if (out) out.textContent = fmtFn ? fmtFn(el.value) : el.value; if (!state.playing) renderStatic(); };
  el.addEventListener('input', upd);
  upd();
}
bindRange('barWidth'); bindRange('gap'); bindRange('lineWidth');
bindRange('sensitivity', (v) => `${(+v).toFixed(1)}×`);
bindRange('smoothing'); bindRange('crf');

els.type.addEventListener('change', () => {
  refreshStyleHint();
  if (state.renderer) { state.renderer = null; ensureChain(); }
  if (!state.playing) renderStatic();
});
for (const id of ['color', 'color2', 'gradient', 'glow', 'fft', 'prevg'])
  els[id].addEventListener('input', () => {
    if (!state.playing) renderStatic();
  });
for (const id of ['ratio', 'cWidth', 'cHeight'])
  els[id].addEventListener('input', () => {
    els.customRow.hidden = els.ratio.value !== 'custom';
    fitPreview();
  });
els.format.addEventListener('change', updateFormatUI);
els.prevg.addEventListener('change', () => {
  els.stage.className = els.prevg.value;
});
els.stage.className = 'transparent';

els.file.addEventListener('change', async () => {
  await addFiles(els.file.files);
  els.file.value = '';
});
window.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag'); });
window.addEventListener('dragleave', () => els.dropZone.classList.remove('drag'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('drag');
  await addFiles(e.dataTransfer?.files || []);
});

els.playBtn.addEventListener('click', () => (state.playing ? stopPlay() : play()));
els.stopBtn.addEventListener('click', () => { stopPlay(); state.offset = 0; renderStatic(); });
els.seek.addEventListener('input', () => {
  if (state.playing) stopPlay();
  state.offset = +els.seek.value / 100;
  if (state.previewChain) state.previewChain.reset();
  state.lastPreviewT = -1;
  els.time.textContent = `${fmtTime(state.offset)} / ${fmtTime(state.duration)}`;
  renderStatic();
});
els.exportBtn.addEventListener('click', startExport);
els.runQueueBtn.addEventListener('click', () => runQueue());
els.clearDoneBtn.addEventListener('click', clearDone);

els.trimMarkStart.addEventListener('click', () => {
  els.trimStart.value = String(Math.round(state.offset * 10) / 10);
  updateTrimInfo();
});
els.trimMarkEnd.addEventListener('click', () => {
  els.trimEnd.value = String(Math.round(state.offset * 10) / 10);
  updateTrimInfo();
});
els.trimFull.addEventListener('click', () => {
  els.trimStart.value = '0';
  els.trimEnd.value = String(Math.round(state.duration * 10) / 10);
  updateTrimInfo();
});
els.trimClear.addEventListener('click', () => {
  els.trimStart.value = '0';
  els.fadeIn.value = '0';
  els.fadeOut.value = '0';
  updateTrimInfo();
});
els.trimStart.addEventListener('input', updateTrimInfo);
els.trimEnd.addEventListener('input', updateTrimInfo);
els.fps.addEventListener('change', updateTrimInfo);

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea, button, a')) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stopPlay() : play(); }
  if (e.key.toLowerCase() === 's') stopPlay();
  if (e.key === 'Escape' && !els.previewModal.hidden) closePreview();
});

new ResizeObserver(fitPreview).observe(els.stage);
updateFormatUI();
detectCodecCaps();
refreshStyleHint();
renderQueue();
loadSettings();

// testable hook (used by the headless-Chrome e2e; harmless in normal use)
window.av = {
  state, tracks, queue,
  fitPreview, stopPlay, play, startExport, runQueue, renderQueue,
  snapshot, exportSizeFor, humanDuration,
  loadUrl: async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'sample.wav';
    const blob = await r.blob();
    const t = await addToLibrary(new File([blob], name, { type: blob.type }));
    if (t) loadTrack(t.id);
    return t ? t.id : null;
  },
  enqueueTrack,
  ready: () => !!state.pcm,
  queueStatuses: () => queue.map((q) => ({ qid: q.qid, status: q.status, jobId: q.jobId, error: q.error })),
};

if (new URLSearchParams(location.search).has('sample')) {
  window.av.loadUrl('/test/sample.wav').catch((e) => console.warn('sample load failed:', e.message));
}
