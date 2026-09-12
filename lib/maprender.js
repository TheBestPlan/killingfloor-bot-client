// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Build a top-down "view from above" of a Killing Floor map (.rom) for the Virtual Map background.
 * Geometry comes from three sources: the level BSP (floors only - ceilings/undersides are skipped so
 * indoor maps show the walkable layout instead of their roofs), the TerrainInfo heightmap (outdoor
 * ground), and placed StaticMeshActors (embedded in the map or resolved from external .usx/.u
 * packages) - the props/buildings that carry most of a KF map's visible detail. Sky-box geometry and
 * stray distant brushes are cut by a connected-component filter anchored at PlayerStart/ShopVolume
 * actors, which also keeps the image bounds tight around the playable area. The rasterizer height-
 * shades per pixel (hypsometric ramp × hillshade), then a post-pass adds contour lines and darkens
 * wall bases so terrain relief and building outlines read at a glance. Pure JS - no canvas / native
 * deps. Returns a PNG buffer + the world bounds the image covers, so the renderer can place it under
 * the dots at the right world scale. Caller converts to JPEG (nativeImage) and caches by map size.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const kfrom = require('./kfrom');
const { packageDirs, findGameRoot } = require('./pkgmap');

// Locate <map>.rom across the client install / server dir / downloads / cache.
function findMapRom(mapName, systemDir) {
  const dirs = packageDirs(findGameRoot(systemDir), systemDir);
  for (const d of dirs) {
    const f = path.join(d, mapName + '.rom');
    try { if (fs.existsSync(f)) return f; } catch (e) {}
  }
  return null;
}

// ---- geometry collection -----------------------------------------------------------------------

// UE2 FRotator (Pitch,Yaw,Roll in 65536ths) -> row-major rotation matrix (rows = rotated axes).
function rotMatrix(rot) {
  const u = Math.PI / 32768;
  const p = (rot[0] || 0) * u, y = (rot[1] || 0) * u, r = (rot[2] || 0) * u;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(r), cr = Math.cos(r);
  return [
    cp * cy, cp * sy, sp,
    sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp,
    -(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp,
  ];
}

function collectBsp(pkg, tris) {
  const wm = kfrom.findWorldModel(pkg);
  if (!wm) return;
  const model = kfrom.readModel(pkg, wm);
  const groups = kfrom.buildMesh(pkg, model);
  for (const g of groups.values()) {
    // KFX = the gore/effects texture package; mappers put those on invisible-in-game effect sheets
    // (e.g. the rain sheet over KF-WestLondon's street) that would blanket the layout from above.
    if (g.material && g.material.file === 'KFX') continue;
    const P = g.positions, I = g.indices;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      tris.push([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]);
    }
  }
}

function collectTerrain(pkg, tris) {
  let ti;
  try { ti = kfrom.readTerrainInfo(pkg); } catch (e) { return; }
  if (!ti || !(ti.terrainMapRef > 0)) return;   // heightmap is embedded in the map in practice
  const exp = pkg.exports[ti.terrainMapRef - 1];
  if (!exp) return;
  let mip;
  try { mip = kfrom.readTextureMip0(pkg, exp); } catch (e) { return; }
  if (!mip || mip.fmtCode !== 10) return;       // G16 heightmap only
  const w = mip.width, h = mip.height;
  if (!(w > 1 && h > 1) || mip.data.length < w * h * 2) return;
  const heights = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) heights[i] = mip.data[i * 2] | (mip.data[i * 2 + 1] << 8);
  const tm = kfrom.buildTerrainMesh(heights, w, h, ti.scale, ti.location, 1, 1);
  const P = tm.positions, I = tm.indices;
  // buildTerrainMesh winds facing down for positive scales - swap two verts so the normal points up.
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 2] * 3, c = I[k + 1] * 3;
    tris.push([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]);
  }
}

