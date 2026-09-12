// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Self-consistency test: encode packets/bunches via UEConnection, decode via decodePacket.
// Run: node test/netconn.test.js
const { UEConnection, decodePacket, CHTYPE, CONTROL_CHANNEL } = require('../lib/netconn');
const { BitWriter } = require('../lib/bitstream');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('FAIL ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) + ')', JSON.stringify(a) === JSON.stringify(b)); }

// capture sent datagrams
const sent = [];
const conn = new UEConnection((buf) => sent.push(buf), { log: () => {} });

// 1) HELLO on control channel (opens channel 0)
conn.sendControl('HELLO REVISION=0 MINVER=3180 VER=3369');
ok('one packet sent', sent.length === 1);
let p = decodePacket(sent[0]);
eq('packetId', p.packetId, 0);
eq('records', p.records.length, 1);
const b0 = p.records[0];
eq('bunch type', b0.type, 'bunch');
eq('chIndex', b0.chIndex, CONTROL_CHANNEL);
eq('chType', b0.chType, CHTYPE.Control);
eq('bOpen', b0.bOpen, 1);
eq('bReliable', b0.bReliable, 1);
eq('chSeq', b0.chSeq, 1);
eq('command', b0.commands, ['HELLO REVISION=0 MINVER=3180 VER=3369']);

// 2) second control command (channel already open -> bOpen=0, chSeq=2)
conn.sendControl('NETSPEED 10000');
p = decodePacket(sent[1]);
eq('packetId 2', p.packetId, 1);
eq('bOpen 2', p.records[0].bOpen, 0);
eq('chSeq 2', p.records[0].chSeq, 2);
eq('command 2', p.records[0].commands, ['NETSPEED 10000']);

// 3) multiple commands in one bunch
conn.sendControl(['HAVE GUID=ABC GEN=0', 'HAVE GUID=DEF GEN=0']);
p = decodePacket(sent[2]);
eq('multi command', p.records[0].commands, ['HAVE GUID=ABC GEN=0', 'HAVE GUID=DEF GEN=0']);

// 4) ack piggyback: simulate receiving a packet, then sending -> ack should ride along
const rxConn = new UEConnection(() => {}, { log: () => {} });
// craft an inbound packet (reuse encoder from a server-ish connection)
const srv = new UEConnection((buf) => { rxConn.receive(buf); }, { log: () => {} });
srv.sendControl('CHALLENGE VER=3369 CHALLENGE=123456 STATS=0 SEC=0 GZ=0');
ok('rx pending ack queued', rxConn.pendingAcks.length === 1);
const rxSent = [];
rxConn.sendFn = (buf) => rxSent.push(buf);
rxConn.sendControl('LOGIN RESPONSE=42 URL=?Name=Bot');
p = decodePacket(rxSent[0]);
const acks = p.records.filter(r => r.type === 'ack');
ok('ack piggybacked', acks.length === 1);
eq('ack value', acks[0].ackPacketId, 0);
const ctrl = p.records.find(r => r.type === 'bunch');
eq('login command', ctrl.commands, ['LOGIN RESPONSE=42 URL=?Name=Bot']);

// 5) server closing control channel 0 (bClose) fires onClose (kick/disconnect detection)
let closeReason = null;
const kickClient = new UEConnection(() => {}, { log: () => {}, onClose: (r) => { closeReason = r; } });
const kickSrv = new UEConnection((buf) => { kickClient.receive(buf); }, { log: () => {} });
kickSrv._flush([kickSrv._encodeBunch({ chIndex: 0, chType: CHTYPE.Control, reliable: true, open: false, close: true, payload: new BitWriter() })]);
ok('onClose fires on control-channel close bunch', typeof closeReason === 'string' && closeReason.length > 0);

console.log('\nnetconn self-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
