// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * UE2.5 in-game package download over File channels (UChannel type 3), reversed from
 * Engine.dll UFileChannel::ReceivedBunch (_ghidra/rpc-out.log):
 *   - first bunch on the channel: FGuid (16 bytes) identifying which USES package this is;
 *   - every following bunch: raw file bytes, appended until `size` is reached;
 *   - the file may be .uz2-compressed (UE2's chunked LZ) - decompressed on completion.
 * We only ask for the packages the decoder needs and lacks (code .u / the map .rom); textures /
 * sounds / meshes are HAVE'd (claimed) since a headless bot never loads them.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { BitReader } = require('./bitstream');

// Fetch a URL to a Buffer (redirect servers are plain HTTP; a few use HTTPS).
function fetchBuffer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'User-Agent': 'UnrealEngine/UT2004' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
  });
}

// Decode UE2 .uz2: a run of chunks, each [compressedLen:u32][uncompressedLen:u32][zlib data]. Verified
// against a live KF redirect - the chunk payload is standard zlib (0x789c), so Node inflate suffices.
function decodeUz2(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const clen = buf.readUInt32LE(i), ulen = buf.readUInt32LE(i + 4);
    i += 8;
    if (clen <= 0 || i + clen > buf.length) break;
    const dec = zlib.inflateSync(buf.slice(i, i + clen));
    if (dec.length !== ulen) throw new Error('uz2 chunk size mismatch (' + dec.length + ' != ' + ulen + ')');
    out.push(dec);
    i += clen;
  }
  return Buffer.concat(out);
}

// Download packages from an HTTP redirect (the way modded KF servers ship content, vs the in-game File
// channel): GET "<base><fname>.uz2", decompress, write. Falls back to the uncompressed "<base><fname>".
// Runs a few in parallel; reports byte progress against the total USES size.
async function httpRedirectDownload(redirectUrl, packages, destDir, opts = {}) {
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const onComplete = opts.onComplete || (() => {});   // called per package as it lands, for incremental HAVE
  const base = redirectUrl.endsWith('/') ? redirectUrl : redirectUrl + '/';
  fs.mkdirSync(destDir, { recursive: true });
  const totalSize = packages.reduce((s, p) => s + (p.size || 0), 0);
  const completed = [], missed = [];
  let done = 0, idx = 0, aborted = false;
  // A join budget bounds how long we hold the handshake downloading: a server kicks a client that lingers
  // in the WELCOME stage (~110 s), so if a modded pack is many GB we stop pulling new files past the
  // deadline and let the caller JOIN with what finished. Each completed file is written to disk, so the
  // rest fill in over subsequent reconnects instead of getting us kicked mid-download.
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : Infinity;
  const report = (name) => onProgress({ name, bytes: done, size: totalSize, pct: totalSize ? Math.round(100 * done / totalSize) : 0 });
  async function worker() {
    while (idx < packages.length) {
      if (Date.now() > deadline) { aborted = true; break; }
      const p = packages[idx++];
      report(p.fname);
      let ok = false, notFound = false;
      // Retry transient failures (large files like a 50 MB map .rom can drop mid-transfer); a real 404 is
      // not retried - it just falls through to the in-game File channel.
      for (let attempt = 0; attempt < 3 && !ok && !notFound; attempt++) {
        try {
          let data = null;
          const uz2 = await fetchBuffer(base + encodeURIComponent(p.fname) + '.uz2').catch((e) => { if (/HTTP 4/.test(e.message)) notFound = true; return null; });
          if (uz2) data = decodeUz2(uz2);
          else if (!notFound) data = await fetchBuffer(base + encodeURIComponent(p.fname)).catch((e) => { if (/HTTP 4/.test(e.message)) notFound = true; return null; });
          if (data) {
            fs.writeFileSync(path.join(destDir, p.fname), data);
            const entry = { guid: p.guid, gen: p.gen, name: p.name, fname: p.fname, file: path.join(destDir, p.fname) };
            completed.push(entry);
            log('[DL] http ' + p.fname + ' ' + data.length + ' bytes' + (attempt ? ' (retry ' + attempt + ')' : ''));
            try { onComplete(entry); } catch (e) { /* HAVE send is best-effort */ }
            ok = true;
          }
        } catch (e) { log('[DL] redirect decode fail ' + p.fname + ': ' + (e.message || e)); }
      }
      if (!ok) { log('[DL] redirect miss ' + p.fname + ' — will try in-game'); missed.push(p); }
      done += p.size || 0;
      report(p.fname);
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency || 4, packages.length || 1) }, worker));
  return { completed, missed, aborted };
}

