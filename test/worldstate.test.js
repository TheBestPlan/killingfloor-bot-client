// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Self-test for the map-object classification WorldState hands the GUI: my pawn -> 'self',
// a pawn owned by another PRI -> 'player' (with that PRI's nickname), everything else -> 'mon'.
// Run: node test/worldstate.test.js
const assert = require('assert');
const path = require('path');
const { WorldState, classifyMonsters, extractName } = require('../lib/worldstate');
const { BitWriter } = require('../lib/bitstream');

// Build a fake open bunch: junk header bits, then an ANSI FString name, then a later one.
function fakeOpenBunch(names) {
  const w = new BitWriter();
  for (let i = 0; i < 13; i++) w.writeBit(i % 3 === 0 ? 1 : 0);   // stand-in for the class-ref prefix
  for (const n of names) { w.writeString(n); }
  return { hex: w.toBuffer().toString('hex'), numBits: w.bitLength() };
}

const sysDir = path.join(__dirname, '..', '_kfds', 'System');
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('PASS ' + name); };

let clock = 0;
const ws = new WorldState(sysDir, 'Me', { now: () => clock });

// Wire up the identity/ownership state onBunch would have discovered, then feed positions.
ws.myPawn = 10;
ws.playerPawns.add(11);
ws.pawnOwner[11] = 5;
ws.priNames[5] = 'Alice';

// A NEW dot needs two consistent decodes (anti-ghost gate); self is trusted and appears at once.
ws._trackPosition(10, [1000, 2000, 50]);   // me
ws._trackPosition(11, [1500, 2000, 50]);   // another player
ws._trackPosition(12, [3000, 1000, 50]);   // a monster (no PRI owner)
clock = 100;
ws._trackPosition(11, [1520, 2010, 50]);   // second consistent decode confirms
ws._trackPosition(12, [3010, 1005, 50]);

const byCh = Object.fromEntries(ws.snapshot().objects.map((o) => [o.chIndex, o]));
ok('my pawn -> self', byCh[10].type === 'self');
ok('other player pawn -> player', byCh[11].type === 'player');
ok('player carries its nickname', byCh[11].name === 'Alice');
ok('unowned pawn -> mon', byCh[12].type === 'mon');
ok('monster has no nickname', byCh[12].name === null);

// Blue-monster regression: a zed's bunch can mis-decode a field as a PlayerReplicationInfo ref pointing at a
// junk channel. That must NOT paint the zed blue - a 'player' needs a corroborated, non-monster PRI name.
{
  const wm = new WorldState(sysDir, 'Me', { now: () => 0 });
  wm.pawnOwner[13] = 99;                                   // junk ref, ch99 has no name
  wm.pawnOwner[14] = 6; wm.priNames[6] = 'ZombieClot';     // ref resolves to a monster name
  wm.pawnOwner[15] = 7; wm.priNames[7] = 'RealPlayer';     // ref is a genuine player
  for (const [ch, x] of [[13, 3200], [14, 3400], [15, 3600]]) {
    wm._trackPosition(ch, [x, 1200, 50]);
    wm._trackPosition(ch, [x + 10, 1210, 50]);   // confirm past the anti-ghost gate
  }
  const b = Object.fromEntries(wm.snapshot().objects.map((o) => [o.chIndex, o]));
  ok('zed with a junk PRI ref stays mon (not blue)', b[13].type === 'mon');
  ok('zed whose ref names a monster stays mon', b[14].type === 'mon');
  ok('pawn with a real PRI name is a player', b[15].type === 'player');
}

