// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Round-trip self-test for the replication decode primitives (lib/repdecode.js, lib/bitstream.js).
// Run: node test/repdecode.test.js
const { BitWriter, BitReader } = require('../lib/bitstream');
const { readIntUE, readPackedVector, writePackedVector, decodeBunch } = require('../lib/repdecode');

let pass = 0, fail = 0;
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`FAIL ${name}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
}

// Value-aware SerializeInt must round-trip (writeIntUE <-> readIntUE), incl. non-power-of-2 maxes.
for (const max of [20, 79, 144, 236, 281, 1024]) {
  for (const v of [0, 1, 2, 21, 57, 61, max - 1]) {
    if (v >= max) continue;
    const w = new BitWriter(); w.writeIntUE(v, max);
    const r = new BitReader(w.toBuffer(), w.bitLength());
    eq(`intUE max=${max} v=${v}`, v, readIntUE(r, max));
  }
}

// Packed vector round-trips (integer components; the format reversed from Engine.dll).
for (const vec of [[0, 0, 0], [-46, 1217, -44], [42, -1106, -44], [3000, -8000, 500], [-1, 1, -1]]) {
  const w = new BitWriter(); writePackedVector(w, vec[0], vec[1], vec[2]);
  const r = new BitReader(w.toBuffer(), w.bitLength());
  eq(`packedVec ${vec}`, vec, readPackedVector(r).value);
}

// Lock the packed-vector bias/width to the SERVER's format (nbm1 on wire, bias=2^numBits,
// compMax=2^(numBits+1)) - verified live against KFDS ServerMove (pawn accelerates in the commanded
// direction) and position corrections. The old off-by-one (bias=2^(numBits+1)) round-trips fine but
// desyncs against the server: it changes this vector's width (46 vs 49 bits) and mis-decodes real data.
{
  const w = new BitWriter(); writePackedVector(w, 6000, 0, 0);
  eq('packedVec width locks server bias', 46, w.bitLength());
  const s = new BitWriter(), nb = 13, bias = 2 ** nb, cmax = 2 ** (nb + 1);   // server-side hand-encode
  s.writeIntUE(nb - 1, 20); s.writeIntUE(1234 + bias, cmax); s.writeIntUE(-77 + bias, cmax); s.writeIntUE(0 + bias, cmax);
  const sr = new BitReader(s.toBuffer(), s.bitLength());
  eq('packedVec decodes server format', [1234, -77, 0], readPackedVector(sr).value);
}

// decodeBunch parses [handle][value] pairs against a tiny net cache.
{
  const cache = [{ index: 0, name: 'Location', type: 'StructProperty' }, { index: 1, name: 'Health', type: 'IntProperty' }];
  for (let i = 2; i < 10; i++) cache.push({ index: i, name: 'f' + i, type: 'ByteProperty' });
  const w = new BitWriter();
  w.writeIntUE(1, cache.length); w.writeBits(87 >>> 0, 32);   // handle 1 (Health) = 87
  const r = new BitReader(w.toBuffer(), w.bitLength());
  const d = decodeBunch(w.toBuffer().toString('hex'), w.bitLength(), cache, {});
  const health = d.fields.find((f) => f.name === 'Health');
  eq('decodeBunch Health', 87, health && health.value);
}

// RPC param encoding: value-aware field index + per-param presence bit + FString (the ServerSay
// format). The framing writeInt would emit a different width for 135/281 and shift the string.
{
  const w = new BitWriter();
  w.writeIntUE(135, 281);      // ServerSay index
  w.writeBit(1);               // param presence gate
  w.writeString('hi there');
  const r = new BitReader(w.toBuffer(), w.bitLength());
  eq('rpc index value-aware', 135, readIntUE(r, 281));
  eq('rpc param gate', 1, r.readBit());
  eq('rpc string param', 'hi there', r.readString());
}

console.log(`\nrepdecode self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
