// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan
'use strict';
// #3 anti-stall in BotSession._tickMove: when the server-confirmed position stops advancing during an active
// move (the pawn is wedged against geometry and the LEASH freezes the on-screen estimate), the tick must
// re-route via the nav graph, and sidestep when no route exists - instead of the square sitting frozen.
const assert = require('assert');
const { BotSession } = require('../lib/botsession');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ok ' + name); pass++; };

let navCalls = 0, sidesteps = 0, sent = 0;
const bot = Object.create(BotSession.prototype);
bot.joined = true; bot.closed = false; bot.leaving = false;
bot._log = (l) => { if (/sidestep/.test(l)) sidesteps++; };
bot.world = {
  selfPos: () => ({ x: 100, y: 100, z: 0 }),   // FROZEN server position = wedged pawn
  myPawn: 5, stats: { hp: 100 }, selfEstimate: null, selfAdjustPos: { x: 100, y: 100 },
  corrCount: 1, now: () => Date.now(), objects: {},
};
bot._movePawn = 5;
bot._movePath = [{ x: 2000, y: 100, z: 0 }];
bot._moveTarget = { x: 2000, y: 100, z: 0 };
bot._finalTarget = { x: 2000, y: 100 };
bot._moveUntil = Date.now() + 60000;
bot._rpcIndex = () => ({ index: 1, max: 100 });
bot._sendServerMove = () => { sent++; };
bot._updateMeasuredSpeed = () => {};
bot._rpcChannels = () => [1];
bot._stopMoveTimer = () => {};
bot._nav = { findPath: () => { navCalls++; return [{ x: 100, y: 600, z: 0 }, { x: 2000, y: 100, z: 0 }]; } };

bot._tickMove();
ok('tick streams a ServerMove', sent >= 1);
ok('no reroute before a stall', navCalls === 0);

bot._moveProgAt = Date.now() - 3000;   // 3s without forward progress (> the 2.5s stall window)
bot._moveProg = { x: 100, y: 100 };
bot._tickMove();
ok('re-routes via nav on a stall', navCalls >= 1);

bot._nav = null; bot._moveProgAt = Date.now() - 3000; bot._moveProg = { x: 100, y: 100 }; bot._stallCount = 0;
bot._tickMove();
ok('sidesteps when no nav route exists', sidesteps >= 1);

console.log('move-stall self-test: ' + pass + ' passed, 0 failed');
