// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Bootstrap from a clean clone (Windows). Restores everything under .gitignore.
 *
 *   node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
 *   node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
 *
 * Idempotent: anything already installed is skipped. Requires: internet, 7-Zip.
 * After bootstrap the tool is fully working (see docs/USAGE.md).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = __dirname;
const NODE32_VER = 'v22.12.0';
const KOFFI_VER = (() => { try { return require('./node_modules/koffi/package.json').version; } catch (e) { return '3.0.2'; } })();
const GHIDRA_URL = 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.2_build/ghidra_12.1.2_PUBLIC_20260605.zip';
const JDK_URL = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk';
const GBE_RELEASE = 'release-2026_05_30';

const SEVENZIP = ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe'].find(p => fs.existsSync(p)) || '7z';

function log(m) { process.stdout.write('[bootstrap] ' + m + '\n'); }
function exists(p) { return fs.existsSync(p); }

// curl first (fast), then PowerShell Invoke-WebRequest (reliable for nodejs.org)
function download(url, dest) {
  if (exists(dest) && fs.statSync(dest).size > 1000) { log('have: ' + path.basename(dest)); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log('downloading ' + url);
  try {
    execFileSync('curl', ['-sL', '--fail', '--connect-timeout', '30', url, '-o', dest], { stdio: 'ignore' });
    if (exists(dest) && fs.statSync(dest).size > 1000) return;
  } catch (e) { /* fallback */ }
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing -TimeoutSec 180`], { stdio: 'inherit' });
  if (!exists(dest) || fs.statSync(dest).size < 1000) throw new Error('download failed: ' + url);
}

function un7z(archive, outdir) {
  fs.mkdirSync(outdir, { recursive: true });
  execFileSync(SEVENZIP, ['x', archive, '-o' + outdir, '-y'], { stdio: 'ignore' });
}

// --- Tier 1: core deps - koffi (64-bit) + Electron GUI, via pnpm ---
function tier1() {
  if (exists(path.join(ROOT, 'node_modules', 'koffi'))) { log('Tier1: node_modules already present'); return; }
  log('Tier1: pnpm install');
  execSync('pnpm install', { cwd: ROOT, stdio: 'inherit' });
}

// --- Tier 2: --real-steam (32-bit node + koffi-ia32) ---
function tier2() {
  const s32 = path.join(ROOT, '_steam32');
  const nodeDir = path.join(s32, `node-${NODE32_VER}-win-x86`);
  fs.mkdirSync(s32, { recursive: true });

  if (!exists(path.join(nodeDir, 'node.exe'))) {
    const zip = path.join(s32, 'node-x86.zip');
    download(`https://nodejs.org/dist/${NODE32_VER}/node-${NODE32_VER}-win-x86.zip`, zip);
    log('Tier2: extracting 32-bit node');
    un7z(zip, s32);
  } else log('Tier2: 32-bit node already present');

  // koffi JS (arch-independent) - copy from the main node_modules
  const koffiSrc = path.join(ROOT, 'node_modules', 'koffi');
  const koffiDst = path.join(s32, 'node_modules', 'koffi');
  if (!exists(koffiDst)) {
    if (!exists(koffiSrc)) throw new Error('run Tier1 first (pnpm install)');
    log('Tier2: copying koffi JS into _steam32');
    fs.cpSync(koffiSrc, koffiDst, { recursive: true });
  } else log('Tier2: koffi JS in _steam32 already present');

  // koffi-ia32 native binary (npm-install under x86 failed on permissions -> install from tarball)
  const iaDst = path.join(s32, 'node_modules', '@koromix', 'koffi-win32-ia32');
  if (!fs.existsSync(path.join(iaDst, 'win32_ia32', 'koffi.node'))) {
    const tgz = path.join(s32, 'koffi-ia32.tgz');
    download(`https://registry.npmjs.org/@koromix/koffi-win32-ia32/-/koffi-win32-ia32-${KOFFI_VER}.tgz`, tgz);
    const tmp = path.join(s32, '_koffi_ia32_tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    un7z(tgz, tmp);                                   // .tgz -> .tar
    const tar = fs.readdirSync(tmp).find(f => f.endsWith('.tar'));
    un7z(path.join(tmp, tar), tmp);                   // .tar -> package/
    fs.mkdirSync(iaDst, { recursive: true });
    fs.cpSync(path.join(tmp, 'package'), iaDst, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    log('Tier2: koffi-ia32 binary installed');
  } else log('Tier2: koffi-ia32 binary already present');

  if (!exists(path.join(s32, 'package.json')))
    fs.writeFileSync(path.join(s32, 'package.json'), '{"name":"steam32","private":true}\n');
}

// --- Tier 3 (optional): Goldberg + Ghidra/JDK ---
function tier3() {
  // Goldberg (x86 steam_api.dll) - for an own server with Steam emulation
  const gb = path.join(ROOT, '_goldberg');
  if (!exists(path.join(gb, 'extracted', 'steam_api.dll'))) {
    const sz = path.join(gb, 'emu-win-release.7z');
    download(`https://github.com/Detanup01/gbe_fork/releases/download/${GBE_RELEASE}/emu-win-release.7z`, sz);
    log('Tier3: extracting Goldberg x86 steam_api.dll');
    execFileSync(SEVENZIP, ['e', sz, 'release/regular/x86/steam_api.dll', '-o' + path.join(gb, 'extracted'), '-y'], { stdio: 'ignore' });
  } else log('Tier3: Goldberg already present');

  // Ghidra + JDK 21 - only for reverse-engineering Engine.dll
  const gh = path.join(ROOT, '_ghidra');
  if (!exists(path.join(gh, 'ghidra'))) {
    const zip = path.join(gh, 'ghidra.zip');
    download(GHIDRA_URL, zip);
    log('Tier3: extracting Ghidra (~550MB)');
    un7z(zip, path.join(gh, 'ghidra'));
  } else log('Tier3: Ghidra already present');
  if (!exists(path.join(gh, 'jdk'))) {
    const zip = path.join(gh, 'jdk.zip');
    download(JDK_URL, zip);
    log('Tier3: extracting JDK 21');
    un7z(zip, path.join(gh, 'jdk'));
  } else log('Tier3: JDK already present');
}

function main() {
  const all = process.argv.includes('--all');
  log('koffi=' + KOFFI_VER + '  7z=' + SEVENZIP);
  tier1();
  tier2();
  if (all) tier3();
  log('DONE. Core + --real-steam ready.' + (all ? ' Goldberg + Ghidra too.' : ' (for Goldberg/Ghidra: --all)'));
  log('Check: pnpm test');
}
main();
