// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Navigation graph of a Killing Floor map, read from its .rom - the same PathNode/ReachSpec
 * network the game's own AI walks. Nodes are the actors ReachSpecs connect (PathNode, PlayerStart,
 * InventorySpot, Door...), edges are the ReachSpecs themselves (Start/End export refs + Distance +
 * reachFlags). A route found here follows the map's real walkable geometry, so a far move-to can
 * round corners instead of driving the pawn into a wall.
 */
const fs = require('fs');
const kfrom = require('./kfrom');
const { findMapFile } = require('./mapactors');

// UE2 reach flags. A player pawn can use WALK/DOOR/SPECIAL/PLAYERONLY edges, and JUMP edges too
// (in KF maps those are mostly ledge drops the walk physics just falls down); FLY/SWIM/LADDER or
// proscribed edges need abilities our ServerMove stream doesn't have - excluding JUMP outright
// fragmented real maps (KF-EvilSantasLair: 166 of 843 nodes unreachable).
const R_WALK = 1, R_FLY = 2, R_SWIM = 4, R_JUMP = 8, R_DOOR = 16, R_SPECIAL = 32, R_LADDER = 64, R_PROSCRIBED = 128;
const BLOCKED = R_FLY | R_SWIM | R_LADDER | R_PROSCRIBED;

class NavGraph {
  constructor(nodes, adj) {
    this.nodes = nodes;   // Map exportIndex -> {x,y,z}
    this.adj = adj;       // Map exportIndex -> [{to, dist}]
  }
  get size() { return this.nodes.size; }

  // Nearest graph node to a world point; |dz| weighted so a node on our floor beats one right
  // above/below us through a ceiling. Returns the export index or null when nothing is near.
  nearestNode(p, maxR = 3000) {
    let best = null, bestD = Infinity;
    for (const [idx, n] of this.nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y) + (p.z != null ? Math.abs((n.z || 0) - p.z) * 2 : 0);
      if (d < bestD) { bestD = d; best = idx; }
    }
    return bestD <= maxR ? best : null;
  }

  // A* over the ReachSpec edges. Returns [{x,y,z}...] node waypoints from the node nearest `from`
  // to the node nearest `to` (exclusive of `from`, inclusive of the goal node), or null.
  // The goal side is uncapped: a click beyond the walkable area routes to the closest node the
  // nav network can actually reach (the final straight leg to the click point is the caller's).
  findPath(from, to) {
    const start = this.nearestNode(from, 5000), goal = this.nearestNode(to, Infinity);
    if (start == null || goal == null) return null;
    if (start === goal) return [this.nodes.get(goal)];
    const gs = new Map([[start, 0]]);
    const came = new Map();
    const h = (i) => { const n = this.nodes.get(i), g = this.nodes.get(goal); return Math.hypot(n.x - g.x, n.y - g.y); };
    const open = [[h(start), start]];   // simple binary-less heap: sorted-insert array (graphs are ~10^2-10^3 nodes)
    const closed = new Set();
    while (open.length) {
      const [, cur] = open.shift();
      if (cur === goal) {
        const path = [];
        for (let i = goal; i !== start; i = came.get(i)) path.push(this.nodes.get(i));
        return path.reverse();
      }
      if (closed.has(cur)) continue;
      closed.add(cur);
      for (const e of this.adj.get(cur) || []) {
        if (closed.has(e.to)) continue;
        const g = gs.get(cur) + e.dist;
        if (g >= (gs.get(e.to) ?? Infinity)) continue;
        gs.set(e.to, g); came.set(e.to, cur);
        const f = g + h(e.to);
        let lo = 0, hi = open.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (open[mid][0] < f) lo = mid + 1; else hi = mid; }
        open.splice(lo, 0, [f, e.to]);
      }
    }
    return null;
  }
}

function graphFromPackage(pkg) {
  const specs = kfrom.readActors(pkg, ['ReachSpec']);
  if (!specs.length) return null;
  // Nodes = exactly the exports the specs connect, whatever their class (PathNode, PlayerStart, Door...).
  const wantIdx = new Set();
  for (const s of specs) {
    const f = s.props.reachFlags != null ? s.props.reachFlags : R_WALK;
    if ((f & BLOCKED) || !s.props.Start || !s.props.End) continue;
    wantIdx.add(s.props.Start); wantIdx.add(s.props.End);
  }
  const classes = new Set();
  for (const i of wantIdx) { const e = pkg.exports[i - 1]; if (e) classes.add(pkg.classOf(e)); }
  const nodes = new Map();
  for (const a of kfrom.readActors(pkg, classes)) {
    if (!wantIdx.has(a.exportIndex) || !Array.isArray(a.location)) continue;
    nodes.set(a.exportIndex, { x: a.location[0], y: a.location[1], z: a.location[2] });
  }
  const adj = new Map();
  for (const s of specs) {
    const f = s.props.reachFlags != null ? s.props.reachFlags : R_WALK;
    if ((f & BLOCKED) || !nodes.has(s.props.Start) || !nodes.has(s.props.End)) continue;
    const a = nodes.get(s.props.Start), b = nodes.get(s.props.End);
    const dist = s.props.Distance > 0 ? s.props.Distance : Math.hypot(b.x - a.x, b.y - a.y);
    if (!adj.has(s.props.Start)) adj.set(s.props.Start, []);
    adj.get(s.props.Start).push({ to: s.props.End, dist });
  }
  if (!nodes.size || !adj.size) return null;
  return new NavGraph(nodes, adj);
}

// Locate + parse the connection's map .rom (same lookup as mapactors) and build its nav graph.
function loadNavGraph(usesOrder, dirs) {
  const found = findMapFile(usesOrder, dirs);
  if (!found) return null;
  try { return graphFromPackage(kfrom.parsePackage(new Uint8Array(fs.readFileSync(found.file)))); }
  catch (e) { return null; }
}

module.exports = { NavGraph, graphFromPackage, loadNavGraph };
