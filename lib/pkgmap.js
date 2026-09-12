// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Build the connection's EXACT net object table from the packages the client actually has.
 *
 * The server numbers replicated object refs by its package map: USES packages in order, each package's
 * export table appended (global index = ObjectBase + export index), MaxObjectIndex = the running total.
 * Reproduce it exactly by locating every USES package on disk (game install content dirs + the dedicated
 * server dir + the download Cache) and summing real export counts. With every package present this yields
 * the exact MaxObjectIndex (no brute force) and resolves every class ref to its true name - items,
 * traders, monsters, players. Packages the client is missing (custom content) leave gaps: their range is
 * unknown, so refs into or past them don't resolve, but everything before the first gap still does.
 */
const fs = require('fs');
const path = require('path');
const { UPackage } = require('./upackage');

const CONTENT_SUBDIRS = ['System', 'Textures', 'Sounds', 'Animations', 'StaticMeshes', 'Music', 'Maps', 'KarmaData'];
const PKG_EXTS = ['.u', '.utx', '.uax', '.usx', '.ukx', '.rom', '.ogg', '.rus_uax'];

// Locate the KF CLIENT install (has the content dirs the dedicated server lacks). Order: explicit hint /
// env, then the parent of the given System dir, then common Steam library locations across drives.
function findGameRoot(hintSystemDir) {
  const cands = [];
  if (process.env.KF_GAME_DIR) cands.push(process.env.KF_GAME_DIR);
  if (hintSystemDir) cands.push(path.dirname(hintSystemDir));
  for (const b of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:/Program Files (x86)', 'C:/Program Files']) {
    if (b) cands.push(path.join(b, 'Steam/steamapps/common/KillingFloor'));
  }
  for (const drive of ['C', 'D', 'E', 'F']) {
    cands.push(`${drive}:/games/SteamLibrary/steamapps/common/KillingFloor`);
    cands.push(`${drive}:/SteamLibrary/steamapps/common/KillingFloor`);
    cands.push(`${drive}:/Steam/steamapps/common/KillingFloor`);
  }
  for (const c of cands) { try { if (c && fs.existsSync(path.join(c, 'Textures'))) return c; } catch (e) { /* ignore */ } }
  return hintSystemDir ? path.dirname(hintSystemDir) : null;
}

// Every directory a package might live in: the client install's content dirs + the (junctioned) server dir.
function packageDirs(gameRoot, serverSystemDir) {
  const dirs = [];
  if (gameRoot) for (const s of CONTENT_SUBDIRS) dirs.push(path.join(gameRoot, s));
  if (gameRoot) dirs.push(path.join(gameRoot, 'Cache'));
  if (serverSystemDir) { dirs.push(serverSystemDir); dirs.push(path.join(serverSystemDir, '..', 'Maps')); }
  dirs.push(path.join(__dirname, '..', 'downloads'));   // packages the bot pulled from a server this session
  return dirs.filter((d) => { try { return fs.existsSync(d); } catch (e) { return false; } });
}

class PackageMap {
  constructor(usesOrder, serverSystemDir) {
    this.uses = usesOrder;
    this.gameRoot = findGameRoot(serverSystemDir);
    this.dirs = packageDirs(this.gameRoot, serverSystemDir);
    this._guidByName = {};
    for (const u of usesOrder) if (u.name && u.guid) this._guidByName[u.name] = u.guid;
    this._cache = {};
    this.ranges = [];
    this.maxObjectIndex = 0;      // exact object-table size - set only when every package is present
    this.baseObjectIndex = 0;     // running total of the packages present up to the first gap (a lower bound)
    this.complete = false;
    this.missing = [];
  }

  // Every on-disk copy of a package: by name across the content dirs + downloads, then GUID-named in the
  // real client's Cache. Order matters only as a preference - _pkg tries each until one PARSES, so a
  // corrupt or still-compressed download (which exists yet won't parse) falls back to the good Cache copy.
  _candidates(name) {
    const out = [];
    for (const d of this.dirs) for (const e of PKG_EXTS) { const f = path.join(d, name + e); if (fs.existsSync(f)) out.push(f); }
    const g = findCachedByGuid(this._guidByName[name], this.gameRoot);
    if (g) out.push(g);
    return out;
  }
  _pkg(name) {
    if (name in this._cache) return this._cache[name];
    const want = this._guidByName[name] ? this._guidByName[name].replace(/[^0-9A-Fa-f]/g, '').toUpperCase() : null;
    let pkg = null, fallback = null;
    for (const f of this._candidates(name)) {
      let p; try { p = new UPackage(f); } catch (e) { continue; }   // corrupt/compressed copy - try the next
      if (!fallback) fallback = p;
      // Prefer the copy whose GUID matches the server's USES GUID. A same-named but different-version package
      // (a stock copy in the content dir vs the server's modded build) has a different export count, so summing
      // the wrong one yields a wrong MaxObjectIndex - static class refs then misframe and monsters never resolve
      // (invisible while they attack). Matching by GUID picks the server's exact version (from downloads/ or the
      // retail Cache). No match on disk falls back to any parsable copy, so this never invents a gap.
      if (!want || (p.guid && p.guid.replace(/[^0-9A-Fa-f]/g, '').toUpperCase() === want)) { pkg = p; break; }
    }
    return (this._cache[name] = pkg || fallback);
  }

