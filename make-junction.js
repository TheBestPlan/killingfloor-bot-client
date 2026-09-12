// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Create a no-spaces junction to the KF dedicated server dir, because UCC.exe (UE2)
// splits its command line on spaces and a spaced install path makes it parse a path
// fragment ("Dedicated") as the map name. Run: node make-junction.js
const fs = require('fs');
const path = require('path');
const { findServerDir } = require('./lib/findsteam');

// target = the KF dedicated-server install (auto-detected; override: arg or env KF_SERVER_DIR).
const target = process.argv[2] || findServerDir();
// link = a no-spaces junction kept INSIDE the project, so all paths are project-relative.
const link = process.argv[3] || path.join(__dirname, '_kfds');
if (!target) {
  console.error('server dir not found — pass it as arg or set KF_SERVER_DIR\n' +
    '  (the "Killing Floor Dedicated Server - Win32" folder)');
  process.exit(1);
}
try {
  fs.symlinkSync(target, link, 'junction');
  console.log('junction created: ' + link + '  ->  ' + target);
} catch (e) {
  if (e.code === 'EEXIST') console.log('junction already exists: ' + link);
  else { console.error('ERR ' + e.message); process.exit(1); }
}
console.log('UCC.exe present: ' + fs.existsSync(link + '\\System\\UCC.exe'));
