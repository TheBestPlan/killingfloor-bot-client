// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Round-trip self-test for the bit-stream codec. Run: node test/bitstream.test.js
const { BitWriter, BitReader } = require('../lib/bitstream');

let pass = 0, fail = 0;
function eq(name, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; } else { fail++; console.error(`FAIL ${name}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
}

// bits
{
  const w = new BitWriter();
  const pattern = [1,0,1,1,0,0,0,1,1,0];
  for (const b of pattern) w.writeBit(b);
  const r = new BitReader(w.toBuffer(), w.bitLength());
  const out = []; for (let i = 0; i < pattern.length; i++) out.push(r.readBit());
  eq('bits', pattern, out);
}

// writeInt / readInt for the framing maxes
for (const max of [8, 1024, 4096, 16384, 1023]) {
  for (const v of [0, 1, 2, 7, 100, 500, max - 1]) {
    if (v >= max) continue;
    const w = new BitWriter(); w.writeInt(v, max);
    const r = new BitReader(w.toBuffer(), w.bitLength());
    eq(`int max=${max} v=${v}`, v, r.readInt(max));
  }
}

// bytes
{
  const w = new BitWriter();
  // misalign by 3 bits then write bytes (bunch payload is rarely byte-aligned)
  w.writeBit(1); w.writeBit(0); w.writeBit(1);
  const data = [0x00, 0xff, 0x41, 0x93, 0x7e];
  for (const b of data) w.writeByte(b);
  const r = new BitReader(w.toBuffer(), w.bitLength());
  r.readBit(); r.readBit(); r.readBit();
  const out = []; for (let i = 0; i < data.length; i++) out.push(r.readByte());
  eq('bytes misaligned', data, out);
}

// FCompactIndex
for (const v of [0, 1, -1, 63, 64, -64, 8191, 8192, 100000, -100000, 16383, 2147483646]) {
  const w = new BitWriter(); w.writeIndex(v);
  const r = new BitReader(w.toBuffer(), w.bitLength());
  eq(`index ${v}`, v, r.readIndex());
}

// FString (ANSI), including misaligned
{
  for (const s of ['', 'HELLO', 'HELLO REVISION=0 MINVER=3180 VER=3369', 'A', '?Name=Bot?Team=0']) {
    const w = new BitWriter();
    w.writeBit(1); w.writeBit(1); // misalign
    w.writeString(s);
    const r = new BitReader(w.toBuffer(), w.bitLength());
    r.readBit(); r.readBit();
    eq(`string "${s}"`, s, r.readString());
  }
}

// Known FCompactIndex encodings (byte-level sanity vs UE spec)
{
  // value 0 -> single byte 0x00
  let w = new BitWriter(); w.writeIndex(0);
  eq('index 0 bytes', [0x00], Array.from(w.toBuffer()));
  // value 63 -> 0x3f (fits in 6 data bits, no sign, no continue)
  w = new BitWriter(); w.writeIndex(63);
  eq('index 63 bytes', [0x3f], Array.from(w.toBuffer()));
  // value 64 -> 0x40|0x00=0x40 (continue set, low6=0), then 0x01
  w = new BitWriter(); w.writeIndex(64);
  eq('index 64 bytes', [0x40, 0x01], Array.from(w.toBuffer()));
  // value -1 -> 0x81 (sign set, low6=1)
  w = new BitWriter(); w.writeIndex(-1);
  eq('index -1 bytes', [0x81], Array.from(w.toBuffer()));
}

console.log(`\nbitstream self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
