// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Validate classifyName: item / trader / door / mover / monster / player classes land in the right map
// layer, and a controller (not a map entity) classifies to null.
// Run: node test/netobjmap.test.js
const assert = require('assert');
const { classifyName } = require('../lib/netobjmap');

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; console.log('PASS ' + n); };

ok('classifyName: KFAmmoPickup -> item', classifyName('KFAmmoPickup') === 'item');
ok('classifyName: M4Pickup -> item', classifyName('M4Pickup') === 'item');
ok('classifyName: Vest -> item', classifyName('Vest') === 'item');
ok('classifyName: ShopVolume -> trader', classifyName('ShopVolume') === 'trader');
ok('classifyName: KFTraderDoor1 -> door', classifyName('KFTraderDoor1') === 'door');
ok('classifyName: KFDoorMover2 -> door (door-named movers stay doors)', classifyName('KFDoorMover2') === 'door');
ok('classifyName: ShopDirectionPointer -> trader', classifyName('ShopDirectionPointer') === 'trader');
ok('classifyName: Mover3 -> mover (generic movers get their own layer)', classifyName('Mover3') === 'mover');
ok('classifyName: IMover7 -> mover', classifyName('IMover7') === 'mover');
ok('classifyName: ZombieScrake -> mon', classifyName('ZombieScrake') === 'mon');
ok('classifyName: KFHumanPawn -> player', classifyName('KFHumanPawn') === 'player');
ok('classifyName: KFPlayerController -> null (not a map entity)', classifyName('KFPlayerController') === null);

console.log('netobjmap self-test: ' + pass + ' passed, 0 failed');
