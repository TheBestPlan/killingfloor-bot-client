// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * UE2.5 (UT2004 / Killing Floor) packet + bunch framing, and the control channel.
 *
 * Packet layout (bit-stream, LSB-first):
 *   PacketId = ReadInt(MAX_PACKETID)            // once, at packet start
 *   while(!AtEnd):
 *     IsAck = ReadBit
 *     if IsAck:  AckPacketId = ReadInt(MAX_PACKETID)
 *     else:      <bunch>
 *   <trailer stop bit '1', then zero-pad to byte>   // receiver finds bit-length = highest set bit
 *
 * Bunch header:
 *   bControl = ReadBit
 *   bOpen    = bControl ? ReadBit : 0
 *   bClose   = bControl ? ReadBit : 0
 *   bReliable= ReadBit
 *   ChIndex  = ReadInt(MAX_CHANNELS)
 *   ChSeq    = bReliable ? ReadInt(MAX_CHSEQUENCE) : 0    (MakeRelative on real engine)
 *   ChType   = (bReliable||bOpen) ? ReadInt(CHTYPE_MAX) : 0
 *   NumBits  = ReadInt(MaxPacket*8)
 *   <NumBits payload bits>
 *
 * Control channel (index 0) payload = one or more FStrings, each an ASCII command line
 * (HELLO / CHALLENGE / LOGIN / USES / HAVE / WELCOME / JOIN ...).
 *
 * Spec + sources: docs/PROTOCOL.md.
 * Anything the engine could differ on (exact MaxPacket, value-aware ReadInt for channel
 * indices >510, MakeRelative wrap) is resolved by Phase 1 capture (phase1_relay.js).
 */

const { BitWriter, BitReader } = require('./bitstream');

const MAX_PACKETID = 16384;   // 2^14
const MAX_CHSEQUENCE = 1024;  // 2^10
const MAX_CHANNELS = 1023;
const CHTYPE_MAX = 8;
const CHTYPE = { None: 0, Control: 1, Actor: 2, File: 3 };
const CONTROL_CHANNEL = 0;
const DEFAULT_MAX_PACKET = 512; // bunch length field max = MaxPacket*8

// Copy `nbits` bits out of `reader` into a fresh BitReader starting at 0.
function subBits(reader, nbits) {
  const w = new BitWriter();
  for (let i = 0; i < nbits; i++) w.writeBit(reader.readBit());
  return new BitReader(w.toBuffer(), nbits);
}

// Append every bit of BitWriter `src` onto BitWriter `dst`.
function appendBits(dst, src) {
  const r = new BitReader(src.toBuffer(), src.bitLength());
  while (!r.atEnd()) dst.writeBit(r.readBit());
}

// Bit length of a received datagram = index of the highest set bit (the stop bit).
function packetBitLength(buf) {
  for (let byteIndex = buf.length - 1; byteIndex >= 0; byteIndex--) {
    const b = buf[byteIndex];
    if (b !== 0) {
      for (let bit = 7; bit >= 0; bit--) {
        if (b & (1 << bit)) return byteIndex * 8 + bit; // position of stop bit
      }
    }
  }
  return 0;
}

/* ---- stateless decode (for the relay / disassembler) ---- */
function decodePacket(buf, opts = {}) {
  const maxPacket = opts.maxPacket || DEFAULT_MAX_PACKET;
  const bitLen = packetBitLength(buf);
  const r = new BitReader(buf, bitLen);
  const out = { byteLen: buf.length, bitLen, packetId: null, records: [], error: null };
  if (bitLen === 0) { out.error = 'empty/no-stop-bit'; return out; }
  try {
    out.packetId = r.readInt(MAX_PACKETID);
    while (!r.atEnd()) {
      const isAck = r.readBit();
      if (isAck) {
        out.records.push({ type: 'ack', ackPacketId: r.readInt(MAX_PACKETID) });
        continue;
      }
      const bControl = r.readBit();
      const bOpen = bControl ? r.readBit() : 0;
      const bClose = bControl ? r.readBit() : 0;
      const bReliable = r.readBit();
      const chIndex = r.readInt(MAX_CHANNELS);
      const chSeq = bReliable ? r.readInt(MAX_CHSEQUENCE) : 0;
      const chType = (bReliable || bOpen) ? r.readInt(CHTYPE_MAX) : 0;
      const numBits = r.readInt(maxPacket * 8);
      if (numBits > r.bitsLeft()) { out.error = `bunch numBits=${numBits} > left=${r.bitsLeft()}`; break; }
      const payload = subBits(r, numBits);
      const rec = { type: 'bunch', bControl, bOpen, bClose, bReliable, chIndex, chSeq, chType, numBits };
      // Control channel payload = ASCII command FStrings.
      if (chIndex === CONTROL_CHANNEL) {
        rec.commands = [];
        try {
          while (!payload.atEnd() && payload.bitsLeft() >= 8 && !payload.error) {
            const s = payload.readString();
            if (s === '' && payload.atEnd()) break;
            rec.commands.push(s);
          }
        } catch (e) { rec.commandsError = String(e.message || e); }
      } else {
        rec.payloadHex = payload.readBytes(Math.ceil(numBits / 8)).toString('hex');
      }
      out.records.push(rec);
    }
  } catch (e) { out.error = String(e.message || e); }
  return out;
}

