// Spectrum analysis shared by preview and export.
// Mirrors the behaviour of a Web-Audio AnalyserNode (dB mapping with
// minDecibels=-100/maxDecibels=-30 semantics + smoothingTimeConstant)
// but runs offline over a pre-decoded PCM buffer, so export frames are
// deterministic and not subject to real-time capture hiccups.

import { FFT } from './fft.js';

export const BAND_COUNT = 256;

export function makeHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// Log-spaced band edges (linear bin ranges per band) so low frequencies get
// the detail they deserve — a plain linear FFT bin look is top-heavy/empty.
export function makeBandLayout(sampleRate, fftSize, bandCount, fMin = 32, fMax = 16000) {
  const n = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const nyq = Math.min(fMax, sampleRate / 2 - binHz);
  const lo = Math.min(fMin, sampleRate / 2 - binHz);
  const edges = new Int32Array(bandCount * 2);
  for (let b = 0; b < bandCount; b++) {
    const f0 = lo * Math.pow(nyq / lo, b / bandCount);
    const f1 = lo * Math.pow(nyq / lo, (b + 1) / bandCount);
    let i0 = Math.max(1, Math.floor(f0 / binHz));
    let i1 = Math.min(n - 1, Math.max(i0 + 1, Math.ceil(f1 / binHz)));
    edges[b * 2] = i0;
    edges[b * 2 + 1] = i1;
  }
  return edges;
}

export class SpectrumAnalyzer {
  // attack: how much of the *instantaneous* value is kept each frame in
  // addition to the AnalyserNode-style smoothing blend. AnalyserNode is a
  // pure low-pass (slow attack); a touch of max-hold makes bars snap like
  // people expect from "sensitivity". Both paths share this exact code.
  constructor(sampleRate, fftSize, { bands = BAND_COUNT, smoothing = 0.8, attack = 0.65 } = {}) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.bands = bands;
    this.fft = new FFT(fftSize);
    this.window = makeHann(fftSize);
    this.edges = makeBandLayout(sampleRate, fftSize, bands);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.prev = new Float32Array(bands);
    this.out = new Float32Array(bands);
    this.smoothing = smoothing;
    this.attack = attack;
  }

  setFftSize(fftSize) {
    if (fftSize === this.fftSize) return;
    this.fftSize = fftSize;
    this.fft = new FFT(fftSize);
    this.window = makeHann(fftSize);
    this.edges = makeBandLayout(this.sampleRate, fftSize, this.bands);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
  }

  reset() { this.prev.fill(0); }

  // pcm: Float32Array (mono). startIdx: first sample of the analysis window.
  // Returns this.out (0..1 per band), valid until next call.
  process(pcm, startIdx, sensitivity = 1) {
    const { fftSize, re, im, window, edges, prev, out, bands } = this;
    const len = pcm.length;

    for (let k = 0; k < fftSize; k++) {
      const idx = startIdx + k;
      re[k] = (idx >= 0 && idx < len) ? pcm[idx] * window[k] : 0;
      im[k] = 0;
    }
    this.fft.transform(re, im);

    const norm = 2 / fftSize;
    const s = this.smoothing;
    const atk = this.attack;
    for (let b = 0; b < bands; b++) {
      const i0 = edges[b * 2];
      const i1 = edges[b * 2 + 1];
      let m = 0;
      for (let i = i0; i < i1; i++) {
        const ar = re[i], ai = im[i];
        const mag = Math.sqrt(ar * ar + ai * ai);
        if (mag > m) m = mag;
      }
      const amp = m * norm;
      const db = 20 * Math.log10(amp + 1e-7);
      let v = (db + 100) / 70; // AnalyserNode min/max dB mapping
      if (v < 0) v = 0; else if (v > 1) v = 1;
      v = v * sensitivity;
      if (v > 1) v = 1;
      const p = prev[b];
      const blended = p * s + v * (1 - s);      // AnalyserNode-style low-pass
      const keep = Math.max(blended, v, p * atk); // instant attack + short peak-hold
      prev[b] = keep;
      out[b] = keep;
    }
    return out;
  }

  stats() {
    const out = this.out, bands = this.bands;
    let bass = 0, mid = 0, high = 0;
    const bEnd = Math.max(4, Math.floor(bands * 0.05));
    const mEnd = Math.floor(bands * 0.4);
    for (let i = 0; i < bEnd; i++) bass += out[i];
    for (let i = bEnd; i < mEnd; i++) mid += out[i];
    for (let i = mEnd; i < bands; i++) high += out[i];
    bass /= bEnd; mid /= (mEnd - bEnd); high /= (bands - mEnd);
    return { bass, mid, high, level: Math.min(1, bass * 1.2) };
  }
}

// Time-domain waveform slice (for Line / Dot styles): centered window,
// decimated to out.length points, values in -1..1.
export function getWave(pcm, centerIdx, win, out) {
  const n = out.length;
  const half = win / 2;
  const step = win / n;
  for (let j = 0; j < n; j++) {
    const a = Math.floor(centerIdx - half + j * step);
    const b = Math.floor(centerIdx - half + (j + 1) * step);
    let sum = 0, cnt = 0, peak = 0;
    for (let i = a; i < b; i++) {
      if (i >= 0 && i < pcm.length) {
        const s = pcm[i];
        sum += s; cnt++;
        if (Math.abs(s) > Math.abs(peak)) peak = s;
      }
    }
    const avg = cnt ? sum / cnt : 0;
    out[j] = 0.6 * avg + 0.4 * peak; // blend mean+peak so quiet detail still shows
  }
  return out;
}
