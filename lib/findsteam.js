// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Locate Steam game installs WITHOUT hardcoding a machine-specific path.
 * Resolution order for every lookup: explicit env var -> scan all Steam library folders.
 * Pure JS / built-ins only; runs under both the 64-bit bot and the bundled 32-bit node.
 *
 * Env overrides:  KF_STEAM_API_DLL, KF_SERVER_DIR, KF_GAME_DIR, STEAM_PATH
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Candidate Steam root dirs (each holds steamapps/libraryfolders.vdf).
function steamRoots() {
  const roots = new Set();
  if (process.env.STEAM_PATH) roots.add(process.env.STEAM_PATH);
  try { // current-user registry
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) roots.add(m[1].trim().replace(/\//g, '\\'));
  } catch (e) { /* reg absent / key missing */ }
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  roots.add(path.join(pf86, 'Steam'));
  roots.add(path.join(pf, 'Steam'));
  roots.add('C:\\Steam');
  return [...roots].filter(Boolean);
}

// All Steam library content roots (each has a steamapps/common/).
function libraryFolders() {
  const libs = new Set();
  // Project-relative roots - covers a dedicated server unpacked next to the repo
  // (e.g. via SteamCMD into <repo>/steamapps or its parent), so no absolute path is needed.
  libs.add(path.join(__dirname, '..'));        // project root (killingfloor-bot-client/)
  libs.add(path.join(__dirname, '..', '..'));  // the directory the project sits in
  for (const root of steamRoots()) {
    libs.add(root); // the steam root itself is a library
    for (const vdf of [path.join(root, 'steamapps', 'libraryfolders.vdf'),
      path.join(root, 'config', 'libraryfolders.vdf')]) {
      try {
        const txt = fs.readFileSync(vdf, 'utf8');
        const re = /"path"\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(txt))) libs.add(m[1].replace(/\\\\/g, '\\'));
      } catch (e) { /* this library list absent */ }
    }
  }
  return [...libs];
}

// First existing <lib>/steamapps/common/<rel> across all libraries, else null.
function findInLibraries(rel) {
  for (const lib of libraryFolders()) {
    const p = path.join(lib, 'steamapps', 'common', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// steam_api.dll of the KF client install (for the real-Steam ticket helper).
function findSteamApiDll() {
  return process.env.KF_STEAM_API_DLL ||
    findInLibraries(path.join('KillingFloor', 'System', 'steam_api.dll'));
}

// The KF dedicated-server install dir (for make-junction / launch-server).
function findServerDir() {
  return process.env.KF_SERVER_DIR ||
    findInLibraries('Killing Floor Dedicated Server - Win32');
}

// The KF client install root (for run-local-server / Engine.dll reverse).
function findGameDir() {
  return process.env.KF_GAME_DIR || findInLibraries('KillingFloor');
}

module.exports = { steamRoots, libraryFolders, findInLibraries, findSteamApiDll, findServerDir, findGameDir };