/* ---- stateful client connection ---- */
class UEConnection {
  constructor(sendFn, opts = {}) {
    this.sendFn = sendFn;                 // (Buffer) => void
    this.maxPacket = opts.maxPacket || DEFAULT_MAX_PACKET;
    this.log = opts.log || (() => {});
    this.verbose = opts.verbose || false; // per-packet SEND/RECV/ACK spam; off keeps the GUI responsive
    this.vlog = this.verbose ? this.log : () => {};
    this.outPacketId = 0;
    this.inPacketId = -1;
    this.outReliable = {};                // per-channel out reliable seq
    this.inReliable = {};
    this.pendingAcks = [];                // packetIds to ack
    this._outbox = [];                    // unacked reliable packets: { id, records, sentAt, tries }
    this.rto = opts.rto || 500;           // retransmit timeout (ms)
    this.maxRetries = opts.maxRetries || 20;
    this.openedChannels = {};             // chIndex -> true
    this.onControlText = opts.onControlText || (() => {}); // (cmd:string) => void
    this.onBunch = opts.onBunch || (() => {});             // (rec) => void for non-control
    this.onClose = opts.onClose || (() => {});             // (reason) => void when the server closes control ch 0
  }

  // Build + send one packet carrying the given bunch BitWriters; returns its packetId.
  _send(bunchRecords) {
    const w = new BitWriter();
    w.writeInt(this.outPacketId, MAX_PACKETID);
    for (const ackId of this.pendingAcks) { w.writeBit(1); w.writeInt(ackId, MAX_PACKETID); }
    this.pendingAcks = [];
    for (const br of bunchRecords) appendBits(w, br);
    w.writeBit(1); // trailer stop bit
    const buf = w.toBuffer();
    const id = this.outPacketId;
    this.vlog(`SEND pkt #${id} (${buf.length}B, ${w.bitLength()}b, ${bunchRecords.length} bunch)`);
    this.outPacketId = (this.outPacketId + 1) % MAX_PACKETID;
    this.sendFn(buf);
    return id;
  }

  // Send a packet, tracking it for retransmit if it carries any reliable bunch. We keep every packet id a
  // bunch was sent under (original + each retransmit) so a late ACK for any of them clears it.
  _flush(bunchRecords) {
    const id = this._send(bunchRecords);
    if (bunchRecords.some((r) => r && r.reliable)) this._outbox.push({ ids: [id], records: bunchRecords, sentAt: this._now(), tries: 0 });
  }

  _now() { return Date.now(); }

  // Resend reliable bunches whose packet hasn't been ACKed within the RTO. The server dedupes by the
  // bunch's ChSequence and processes reliable bunches strictly in order - a permanently-lost bunch makes
  // the server buffer every later reliable bunch on that channel forever (outbound RPCs silently die). So
  // we retransmit for the whole connection lifetime (the silence watchdog / _close bound it), never giving
  // up on a live link. Returns true while there is still unacked reliable traffic in flight.
  retransmit() {
    const now = this._now();
    for (const e of this._outbox) {
      if (now - e.sentAt >= this.rto) {
        const id = this._send(e.records);
        e.ids.push(id); if (e.ids.length > 16) e.ids.shift();
        e.sentAt = now; e.tries++;
        if (e.tries === 40 || (e.tries && e.tries % 200 === 0)) this.log('  ~ reliable bunch still unacked after ' + e.tries + ' retransmits (congested link)');
      }
    }
    return this._outbox.length > 0;
  }

  // Encode one bunch (header + payload) into a BitWriter record.
  _encodeBunch({ chIndex, chType, reliable = true, open = false, close = false, payload }) {
    const w = new BitWriter();
    let chSeq = 0;
    if (reliable) { this.outReliable[chIndex] = (this.outReliable[chIndex] || 0) + 1; chSeq = this.outReliable[chIndex]; }
    const bControl = (open || close) ? 1 : 0;
    w.writeBit(0);            // IsAck = 0 -> this record is a bunch
    w.writeBit(bControl);
    if (bControl) { w.writeBit(open ? 1 : 0); w.writeBit(close ? 1 : 0); }
    w.writeBit(reliable ? 1 : 0);
    w.writeInt(chIndex, MAX_CHANNELS);
    if (reliable) w.writeInt(chSeq, MAX_CHSEQUENCE);
    if (reliable || open) w.writeInt(chType, CHTYPE_MAX);
    const nbits = payload.bitLength();
    w.writeInt(nbits, this.maxPacket * 8);
    appendBits(w, payload);
    w.reliable = reliable;   // so _flush knows to track it for retransmit
    return w;
  }

