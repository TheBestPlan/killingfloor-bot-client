// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Decode a UE2.5 actor-channel replication bunch into { field: value } updates,
 * using the per-class net cache (lib/netcache.js). Mirrors UActorChannel::ReceivedBunch
 * (see docs/PROTOCOL.md §8, reversed from Engine.dll):
 *
 *   loop: handle = ReadInt(GetMaxIndex); field = cache[handle]; value = NetSerializeItem(field)
 *
 * ReadInt is UE's value-aware SerializeInt ((Value+Mask)<Max), NOT the byte-framing form.
 * The decoder stops cleanly at the first field whose wire size it can't yet determine
 * (unknown struct / static object ref) so a partial decode never desyncs into garbage.
 */
const { BitReader } = require('./bitstream');

// Struct properties whose NetSerialize wire form we know, keyed by property name.
const VECTOR_PROPS = new Set(['Location', 'Velocity', 'PrePivot', 'PawnPosition', 'mWhizSoundLocation',
  'ColorOverride', 'Acceleration', 'RelativeLocation', 'TakeHitLocation']);
const ROTATOR_PROPS = new Set(['Rotation', 'RotationRate', 'DesiredRotation', 'ViewRotation',
  'TargetViewRotation', 'RelativeRotation']);

// UE value-aware SerializeInt.
function readIntUE(br, max) {
  let v = 0;
  for (let mask = 1; (v + mask) < max && !br.error; mask *= 2) if (br.readBit()) v |= mask;
  return v >>> 0;
}

function readFloat(br) {
  const b = Buffer.alloc(4); b.writeUInt32LE(br.readBits(32) >>> 0, 0); return b.readFloatLE(0);
}

// UE2 packed vector (reversed from Engine.dll FVector::NetSerialize @ FUN_103fada0, docs/PROTOCOL.md §8):
// components are rounded to integers; a shared bit width `nbm1` (numBits-1) is sent, then each component
// biased into an unsigned int. The bias/width are keyed to nbm1: with numBits = nbm1 + 1,
//   bias = 2^numBits;  each = ReadInt(2^(numBits+1)) - bias
// (verified against the live server's ServerMove decode: bias=2^numBits, not 2^(numBits+1)).
function readPackedVector(br) {
  const numBits = readIntUE(br, 20) + 1;
  const bias = Math.pow(2, numBits);
  const max = Math.pow(2, numBits + 1);
  const x = readIntUE(br, max) - bias;
  const y = readIntUE(br, max) - bias;
  const z = readIntUE(br, max) - bias;
  return { value: [x, y, z], ok: true };
}

// UPackageMap::SerializeObject (loading): 1 bit; 1 -> actor by channel index (ReadInt 1023, 0=null);
// 0 -> static package object (ReadInt maxObjectIndex). Static needs maxObjectIndex to size.
function readObject(br, maxObjectIndex) {
  const dynamic = br.readBit();
  // Engine.dll UPackageMapLevel::SerializeObject reads the actor's channel as ReadInt(0x3ff=1023).
  if (dynamic) return { kind: 'actor', channel: readIntUE(br, 1023), ok: true };
  if (!maxObjectIndex) return { ok: false, reason: 'static-object (need MaxObjectIndex)' };
  return { kind: 'object', index: readIntUE(br, maxObjectIndex), ok: true };
}

// Decode one field's value; returns { value, ok }. ok=false means "can't size this - stop".
function readValue(br, field, opts) {
  const t = field.type;
  switch (t) {
    case 'IntProperty': return { value: br.readBits(32) | 0, ok: true };
    case 'FloatProperty': return { value: readFloat(br), ok: true };
    case 'ByteProperty': return { value: br.readByte(), ok: true };
    case 'BoolProperty': return { value: br.readBit(), ok: true };
    case 'StrProperty': return { value: br.readString(), ok: true };
    case 'ObjectProperty':
    case 'ClassProperty': { const o = readObject(br, opts.maxObjectIndex); return { value: o, ok: o.ok }; }
    case 'StructProperty':
      if (ROTATOR_PROPS.has(field.name)) {
        // FRotator NetSerialize is delegated to opts.rotator (worldstate._rotator).
        return opts.rotator ? opts.rotator(br) : { ok: false, reason: 'rotator-format' };
      }
      if (VECTOR_PROPS.has(field.name)) {
        return (opts.vector || readPackedVector)(br);
      }
      return { ok: false, reason: 'struct:' + field.name };
    default:
      return { ok: false, reason: 'type:' + t };
  }
}

// Decode a non-open actor bunch payload against a class net cache.
// Returns { fields: [{index,name,type,value}], stoppedAt, complete }.
function decodeBunch(payloadHex, numBits, netCache, opts = {}) {
  const br = new BitReader(Buffer.from(payloadHex, 'hex'), numBits);
  const max = netCache.length;
  const fields = [];
  while (br.bitsLeft() >= 2 && !br.error) {
    const handle = readIntUE(br, max);
    const field = netCache[handle];
    if (!field) return { fields, stoppedAt: { handle, reason: 'bad-handle' }, complete: false };
    if (field.isFunc) return { fields, stoppedAt: { handle, name: field.name, reason: 'rpc' }, complete: false };
    const r = readValue(br, field, opts);
    if (!r.ok) return { fields, stoppedAt: { handle, name: field.name, type: field.type, reason: r.reason }, complete: false };
    fields.push({ index: handle, name: field.name, type: field.type, value: r.value });
  }
  return { fields, complete: true };
}

// Inverse of readPackedVector - write a vector in UE2's packed form (integer components).
function writePackedVector(bw, x, y, z) {
  x = Math.round(x); y = Math.round(y); z = Math.round(z);
  const maxAbs = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  let numBits = Math.ceil(Math.log2(maxAbs + 1)); if (!numBits) numBits = 1; if (numBits > 20) numBits = 20;
  const bias = Math.pow(2, numBits), max = Math.pow(2, numBits + 1);
  bw.writeIntUE(numBits - 1, 20);
  bw.writeIntUE(x + bias, max); bw.writeIntUE(y + bias, max); bw.writeIntUE(z + bias, max);
}

module.exports = { decodeBunch, readIntUE, readObject, readValue, readPackedVector, writePackedVector };
