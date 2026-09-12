// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan
'use strict';
// Verifies the map dot glide never renders faster than its per-actor speed ceiling, so a sparse/large
// Location jump (KF replicates a relevant pawn's position only every ~1s) slides smoothly instead of
// snapping (the "monsters teleport" symptom). Mirrors renderer.js stepMapPositions' glide math.
const assert = require('assert');

// The exact glide used by the renderer: given a segment (px,py)->(gx,gy) opened at segStart, over a
// duration stretched so speed <= SPEED_CAP, return the rendered point at time `now`.
function glide(e, now) {
  const SPEED_CAP = e.type === 'self' ? 800 : e.type === 'player' ? 650 : e.type === 'mon' ? 620 : 400;
  const dist = Math.hypot(e.gx - e.px, e.gy - e.py);
  const base = Math.max(100, Math.min(1600, (e.updT || 200) * 1.15));
  const dur = Math.max(base, (dist / SPEED_CAP) * 1000);
  const f = Math.min(1, (now - e.segStart) / dur);
  return { x: e.px + (e.gx - e.px) * f, y: e.py + (e.gy - e.py) * f, cap: SPEED_CAP };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };

// A big sparse monster jump (450uu) must render at <= its 620 uu/s ceiling, frame by frame at 60fps.
for (const jump of [80, 300, 450, 900]) {
  const e = { type: 'mon', px: 0, py: 0, gx: jump, gy: 0, segStart: 0, updT: 200 };
  let prev = glide(e, 0), maxSpeed = 0;
  for (let t = 16; t <= 4000; t += 16) {
    const p = glide(e, t);
    const v = Math.hypot(p.x - prev.x, p.y - prev.y) / (16 / 1000);
    maxSpeed = Math.max(maxSpeed, v);
    prev = p;
  }
  ok(maxSpeed <= 621, 'mon jump ' + jump + ' maxSpeed=' + Math.round(maxSpeed) + ' <= 620');
}
// Small updates still complete within ~one update interval (not artificially slowed).
{
  const e = { type: 'mon', px: 0, py: 0, gx: 60, gy: 0, segStart: 0, updT: 200 };
  const end = glide(e, 300);   // base dur ~230ms, so by 300ms fully arrived
  ok(Math.abs(end.x - 60) < 0.5, 'small update arrives within interval (x=' + end.x.toFixed(1) + ')');
}
// Per-actor ceilings differ: self glides faster than a monster for the same jump.
{
  const j = 900, dSelf = glide({ type: 'self', px: 0, py: 0, gx: j, gy: 0, segStart: 0, updT: 200 }, 500).x;
  const dMon = glide({ type: 'mon', px: 0, py: 0, gx: j, gy: 0, segStart: 0, updT: 200 }, 500).x;
  ok(dSelf > dMon, 'self ceiling (800) outpaces monster (620) on same jump: ' + dSelf.toFixed(0) + ' > ' + dMon.toFixed(0));
}

console.log('\nglide-speed self-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
