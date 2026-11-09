// 12 visualizer styles, drawn with plain Canvas2D.
// Every renderer is *deterministic*: given the same frame sequence it draws
// the same pictures, so preview == export. No wall-clock calls, no
// Math.random() (seeded PRNG only), all motion driven by frame time/dt.

export const TYPES = [
  ['bar', 'Bar'],
  ['wave', 'Wave'],
  ['line', 'Line'],
  ['radial', 'Radial Bars'],
  ['mirror', 'Mirror Bars'],
  ['mountain', 'Mountain'],
  ['blob', 'Blob'],
  ['siri', 'Siri'],
  ['hex', 'Hexagon Grid'],
  ['vinyl', 'Vinyl Record'],
  ['vortex', 'Particle Vortex'],
  ['dots', 'Dot to Dot'],
  ['neon', 'Neon Bars + Reflection'],
  ['ringspec', 'Radial Spectrum Ring'],
  ['sparks', 'Particle Fountain'],
  ['aurora', 'Aurora Ribbons'],
  ['minibar', 'Minimal Line'],
  ['pulse', 'Bass Ripple'],
];

export const HINTS = {
  blob: 'Blob looks best with maximum FFT size (4096) for smoothness.',
  bar: 'Bar width and gap control how many bars fit across the frame.',
  siri: 'Siri reacts mostly to overall level; raise sensitivity for more swing.',
  vortex: 'Particle Vortex speed follows the spectrum; smoothing 0.85+ looks calmest.',
  neon: 'Neon Bars shows a mirrored floor reflection; works great on transparent exports.',
  ringspec: 'Radial Spectrum Ring wraps the bands around the circle; slow rotation keeps it steady.',
  sparks: 'Particle Fountain emits more sparks the harder the bass hits.',
  aurora: 'Aurora Ribbons is the calmer organic style; pair with smoothing 0.8+.',
  minibar: 'Minimal Line stays subtle; good when text overlays sit on top of the video.',
  pulse: 'Bass Ripple sends a ring out on every bass hit; raise sensitivity for denser ripples.',
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// Periodic mirror index into the band array (avoids seams when styles
// scroll/sweep bands along the x axis or around a circle).
function mirrorIdx(len, x) {
  const period = 2 * (len - 1);
  let p = x % period;
  if (p < 0) p += period;
  return p < len ? p | 0 : (period - p) | 0;
}

function styleFor(ctx, W, H, P, alpha = 1) {
  ctx.globalAlpha = alpha;
  if (P.gradient && P.color2 && P.color2 !== P.color) {
    const g = ctx.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0, P.color);
    g.addColorStop(1, P.color2);
    return g;
  }
  return P.color;
}

