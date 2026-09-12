// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Smoke-check the Virtual Map top-down renderer against a stock map (skipped when no KF install).
const assert = require('assert');
const { findMapRom, renderTopDown } = require('../lib/maprender');

const rom = findMapRom('KF-WestLondon', null);
if (!rom) { console.log('skip: stock KF install not found — maprender smoke skipped'); process.exit(0); }

const r = renderTopDown(rom, 512, null);
assert(r && r.png && r.png.length > 8, 'png produced');
assert.deepStrictEqual([...r.png.subarray(0, 4)], [137, 80, 78, 71], 'PNG signature');
assert(r.w > 0 && r.h > 0 && r.w <= 512 && r.h <= 512, 'dimensions within maxDim');
const b = r.bounds;
assert(b.minX < b.maxX && b.minY < b.maxY, 'sane bounds');
// playable-bounds crop: WestLondon's play area is ~10k uu across - sky/void geometry would be far bigger
assert(b.maxX - b.minX < 30000 && b.maxY - b.minY < 30000, 'bounds cropped to playable area');
console.log('maprender self-test: OK (' + r.w + 'x' + r.h + ')');
