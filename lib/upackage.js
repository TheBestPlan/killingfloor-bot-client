// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Minimal Unreal Engine 2 (.u/.upk) package reader - UT2004/Killing Floor line
 * (file version ~128). Parses the header, name table, import table and export
 * table, and resolves object references. This is the base for building the net
 * cache (class -> replicated field index) needed to decode UE2.5 replication.
 *
 * Byte-stream format (not the bit-stream in bitstream.js):
 *   FCompactIndex : signed varint. first byte 0x80=sign 0x40=more 0x3f=data;
 *                   next bytes 0x80=more 0x7f=data (little-endian).
 *   FString       : FCompactIndex len; len>0 ANSI (incl. NUL), len<0 UNICODE.
 *   object ref    : signed index; 0=null, +N=export[N-1], -N=import[-N-1].
 */
const fs = require('fs');

const PACKAGE_MAGIC = 0x9e2a83c1;      // stock Unreal
const PACKAGE_MAGIC_RO = 0x9e2a83c2;   // Red Orchestra / Killing Floor (ROEngine)

class ByteReader {
  constructor(buf, pos = 0) { this.buf = buf; this.i = pos; }
  u8() { return this.buf[this.i++]; }
  u32() { const v = this.buf.readUInt32LE(this.i); this.i += 4; return v; }
  i32() { const v = this.buf.readInt32LE(this.i); this.i += 4; return v; }
  u16() { const v = this.buf.readUInt16LE(this.i); this.i += 2; return v; }
  // FCompactIndex (signed)
  index() {
    let b = this.buf[this.i++];
    const neg = (b & 0x80) !== 0;
    let value = b & 0x3f;
    if (b & 0x40) {
      let shift = 6;
      for (let j = 0; j < 4; j++) {
        b = this.buf[this.i++];
        value += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (!(b & 0x80)) break;
      }
    }
    return neg ? -value : value;
  }
  // FString
  str() {
    const len = this.index();
    if (len === 0) return '';
    if (len > 0) { const s = this.buf.toString('latin1', this.i, this.i + len - 1); this.i += len; return s; }
    const cnt = -len; let s = '';
    for (let k = 0; k < cnt - 1; k++) { s += String.fromCharCode(this.buf.readUInt16LE(this.i)); this.i += 2; }
    this.i += 2; return s;
  }
}

class UPackage {
  constructor(file) {
    this.buf = fs.readFileSync(file);
    const r = new ByteReader(this.buf);
    const tag = r.u32();
    if (tag !== PACKAGE_MAGIC && tag !== PACKAGE_MAGIC_RO) throw new Error('not an Unreal package: ' + file + ' (tag=0x' + tag.toString(16) + ')');
    this.version = r.u16();
    this.licenseeVersion = r.u16();
    this.packageFlags = r.u32();
    this.nameCount = r.i32(); this.nameOffset = r.i32();
    this.exportCount = r.i32(); this.exportOffset = r.i32();
    this.importCount = r.i32(); this.importOffset = r.i32();
    // FGuid follows the import table offset (4 uint32) - the package's content identity. Formatted like the
    // 32-hex string the server hands out in USES GUID=, so a name-matched but wrong-VERSION file (e.g. a
    // custom map we happen to have a different build of) can be told apart from the exact one the server runs.
    { const g = this.buf; const b = r.i; const h = (x) => x.toString(16).padStart(8, '0');
      this.guid = (h(g.readUInt32LE(b)) + h(g.readUInt32LE(b + 4)) + h(g.readUInt32LE(b + 8)) + h(g.readUInt32LE(b + 12))).toUpperCase(); }

    this.names = this._readNames();
    this.imports = this._readImports();
    this.exports = this._readExports();
  }