// meshRef < 0 (import): walk the Outer chain to the top-level package name, find that file on disk,
// parse it once (cache) and read the named StaticMesh export from it.
function resolveExternalMesh(pkg, ref, systemDir, extPkgs) {
  const im = pkg.imports[-ref - 1];
  if (!im) return null;
  let top = null, outer = im.packageIndex;
  while (outer < 0) { const p = pkg.imports[-outer - 1]; if (!p) break; top = p.name; outer = p.packageIndex; }
  if (!top) return null;
  const key = top.toLowerCase();
  if (!extPkgs.has(key)) {
    let parsed = null;
    const dirs = packageDirs(findGameRoot(systemDir), systemDir);
    outerLoop:
    for (const ext of ['.usx', '.u', '.rom']) {
      for (const d of dirs) {
        const f = path.join(d, top + ext);
        try {
          if (!fs.existsSync(f)) continue;
          parsed = kfrom.parsePackage(new Uint8Array(fs.readFileSync(f)));
          break outerLoop;
        } catch (e) {}
      }
    }
    extPkgs.set(key, parsed);
  }
  const epkg = extPkgs.get(key);
  if (!epkg) return null;
  const want = im.name.toLowerCase();
  for (const e of epkg.exports) {
    if (e.serialSize > 0 && e.name.toLowerCase() === want && epkg.classOf(e) === 'StaticMesh') {
      try { const m = kfrom.readStaticMesh(epkg, e); if (m) return m; } catch (err) {}
    }
  }
  return null;
}

function collectStaticMeshes(pkg, tris, systemDir) {
  let actors;
  try { actors = kfrom.readStaticMeshActors(pkg); } catch (e) { return; }
  const meshCache = new Map();   // meshRef -> geometry | null
  const extPkgs = new Map();     // package file base -> parsed pkg | null
  for (const a of actors) {
    let m = meshCache.get(a.meshRef);
    if (m === undefined) {
      m = null;
      try {
        if (a.meshRef > 0) {
          const e = pkg.exports[a.meshRef - 1];
          if (e && pkg.classOf(e) === 'StaticMesh' && e.serialSize > 0) m = kfrom.readStaticMesh(pkg, e);
        } else if (a.meshRef < 0) {
          m = resolveExternalMesh(pkg, a.meshRef, systemDir, extPkgs);
        }
      } catch (e) { m = null; }
      meshCache.set(a.meshRef, m);
    }
    if (!m) continue;
    // world = R * (S * (v - PrePivot)) + Location  (UE2 LocalToWorld order)
    const R = rotMatrix(a.rotation);
    const s = a.drawScale, s3 = a.drawScale3D, pp = a.prePivot, L = a.location;
    const P = m.positions, I = m.indices, n = I.length;
    const wpos = new Float32Array(m.nVert * 3);
    for (let i = 0; i < m.nVert; i++) {
      const vx = (P[i * 3] - pp[0]) * s3[0] * s, vy = (P[i * 3 + 1] - pp[1]) * s3[1] * s, vz = (P[i * 3 + 2] - pp[2]) * s3[2] * s;
      wpos[i * 3] = L[0] + vx * R[0] + vy * R[3] + vz * R[6];
      wpos[i * 3 + 1] = L[1] + vx * R[1] + vy * R[4] + vz * R[7];
      wpos[i * 3 + 2] = L[2] + vx * R[2] + vy * R[5] + vz * R[8];
    }
    for (let k = 0; k < n; k += 3) {
      const a3 = I[k] * 3, b3 = I[k + 1] * 3, c3 = I[k + 2] * 3;
      tris.push([wpos[a3], wpos[a3 + 1], wpos[a3 + 2], wpos[b3], wpos[b3 + 1], wpos[b3 + 2], wpos[c3], wpos[c3 + 1], wpos[c3 + 2]]);
    }
  }
}