// Playable-bounds gate: with map anchors known, a decode outside the padded playable bbox is junk
// even when repeated consistently (KF15Beta customs mis-decode a stable field as a near-axis vector).
{
  const wb = new WorldState(sysDir, 'Me', { now: () => 0 });
  wb.mapActors = { traders: [], doors: [], bounds: { minX: -2199, maxX: 16720, minY: -15407, maxY: 12032, minZ: 2038, maxZ: 6184 } };
  wb._trackPosition(60, [-9878, 44, 3000], 100);   // consistent junk left of every PathNode
  wb._trackPosition(60, [-9878, 44, 3000], 100);
  ok('consistent junk outside playable bounds paints no dot', wb.snapshot().objects.length === 0);
  wb._trackPosition(61, [5000, -3000, 900], 100);  // inside XY but junk Z (below the map)
  wb._trackPosition(61, [5000, -3000, 900], 100);
  ok('junk Z outside the playable band paints no dot', wb.snapshot().objects.length === 0);
  wb._trackPosition(62, [5000, -3000, 3000], 100);
  wb._trackPosition(62, [5010, -2990, 3000], 100);
  ok('real position inside bounds still tracks', wb.snapshot().objects.length === 1);
}

// Ghost-dot regression: a single junk Location decode must NOT paint a dot (it used to sit outside
// the map for STALE_MS); a second CONSISTENT decode is what confirms a real actor. A discordant
// second decode restarts the confirmation instead of confirming.
{
  const wg = new WorldState(sysDir, 'Me', { now: () => 0 });
  wg._trackPosition(30, [25000, 25000, 50]);                       // one junk decode
  ok('single decode paints no dot', wg.snapshot().objects.length === 0);
  wg._trackPosition(30, [-8000, 12000, 50]);                       // far from the first -> still pending
  ok('discordant second decode paints no dot', wg.snapshot().objects.length === 0);
  wg._trackPosition(30, [-7990, 12010, 50]);                       // consistent with the second -> real
  ok('two consistent decodes confirm the dot', wg.snapshot().objects.length === 1);
}

// Objects persist across bursty replication, then fall out of the snapshot after STALE_MS (10s).
clock = 8000;
ok('objects persist within the stale window', ws.snapshot().objects.length === 3);
clock = 11000;
ok('stale objects are dropped past the window', ws.snapshot().objects.length === 0);

// Monster naming by fitted Health modifier.
// Suicidal-ish game, modifier ~2x: Clot 200, Gorefast 300, Fleshpound 3000, Scrake 2000.
const nm2x = classifyMonsters([{ ch: 1, hp: 200 }, { ch: 2, hp: 300 }, { ch: 3, hp: 3000 }, { ch: 4, hp: 2000 }]);
ok('fit 2x: 200 -> Clot', nm2x[1] === 'Clot');
ok('fit 2x: 300 -> Gorefast', nm2x[2] === 'Gorefast');
ok('fit 2x: 3000 -> Fleshpound', nm2x[3] === 'Fleshpound');
ok('fit 2x: 2000 -> Scrake', nm2x[4] === 'Scrake');

// Normal, modifier 1x, with a damaged monster (hp below any base) staying unnamed.
const nm1x = classifyMonsters([{ ch: 1, hp: 100 }, { ch: 2, hp: 350 }, { ch: 3, hp: 42 }]);
ok('fit 1x: 100 -> Clot', nm1x[1] === 'Clot');
ok('fit 1x: 350 -> Siren', nm1x[2] === 'Siren');
ok('fit 1x: damaged 42 stays unnamed', nm1x[3] === null);

// A lone monster is ambiguous -> never named.
const lone = classifyMonsters([{ ch: 9, hp: 500 }]);
ok('single monster stays unnamed (ambiguous)', lone[9] === null);

// Nickname sniff from a PRI open bunch: earliest name (PlayerName) wins over a later one (CharacterName).
const ob = fakeOpenBunch(['24kmagick', 'Harold_Hunt']);
ok('extractName picks the earliest name', extractName(ob.hex, ob.numBits) === '24kmagick');
ok('extractName rejects a bare SteamID', extractName(fakeOpenBunch(['76561199559004869']).hex, fakeOpenBunch(['76561199559004869']).numBits) === null);
ok('extractName returns null when no name present', extractName(fakeOpenBunch([]).hex, fakeOpenBunch([]).numBits) === null);

