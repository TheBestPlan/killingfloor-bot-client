// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Self-test for BotSession._reportDamage - the HP-delta -> Events-log translation (damage / heal /
// death / spawn). Exercised on the prototype with a captured _log, no socket/session needed.
// Run: node test/damageevents.test.js
const assert = require('assert');
const { BotSession } = require('../lib/botsession');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('PASS ' + name); };

// A bare BotSession with just the fields _reportDamage touches + a captured log.
function harness() {
  const bs = Object.create(BotSession.prototype);
  bs._logs = [];
  bs._log = (l) => bs._logs.push(l);
  bs._now = 0;
  // freeze Date.now via the debounce fields the method reads (it uses Date.now for spawn/death gating);
  // feed states spaced far enough apart that the 1.5s debounce never blocks a distinct event.
  return bs;
}
const feed = (bs, states) => { for (const s of states) bs._reportDamage(s); };

{
  const bs = harness();
  feed(bs, [{ alive: true, spawned: true, hp: 100 }]);
  ok('first sample is silent (baseline)', bs._logs.length === 0);
}

{
  const bs = harness();
  feed(bs, [{ alive: true, spawned: true, hp: 100 }, { alive: true, spawned: true, hp: 79 }]);
  ok('damage line shows amount + new HP', bs._logs.length === 1 && bs._logs[0] === '>>> took 21 damage — HP 79');
}

// Full HP that never replicated reads as 100, so the first real value below it is damage from 100.
{
  const bs = harness();
  feed(bs, [{ alive: true, spawned: true, hp: 100 }, { alive: true, spawned: true, hp: 63 }]);
  ok('unreplicated-full baseline yields correct first-hit damage', bs._logs[0] === '>>> took 37 damage — HP 63');
}

{
  const bs = harness();
  feed(bs, [{ alive: true, spawned: true, hp: 40 }, { alive: true, spawned: true, hp: 75 }]);
  ok('heal line shows the gain', bs._logs[0] === '>>> healed +35 — HP 75');
}

{
  const bs = harness();
  feed(bs, [{ alive: true, spawned: true, hp: 88 }, { alive: true, spawned: true, hp: 88 }]);
  ok('unchanged HP emits nothing', bs._logs.length === 0);
}

{
  const bs = harness();
  feed(bs, [{ alive: true, spawned: true, hp: 12 }, { alive: false, spawned: false, hp: 0 }]);
  ok('death line reports the prior HP', bs._logs[0] === '>>> YOU DIED — was 12 HP');
}

{
  const bs = harness();
  feed(bs, [{ alive: false, spawned: false, hp: null }, { alive: true, spawned: true, hp: null }]);
  ok('spawn line shows default HP 100', bs._logs[0] === '>>> spawned — HP 100');
}

// Death is debounced: a same-tick-cluster flicker doesn't double-log within 1.5s.
{
  const bs = harness();
  feed(bs, [
    { alive: true, spawned: true, hp: 5 },
    { alive: false, spawned: false, hp: 0 },
    { alive: true, spawned: true, hp: 100 },   // channel churn re-adds the pawn briefly
    { alive: false, spawned: false, hp: 0 },
  ]);
  const deaths = bs._logs.filter((l) => /YOU DIED/.test(l)).length;
  ok('death is debounced against relevancy churn', deaths === 1);
}

console.log('damageevents self-test: ' + pass + ' passed, 0 failed');