// Cut the sky box and stray distant brushes: rasterize triangle centroids onto a coarse occupancy
// grid, label 8-connected components, and keep the ones containing PlayerStart / ShopVolume actors
// (fallback: the largest component). Keeps the image bounds tight around the playable area.
function filterToPlayable(pkg, tris) {
  if (tris.length < 10) return tris;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const cx = new Float64Array(tris.length), cy = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const x = (t[0] + t[3] + t[6]) / 3, y = (t[1] + t[4] + t[7]) / 3;
    cx[i] = x; cy[i] = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const wW = maxX - minX, wH = maxY - minY;
  if (!(wW > 0 && wH > 0)) return tris;
  const cell = Math.max(wW, wH) / 160;
  const cols = Math.min(1024, Math.max(1, Math.ceil(wW / cell))), rows = Math.min(1024, Math.max(1, Math.ceil(wH / cell)));
  const cellOf = (x, y) => {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell)));
    return gy * cols + gx;
  };
  const occ = new Uint8Array(cols * rows);
  for (let i = 0; i < tris.length; i++) occ[cellOf(cx[i], cy[i])] = 1;
  // label components (iterative BFS)
  const label = new Int32Array(cols * rows).fill(-1);
  const sizes = [];
  const queue = new Int32Array(cols * rows);
  for (let c = 0; c < cols * rows; c++) {
    if (!occ[c] || label[c] >= 0) continue;
    const id = sizes.length;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = c; label[c] = id;
    while (head < tail) {
      const cur = queue[head++]; size++;
      const gx = cur % cols, gy = (cur / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nc = ny * cols + nx;
        if (occ[nc] && label[nc] < 0) { label[nc] = id; queue[tail++] = nc; }
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return tris;
  // anchor components at gameplay actors (nearest occupied cell within a small radius)
  const keep = new Set();
  let anchors = [];
  try {
    for (const a of kfrom.readActors(pkg, ['PlayerStart', 'ShopVolume'])) {
      if (Array.isArray(a.location)) anchors.push(a.location);
    }
  } catch (e) { anchors = []; }
  for (const [ax, ay] of anchors) {
    const c0 = cellOf(ax, ay);
    const gx = c0 % cols, gy = (c0 / cols) | 0;
    outer:
    for (let rad = 0; rad <= 3; rad++) {
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const l = label[ny * cols + nx];
        if (l >= 0) { keep.add(l); break outer; }
      }
    }
  }
  if (!keep.size) {
    let best = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
    keep.add(best);
  }
  return tris.filter((t, i) => keep.has(label[cellOf(cx[i], cy[i])]));
}

// Where the game actually happens: percentile bbox of PathNode/PlayerStart/ShopVolume actors,
// padded. Crops sky boxes and oversized terrain (L2 ports have mountains 4x the town) and gives the
// height ramp the walkable Z range so the playable relief spans the palette instead of the extremes.
function playableBounds(pkg) {
  const xs = [], ys = [], zs = [];
  try {
    for (const a of kfrom.readActors(pkg, ['PathNode', 'PlayerStart', 'ShopVolume'])) {
      const L = a.location;
      if (Array.isArray(L) && L.every(Number.isFinite)) { xs.push(L[0]); ys.push(L[1]); zs.push(L[2]); }
    }
  } catch (e) { return null; }
  if (xs.length < 8) return null;   // too few anchors to trust (custom maps without bot pathing)
  const num = (a, b) => a - b;
  xs.sort(num); ys.sort(num); zs.sort(num);
  const pct = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)))];
  const x0 = pct(xs, 0.01), x1 = pct(xs, 0.99), y0 = pct(ys, 0.01), y1 = pct(ys, 0.99);
  const padX = (x1 - x0) * 0.10 + 600, padY = (y1 - y0) * 0.10 + 600;
  return {
    minX: x0 - padX, maxX: x1 + padX, minY: y0 - padY, maxY: y1 + padY,
    zLo: pct(zs, 0.02) - 300, zHi: pct(zs, 0.98) + 900,
    // ceiling cut: structure triangles entirely above the top walkable floor are roofs/ceilings that
    // would blanket the interiors where the actual game happens (KF-Offices under its roof).
    zCut: pct(zs, 0.98) + 250,
  };
}

