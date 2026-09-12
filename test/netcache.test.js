// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Structural self-test for the .u parser + net cache (lib/upackage.js, lib/netcache.js).
// Needs the game's System dir (.u files); skips cleanly if none is found so CI stays green.
// Run: node test/netcache.test.js   (or set KF_SYSTEM_DIR=<path to ...\System>)
const fs = require('fs');
const path = require('path');
const { PackageSet, fieldNetIndex } = require('../lib/netcache');

function findSystemDir() {
  const candidates = [
    process.env.KF_SYSTEM_DIR,
    path.join(__dirname, '..', '_kfds', 'System'),
    'D:/games/SteamLibrary/steamapps/common/KillingFloor/System',
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'Engine.u')) && fs.existsSync(path.join(d, 'KFMod.u')));
}

const dir = findSystemDir();
if (!dir) {
  console.log('netcache self-test: SKIP (no KF System dir with Engine.u/KFMod.u; set KF_SYSTEM_DIR to run)');
  process.exit(0);
}

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const ps = new PackageSet(dir);

// Cross-package hierarchy resolves through KFMod.u -> XGame.u -> Engine.u -> Core.u.
const pawnChain = ps.hierarchy('KFHumanPawn');
ok('pawn chain root is Object', pawnChain[0] === 'Object', pawnChain.join('>'));
ok('pawn chain ends KFHumanPawn', pawnChain[pawnChain.length - 1] === 'KFHumanPawn', pawnChain.join('>'));
ok('pawn chain spans Pawn+xPawn', pawnChain.includes('Pawn') && pawnChain.includes('xPawn'), pawnChain.join('>'));

// Health is a replicated IntProperty declared in Pawn.
const pawn = ps.netFields('KFHumanPawn');
const health = pawn.find((f) => f.name === 'Health');
ok('Health is a net field', !!health, 'not found');
ok('Health type IntProperty', health && health.type === 'IntProperty', health && health.type);
ok('Health declared in Pawn', health && health.cls === 'Pawn', health && health.cls);

// The Actor-derived prefix is identical across every Actor subclass (same names, same order).
const actorFields = (cls) => ps.netFields(cls).filter((f) => f.cls === 'Actor').map((f) => f.name);
const pawnActor = actorFields('KFHumanPawn');
for (const cls of ['KFPlayerReplicationInfo', 'PlayerController']) {
  ok('Actor prefix matches for ' + cls, JSON.stringify(actorFields(cls)) === JSON.stringify(pawnActor),
    cls + ' differs');
}
ok('Actor prefix non-trivial', pawnActor.length >= 15, 'only ' + pawnActor.length);

// ServerReStartPlayer (the Ready RPC) is a net function; its index fits the wire field range.
const restart = fieldNetIndex(dir, 'KFPlayerController', 'ServerReStartPlayer');
ok('ServerReStartPlayer resolved', !!restart, 'null');
ok('restart index < GetMaxIndex', restart && restart.index < restart.max, restart && JSON.stringify(restart));
const restartField = ps.netFields('KFPlayerController').find((f) => f.name === 'ServerReStartPlayer');
ok('ServerReStartPlayer is a function', restartField && restartField.isFunc, 'not a func');

// ServerMove (movement RPC) also resolves.
ok('ServerMove resolved', !!fieldNetIndex(dir, 'KFPlayerController', 'ServerMove'), 'null');

// Regression: PropertyFlags must be parsed at its variable header offset, not a fixed 8.
// Location/Rotation carry CPF_Net but their flags sit at offset 7 - the offset-8 bug dropped
// them, which shifted every net index (PlayerName appeared at 22 instead of its real 57).
const actorNet = ps.fieldsOf('Actor').filter((f) => f.net && f.isProp).map((f) => f.name);
ok('Actor.Location detected as net', actorNet.includes('Location'), 'missed — PropertyFlags offset regressed');
ok('Actor.Rotation detected as net', actorNet.includes('Rotation'), 'missed — PropertyFlags offset regressed');
const pn = ps.netFields('KFPlayerReplicationInfo').find((f) => f.name === 'PlayerName');
// Ground-truth wire index from the capture (bot name "TestBot"); guard against the offset bug's 22.
ok('PlayerName wire index sane (>40)', pn && pn.index > 40, pn && 'index=' + pn.index);

// addParsed teaches a class the base set lacks so its net table (and RPC max) resolve like the real
// client after downloading - the path that makes a modded PlayerController's RPCs encode right. Register
// KFChar (a stock package NOT in DEFAULT_PACKAGES) under a fresh set and confirm one of its classes gains
// a net table whose ServerMove index matches the class it derives from.
{
  const fresh = new PackageSet(dir, ['Core', 'Engine', 'UnrealGame', 'XGame']);   // minimal base
  const n0 = Object.keys(fresh.classLoc).length;
  fresh.addParsed('KFChar', new (require('../lib/upackage').UPackage)(require('path').join(dir, 'KFChar.u')));
  ok('addParsed registers the package', !!fresh.pkgs['KFChar'], 'not registered');
  ok('addParsed exposes new classes to the net cache', Object.keys(fresh.classLoc).length > n0, 'classLoc did not grow');
  // Some class defined in KFChar now resolves to a real net table, spanning its inherited hierarchy.
  const someKFChar = Object.keys(fresh.classLoc).find((k) => fresh.classLoc[k].pkg === 'KFChar' && fresh.hierarchy(k).length > 2);
  ok('a taught KFChar class spans an inherited hierarchy', !!someKFChar && fresh.netFields(someKFChar).length > 0, 'no multi-level KFChar class resolved');
  const n1 = Object.keys(fresh.classLoc).length;
  fresh.addParsed('KFChar', fresh.pkgs['KFChar']);
  ok('addParsed is idempotent', Object.keys(fresh.classLoc).length === n1, 'classLoc grew on re-add');
}

console.log(`\nnetcache self-test (${dir}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
