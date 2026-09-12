// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Phase 1 - UDP MITM relay + packet disassembler.
 *
 * Sits between a REAL Killing Floor client and a REAL server, forwarding every
 * datagram and logging it (hexdump + best-effort UE2 packet/bunch/control-text
 * disassembly). This is the ground-truth capture for the protocol AND a live
 * validation of our own codec (lib/netconn.js): if our disassembly of the real
 * traffic is clean, the codec is right; where it errors, we've found the exact
 * byte we still have wrong. No Wireshark/npcap needed.
 *
 * Topology (single machine):
 *   - run a local KF server on :7707
 *   - run this relay listening on :7708, forwarding to 127.0.0.1:7707
 *   - in the real client console:  open 127.0.0.1:7708
 *
 * Usage:
 *   node phase1_relay.js --listen 7708 --server 127.0.0.1:7707 [--log capture.log] [--maxpacket 512]
 */
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { hexdump } = require('./lib/hexdump');
const { decodePacket } = require('./lib/netconn');

function parseArgs(argv) {
  const a = { listen: 7708, server: '127.0.0.1:7707', log: null, maxpacket: 512 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--listen') a.listen = parseInt(argv[++i], 10);
    else if (k === '--server') a.server = argv[++i];
    else if (k === '--log') a.log = argv[++i];
    else if (k === '--maxpacket') a.maxpacket = parseInt(argv[++i], 10);
  }
  const [host, port] = a.server.split(':');
  a.serverHost = host; a.serverPort = parseInt(port, 10);
  return a;
}

const args = parseArgs(process.argv);
const logPath = args.log || path.join(__dirname, 'captures',
  'capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function out(line) { process.stdout.write(line + '\n'); logStream.write(line + '\n'); }

function describe(pkt) {
  if (pkt.packetId === null) return '    [undecodable] ' + (pkt.error || '');
  const lines = ['    pkt #' + pkt.packetId + '  (' + pkt.byteLen + 'B / ' + pkt.bitLen + 'b)' +
    (pkt.error ? '  ERROR: ' + pkt.error : '')];
  for (const r of pkt.records) {
    if (r.type === 'ack') { lines.push('      ACK ' + r.ackPacketId); continue; }
    let h = '      BUNCH ch=' + r.chIndex +
      ' ' + (r.bReliable ? 'rel' : 'unrel') +
      (r.bOpen ? ' OPEN' : '') + (r.bClose ? ' CLOSE' : '') +
      ' type=' + r.chType + ' seq=' + r.chSeq + ' bits=' + r.numBits;
    lines.push(h);
    if (r.commands) for (const c of r.commands) lines.push('         TEXT: ' + JSON.stringify(c));
    if (r.commandsError) lines.push('         TEXT-ERR: ' + r.commandsError);
    if (r.payloadHex) lines.push('         data: ' + r.payloadHex.slice(0, 96) + (r.payloadHex.length > 96 ? '…' : ''));
  }
  return lines.join('\n');
}

let pktCount = 0;
function dump(dir, buf) {
  pktCount++;
  out('\n[' + new Date().toISOString() + '] ' + dir + '  #' + pktCount + '  ' + buf.length + ' bytes');
  out(hexdump(buf, '    '));
  try { out(describe(decodePacket(buf, { maxpacket: args.maxpacket }))); }
  catch (e) { out('    [disasm threw] ' + e.message); }
}

// One upstream socket per distinct client address (so server replies route back).
const upstreams = new Map(); // clientKey -> { sock, addr, port }
const listen = dgram.createSocket('udp4');

listen.on('message', (buf, rinfo) => {
  const key = rinfo.address + ':' + rinfo.port;
  let up = upstreams.get(key);
  if (!up) {
    const sock = dgram.createSocket('udp4');
    up = { sock, addr: rinfo.address, port: rinfo.port };
    upstreams.set(key, up);
    sock.on('message', (rbuf) => {
      dump('S->C', rbuf);
      listen.send(rbuf, rinfo.port, rinfo.address);
    });
    sock.on('error', (e) => out('    [upstream error] ' + e.message));
    out('== new client ' + key + ' -> server ' + args.serverHost + ':' + args.serverPort + ' ==');
  }
  dump('C->S', buf);
  up.sock.send(buf, args.serverPort, args.serverHost);
});

listen.on('error', (e) => { out('[listen error] ' + e.message); process.exit(1); });
listen.bind(args.listen, () => {
  out('== KF MITM relay ==');
  out('listening udp/' + args.listen + '  ->  ' + args.serverHost + ':' + args.serverPort);
  out('point the real client at:  open <this-host>:' + args.listen);
  out('logging to: ' + logPath);
});