// All map geometry as flat triangles + the XY/Z bounds of the playable area.
function meshTriangles(romPath, systemDir) {
  const pkg = kfrom.parsePackage(new Uint8Array(fs.readFileSync(romPath)));
  let tris = [];
  collectBsp(pkg, tris);
  collectStaticMeshes(pkg, tris, systemDir);
  const pb = playableBounds(pkg);
  // terrain is ground - never a ceiling, so it bypasses the zCut roof filter below
  const terrain = [];
  collectTerrain(pkg, terrain);
  if (pb) tris = tris.filter((t) => Math.min(t[2], t[5], t[8]) <= pb.zCut);
  tris = tris.concat(terrain);
  if (!tris.length) return null;
  if (pb) {
    tris = tris.filter((t) =>
      Math.min(t[0], t[3], t[6]) <= pb.maxX && Math.max(t[0], t[3], t[6]) >= pb.minX &&
      Math.min(t[1], t[4], t[7]) <= pb.maxY && Math.max(t[1], t[4], t[7]) >= pb.minY);
  } else {
    tris = filterToPlayable(pkg, tris);
  }
  if (!tris.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tris) {
    for (const off of [0, 3, 6]) {
      const x = t[off], y = t[off + 1], z = t[off + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) return null;
  const bounds = pb
    ? { minX: Math.max(minX, pb.minX), maxX: Math.min(maxX, pb.maxX), minY: Math.max(minY, pb.minY), maxY: Math.min(maxY, pb.maxY), minZ, maxZ }
    : { minX, maxX, minY, maxY, minZ, maxZ };
  return { tris, bounds, zRamp: pb ? { lo: pb.zLo, hi: pb.zHi } : null };
}

// ---- PNG encode (deflate, no deps) -------------------------------------------------------------
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                                   // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) { CRC_T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c; } }
  let c = ~0; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c;
}

// ---- rasterizer --------------------------------------------------------------------------------

// Hypsometric ramp: low = dark slate, high = light sand. hn in [0,1] -> [r,g,b].
const RAMP = [
  [0.00, 58, 68, 84],
  [0.30, 98, 112, 106],
  [0.60, 152, 148, 128],
  [0.85, 196, 186, 170],
  [1.00, 232, 228, 218],
];
function rampColor(hn) {
  for (let i = 1; i < RAMP.length; i++) {
    if (hn <= RAMP[i][0]) {
      const [t0, r0, g0, b0] = RAMP[i - 1], [t1, r1, g1, b1] = RAMP[i];
      const f = (hn - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [RAMP[RAMP.length - 1][1], RAMP[RAMP.length - 1][2], RAMP[RAMP.length - 1][3]];
}

// Rasterize the top-down projection. Y is flipped so world +Y is up (like the Virtual Map).
// Per-pixel interpolated Z + z-buffer keeps the topmost floor; ceilings (down-facing) are skipped.
// Color = height ramp × hillshade; post-pass adds wall-base shadows and height contour lines.
function rasterize(mesh, maxDim) {
  const { tris, bounds } = mesh;
  const wW = bounds.maxX - bounds.minX || 1, wH = bounds.maxY - bounds.minY || 1;
  const scale = maxDim / Math.max(wW, wH);
  const W = Math.max(1, Math.round(wW * scale)), H = Math.max(1, Math.round(wH * scale));
  // Bake the Virtual Map's own blue (#396da5) as the background so the (alpha-less) JPEG tiles seamlessly
  // onto the canvas outside the map bounds - JPEG has no transparency to let the canvas blue show through.
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { const o = i * 4; rgba[o] = 57; rgba[o + 1] = 109; rgba[o + 2] = 165; rgba[o + 3] = 255; }
  const zbuf = new Float32Array(W * H).fill(-Infinity);
  // Height ramp range: the walkable Z band (from playableBounds) when known, else the 1st/99th
  // percentile of centroid Z so one pit/spire can't flatten it. Geometry outside the band clamps.
  let zLo, zHi;
  if (mesh.zRamp) {
    zLo = mesh.zRamp.lo; zHi = mesh.zRamp.hi;
  } else {
    const zs = new Float64Array(tris.length);
    for (let i = 0; i < tris.length; i++) zs[i] = (tris[i][2] + tris[i][5] + tris[i][8]) / 3;
    zs.sort();
    zLo = zs[Math.floor(zs.length * 0.01)]; zHi = zs[Math.min(zs.length - 1, Math.floor(zs.length * 0.99))];
  }
  const zr = (zHi - zLo) || 1;
  // Light from the image's top-left (world -X, +Y), well off vertical so slopes and walls pop.
  const LL = Math.hypot(-0.45, 0.45, 0.77), Lx = -0.45 / LL, Ly = 0.45 / LL, Lz = 0.77 / LL;
  const toPx = (x, y) => [(x - bounds.minX) * scale, (bounds.maxY - y) * scale];   // flip Y
  for (const t of tris) {
    // world-space face normal - skip down-facing surfaces (ceilings / undersides)
    let nx = (t[4] - t[1]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[7] - t[1]);
    let ny = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]);
    let nz = (t[3] - t[0]) * (t[7] - t[1]) - (t[4] - t[1]) * (t[6] - t[0]);
    const nl = Math.hypot(nx, ny, nz);
    if (!nl) continue;
    nx /= nl; ny /= nl; nz /= nl;
    if (nz < -0.05) continue;
    const [x0, y0] = toPx(t[0], t[1]), [x1, y1] = toPx(t[3], t[4]), [x2, y2] = toPx(t[6], t[7]);
    const z0 = t[2], z1 = t[5], z2 = t[8];
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minx > maxx || miny > maxy) continue;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-6) continue;
    const inv = 1 / area;
    const lambert = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
    const shade = 0.45 + 0.55 * lambert;
    for (let py = miny; py <= maxy; py++) {
      for (let px = minx; px <= maxx; px++) {
        const cxp = px + 0.5, cyp = py + 0.5;
        const w0 = ((x1 - cxp) * (y2 - cyp) - (x2 - cxp) * (y1 - cyp)) * inv;
        const w1 = ((x2 - cxp) * (y0 - cyp) - (x0 - cxp) * (y2 - cyp)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const idx = py * W + px;
        if (z <= zbuf[idx]) continue;
        zbuf[idx] = z;
        const hn = Math.max(0, Math.min(1, (z - zLo) / zr));
        const col = rampColor(hn);
        const o = idx * 4;
        rgba[o] = (col[0] * shade) | 0; rgba[o + 1] = (col[1] * shade) | 0; rgba[o + 2] = (col[2] * shade) | 0; rgba[o + 3] = 255;
      }
    }
  }
  // Post-pass: darken pixels sitting at the base of a wall (higher neighbours -> soft AO) and etch
  // contour lines where the height crosses a 256-unit level on a gentle slope.
  const CONTOUR = 256;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const idx = py * W + px;
      const z = zbuf[idx];
      if (z === -Infinity) continue;
      let higher = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx2 = px + dx, ny2 = py + dy;
        if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
        if (zbuf[ny2 * W + nx2] > z + 48) higher++;
      }
      let f = 1 - Math.min(0.5, higher * 0.08);
      const zR = px + 1 < W ? zbuf[idx + 1] : z, zD = py + 1 < H ? zbuf[idx + W] : z;
      const lv = Math.floor(z / CONTOUR);
      if ((zR !== -Infinity && Math.floor(zR / CONTOUR) !== lv && Math.abs(zR - z) < 96) ||
          (zD !== -Infinity && Math.floor(zD / CONTOUR) !== lv && Math.abs(zD - z) < 96)) f *= 0.84;
      if (f < 1) {
        const o = idx * 4;
        rgba[o] = (rgba[o] * f) | 0; rgba[o + 1] = (rgba[o + 1] * f) | 0; rgba[o + 2] = (rgba[o + 2] * f) | 0;
      }
    }
  }
  return { png: encodePng(rgba, W, H), w: W, h: H, bounds };
}

// Full pipeline: parse + rasterize a .rom to a top-down PNG (+ world bounds). null if unparsable.
function renderTopDown(romPath, maxDim = 2048, systemDir = null) {
  const mesh = meshTriangles(romPath, systemDir);
  if (!mesh) return null;
  return rasterize(mesh, maxDim);
}

module.exports = { findMapRom, renderTopDown, meshTriangles, rasterize, encodePng };
