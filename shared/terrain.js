/*
 * Deterministic destructible terrain, shared by server and client.
 *
 * The terrain is a bitmap (Uint8Array, 1 = solid rock, 0 = empty air). Both the
 * server and every client generate the *identical* bitmap from a single integer
 * seed, so we only ever send the seed over the wire at match start. After that,
 * explosions are broadcast as small "crater" events that both sides apply, which
 * keeps collision (server) and rendering (client) perfectly in sync.
 */
(function (global) {
  'use strict';

  // Small, fast, seedable PRNG (mulberry32). Deterministic across Node/browser.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 1D midpoint displacement to make natural rolling hills.
  function buildHeightmap(width, height, rand) {
    // Work on a power-of-two-plus-one buffer then sample down to `width`.
    let size = 2;
    while (size + 1 < width) size *= 2;
    size += 1;

    const h = new Float32Array(size);
    const top = height * 0.18; // highest peaks
    const bottom = height * 0.72; // lowest valleys
    h[0] = bottom - rand() * (bottom - top);
    h[size - 1] = bottom - rand() * (bottom - top);

    let step = size - 1;
    let displace = (bottom - top) * 0.65;
    while (step > 1) {
      const half = step / 2;
      for (let i = half; i < size; i += step) {
        const avg = (h[i - half] + h[i + half]) / 2;
        h[i] = avg + (rand() * 2 - 1) * displace;
      }
      step = half;
      displace *= 0.5;
    }

    // Sample to the requested width and clamp into the playable band.
    const heights = new Float32Array(width);
    const minH = height * 0.12;
    const maxH = height * 0.88;
    for (let x = 0; x < width; x++) {
      const t = (x / (width - 1)) * (size - 1);
      const i = Math.floor(t);
      const frac = t - i;
      const a = h[i];
      const b = h[Math.min(size - 1, i + 1)];
      let v = a + (b - a) * frac;
      if (v < minH) v = minH;
      if (v > maxH) v = maxH;
      heights[x] = v;
    }
    return heights;
  }

  function generate(seed, width, height) {
    const rand = mulberry32(seed >>> 0);
    const heights = buildHeightmap(width, height, rand);
    const grid = new Uint8Array(width * height);

    for (let x = 0; x < width; x++) {
      const surface = Math.floor(heights[x]);
      for (let y = surface; y < height; y++) {
        grid[y * width + x] = 1;
      }
    }

    // A couple of floating platforms add tactical interest.
    const platforms = 2 + Math.floor(rand() * 2);
    for (let p = 0; p < platforms; p++) {
      const pw = 80 + Math.floor(rand() * 160);
      const px = Math.floor(rand() * (width - pw));
      const py = Math.floor(height * (0.28 + rand() * 0.28));
      const ph = 16 + Math.floor(rand() * 14);
      for (let x = px; x < px + pw; x++) {
        // rounded ends
        const edge = Math.min(x - px, px + pw - 1 - x);
        const taper = edge < 10 ? Math.floor((10 - edge) * 0.8) : 0;
        for (let y = py + taper; y < py + ph; y++) {
          if (x >= 0 && x < width && y >= 0 && y < height) grid[y * width + x] = 1;
        }
      }
    }

    return { grid, width, height, heights };
  }

  // Carve a circular crater (used for explosions). Returns nothing; mutates grid.
  function carveCircle(terrain, cx, cy, radius) {
    const { grid, width, height } = terrain;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) grid[y * width + x] = 0;
      }
    }
  }

  function isSolid(terrain, x, y) {
    x = x | 0;
    y = y | 0;
    if (x < 0 || x >= terrain.width || y < 0 || y >= terrain.height) return false;
    return terrain.grid[y * terrain.width + x] === 1;
  }

  const api = { mulberry32, generate, carveCircle, isSolid };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.WormsTerrain = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