  // Send one or more control-channel text commands (each becomes an FString in the payload).
  sendControl(commands, { open = undefined, quiet = false } = {}) {
    const list = Array.isArray(commands) ? commands : [commands];
    const payload = new BitWriter();
    for (const c of list) payload.writeString(c);
    const isOpen = (open === undefined) ? !this.openedChannels[CONTROL_CHANNEL] : open;
    this.openedChannels[CONTROL_CHANNEL] = true;
    const rec = this._encodeBunch({
      chIndex: CONTROL_CHANNEL, chType: CHTYPE.Control,
      reliable: true, open: isOpen, payload,
    });
    for (const c of list) (quiet ? this.vlog : this.log)(`  -> CTRL "${c}"`);
    this._flush([rec]);
  }

  // Graceful disconnect: close the control channel (bClose on channel 0). The server
  // sees the control-channel close and runs NotifyLogout -> removes the player.
  sendControlClose() {
    const payload = new BitWriter();
    const rec = this._encodeBunch({
      chIndex: CONTROL_CHANNEL, chType: CHTYPE.Control,
      reliable: true, open: false, close: true, payload,
    });
    this.log('  -> CTRL <close channel 0 / disconnect>');
    this._flush([rec]);
  }

  // Send a reliable RPC payload on an actor channel (Phase 3).
  sendActorBunch(chIndex, payload, { reliable = true, open = false, close = false } = {}) {
    const rec = this._encodeBunch({ chIndex, chType: CHTYPE.Actor, reliable, open, close, payload });
    this._flush([rec]);
  }

  // Open a File channel (CHTYPE 3) and send the download request (the package FGuid). The server's
  // UFileChannel::ReceivedBunch reads the GUID, finds the package, and streams it back on this channel.
  sendFileOpen(chIndex, payload) {
    const rec = this._encodeBunch({ chIndex, chType: CHTYPE.File, reliable: true, open: true, payload });
    this._flush([rec]);
  }

  // Send an ack-only packet (flush pending acks with no bunches).
  flushAcks() { if (this.pendingAcks.length) this._flush([]); }

  // Process a received datagram.
  receive(buf) {
    const pkt = decodePacket(buf, { maxPacket: this.maxPacket });
    if (pkt.error && pkt.packetId === null) { this.vlog(`RECV undecodable: ${pkt.error}`); return pkt; }
    this.vlog(`RECV pkt #${pkt.packetId} (${pkt.byteLen}B) ${pkt.records.length} rec${pkt.error ? ' ERR:' + pkt.error : ''}`);
    this.inPacketId = pkt.packetId;
    this.pendingAcks.push(pkt.packetId);
    for (const rec of pkt.records) {
      if (rec.type === 'ack') { this._outbox = this._outbox.filter((e) => !e.ids.includes(rec.ackPacketId)); this.vlog(`  <- ACK ${rec.ackPacketId}`); continue; }
      if (rec.chIndex === CONTROL_CHANNEL) {
        this._deliverControlInOrder(rec);
      } else {
        this.onBunch(rec);
      }
    }
    return pkt;
  }

  // Deliver reliable control-channel bunches STRICTLY in ChSequence order, like the real engine. UDP reorders
  // datagrams and retransmits arrive late, so processing control bunches on arrival scrambles the USES stream:
  // the package-map ranges then depend on arrival order, so the same class-ref index resolves to a different
  // class run-to-run (players read as monsters, monster names wrong) - non-deterministically, on ANY server.
  // Buffer out-of-order reliable bunches and drain them in sequence. Non-reliable control isn't sequenced.
  _deliverControlInOrder(rec) {
    if (!rec.bReliable) { this._runControl(rec); return; }
    if (this._inCtrlSeq === undefined) { this._inCtrlSeq = 0; this._ctrlBuf = {}; }
    if (rec.chSeq <= this._inCtrlSeq) return;                 // duplicate / already delivered
    this._ctrlBuf[rec.chSeq] = rec;
    while (this._ctrlBuf[this._inCtrlSeq + 1]) {
      const next = this._ctrlBuf[this._inCtrlSeq + 1];
      delete this._ctrlBuf[this._inCtrlSeq + 1];
      this._inCtrlSeq++;
      this._runControl(next);
    }
  }
  _runControl(rec) {
    if (rec.commands) for (const c of rec.commands) { this.log(`  <- CTRL "${c}"`); this.onControlText(c, rec); }
    // The server closing the control channel (bClose on ch 0) is a disconnect/kick.
    if (rec.bClose) { this.log('  <- CTRL <server closed channel 0>'); this.onClose('server closed control channel'); }
  }
}

module.exports = {
  MAX_PACKETID, MAX_CHSEQUENCE, MAX_CHANNELS, CHTYPE_MAX, CHTYPE, CONTROL_CHANNEL,
  DEFAULT_MAX_PACKET, decodePacket, packetBitLength, UEConnection, subBits, appendBits,
};
