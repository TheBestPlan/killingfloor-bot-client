// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * End-to-end test of phase2_client.js against a MOCK KF server that speaks the
 * UT2004 text control protocol. Validates the full client state machine:
 *   HELLO -> CHALLENGE -> NETSPEED/LOGIN(verify response) -> USES/HAVE -> WELCOME -> JOIN
 *   -> server opens an actor channel -> client reaches in-level -> (--ready) RPC sent.
 * Run: node test/handshake.e2e.js
 */
const dgram = require('dgram');
const { spawn } = require('child_process');
const path = require('path');
const { UEConnection, CHTYPE } = require('../lib/netconn');
const { BitWriter } = require('../lib/bitstream');

// must match phase2_client.challengeResponse
function challengeResponse(c) {
  c = c | 0;
  return (Math.imul(c, 237) ^ 0x93fe92ce ^ (c >> 16) ^ (c << 16)) | 0;
}

const PORT = 7710;
const CHALLENGE = 1337421;
const RESTART_INDEX = 77, PC_CHANNEL = 4;

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

const server = dgram.createSocket('udp4');
const clients = new Map(); // key -> { conn, got:{} }

server.on('message', (buf, rinfo) => {
  const key = rinfo.address + ':' + rinfo.port;
  let c = clients.get(key);
  if (!c) {
    c = { got: {}, addr: rinfo, conn: null };
    c.conn = new UEConnection((b) => server.send(b, rinfo.port, rinfo.address), {
      log: () => {},
      onControlText: (cmd) => onClientText(c, cmd),
      onBunch: () => {},
    });
    clients.set(key, c);
  }
  c.conn.receive(buf);
});

function onClientText(c, cmd) {
  const w = cmd.split(/\s+/)[0].toUpperCase();
  c.got[w] = (c.got[w] || 0) + 1;
  if (w === 'HELLO') {
    check('server got HELLO with VER', /VER=3369/.test(cmd) && /MINVER=3180/.test(cmd));
    check('server got HELLO with STEAMID', /STEAMID=\d+/.test(cmd));
    // KF build-1065 handshake: server first asks for the Steam blob.
    c.conn.sendControl('STEAMENCRYPTIONKEY STEAMID=90071992547409920 SECURE=0');
  } else if (w === 'STEAMCLIENTBLOB') {
    check('client answered STEAMCLIENTBLOB', /SIZE=\d+ CHUNK=\d+ BLOB=/.test(cmd));
    // (a Goldberg-backed server auto-approves here) -> proceed to CHALLENGE
    c.conn.sendControl('CHALLENGE VER=3369 CHALLENGE=' + CHALLENGE + ' STATS=0 SEC=0 GZ=0');
  } else if (w === 'NETSPEED') {
    check('server got NETSPEED', /NETSPEED \d+/.test(cmd));
  } else if (w === 'LOGIN') {
    const m = /RESPONSE=(-?\d+)/.exec(cmd);
    const resp = m ? parseInt(m[1], 10) : null;
    check('LOGIN response matches ChallengeResponse formula', resp === challengeResponse(CHALLENGE));
    check('LOGIN url carries Name', /URL=.*Name=Bot/.test(cmd));
    // send a package to verify HAVE handling, then WELCOME
    c.conn.sendControl('USES GUID=ABCDEF0123456789ABCDEF0123456789 PKG=KFmod FLAGS=1 SIZE=4194304 GEN=0 FNAME=KFmod.u');
  } else if (w === 'HAVE') {
    check('client answered HAVE for the package', /GUID=ABCDEF0123456789ABCDEF0123456789/.test(cmd));
    c.conn.sendControl('WELCOME LEVEL=KF-BioticsLab GAME=KFmod.KFGameType');
  } else if (w === 'JOIN') {
    check('client sent JOIN', true);
    // simulate the server opening an actor channel (world replication begins)
    const payload = new BitWriter();
    payload.writeByte(0x01); payload.writeByte(0x02); // dummy initial data
    c.conn.sendActorBunch(PC_CHANNEL, payload, { reliable: true, open: true });
  }
}

server.bind(PORT, () => {
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'phase2_client.js'),
    '--server', '127.0.0.1:' + PORT, '--name', 'Bot',
    '--ready', '--ready-delay', '500', '--leave-delay', '60000',
    '--pc-channel', String(PC_CHANNEL), '--restart-index', String(RESTART_INDEX),
    '--log', path.join(__dirname, '..', 'captures', 'e2e-client.log'),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KF_CLIENT_TIMEOUT: '4000' } });

  let cout = '';
  child.stdout.on('data', (d) => { cout += d; });
  child.stderr.on('data', (d) => { cout += d; });

  // capture the RPC bunch the client sends on the PC channel
  let rpcSeen = false;
  const origOn = server.listeners('message');
  server.on('message', (buf) => {
    const { decodePacket } = require('../lib/netconn');
    const p = decodePacket(buf);
    for (const r of p.records) {
      if (r.type === 'bunch' && r.chIndex === PC_CHANNEL && r.bReliable && !r.bOpen) rpcSeen = true;
    }
  });

  child.on('exit', () => {
    check('client reached in-level', /ADMITTED/.test(cout));
    check('client sent ServerRestartPlayer RPC on PC channel', rpcSeen);
    let fail = 0;
    for (const [name, ok] of results) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
    if (fail) console.log('\n--- client stdout ---\n' + cout);
    console.log('\nhandshake e2e: ' + (fail ? fail + ' FAILED' : 'OK'));
    server.close();
    process.exit(fail ? 1 : 0);
  });
});