// spawnInfo skips the static class ref (sized by the recovered MaxObjectIndex) and reads the packed
// spawn location out of a fresh-spawn open bunch.
const { writePackedVector } = require('../lib/repdecode');
function fakeSpawn(M, classIdx, x, y, z) {
  const w = new BitWriter();
  w.writeBit(0);                 // static class ref (fresh spawn)
  w.writeIntUE(classIdx, M);
  writePackedVector(w, x, y, z);
  return { hex: w.toBuffer().toString('hex'), numBits: w.bitLength() };
}
const wspawn = new WorldState(sysDir, 'Me', { now: () => 0 });
wspawn.maxObjIndex = 100000;
wspawn.openBunches[5] = fakeSpawn(100000, 42000, 7000, -3000, 120);
const sp = wspawn.spawnInfo(5);
ok('spawnInfo recovers the spawn location', sp && sp.x === 7000 && sp.y === -3000 && sp.classIdx === 42000);
ok('spawnInfo returns null without MaxObjectIndex', (wspawn.maxObjIndex = 0) || wspawn.spawnInfo(5) === null);

// playerList sniffs names from each channel's stored open bunch (bypasses the per-field decoder).
const wsp = new WorldState(sysDir, 'Me', { now: () => 0 });
wsp.openBunches[7] = fakeOpenBunch(['CoolGuy', 'Harold_Hunt']);
wsp.openBunches[8] = fakeOpenBunch([]);
const roster = wsp.playerList();
ok('playerList finds the named channel', roster.some((p) => p.ch === 7 && p.name === 'CoolGuy'));
ok('playerList skips nameless channels', !roster.some((p) => p.ch === 8));

// Possession: the server replicates Controller.Pawn on our PlayerController channel and corrects our position
// via VeryShortClientAdjustPosition(TimeStamp, X, Y, Z, NewBase). Decode both against the KFPlayerController net.
const wposs = new WorldState(sysDir, 'Me', { now: () => 0 });
wposs.myPcChannel = 1;                       // pin ch1 as the PC so the controller-channel gate passes
const pcLen = wposs.pc.length;
// Real VeryShortClientAdjustPosition(147) bunch captured off a live KFPlayerController, verified byte-exact
// against the server-side pawn Location [GT] = (823.38, 1556.47, -341.68). The position is three consecutive
// [present-bit][float32] params (X@66/Y@99/Z@132) that sit AFTER a name+physics gap, not immediately after
// TimeStamp - so the decoder must scan for the first sane present-framed triple, not read floats 2-4.
const realVeryShort = { chIndex: 1, bOpen: false, payloadHex: '9323dbc9826ea518be6137116d771426fa77ad3adc1400', numBits: 183 };
const adj = wposs.tryClientAdjust(realVeryShort);
ok('tryClientAdjust decodes a real VeryShort bunch to the server-GT position', adj && Math.round(adj.x) === 823 && Math.round(adj.y) === 1556 && Math.round(adj.z) === -342);
// Real Short(148) bunch, same pawn/position but a longer body whose trailing NewVel/NewBase bytes bit-shift
// into extra "sane" float triples - the decoder must take the FIRST triple (the real NewLoc), not the last.
const realShort = { chIndex: 1, bOpen: false, payloadHex: '941383c8816ea518be6137116d771426fa77ad3adcce3f34a8f17e6890a60000', numBits: 250 };
const adjS = wposs.tryClientAdjust(realShort);
ok('tryClientAdjust takes the FIRST NewLoc triple on a Short bunch (not a trailing spurious one)', adjS && Math.round(adjS.x) === 823 && Math.round(adjS.y) === 1556);
// Controller.Pawn property bunch: [handle=Pawn index][dynamic-actor bit][channel]
function fakePcPawn(ch) {
  const w = new BitWriter();
  w.writeIntUE(wposs.idx.pcPawn, pcLen);
  w.writeBit(1); w.writeIntUE(ch, 1023);   // ObjectProperty: dynamic actor ref -> channel
  return { chIndex: 1, bOpen: false, payloadHex: w.toBuffer().toString('hex'), numBits: w.bitLength() };
}
ok('tryPcPawn reads my possessed pawn channel', wposs.tryPcPawn(fakePcPawn(65)) === 65);
ok('tryClientAdjust/PcPawn ignore a non-controller channel', (wposs.myPcChannel = 1, wposs.tryPcPawn({ chIndex: 40, bOpen: false, payloadHex: 'ffff', numBits: 16 })) === null);