function guidHex(br) {
  // FGuid = 4 uint32 (A,B,C,D). Format as the 32-hex-char string KF prints in USES GUID=.
  const A = br.readBits(32) >>> 0, B = br.readBits(32) >>> 0, C = br.readBits(32) >>> 0, D = br.readBits(32) >>> 0;
  const h = (x) => x.toString(16).padStart(8, '0');
  return (h(A) + h(B) + h(C) + h(D)).toUpperCase();
}

class PackageDownloader {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.destDir = opts.destDir;          // where to write the finished package (the Cache dir)
    this.capture = !!opts.capture;        // log raw file-channel traffic (protocol reversing)
    this.pending = {};                    // GUID -> { name, gen, size, fname }
    this.byName = {};                     // name -> GUID (so a completion can report the package)
    this.channels = {};                   // channel index -> { guid, name, fname, chunks:[Buffer], bytes, size }
    this.completed = [];                  // { name, file } written to disk, ready to load
    this.wantCount = 0;
  }

  // Ask the server to send this package (we lack it locally and the decoder needs it).
  want(name, guid, gen, size, fname) {
    const g = String(guid || '').toUpperCase();
    this.pending[g] = { name, gen: +gen || 0, size: +size || 0, fname: fname || (name + '.u') };
    this.byName[name] = g;
    this.wantCount++;
  }
  wants() { return this.wantCount > 0; }
  hasPending() { return Object.keys(this.pending).length > 0 || Object.keys(this.channels).length > 0; }
  progress() {
    let bytes = 0, size = 0, name = '';
    for (const st of Object.values(this.channels)) { bytes += st.bytes; size += st.size; if (!name) name = st.name; }
    return { name, bytes, size, pct: size ? Math.round(100 * bytes / size) : 0 };
  }

  // We opened file channel `ch` and requested `guid`; the server streams that package's RAW file back on
  // it (verified against KFMod.u - the stream is the file byte-for-byte, no GUID prefix). Pre-registering
  // the channel lets onFileBunch append every byte as file data and know the expected size up front.
  expect(ch, guid) {
    const g = String(guid || '').toUpperCase();
    const info = this.pending[g];
    this.channels[ch] = { guid: g, name: info ? info.name : ('guid:' + g), fname: info ? info.fname : (g + '.u'), size: info ? info.size : 0, chunks: [], bytes: 0 };
  }

  // A bunch on a File channel (chType===3). Returns true if it was consumed as download data.
  onFileBunch(rec) {
    const ch = rec.chIndex;
    const buf = Buffer.from(rec.payloadHex || '', 'hex');
    if (this.capture) this.log('[DL] file ch' + ch + ' open=' + (rec.bOpen ? 1 : 0) + ' close=' + (rec.bClose ? 1 : 0) + ' bits=' + rec.numBits + ' bytes=' + buf.length + ' hex=' + buf.slice(0, 40).toString('hex'));
    let st = this.channels[ch];
    if (!st) {
      // Not pre-registered (a server-initiated push): first bunch leads with the package FGuid.
      const br = new BitReader(buf, rec.numBits);
      const g = guidHex(br);
      const info = this.pending[g];
      const startByte = Math.ceil(br.pos / 8);
      st = this.channels[ch] = { guid: g, name: info ? info.name : ('guid:' + g), fname: info ? info.fname : (g + '.uxx'), size: info ? info.size : 0, chunks: [], bytes: 0 };
      this.log('[DL] start ch' + ch + ' pkg=' + st.name + ' guid=' + g + ' size=' + st.size + (info ? '' : ' (UNMATCHED)'));
      const rest = buf.slice(startByte);
      if (rest.length) { st.chunks.push(rest); st.bytes += rest.length; }
    } else {
      if (st.bytes === 0 && !st.logged) { st.logged = true; this.log('[DL] start ch' + ch + ' pkg=' + st.name + ' size=' + st.size); }
      if (buf.length) { st.chunks.push(buf); st.bytes += buf.length; }
    }
    const complete = (st.size > 0 && st.bytes >= st.size) || rec.bClose;
    if (complete) this._finish(ch);
    return true;
  }

  _finish(ch) {
    const st = this.channels[ch]; if (!st) return;
    delete this.channels[ch];
    delete this.pending[st.guid];
    let data = Buffer.concat(st.chunks, st.bytes);
    if (st.size > 0 && data.length > st.size) data = data.slice(0, st.size);
    try {
      const outName = st.fname;   // in-game download sends the raw package (redirect/.uz2 is a separate path)
      fs.mkdirSync(this.destDir, { recursive: true });
      const file = path.join(this.destDir, outName);
      fs.writeFileSync(file, data);
      this.completed.push({ name: st.name, file });
      this.log('[DL] wrote ' + outName + ' (' + data.length + ' bytes) for ' + st.name);
    } catch (e) { this.log('[DL] write failed for ' + st.name + ': ' + (e.message || e)); }
  }
}

module.exports = { PackageDownloader, httpRedirectDownload, decodeUz2 };
