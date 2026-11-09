// Unit tests for the shared DSP (run: node test/spectrum.test.mjs)
import { SpectrumAnalyzer, getWave, makeBandLayout } from '../public/lib/spectrum.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const SR = 44100;

// --- FFT amplitude accuracy: 1 kHz sine, exactly one window bin wide ---
{
  const N = 1024;
  const pcm = new Float32Array(SR * 2);
  // quiet on purpose (≈-54 dB): keeps the meter mid-range so the peak band
  // is measurable instead of clamped-equal across neighbours
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.002 * Math.sin(2 * Math.PI * 1000 * i / SR);
  const an = new SpectrumAnalyzer(SR, N, { smoothing: 0 });
  const v = an.process(pcm, 8192, 1);
  let max = 0, maxB = -1;
  for (let b = 0; b < an.bands; b++) if (v[b] > max) { max = v[b]; maxB = b; }
  // expected band from the exact log law: floor(log(1000/32)/log(16000/32)*256) = 141
  check('1 kHz sine peaks in the expected log band (±2)', Math.abs(maxB - 141) <= 2,
    `band=${maxB} value=${max.toFixed(2)}`);
  check('meter responds to quiet tone mid-range', max > 0.3 && max < 1, `value=${max.toFixed(2)}`);
}

// --- silence produces zeros ---
{
  const pcm = new Float32Array(SR);
  const an = new SpectrumAnalyzer(SR, 1024, { smoothing: 0 });
  const v = an.process(pcm, 0, 1);
  let max = 0; for (const x of v) max = Math.max(max, x);
  check('silence -> ~0', max < 0.02, `max=${max.toFixed(3)}`);
}

// --- instant attack: onset hits near full value on the very first frame ---
{
  const pcm = new Float32Array(SR);
  for (let i = SR / 4; i < SR / 4 + 2000; i++) pcm[i] = 0.9 * Math.sin(2 * Math.PI * 100 * i / SR);
  const an = new SpectrumAnalyzer(SR, 512, { smoothing: 0.8 });
  const v = an.process(pcm, SR / 4, 1);
  let max = 0; for (const x of v) max = Math.max(max, x);
  check('attack: first frame of a onset is already loud', max > 0.6, `max=${max.toFixed(2)}`);
}

// --- decay is slower than attack (smoothing works) ---
{
  const pcm = new Float32Array(SR);
  for (let i = 0; i < 2048; i++) pcm[i] = 0.9 * Math.sin(2 * Math.PI * 100 * i / SR);
  const an = new SpectrumAnalyzer(SR, 512, { smoothing: 0.9 });
  an.process(pcm, 0, 1);
  const v2 = an.process(pcm, 4096, 1); // window past the tone
  let max = 0; for (const x of v2) max = Math.max(max, x);
  check('decay: after tone ends, energy decays (not instant 0)', max > 0 && max < 0.9, `max=${max.toFixed(2)}`);
}

// --- band layout is log-spaced and monotonic ---
{
  const e = makeBandLayout(SR, 1024, 256);
  let mono = true;
  for (let b = 1; b < 256; b++) if (e[b * 2] < e[(b - 1) * 2]) mono = false;
  check('band edges monotonic', mono, `first band bins ${e[0]}..${e[1]}, last ${e[510]}..${e[511]}`);
}

// --- waveform extraction sees a tone ---
{
  const pcm = new Float32Array(SR);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 220 * i / SR);
  const out = new Float32Array(64);
  getWave(pcm, 4410, 1024, out);
  let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x));
  check('getWave sees tone energy', peak > 0.5, `peak=${peak.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall tests passed');
process.exit(failures ? 1 : 0);
