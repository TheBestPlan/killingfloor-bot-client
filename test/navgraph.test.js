// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Self-test for the map navigation graph (PathNode/ReachSpec routing behind far move-to).
// Run: node test/navgraph.test.js
const assert = require('assert');
const fs = require('fs');
const { NavGraph, graphFromPackage } = require('../lib/navgraph');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('PASS ' + name); };

// Synthetic square: A(0,0) B(1000,0) C(1000,1000) D(0,1000); edges only along A-B-C-D, so a route
// from A's corner to D's corner must go the long way around instead of cutting the missing A-D side.
const nodes = new Map([
  [1, { x: 0, y: 0, z: 0 }], [2, { x: 1000, y: 0, z: 0 }],
  [3, { x: 1000, y: 1000, z: 0 }], [4, { x: 0, y: 1000, z: 0 }],
]);
const adj = new Map();
const link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, dist: 1000 }); };
link(1, 2); link(2, 1); link(2, 3); link(3, 2); link(3, 4); link(4, 3);
const g = new NavGraph(nodes, adj);

ok('nearestNode picks the closest same-floor node', g.nearestNode({ x: 50, y: -20, z: 0 }) === 1);
ok('nearestNode rejects a point far from every node', g.nearestNode({ x: 99999, y: 0, z: 0 }) === null);
const p = g.findPath({ x: 10, y: 10, z: 0 }, { x: 30, y: 960, z: 0 });
ok('A* routes around the missing direct edge (A->B->C->D)',
  p && p.length === 3 && p[0].x === 1000 && p[0].y === 0 && p[2].x === 0 && p[2].y === 1000);
ok('no edges -> no path', new NavGraph(nodes, new Map()).findPath({ x: 0, y: 0, z: 0 }, { x: 0, y: 1000, z: 0 }) === null);
// z weighting: a node 300uu above beats one 400uu away on the same floor only if the 2D one is farther.
const gz = new NavGraph(new Map([[1, { x: 0, y: 0, z: 0 }], [2, { x: 120, y: 0, z: 500 }]]), new Map());
ok('same-floor node preferred over one right above through a ceiling', gz.nearestNode({ x: 100, y: 0, z: 0 }) === 1);

// Integration (skipped when the stock install isn't present): the real KF-LyesKrovy nav network.
const rom = 'D:/games/SteamLibrary/steamapps/common/KillingFloor/Maps/KF-LyesKrovy.rom';
if (fs.existsSync(rom)) {
  const kfrom = require('../lib/kfrom');
  const gg = graphFromPackage(kfrom.parsePackage(new Uint8Array(fs.readFileSync(rom))));
  ok('LyesKrovy graph has hundreds of connected nodes', gg && gg.size > 200);
  const ns = [...gg.nodes.values()];
  const a = ns[0];
  let b = ns[0], far = 0;
  for (const n of ns) { const d = Math.hypot(n.x - a.x, n.y - a.y); if (d > far) { far = d; b = n; } }
  const route = gg.findPath(a, b);
  ok('a far route exists across the real map', route && route.length >= 3);
  let prev = a, maxLeg = 0;
  for (const wpt of route) { maxLeg = Math.max(maxLeg, Math.hypot(wpt.x - prev.x, wpt.y - prev.y)); prev = wpt; }
  ok('every leg is a local ReachSpec hop (<2000uu)', maxLeg < 2000);
} else {
  console.log('skip: stock KF install not found — synthetic graph tests only');
}

console.log('navgraph self-test: ' + pass + ' passed, 0 failed');
