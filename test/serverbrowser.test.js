// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan
'use strict';
// Server Browser source-merge logic: Steam is truth, GameTracker only adds connect-addrs Steam missed.
const assert = require('assert');
const { mergeServers, parseUt2Info } = require('../lib/serverbrowser');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } };

const steam = [
  { connect: '1.1.1.1:7707', name: 'Steam A', source: 'steam' },
  { connect: '2.2.2.2:7707', name: 'Steam B', source: 'steam' },
];
const gametracker = [
  { connect: '2.2.2.2:7707', name: 'GT dup (should be dropped)', source: 'gametracker' },
  { connect: '3.3.3.3:7717', name: 'GT only', source: 'gametracker' },
];
const merged = mergeServers(steam, gametracker);

ok('merges all unique connect addrs', merged.length === 3);
ok('steam entry wins over a gametracker duplicate', merged.find((s) => s.connect === '2.2.2.2:7707').source === 'steam');
ok('gametracker adds a server steam missed', !!merged.find((s) => s.connect === '3.3.3.3:7717' && s.source === 'gametracker'));
ok('empty gametracker keeps the steam list intact', mergeServers(steam, []).length === 2);
ok('no-steam falls back to gametracker only', mergeServers([], gametracker).length === 2);

// UT2004-native query info reply (gameport+1) -> wave column. Fixtures are byte-for-byte captures from
// live KF servers (2026-07-25): header 80 00 00 00 00, then ServerResponseLine fields.
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
// 74.91.124.124:7708 - "Lammah's KF - Long/KFO Map Vote", KF-Farm, 2/6 players, wave 10/10, flags 0x200.
const farm = hex(`
  80 00 00 00 00 00 00 00 00 00 1b 1e 00 00 00 00
  00 00 20 4c 61 6d 6d 61 68 27 73 20 4b 46 20 2d
  20 4c 6f 6e 67 2f 4b 46 4f 20 4d 61 70 20 56 6f
  74 65 00 08 4b 46 2d 46 61 72 6d 00 0b 4b 46 47
  61 6d 65 54 79 70 65 00 02 00 00 00 06 00 00 00
  0a 00 00 00 0a 00 00 00 00 00 00 00 00 02 00 00
  02 30 00 00 00`);
// 107.173.148.127:7708 - KF-AbusementPark, 0/6, wave 1/10 (0xa0 = colour-space in the name), flags 0x80.
const spooky = hex(`
  80 00 00 00 00 00 00 00 00 00 1b 1e 00 00 00 00
  00 00 19 54 68 65 a0 53 70 6f 6f 6b 79 a0 53 65
  72 76 65 72 a0 5b 42 6f 6f 21 5d 00 11 4b 46 2d
  41 62 75 73 65 6d 65 6e 74 50 61 72 6b 00 0b 4b
  46 47 61 6d 65 54 79 70 65 00 00 00 00 00 06 00
  00 00 01 00 00 00 0a 00 00 00 00 00 00 00 80 00
  00 00 02 30 00 00 00`);
const f = parseUt2Info(farm), s2 = parseUt2Info(spooky);
ok('ut2 info: game port', f && f.gamePort === 7707);
ok('ut2 info: server name', f && f.name === "Lammah's KF - Long/KFO Map Vote");
ok('ut2 info: map', f && f.map === 'KF-Farm');
ok('ut2 info: players', f && f.numPlayers === 2 && f.maxPlayers === 6);
ok('ut2 info: wave = CurrentWave/FinalWave', f && f.wave === '10/10');
ok('ut2 info: not passworded (flags 0x200 = difficulty only)', f && f.password === false);
ok('ut2 info: second fixture wave 1/10', s2 && s2.wave === '1/10');
ok('ut2 info: name parsed through colour-space bytes', s2 && s2.name.indexOf('Spooky') >= 0 && s2.name.indexOf('[Boo!]') >= 0);
ok('ut2 info rejects an A2S packet', parseUt2Info(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0, 0, 0])) === null);
ok('ut2 info rejects a truncated reply', parseUt2Info(farm.slice(0, 20)) === null);

// 45.77.126.130:7708 - KFTurbo, colour-coded 109-char name whose length is a two-byte FCompactIndex
// (6e 01 = 110 incl NUL): a single-byte length read misparses everything after it.
const turbo = hex(`
  80 00 00 00 00 00 00 00 00 00 1b 1e 00 00 00 00
  00 00 6e 01 1b 8b ac ec 4b 69 1b a2 bc ef 6c 6c
  1b b9 cd f3 69 6e 1b d0 dd f7 67 20 46 1b e7 ee
  fb 6c 6f 1b ff ff ff 6f 72 20 1b f8 c6 90 54 1b
  f8 a0 40 75 1b f8 7e 40 72 1b f8 40 40 62 6f 20
  1b f8 c6 90 53 1b f8 a0 40 65 1b f8 7e 40 72 1b
  f8 40 40 76 65 72 1b ff ff ff 20 2d 20 76 37 2e
  31 2e 31 20 2d 20 4c 6f 73 20 41 6e 67 65 6c 65
  73 00 1b 1b 8b ac ec 4b 46 2d 1b a2 bc ef 54 72
  61 1b b9 cd f3 6e 73 69 1b d0 dd f7 74 00 10 4b
  46 54 75 72 62 6f 47 61 6d 65 54 79 70 65 00 00
  00 00 00 06 00 00 00 01 00 00 00 0a 00 00 00 00
  00 00 00 10 00 00 00 02 30 00 00 00`);
const t = parseUt2Info(turbo);
ok('ut2 info: compact-index name length decoded', t && t.name.indexOf('Turbo Server') >= 0);
ok('ut2 info: colour codes stripped from map', t && t.map === 'KF-Transit');
ok('ut2 info: wave after a long name', t && t.wave === '1/10' && t.maxPlayers === 6);

console.log('serverbrowser self-test: ' + pass + ' passed, ' + fail + ' failed');
assert.strictEqual(fail, 0);
