// Iterative radix-2 Cooley-Tukey FFT (in-place). Zero dependencies.
// Shared by the browser preview and the offline export path so both produce
// byte-identical spectra (WYSIWYG exports).

export class FFT {
  constructor(n) {
    if (n < 2 || n & (n - 1)) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;

    // Bit-reversal table
    const bits = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }

    // Precomputed twiddle factors: cos/sin(-2*pi*k/n) for k < n/2
    const half = n >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const ang = (-2 * Math.PI * k) / n;
      this.cos[k] = Math.cos(ang);
      this.sin[k] = Math.sin(ang);
    }
  }

  // re, im: Float32Array of length n, transformed in place.
  transform(re, im) {
    const { n, rev, cos, sin } = this;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wIdx = k * step;
          const wr = cos[wIdx];
          const wi = sin[wIdx];
          const a = i + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