  build() {
    let base = 0, gapHit = false;
    for (const u of this.uses) {
      const p = this._pkg(u.name);
      if (!p) {
        this.missing.push(u.name);              // collect EVERY missing package (the repair pass fetches them all)
        if (!gapHit) { this.ranges.push({ name: u.name, lo: base, hi: null, pkg: null }); gapHit = true; }
        continue;                               // ranges past the first gap can't be numbered, but keep scanning
      }
      if (!gapHit) { this.ranges.push({ name: u.name, lo: base, hi: base + p.exports.length, pkg: p }); base += p.exports.length; }
    }
    this.complete = this.missing.length === 0;
    this.baseObjectIndex = base;                // sum of present packages up to the first gap; == exact total when complete
    if (this.complete) this.maxObjectIndex = base;
    return this.complete;
  }

  // Class name for a global object index, or null (gap / non-class / out of range).
  resolve(idx) { const l = this.resolveLoc(idx); return l ? l.cls : null; }

  // Class name + its owning PARSED package for a global object index - the parsed package is what lets
  // the net cache learn a downloaded custom class (modded PlayerController/Pawn) like the real client.
  resolveLoc(idx) {
    for (const r of this.ranges) {
      if (r.hi == null) return null;                        // reached the first missing package
      if (idx >= r.lo && idx < r.hi) {
        const e = r.pkg.exports[idx - r.lo];
        if (!e) return null;
        const isClass = r.pkg.isClassExport(e);
        return isClass ? { cls: e.name, pkgName: r.name, pkg: r.pkg } : null;   // a ref must land on a class export
      }
    }
    return null;
  }

  // Owning parsed package of a class by NAME (any USES package) - resolves the intermediate links of a
  // custom class's superclass chain, which can live in a different downloaded package. Cached once.
  findClass(name) {
    if (!this._classIdx) {
      this._classIdx = {};
      for (const r of this.ranges) {
        if (!r.pkg) continue;
        for (const e of r.pkg.exports) {
          if (r.pkg.isClassExport(e) && this._classIdx[e.name] === undefined) {
            this._classIdx[e.name] = { pkgName: r.name, pkg: r.pkg };
          }
        }
      }
    }
    return this._classIdx[name] || null;
  }
}

// Absolute path of a locally-present package (any known extension), or null.
function findPackageFile(name, dirs) {
  for (const d of dirs) for (const e of PKG_EXTS) { const f = path.join(d, name + e); try { if (fs.existsSync(f)) return f; } catch (e2) {} }
  return null;
}

// The real KF client stores every package it ever downloaded from a server in <game>/Cache, named by the
// package's FGuid (e.g. "39B04C1B...-1.uxx") and mapped in cache.ini. We look packages up by NAME, so we'd
// miss all of it - yet the server hands us each package's GUID in its USES line. Index Cache by GUID so a
// package the user already pulled by PLAYING the server in the real client resolves with zero download.
const _cacheIdx = {};   // gameRoot -> { GUID(uppercase) -> file path }
function cacheGuidIndex(gameRoot) {
  if (!gameRoot) return {};
  if (_cacheIdx[gameRoot]) return _cacheIdx[gameRoot];
  const idx = {};
  try {
    const dir = path.join(gameRoot, 'Cache');
    for (const f of fs.readdirSync(dir)) {
      const m = /^([0-9A-Fa-f]{32})[-.]/.exec(f);   // "<32-hex GUID>-<gen>.uxx"
      if (m) idx[m[1].toUpperCase()] = path.join(dir, f);
    }
  } catch (e) { /* no cache dir */ }
  return (_cacheIdx[gameRoot] = idx);
}
function findCachedByGuid(guid, gameRoot) {
  if (!guid) return null;
  return cacheGuidIndex(gameRoot)[String(guid).replace(/[^0-9A-Fa-f]/g, '').toUpperCase()] || null;
}

module.exports = { PackageMap, findGameRoot, packageDirs, findPackageFile, findCachedByGuid, PKG_EXTS, CONTENT_SUBDIRS };
