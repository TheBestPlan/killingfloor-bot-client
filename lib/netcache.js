// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Build the UE2.5 net cache (class -> ordered replicated fields, each with a net
 * index) from the game's .u packages, so inbound actor replication can be decoded.
 *
 * The engine numbers a class's replicated fields by walking the class hierarchy
 * base->derived and, within each class, its fields in declaration (export) order,
 * assigning a running index to every replicated property (CPF_Net) and net function.
 */
const fs = require('fs');
const path = require('path');
const { UPackage } = require('./upackage');

// packages that hold the KF pawn / controller / PRI hierarchy
// Old2K4 holds InvasionGameReplicationInfo (KFGameReplicationInfo's parent); without it the GRI net-field
// chain breaks and WaveNumber/TimeToNextWave decode at the wrong indices. It adds no classes that collide
// with the earlier packages, so the pawn/PRI/PC net indices are unchanged (verified).
const DEFAULT_PACKAGES = ['Core', 'Engine', 'Fire', 'GamePlay', 'UnrealGame', 'XGame',
  'XInterface', 'ROEngine', 'ROInterface', 'KFMod', 'KFChar', 'Old2K4'];

class PackageSet {
  constructor(dir, names = DEFAULT_PACKAGES) {
    this.pkgs = {};
    this.classLoc = {};   // className -> { pkg, idx }
    for (const n of names) {
      const file = path.join(dir, n + '.u');
      if (!fs.existsSync(file)) continue;
      const p = new UPackage(file);
      this.pkgs[n] = p;
      for (let i = 0; i < p.exports.length; i++) {
        const e = p.exports[i];
        if (p.isClassExport(e) && !this.classLoc[e.name]) {
          this.classLoc[e.name] = { pkg: n, idx: i };
        }
      }
    }
  }

  // Register an already-parsed package (one downloaded from the server) so its classes resolve through
  // hierarchy()/netFields() exactly like the stock set - this is how a modded PlayerController/Pawn gets
  // the same net table the real client builds after downloading. Stock classes keep priority on collisions.
  addParsed(name, upkg) {
    if (this.pkgs[name]) return;
    this.pkgs[name] = upkg;
    for (let i = 0; i < upkg.exports.length; i++) {
      const e = upkg.exports[i];
      if (upkg.isClassExport(e) && !this.classLoc[e.name]) {
        this.classLoc[e.name] = { pkg: name, idx: i };
      }
    }
  }

  // Super class NAME (resolves import or export), or null at the root.
  superOf(name) {
    const loc = this.classLoc[name];
    if (!loc) return null;
    const p = this.pkgs[loc.pkg];
    const e = p.exports[loc.idx];
    return e.superIndex === 0 ? null : p.refName(e.superIndex);
  }

  // [rootClass, ..., name] base->derived.
  hierarchy(name) {
    const chain = []; const seen = new Set(); let c = name;
    while (c && !seen.has(c)) { seen.add(c); chain.unshift(c); c = this.superOf(c); }
    return chain;
  }

  // A class's own fields (properties + functions) in export order.
  fieldsOf(name) {
    const loc = this.classLoc[name];
    if (!loc) return [];
    return this.pkgs[loc.pkg].classFields(name);
  }

  // Replicated fields (net properties + net functions) across the hierarchy (base->derived),
  // interleaved in declaration order, each with a running net index. This IS the net cache;
  // the count is GetMaxIndex (the wire field-index range).
  netFields(name) {
    const out = [];
    for (const cls of this.hierarchy(name)) {
      for (const f of this.fieldsOf(cls)) {
        if (f.net) out.push({ index: out.length, name: f.name, type: f.type, isFunc: f.isFunc, cls });
      }
    }
    return out;
  }
}

// Cache one PackageSet per System directory (parsing the .u files is not free).
const _byDir = {};
function packageSet(systemDir) {
  return _byDir[systemDir] || (_byDir[systemDir] = new PackageSet(systemDir));
}

// Net index + GetMaxIndex for a class's replicated field (property or net function),
// e.g. rpcIndex(dir, 'KFPlayerController', 'ServerReStartPlayer') -> { index, max }.
// This is the runtime (chIndex/GetMaxIndex/FieldNetIndex) the engine derives from the
// loaded .u files - see docs/PROTOCOL.md §7/§8. Returns null if the field isn't replicated.
function fieldNetIndex(systemDir, className, fieldName) {
  const nf = packageSet(systemDir).netFields(className);
  const f = nf.find((x) => x.name === fieldName);
  return f ? { index: f.index, max: nf.length } : null;
}

module.exports = { PackageSet, DEFAULT_PACKAGES, packageSet, fieldNetIndex };
