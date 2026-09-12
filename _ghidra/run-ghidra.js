// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Run Ghidra analyzeHeadless on Engine.dll with the find_blob.py post-script.
const { spawn } = require('child_process');
const path = require('path');
const base = __dirname;
const javaHome = path.join(base, 'jdk', 'jdk-21.0.11+10');
const headless = path.join(base, 'ghidra', 'ghidra_12.1.2_PUBLIC', 'support', 'analyzeHeadless.bat');
const proj = path.join(base, 'proj');
const engine = process.argv[2] || process.env.KF_ENGINE_DLL ||
  path.join(base, '..', '_kfds', 'System', 'Engine.dll');
// argv[3] = mode (import|process), argv[4] = script name (default find_blob.java)
const mode = process.argv[3] || 'import';
const script = process.argv[4] || 'find_blob.java';
const sp = path.join(base, 'kfscripts');   // clean script dir (no ghidra/ or jdk/ subdirs)
const args = (mode === 'process')
  ? [proj, 'kf', '-process', 'Engine.dll', '-noanalysis', '-scriptPath', sp, '-postScript', script]
  : [proj, 'kf', '-import', engine, '-scriptPath', sp, '-postScript', script, '-analysisTimeoutPerFile', '900'];
console.log('JAVA_HOME_OVERRIDE=' + javaHome);
console.log('headless: ' + headless);
console.log('import: ' + engine);
const jdkBin = path.join(javaHome, 'bin');
const env = Object.assign({}, process.env, {
  JAVA_HOME_OVERRIDE: javaHome,
  JAVA_HOME: javaHome,
  PATH: jdkBin + ';' + process.env.PATH,
});
const child = spawn(headless, args, { env: env, stdio: 'inherit', shell: true });
child.on('error', (e) => { console.error('spawn error', e.message); process.exit(1); });
child.on('exit', (c) => { console.log('ghidra exit ' + c); process.exit(c || 0); });