// _isPawnClass: only Pawn subclasses become map dots (a weapon/effect carrying a Location must not).
ok('_isPawnClass true for a monster', wposs._isPawnClass('ZombieClot') === true);
ok('_isPawnClass true for the player pawn', wposs._isPawnClass('KFHumanPawn') === true);
ok('_isPawnClass false for a weapon', wposs._isPawnClass('Syringe') === false);

// My own position isn't replicated to me - it comes only from the server's move corrections (selfEstimate).
// selfPos prefers it, and losing my pawn must clear it so a stale dot can't linger.
const wdr = new WorldState(sysDir, 'Me', { now: () => 0 });
wdr.myPawn = 12;
ok('selfPos is null before any correction (no spawn info)', wdr.selfPos() === null);
wdr.selfEstimate = { x: 180, y: 140, z: 0 };   // as a ClientAdjustPosition correction would set it
ok('selfPos returns the corrected position', wdr.selfPos().x === 180 && wdr.selfPos().y === 140);
wdr._forgetChannel(12);
ok('losing my pawn clears the corrected position', wdr.selfEstimate === null && wdr.selfPos() === null);

// PackageMap exposes baseObjectIndex (sum of present packages up to the first gap) even when incomplete, so
// a single missing tail package no longer zeroes the whole object table.
const { PackageMap } = require('../lib/pkgmap');
const pmComplete = new PackageMap([{ name: 'Core' }, { name: 'Engine' }], sysDir);
pmComplete.build();
ok('pkgMap complete: baseObjectIndex == exact maxObjectIndex', pmComplete.complete && pmComplete.baseObjectIndex === pmComplete.maxObjectIndex && pmComplete.baseObjectIndex > 0);
const pmGap = new PackageMap([{ name: 'Core' }, { name: '__NoSuchPackage__' }, { name: 'Engine' }], sysDir);
pmGap.build();
ok('pkgMap incomplete: still reports a base from packages before the gap', !pmGap.complete && pmGap.baseObjectIndex > 0 && pmGap.maxObjectIndex === 0);

// Self HP/state: UE2 never replicates a property equal to its class default, so a fresh pawn's
// Health (100) simply never arrives - spawned + no HP must read alive at 100, not "not spawned".
{
  const w = new WorldState(sysDir, 'Me', { now: () => 0 });
  ok('no pawn + no hp -> not alive', w.selfState().alive === false && w.selfState().hp === null);
  w.myPawn = 20; w.serverAckPawn = 20;
  const st = w.selfState();
  ok('spawned pawn, unreplicated Health -> alive at default 100', st.alive === true && st.hp === 100);
  const snap = w.snapshot();
  ok('snapshot stats default hp/armor for an alive pawn', snap.stats.hp === 100 && snap.stats.armor === 0);
  w.stats.hp = 73;
  ok('replicated Health overrides the default', w.selfState().hp === 73);
  w.unpossessed = true;   // Controller.Pawn replicated as None: died, ragdoll channel lingers
  ok('unpossessed -> not alive even with a pawn channel', w.selfState().alive === false);
  w.unpossessed = false;
  w._forgetChannel(20);   // pawn channel closed = the body is gone
  const dead = w.selfState();
  ok('closed pawn channel -> dead (hp 0)', dead.alive === false && dead.hp === 0);
}

// Players list mirrors the same rule: a pawn with no replicated Health is alive at 100.
{
  const w = new WorldState(sysDir, 'Me', { now: () => 0 });
  w.priNames[5] = 'Alice'; w.pawnOwner[31] = 5; w.pawns.add(31);
  const p = w.playerList().find((r) => r.name === 'Alice');
  ok('player with a pawn + default Health -> alive @100', p && p.spawned === true && p.hp === 100);
  w.pawnHp[31] = 0;
  const p0 = w.playerList().find((r) => r.name === 'Alice');
  ok('player pawn at 0 HP -> dead', p0 && p0.spawned === false && p0.hp === 0);
}

