// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Launch the KF dedicated server (UCC.exe) with a correctly-quoted command line.
 * The server install path contains spaces ("Killing Floor Dedicated Server - Win32"),
 * which breaks UCC's own GetCommandLine() parsing when argv[0] is not quoted (Git Bash
 * / mangled cmd quoting make it parse a path fragment "Dedicated" as the map name).
 * Node's child_process.spawn quotes argv[0] properly, so UCC parses the URL correctly.
 *
 * Usage: node launch-server.js [serverSystemDir] [map] [extraOpts]
 */
const { spawn } = require('child_process');
const path = require('path');

// Default = the in-project no-spaces junction made by make-junction.js (override: arg or env).
const sysDir = process.argv[2] || process.env.KF_SERVER_SYSTEM ||
  path.join(__dirname, '_kfds', 'System');
const map = process.argv[3] || 'KF-BioticsLab';
const extra = process.argv[4] || 'VACSecured=false?MaxPlayers=6?AdminName=Admin?AdminPassword=12345';
const absSys = path.resolve(sysDir);            // spawn needs an absolute exe path
const exe = path.join(absSys, 'UCC.exe');
const gameClass = process.env.KF_GAME || 'KFmod.KFGameType';   // KF_GAME lets us test custom gametypes locally
const url = `${map}.rom?game=${gameClass}?${extra}`;

console.log('launching: ' + exe);
console.log('url: server ' + url);
// -nohomedir keeps config/logs in System instead of a per-user home dir (which UCC
// fails to set up headless, exiting code=1 with an empty log).
const child = spawn(exe, ['server', url, '-nohomedir', '-log=server.log'], { cwd: absSys, stdio: 'inherit' });
child.on('error', (e) => { console.error('spawn error:', e.message); process.exit(1); });
child.on('exit', (code, sig) => { console.log('server exited code=' + code + ' sig=' + sig); process.exit(code || 0); });
