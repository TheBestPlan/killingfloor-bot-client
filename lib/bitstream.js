// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * UE2.5 (UT2004 / Killing Floor) bit-stream primitives.
 *
 * The Unreal net protocol is a *bit* stream, not a byte stream. Bits are packed
 * LSB-first within each byte (bit N -> byte N>>3, mask 1<<(N&7)). All the integer
 * fields in the packet/bunch framing are written with WriteInt(value, Max), which
 * emits exactly ceil(log2(Max)) bits (one bit per Mask=1,2,4,... while Mask<Max).
 *
 * Sources (see docs/PROTOCOL.md):
 *   - UT99 v432 public headers (UnBits.h / UnNet.h) - FBitReader/Writer, MAX_* consts
 *   - gildor2/UEViewer UnCoreSerialize.cpp - FString / FCompactIndex byte layout
 *
 * NOTE on ReadInt/WriteInt symmetry: real UE's reader uses a value-aware early-out
 * `(Value+Mask)<Max`, the writer uses `Mask<Max`. For power-of-two Max (all the
 * framing maxes: 16384/1024/8/4096) and for small values of the only non-pow2 max
 * (MAX_CHANNELS=1023, channels 0..510) the two are identical. We implement the
 * symmetric `Mask<Max` form on both sides; the edge case (channel index 511..1022)
 * is flagged in netconn.js and resolved by capture if it ever bites.
 */

class BitWriter {
  constructor() {
    this.bytes = [];
    this.numBits = 0;
  }
  writeBit(b) {
    const byteIndex = this.numBits >>> 3;
    if (byteIndex >= this.bytes.length) this.bytes.push(0);
    if (b) this.bytes[byteIndex] |= (1 << (this.numBits & 7));
    this.numBits++;
  }
  writeBits(value, nbits) {
    for (let i = 0; i < nbits; i++) this.writeBit((value >>> i) & 1);
  }
  // ceil(log2(Max)) bits, LSB-first. Mirrors FBitWriter::WriteInt.
  writeInt(value, max) {
    for (let mask = 1; mask < max; mask *= 2) this.writeBit((value & mask) !== 0 ? 1 : 0);
  }
  // Value-aware form ((Value+Mask)<Max), symmetric with BitReader.readIntUE - required for
  // non-framing ints the engine (de)serializes this way: field indices and packed-vector components.
  writeIntUE(value, max) {
    for (let mask = 1; (value & (mask - 1)) + mask < max; mask *= 2) this.writeBit((value & mask) !== 0 ? 1 : 0);
  }
  writeByte(b) { this.writeBits(b & 0xff, 8); }
  writeBytes(buf) { for (const b of buf) this.writeByte(b); }

  // FCompactIndex: signed var-length int.
  // first byte: 0x80=sign, 0x40=continue, 0x3f=low 6 data bits
  // next  bytes: 0x80=continue, 0x7f=7 data bits
  writeIndex(value) {
    const sign = value < 0 ? 0x80 : 0;
    let v = Math.abs(value) >>> 0;
    let b = sign | (v & 0x3f);
    v = Math.floor(v / 64); // >>6 (unsigned-safe)
    if (v !== 0) b |= 0x40;
    this.writeByte(b);
    while (v !== 0) {
      let c = v & 0x7f;
      v = Math.floor(v / 128); // >>7
      if (v !== 0) c |= 0x80;
      this.writeByte(c);
    }
  }

  // FString: [FCompactIndex length][chars][NUL]. length includes the NUL.
  // len>0 => ANSI (1 byte/char), len<0 => UNICODE UTF-16LE. We emit ANSI.
  writeString(str) {
    const ansi = /^[\x00-\x7f]*$/.test(str);
    if (ansi) {
      this.writeIndex(str.length + 1);
      for (let i = 0; i < str.length; i++) this.writeByte(str.charCodeAt(i) & 0xff);
      this.writeByte(0);
    } else {
      this.writeIndex(-(str.length + 1));
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        this.writeByte(c & 0xff); this.writeByte((c >>> 8) & 0xff);
      }
      this.writeByte(0); this.writeByte(0);
    }
  }

  bitLength() { return this.numBits; }
  // Byte buffer, zero-padded in the final partial byte.
  toBuffer() { return Buffer.from(this.bytes); }
}

class BitReader {
  constructor(buf, bitLength) {
    this.buf = buf;
    this.pos = 0;
    this.numBits = (bitLength === undefined) ? buf.length * 8 : bitLength;
    this.error = false;
  }
  atEnd() { return this.pos >= this.numBits; }
  bitsLeft() { return this.numBits - this.pos; }
  readBit() {
    if (this.pos >= this.numBits) { this.error = true; return 0; }
    const byteIndex = this.pos >>> 3;
    const bit = (this.buf[byteIndex] >>> (this.pos & 7)) & 1;
    this.pos++;
    return bit;
  }
  readBits(nbits) {
    let v = 0;
    for (let i = 0; i < nbits; i++) v |= (this.readBit() << i);
    return v >>> 0;
  }
  readInt(max) {
    let value = 0;
    for (let mask = 1; mask < max; mask *= 2) if (this.readBit()) value |= mask;
    return value >>> 0;
  }
  readByte() { return this.readBits(8); }
  readBytes(n) { const out = Buffer.alloc(n); for (let i = 0; i < n; i++) out[i] = this.readByte(); return out; }

  readIndex() {
    let b = this.readByte();
    const sign = b & 0x80;
    let value = b & 0x3f;
    if (b & 0x40) {
      let shift = 6;
      for (;;) {
        const c = this.readByte();
        value += (c & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (!(c & 0x80)) break;
        if (shift > 35) { this.error = true; break; }
      }
    }
    return sign ? -value : value;
  }

  readString() {
    const len = this.readIndex();
    if (len === 0) return '';
    if (len > 0) {
      const bytes = this.readBytes(len); // includes NUL
      let end = len; while (end > 0 && bytes[end - 1] === 0) end--;
      return bytes.slice(0, end).toString('latin1');
    } else {
      const count = -len;
      const bytes = this.readBytes(count * 2);
      let s = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const c = bytes[i] | (bytes[i + 1] << 8);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
  }
}

module.exports = { BitWriter, BitReader };