  _readNames() {
    const r = new ByteReader(this.buf, this.nameOffset);
    const out = [];
    for (let n = 0; n < this.nameCount; n++) { const name = r.str(); const flags = r.u32(); out.push(name); }
    return out;
  }
  _readImports() {
    const r = new ByteReader(this.buf, this.importOffset);
    const out = [];
    for (let n = 0; n < this.importCount; n++) {
      out.push({
        classPackage: this.names[r.index()],
        className: this.names[r.index()],
        packageIndex: r.i32(),
        objectName: this.names[r.index()],
      });
    }
    return out;
  }
  _readExports() {
    const r = new ByteReader(this.buf, this.exportOffset);
    const out = [];
    for (let n = 0; n < this.exportCount; n++) {
      const classIndex = r.index();
      const superIndex = r.index();
      const packageIndex = r.i32();
      const objectName = this.names[r.index()];
      const objectFlags = r.u32();
      const serialSize = r.index();
      const serialOffset = serialSize > 0 ? r.index() : 0;
      out.push({ classIndex, superIndex, packageIndex, name: objectName, flags: objectFlags, serialSize, serialOffset });
    }
    return out;
  }

  refName(ref) {
    if (ref > 0) return this.exports[ref - 1] ? this.exports[ref - 1].name : '?exp' + ref;
    if (ref < 0) return this.imports[-ref - 1] ? this.imports[-ref - 1].objectName : '?imp' + ref;
    return null;
  }
  // True when an export IS a class object (its class-ref resolves to 'Class', or is 0 for a root UClass). A
  // wire class-ref must land on one of these; a hit on a function/subobject means the index mis-decoded.
  isClassExport(e) { return !!e && (e.classIndex === 0 || this.refName(e.classIndex) === 'Class'); }
  classExports() {
    return this.exports.filter((e) => this.isClassExport(e))
      .map((e) => ({ name: e.name, super: this.refName(e.superIndex), serialSize: e.serialSize, serialOffset: e.serialOffset }));
  }

  // 0-based export index of a class object by name, or -1.
  findClass(name) {
    return this.exports.findIndex((e) => e.name === name && this.isClassExport(e));
  }
  // UProperty PropertyFlags. The property header is [3 FCompactIndex fields][u32 ArrayDim][u32 PropertyFlags];
  // the 3rd compact varies in length, so PropertyFlags is NOT at a fixed byte offset (validated across Engine.u:
  // Location/Rotation/Role land at offset 7 or 9, not 8, and were previously missed).
  propertyFlags(exp) {
    if (exp.serialSize < 12) return 0;
    const r = new ByteReader(this.buf, exp.serialOffset);
    r.index(); r.index(); r.index();   // UField/UProperty header compacts
    r.u32();                            // ArrayDim
    return r.u32();                     // PropertyFlags
  }
  // UFunction FunctionFlags: last dword of the object data, except net functions append a 2-byte RepOffset,
  // so their flags sit at serialSize-6. Detected by the FUNC_Net bit plus an access specifier (Public/Private/Protected).
  functionFlags(exp) {
    if (exp.serialSize < 6) return 0;
    const atNet = this.buf.readUInt32LE(exp.serialOffset + exp.serialSize - 6);
    if ((atNet & UPackage.FUNC_NET) && (atNet & 0x000e0000)) return atNet;
    return this.buf.readUInt32LE(exp.serialOffset + exp.serialSize - 4);
  }
  // Fields (properties + functions) declared directly in a class, in export-table order.
  // net=true for a replicated UProperty (CPF_Net) or a net UFunction (FUNC_Net).
  // type is the field's export class (IntProperty/FloatProperty/Function/...).
  classFields(name) {
    const idx = this.findClass(name);
    if (idx < 0) return [];
    const out = [];
    for (let i = 0; i < this.exports.length; i++) {
      const e = this.exports[i];
      if (e.packageIndex !== idx + 1) continue;
      const type = this.refName(e.classIndex);
      const isProp = /Property$/.test(type || '');
      const isFunc = type === 'Function';
      const net = isProp ? (this.propertyFlags(e) & UPackage.CPF_NET) !== 0
        : isFunc ? (this.functionFlags(e) & UPackage.FUNC_NET) !== 0 : false;
      out.push({ name: e.name, type, exportIdx: i, isProp, isFunc, net });
    }
    return out;
  }
}
UPackage.CPF_NET = 0x20;
UPackage.FUNC_NET = 0x40;

module.exports = { UPackage, ByteReader, PACKAGE_MAGIC };