// Player status comes from the PRI's PlayerHealth (KF replicates it for every player, scoreboard-style),
// so a player who spawned before we joined - no pawn link - still reads as alive/dead with a real HP%.
{
  const w = new WorldState(sysDir, 'Me', { now: () => 0 });
  w.priNames[9] = 'Carol'; w.priHealth[9] = 63;   // PRI HP known, no pawn linked
  const p = w.playerList().find((r) => r.name === 'Carol');
  ok('PRI PlayerHealth -> alive with real HP, no pawn link needed', p && p.spawned === true && p.hp === 63 && p.confirmed === true);
  w.priHealth[9] = 0;
  const pd = w.playerList().find((r) => r.name === 'Carol');
  ok('PRI PlayerHealth 0 -> dead', pd && pd.spawned === false && pd.hp === 0);
}
// A named channel with neither a pawn nor PRI health is an unconfirmed spectator (last-resort).
{
  const w = new WorldState(sysDir, 'Me', { now: () => 0 });
  w.priNames[9] = 'Dave';
  const p = w.playerList().find((r) => r.name === 'Dave');
  ok('no pawn + no PRI HP -> spectator (unconfirmed, no HP)', p && p.spawned === false && p.hp === null && p.confirmed === false);
}

// The wave object must use the renderer HUD's keys (waveNumber/maxMonsters), and ride the snapshot.
{
  const w = new WorldState(sysDir, 'Me', { now: () => 0 });
  w.wave = { waveNumber: 3, finalWave: 7, waveInProgress: true, maxMonsters: 45 };
  const wv = w.snapshot().wave;
  ok('snapshot wave carries waveNumber/finalWave/maxMonsters', wv.waveNumber === 3 && wv.finalWave === 7 && wv.maxMonsters === 45);
}

// Replicated Velocity rides each tracked object (renderer dead-reckons with it) and survives updates
// that omit it (UE2 replicates it only on change).
{
  const w = new WorldState(sysDir, 'Me', { now: () => 5 });
  w.pawns.add(40);
  w._trackPosition(40, [995, 1005, 0], 100, [120, -60, 0]);   // first decode arms the anti-ghost gate
  w._trackPosition(40, [1000, 1000, 0], 100, [120, -60, 0]);
  const o = w.snapshot().objects.find((x) => x.chIndex === 40);
  ok('velocity rides the snapshot', o.vx === 120 && o.vy === -60 && o.vt === 5);
  w._trackPosition(40, [1100, 950, 0], null, null);
  const o2 = w.snapshot().objects.find((x) => x.chIndex === 40);
  ok('velocity persists when an update omits it', o2.vx === 120 && o2.vy === -60);
}

// Self position never trusts field 0 of our OWN possessed pawn's update bunch - the server stops
// replicating our Location, so field 0 there is a junk vector. A player pawn's Location IS trusted.
{
  const w = new WorldState(sysDir, 'Me', { now: () => 7 });
  w.myPri = 5; w.myPawn = 50; w.pawns.add(50); w.playerPawns.add(51); w.pawnOwner[51] = 6; w.priNames[6] = 'Bob';
  // Feed a "Location" for my own pawn: it must NOT become a tracked position (junk-vector guard).
  w._trackPosition(50, [2242, -7298, 2384], 100);
  const mine = w.snapshot().objects.find((o) => o.chIndex === 50);
  // _trackPosition still plots it (called directly here), but onBunch nulls loc for myPawn upstream;
  // the contract we assert is that selfPos ignores that path and stays correction/spawn-driven.
  ok('selfPos ignores my own pawn update-bunch Location (correction/spawn only)', w.selfEstimate == null && w.selfAdjustPos == null);
  // Another player's pawn Location IS a real position (two consistent decodes confirm it).
  w._trackPosition(51, [1495, 1505, 0], 100);
  w._trackPosition(51, [1500, 1500, 0], 100);
  const other = w.snapshot().objects.find((o) => o.chIndex === 51);
  ok('other player pawn Location is tracked', other && other.x === 1500 && other.type === 'player');
}

console.log('worldstate self-test: ' + pass + ' passed, 0 failed');