function setGlow(ctx, W, P, on) {
  if (on && P.glow) {
    ctx.shadowColor = P.color;
    ctx.shadowBlur = Math.max(6, W * 0.012);
  } else {
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
}

export function makeRenderer(type, P) {
  const st = {};

  function reset() {
    st.scroll = [0, 0.33, 0.66];
    st.prev = null;
    st.parts = null;
    const rnd = mulberry32(1337);
    st.vinylDust = Array.from({ length: 90 }, () => ({
      a: rnd() * Math.PI * 2, r: 0.32 + rnd() * 0.6, al: 0.06 + rnd() * 0.16,
    }));
    st.vortex = Array.from({ length: 180 }, (_, i) => ({
      a: rnd() * Math.PI * 2, r0: 0.18 + rnd() * 0.82, tw: rnd(), ph: rnd() * 6.283,
      px: null, py: null,
    }));
  }
  reset();

  function bars(ctx, W, H, f, alpha = 1) {
    const n = Math.max(6, Math.floor(W / (P.barWidth + P.gap)));
    const bw = P.barWidth;
    const total = n * bw + (n - 1) * P.gap;
    const x0 = (W - total) / 2;
    const maxH = H * 0.82;
    ctx.fillStyle = styleFor(ctx, W, H, P, alpha);
    for (let i = 0; i < n; i++) {
      const b = f.bands[Math.floor((i / (n - 1)) * 0.85 * (f.bands.length - 1))];
      const h = Math.max(2, b * maxH);
      const x = x0 + i * (bw + P.gap);
      const y = H * 0.9 - h;
      const r = Math.min(bw / 2, 3);
      ctx.beginPath();
      ctx.roundRect(x, y, bw, h, [r, r, 0, 0]);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return n;
  }

  const styles = {
    bar(ctx, W, H, f) {
      setGlow(ctx, W, P, true);
      bars(ctx, W, H, f);
      setGlow(ctx, W, P, false);
    },

    wave(ctx, W, H, f) {
      const n = Math.max(32, Math.floor(W / 6));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const v = f.bands[mirrorIdx(f.bands.length, (i / n) * 0.8 * f.bands.length)];
        pts.push([i / n * W, H * 0.88 - Math.max(1.5, v * H * 0.62)]);
      }
      const path = new Path2D();
      path.moveTo(0, H);
      path.lineTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = pts[i - 1], [cx0, cy0] = pts[i];
        path.quadraticCurveTo(px, py, (px + cx0) / 2, (py + cy0) / 2);
      }
      path.lineTo(W, pts[pts.length - 1][1]);
      path.lineTo(W, H);
      path.closePath();
      ctx.fillStyle = styleFor(ctx, W, H, P, 0.92);
      setGlow(ctx, W, P, true);
      ctx.fill(path);
      setGlow(ctx, W, P, false);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = pts[i - 1], [cx0, cy0] = pts[i];
        ctx.quadraticCurveTo(px, py, (px + cx0) / 2, (py + cy0) / 2);
      }
      ctx.strokeStyle = P.color2 || '#ffffff';
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(1, W * 0.0015);
      ctx.stroke();
      ctx.globalAlpha = 1;
    },

    line(ctx, W, H, f) {
      const w = f.wave, n = w.length;
      const amp = H * 0.38;
      ctx.strokeStyle = styleFor(ctx, W, H, P);
      ctx.lineWidth = Math.max(1, P.lineWidth * 1.6 + 1);
      ctx.lineJoin = 'round';
      setGlow(ctx, W, P, true);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H / 2 + w[i] * amp;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      setGlow(ctx, W, P, false);
    },

    radial(ctx, W, H, f) {
      const cx = W / 2, cy = H / 2;
      const m = Math.min(W, H);
      const n = 72;
      const r0 = m * 0.17;
      const len = m * 0.30;
      const rot = f.time * 0.35;
      const bl = f.bands.length;
      ctx.strokeStyle = styleFor(ctx, W, H, P);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, P.barWidth * 0.7);
      setGlow(ctx, W, P, true);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const j = i < n / 2 ? i : n - 1 - i;         // mirrored symmetry
        const v = f.bands[Math.floor((j / (n / 2 - 1)) * 0.6 * (bl - 1))];
        const a = (i / n) * Math.PI * 2 + rot;
        const r1 = r0 + 3, r2 = r0 + Math.max(2, v * len);
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      }
      ctx.stroke();
      setGlow(ctx, W, P, false);
      ctx.strokeStyle = P.color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r0 - 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    },

    mirror(ctx, W, H, f) {
      const n = Math.max(6, Math.floor(W / (P.barWidth + P.gap)));
      const bw = P.barWidth;
      const total = n * bw + (n - 1) * P.gap;
      const x0 = (W - total) / 2;
      const maxH = H * 0.40;
      const midY = H / 2;
      setGlow(ctx, W, P, true);
      ctx.fillStyle = styleFor(ctx, W, H, P);
      for (let i = 0; i < n; i++) {
        const b = f.bands[Math.floor((i / (n - 1)) * 0.85 * (f.bands.length - 1))];
        const h = Math.max(2, b * maxH);
        const x = x0 + i * (bw + P.gap);
        ctx.beginPath();
        ctx.roundRect(x, midY - h, bw, h, [2, 2, 0, 0]);
        ctx.fill();
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.roundRect(x, midY, bw, h, [0, 0, 2, 2]);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      setGlow(ctx, W, P, false);
    },

    mountain(ctx, W, H, f) {
      const bl = f.bands.length;
      const layers = 3;
      for (let L = layers - 1; L >= 0; L--) {
        st.scroll[L] += f.dt * (0.05 + 0.03 * L) * (1 + f.level * 1.6) * bl * 0.4;
        ctx.beginPath();
        ctx.moveTo(0, H);
        const stepPx = Math.max(3, W / 240);
        for (let x = 0; x <= W; x += stepPx) {
          const u = x / W;
          const v = f.bands[mirrorIdx(bl, u * 0.9 * bl + st.scroll[L])];
          const y = H * (0.60 + 0.13 * L) - v * H * (0.34 - 0.07 * L) - H * 0.01;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = styleFor(ctx, W, H, P, [0.95, 0.5, 0.28][L]);
        if (L === 0) setGlow(ctx, W, P, true);
        ctx.fill();
        setGlow(ctx, W, P, false);
      }
    },

    blob(ctx, W, H, f) {
      const cx = W / 2, cy = H / 2;
      const m = Math.min(W, H);
      const bl = f.bands.length;
      const r0 = m * 0.15 * (1 + f.bass * 0.55);
      const steps = 180;
      const half = steps / 2;
      const pt = (j) => {
        const jw = j < half ? j : steps - j;
        const v = f.bands[Math.floor((jw / half) * 0.5 * (bl - 1))];
        const r = r0 * (1 + 0.6 * v);
        const a = (j / steps) * Math.PI * 2 - Math.PI / 2 + f.time * 0.25;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      };
      ctx.beginPath();
      let p = pt(0);
      ctx.moveTo(p[0], p[1]);
      for (let j = 1; j <= steps; j++) {
        const q = pt(j);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.closePath();
      ctx.fillStyle = styleFor(ctx, W, H, P, 0.85);
      setGlow(ctx, W, P, true);
      ctx.fill();
      setGlow(ctx, W, P, false);
      ctx.strokeStyle = P.color2 || P.color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = Math.max(1, m * 0.004);
      ctx.stroke();
      ctx.globalAlpha = 1;
    },

    siri(ctx, W, H, f) {
      const lines = 5;
      const cx = W / 2, cy = H / 2;
      const halfW = W * 0.40;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let l = 0; l < lines; l++) {
        const d = Math.abs(l - 2) / 2;                 // 0 center .. 1 outer
        const lw = (1.15 - d * 0.75) * (P.lineWidth * 1.4 + 2);
        const A = H * (0.05 + f.level * 0.30) * (1 - d * 0.45) + H * 0.015 * f.high;
        const phase = f.time * (2.1 + d) + l * 1.1;
        const freq = 2.4 + f.mid * 2.5 + d * 0.8;
        ctx.beginPath();
        for (let i = 0; i <= 96; i++) {
          const u = i / 96;                            // 0..1 across half width
          const env = Math.pow(Math.sin(Math.PI * u), 1.3 + f.high * 2.2);
          const y = cy + (l - 2) * H * 0.016 * (1 + f.bass) +
            Math.sin(u * Math.PI * freq * 2 + phase) * A * env;
          const x = cx - halfW + u * halfW * 2;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = styleFor(ctx, W, H, P, 0.45 + 0.5 * (1 - d));
        ctx.lineWidth = lw;
        setGlow(ctx, W, P, true);
        ctx.stroke();
        setGlow(ctx, W, P, false);
      }
      ctx.globalAlpha = 1;
    },

    hex(ctx, W, H, f) {
      const bl = f.bands.length;
      const s = Math.min(W, H) / 13;
      const dw = Math.sqrt(3) * s;
      const dh = 1.5 * s;
      const cols = Math.ceil(W / dw) + 2;
      const rows = Math.ceil(H / dh) + 2;
      const maxD = Math.hypot(W, H) / 2;
      for (let r = -1; r < rows; r++) {
        for (let c = -1; c < cols; c++) {
          const cx = c * dw + (r % 2 ? dw / 2 : 0);
          const cy = r * dh;
          const dist = Math.hypot(cx - W / 2, cy - H / 2);
          const v = f.bands[mirrorIdx(bl, (1 - clamp(dist / maxD, 0, 1)) * 0.7 * bl + dist * 0.01)];
          const sc = 0.16 + 0.78 * v;
          const rot = f.time * 0.2 + (c + r) * 0.15;
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k + rot;
            const px = cx + Math.cos(a) * s * sc;
            const py = cy + Math.sin(a) * s * sc;
            k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = styleFor(ctx, W, H, P, 0.12 + 0.8 * v);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },

    vinyl(ctx, W, H, f) {
      const cx = W / 2, cy = H / 2;
      const m = Math.min(W, H);
      const R = m * 0.34;
      const bl = f.bands.length;
      // disc outline + grooves
      ctx.strokeStyle = P.color;
      ctx.lineWidth = Math.max(1.5, m * 0.006);
      setGlow(ctx, W, P, true);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      setGlow(ctx, W, P, false);
      ctx.globalAlpha = 0.15;
      ctx.lineWidth = 1;
      for (const g of [0.55, 0.7, 0.85]) {
        ctx.beginPath(); ctx.arc(cx, cy, R * g, 0, Math.PI * 2); ctx.stroke();
      }
      // rotating dust speckles (spin illusion)
      const spin = f.time * 3.1;
      for (const d of st.vinylDust) {
        const a = d.a + spin;
        ctx.globalAlpha = d.al * (0.6 + 0.4 * f.high);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R * d.r, cy + Math.sin(a) * R * d.r, Math.max(0.8, m * 0.0018), 0, 6.283);
        ctx.fill();
      }
      // label
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = styleFor(ctx, W, H, P);
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.26 * (1 + f.bass * 0.25), 0, 6.283); ctx.fill();
      // spectrum bars around the rim (mirrored)
      const n = 84;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.5, m * 0.006);
      ctx.strokeStyle = styleFor(ctx, W, H, P, 1);
      setGlow(ctx, W, P, true);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const j = i < n / 2 ? i : n - 1 - i;
        const v = f.bands[Math.floor((j / (n / 2 - 1)) * 0.6 * (bl - 1))];
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const r1 = R * 1.06, r2 = R * 1.06 + Math.max(2, v * m * 0.11);
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      }
      ctx.stroke();
      setGlow(ctx, W, P, false);
      ctx.globalAlpha = 1;
    },

    vortex(ctx, W, H, f) {
      const cx = W / 2, cy = H / 2;
      const m = Math.min(W, H);
      const bl = f.bands.length;
      const parts = st.vortex;
      ctx.fillStyle = styleFor(ctx, W, H, P, 1);
      setGlow(ctx, W, P, true);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const v = f.bands[mirrorIdx(bl, (i / parts.length) * 0.8 * bl + f.time * 6)];
        p.a += f.dt * (0.35 + v * 3.2) * (p.tw > 0.5 ? 1 : -1);
        const rad = m * 0.42 * (0.16 + 0.84 * p.r0) * (1 + 0.10 * Math.sin(f.time * 1.7 + p.ph)) *
          (1 + 0.06 * v);
        const x = cx + Math.cos(p.a) * rad;
        const y = cy + Math.sin(p.a) * rad * (H / W > 1.2 ? 0.78 : 1); // squash orbit in portrait
        const sz = 1.2 + v * m * 0.012;
        if (p.px !== null) {
          ctx.globalAlpha = 0.16 + 0.25 * v;
          ctx.strokeStyle = P.color;
          ctx.lineWidth = sz * 0.55;
          ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(x, y); ctx.stroke();
        }
        ctx.globalAlpha = 0.55 + 0.45 * v;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, 6.283); ctx.fill();
        p.px = x; p.py = y;
      }
      setGlow(ctx, W, P, false);
      ctx.globalAlpha = 1;
    },

    dots(ctx, W, H, f) {
      const n = Math.max(12, Math.floor(W / 34));
      const bl = f.bands.length;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const v = f.bands[Math.floor(u * 0.85 * (bl - 1))];
        pts.push([u * W, H * 0.5 - Math.max(0.5, v) * H * 0.34, v]);
      }
      ctx.strokeStyle = styleFor(ctx, W, H, P, 0.55);
      ctx.lineWidth = Math.max(1, W * 0.002);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.fillStyle = styleFor(ctx, W, H, P, 1);
      setGlow(ctx, W, P, true);
      for (const [x, y, v] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, 2 + v * (W / 60 + 6), 0, 6.283);
        ctx.fill();
      }
      setGlow(ctx, W, P, false);
      ctx.globalAlpha = 1;
    },
  };

  // ============ new styles (v2) ============

  // Neon capsule bars with rounded caps + faded floor reflection
  styles.neon = function (ctx, W, H, f) {
    const bw = Math.max(3, P.barWidth * 1.6);
    const gap = Math.max(2, P.gap * 1.5);
    const n = Math.max(6, Math.floor(W / (bw + gap)));
    const total = n * bw + (n - 1) * gap;
    const x0 = (W - total) / 2;
    const maxH = H * 0.42;
    const baseY = H * 0.62;
    const grad = styleFor(ctx, W, H, P);
    const drawSet = () => {
      ctx.fillStyle = grad;
      for (let i = 0; i < n; i++) {
        const b = f.bands[Math.floor((i / (n - 1)) * 0.85 * (f.bands.length - 1))];
        const h = Math.max(3, b * maxH);
        const x = x0 + i * (bw + gap);
        const r = Math.min(bw / 2, 5);
        ctx.beginPath();
        ctx.roundRect(x, baseY - h, bw, h, [r, r, r, r]);
        ctx.fill();
      }
    };
    // reflection first (mirrored below the baseline), then fade it out
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.translate(0, baseY * 2 + 8);
    ctx.scale(1, -1);
    drawSet();
    ctx.restore();
    const fadeG = ctx.createLinearGradient(0, baseY + 8, 0, baseY + 8 + maxH * 0.8);
    fadeG.addColorStop(0, 'rgba(0,0,0,0)');
    fadeG.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = fadeG;
    ctx.fillRect(0, baseY + 8, W, maxH);
    ctx.restore();
    // baseline glow line + main bars
    setGlow(ctx, W, P, true);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = grad;
    ctx.fillRect(x0, baseY + 3, total, 2);
    ctx.globalAlpha = 1;
    drawSet();
    setGlow(ctx, W, P, false);
  };

  // radial spectrum ring: bars around a circle + bass pulse + scope ring
  styles.ringspec = function (ctx, W, H, f) {
    const cx = W / 2, cy = H / 2;
    const baseR = Math.min(W, H) * 0.22;
    const grad = styleFor(ctx, W, H, P);
    setGlow(ctx, W, P, true);
    // pulse ring (bass breathing)
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1.5, W * 0.004) * (1 + f.level * 1.5);
    ctx.beginPath();
    ctx.arc(cx, cy, baseR * (1 + 0.12 * f.level), 0, Math.PI * 2);
    ctx.stroke();
    // spectrum bars around the circle (mirrored bands = seamless wrap)
    const N = 128;
    const len = f.bands.length;
    const rot = f.time * 0.15;
    const maxLen = Math.min(W, H) * 0.18;
    const r0 = baseR * (1 + 0.1 * f.level);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const b = f.bands[mirrorIdx(len, (i / N) * 0.9 * len)];
      const a = (i / N) * Math.PI * 2 + rot;
      const r1 = r0 + Math.max(2, b * maxLen);
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    }
    ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * r0) / N * 0.5);
    ctx.lineCap = 'round';
    ctx.strokeStyle = grad;
    ctx.globalAlpha = 1;
    ctx.stroke();
    // inner oscilloscope ring (waveform)
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(1, P.lineWidth);
    ctx.beginPath();
    const wl = f.wave.length;
    for (let i = 0; i <= wl; i++) {
      const wv = f.wave[i % wl];
      const a = (i / wl) * Math.PI * 2 - rot * 2;
      const r = baseR * 0.62 + wv * baseR * 0.35;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
    setGlow(ctx, W, P, false);
  };

  // bass-driven particle fountain (deterministic: fixed dt in export)
  styles.sparks = function (ctx, W, H, f) {
    if (!st.sparks || f.index === 0) {
      st.sparks = { list: [], seed: mulberry32(2024), carry: 0 };
    }
    const S = st.sparks;
    const rate = 10 + f.bass * 90;
    const emit = Math.floor(rate * f.dt + S.carry);
    S.carry = rate * f.dt + S.carry - emit;
    for (let i = 0; i < emit; i++) {
      const a = -Math.PI / 2 + (S.seed() - 0.5) * 1.9;
      const v = (0.25 + S.seed() * 0.35) * H * (0.5 + f.bass);
      S.list.push({
        x: W * (0.25 + S.seed() * 0.5), y: H * 0.88,
        vx: Math.cos(a) * v * 0.55, vy: Math.sin(a) * v,
        life: 1, r: 1.5 + S.seed() * 3.5, hue: S.seed(),
      });
    }
    if (S.list.length > 900) S.list.splice(0, S.list.length - 900);
    const grad = styleFor(ctx, W, H, P);
    setGlow(ctx, W, P, true);
    ctx.fillStyle = grad;
    const g = 1.45 * H * f.dt;
    for (const p of S.list) {
      p.vy += g * (0.6 + p.hue * 0.8);
      p.x += p.vx * f.dt; p.y += p.vy * f.dt;
      p.life -= f.dt * (0.45 + p.hue * 0.3);
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.min(1, p.life) * 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.5 + p.life * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    S.list = S.list.filter((p) => p.life > 0 && p.y < H * 1.2);
    ctx.globalAlpha = 0.7;
    ctx.fillRect(W * 0.05, H * 0.88, W * 0.9, 1.5);
    ctx.globalAlpha = 1;
    setGlow(ctx, W, P, false);
  };

  // organic aurora ribbons (liquid feel, smooth low-frequency motion)
  styles.aurora = function (ctx, W, H, f) {
    const grad = styleFor(ctx, W, H, P);
    setGlow(ctx, W, P, true);
    const layers = 4;
    const steps = Math.max(48, Math.floor(W / 8));
    for (let L = 0; L < layers; L++) {
      const amp = H * 0.07 * (1 + f.bass * 1.2) * (1 - L * 0.18);
      const y0 = H * (0.38 + L * 0.11);
      const speed = 0.25 + L * 0.12;
      ctx.globalAlpha = 0.28 - L * 0.045;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * W;
        const b = f.bands[mirrorIdx(f.bands.length, (i / steps) * 0.7 * f.bands.length + L * 40)];
        const y = y0
          + Math.sin(f.time * speed + i * 0.11 + L * 2.1) * amp
          + Math.sin(f.time * speed * 0.6 - i * 0.043 + L) * amp * 0.8
          + b * H * 0.08;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let i = steps; i >= 0; i--) {
        const x = (i / steps) * W;
        const b = f.bands[mirrorIdx(f.bands.length, (i / steps) * 0.7 * f.bands.length + L * 40)];
        const y = y0 + H * 0.13
          + Math.sin(f.time * speed + i * 0.11 + L * 2.1) * amp * 0.7
          + Math.sin(f.time * speed * 0.6 - i * 0.043 + L) * amp * 0.5
          - b * H * 0.03;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    setGlow(ctx, W, P, false);
  };

  // minimal thin-line spectrum with soft mirror (tasteful, subtle)
  styles.minibar = function (ctx, W, H, f) {
    const len = f.bands.length;
    const n = Math.min(len, Math.max(48, Math.floor(W / 4)));
    const baseY = H * 0.62;
    const maxH = H * 0.3;
    setGlow(ctx, W, P, true);
    ctx.lineCap = 'round';
    ctx.strokeStyle = styleFor(ctx, W, H, P);
    ctx.lineWidth = Math.max(1, Math.min(3, P.lineWidth * 0.6));
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W * 0.9 + W * 0.05;
      const b = f.bands[Math.floor((i / (n - 1)) * 0.85 * (len - 1))];
      const y = baseY - Math.max(1, b * maxH);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W * 0.9 + W * 0.05;
      const b = f.bands[Math.floor((i / (n - 1)) * 0.85 * (len - 1))];
      const y = baseY + Math.max(1, b * maxH) * 0.5;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W * 0.05, baseY);
    ctx.lineTo(W * 0.95, baseY);
    ctx.stroke();
    ctx.globalAlpha = 1;
    setGlow(ctx, W, P, false);
  };

  // expanding ripple rings triggered by bass onsets
  styles.pulse = function (ctx, W, H, f) {
    if (!st.pulse || f.index === 0) {
      st.pulse = { rings: [], prevBass: 0, cooldown: 0 };
    }
    const S = st.pulse;
    S.cooldown -= f.dt;
    const onset = f.bass - S.prevBass;
    if (onset > 0.06 && S.cooldown <= 0) {
      S.rings.push({ r: Math.min(W, H) * 0.03, life: 1, power: Math.min(1, onset * 4) });
      S.cooldown = 0.12;
    }
    S.prevBass = S.prevBass * 0.8 + f.bass * 0.2;
    const cx = W / 2, cy = H * 0.52;
    const grad = styleFor(ctx, W, H, P);
    setGlow(ctx, W, P, true);
    ctx.strokeStyle = grad;
    for (const rg of S.rings) {
      rg.r += (Math.min(W, H) * 0.35 + rg.power * Math.min(W, H) * 0.5) * f.dt;
      rg.life -= f.dt * 0.5;
      if (rg.life <= 0) continue;
      ctx.globalAlpha = rg.life * 0.7;
      ctx.lineWidth = Math.max(1, (1 - rg.life) * 2 + P.lineWidth * rg.life * 0.8);
      ctx.beginPath();
      ctx.arc(cx, cy, rg.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    S.rings = S.rings.filter((r) => r.life > 0 && r.r < Math.max(W, H) * 1.1);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(W, H) * (0.015 + 0.03 * f.level), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    setGlow(ctx, W, P, false);
  };

  return {
    reset,
    draw(ctx, W, H, f) {
      (styles[type] || styles.bar)(ctx, W, H, f);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    },
  };
}
