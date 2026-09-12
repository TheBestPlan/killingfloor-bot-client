// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Smoke test: real phase1_relay.js child process forwards C->S and S->C and disassembles.
// Run: node test/relay.smoke.js
const dgram = require('dgram');
const { spawn } = require('child_process');
const path = require('path');
const { UEConnection } = require('../lib/netconn');

const SRV = 7799, RELAY = 7798;
let failed = false;

// dummy "server": echoes a CHALLENGE-ish packet back to whoever contacts it
const server = dgram.createSocket('udp4');
server.on('message', (buf, rinfo) => {
  const reply = new UEConnection((b) => server.send(b, rinfo.port, rinfo.address), { log: () => {} });
  reply.sendControl('CHALLENGE VER=3369 CHALLENGE=999 STATS=0 SEC=0 GZ=0');
});

server.bind(SRV, () => {
  const relay = spawn(process.execPath,
    [path.join(__dirname, '..', 'phase1_relay.js'), '--listen', String(RELAY),
     '--server', '127.0.0.1:' + SRV, '--log', path.join(__dirname, '..', 'captures', 'smoke.log')],
    { stdio: ['ignore', 'pipe', 'pipe'] });

  let relayOut = '';
  relay.stdout.on('data', (d) => { relayOut += d.toString(); });
  relay.stderr.on('data', (d) => { relayOut += d.toString(); });

  setTimeout(() => {
    // client sends HELLO through the relay
    const client = dgram.createSocket('udp4');
    let gotReply = false;
    client.on('message', () => { gotReply = true; });
    const cconn = new UEConnection((b) => client.send(b, RELAY, '127.0.0.1'), { log: () => {} });
    cconn.sendControl('HELLO REVISION=0 MINVER=3180 VER=3369');

    setTimeout(() => {
      const checks = [
        ['relay forwarded C->S and logged it', /C->S/.test(relayOut)],
        ['relay disassembled HELLO text', /HELLO REVISION=0 MINVER=3180 VER=3369/.test(relayOut)],
        ['relay forwarded S->C', /S->C/.test(relayOut)],
        ['relay disassembled CHALLENGE text', /CHALLENGE VER=3369 CHALLENGE=999/.test(relayOut)],
        ['client received server reply via relay', gotReply],
      ];
      for (const [name, cond] of checks) {
        if (cond) console.log('PASS ' + name);
        else { console.error('FAIL ' + name); failed = true; }
      }
      relay.kill(); client.close(); server.close();
      if (failed) { console.error('\n--- relay output ---\n' + relayOut); }
      console.log('\nrelay smoke: ' + (failed ? 'FAILED' : 'OK'));
      process.exit(failed ? 1 : 0);
    }, 600);
  }, 600);
});
