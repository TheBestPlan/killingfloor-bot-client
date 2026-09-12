// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Phase 2 (+ Phase 3 scaffold) - headless Killing Floor client (CLI).
 *
 * This is now a thin command-line wrapper around lib/botsession.js (BotSession),
 * which holds the actual UE2.5 handshake state machine. The same engine backs the
 * Electron GUI in gui/. Behavior and stdout/log output are unchanged.
 *
 * Drives the UE2.5 control-channel handshake to completion:
 *   HELLO -> CHALLENGE -> [NETSPEED] LOGIN -> USES/HAVE -> WELCOME -> JOIN
 * computing the login auth response with the real UT2004 ChallengeResponse formula.
 * After JOIN the server admits us (PreLogin/Login spawn our KFPlayerController) and
 * begins replicating the world on actor channels.
 *
 * Phase 3 (--ready): once admitted, send the reliable client->server RPC
 * ServerRestartPlayer on the PlayerController's actor channel to flip bReadyToPlay
 * and spawn. The actor-channel index and the function's NetFields index are
 * connection/build specific - capture them with phase1_relay.js and pass via
 * --pc-channel / --restart-index (see README, Phase 3).
 *
 * Usage:
 *   node phase2_client.js --server 127.0.0.1:7707 --name Bot
 *   node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
 *        --pc-channel <N> --restart-index <M>
 *
 * This talks to a Killing Floor server you control. It is interoperability +
 * research tooling, not an attack tool.
 */
const fs = require('fs');
const path = require('path');
const { BotSession, ENGINE_VERSION, ENGINE_MIN_NET_VERSION } = require('./lib/botsession');

function parseArgs(argv) {
  const a = {
    server: '127.0.0.1:7707', name: 'Bot', netspeed: 10000, url: null,
    ready: false, pcChannel: null, restartIndex: null, selectVetIndex: null,
    ver: ENGINE_VERSION, minver: ENGINE_MIN_NET_VERSION, sendNetspeed: true,
    log: null, quiet: false,
    steamid: '76561197960681930', blob: '', blobSize: null,
    readyDelay: 5000, leaveDelay: 10000, pcChannelAuto: true, netMax: 1024,
    realSteam: false, captureRepl: false,
    steamNode: path.join(__dirname, '_steam32', 'node-v22.12.0-win-x86', 'node.exe'),
    steamHelper: path.join(__dirname, '_steam32', 'steamhelper.js'),
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    switch (k) {
      case '--server': a.server = v(); break;
      case '--name': a.name = v(); break;
      case '--netspeed': a.netspeed = parseInt(v(), 10); break;
      case '--url': a.url = v(); break;
      case '--ready': a.ready = true; break;
      case '--pc-channel': a.pcChannel = parseInt(v(), 10); break;
      case '--pc-channels': a.pcChannels = v().split(',').map((s) => parseInt(s, 10)); break;
      case '--restart-index': a.restartIndex = parseInt(v(), 10); break;
      case '--net-max': a.netMax = parseInt(v(), 10); break;
      case '--select-vet-index': a.selectVetIndex = parseInt(v(), 10); break;
      case '--system-dir': a.systemDir = v(); break;
      case '--ver': a.ver = parseInt(v(), 10); break;
      case '--minver': a.minver = parseInt(v(), 10); break;
      case '--ready-delay': a.readyDelay = parseInt(v(), 10); break;
      case '--leave-delay': a.leaveDelay = parseInt(v(), 10); break;
      case '--steamid': a.steamid = v(); break;
      case '--blob': a.blob = v(); break;
      case '--blob-size': a.blobSize = parseInt(v(), 10); break;
      case '--real-steam': a.realSteam = true; break;
      case '--pkg-download': a.pkgDownload = true; break;   // fetch missing server packages like the GUI does
      case '--capture-repl': a.captureRepl = true; break;
      case '--steam-node': a.steamNode = v(); break;
      case '--no-netspeed': a.sendNetspeed = false; break;
      case '--log': a.log = v(); break;
      case '--quiet': a.quiet = true; break;
      default: console.error('unknown arg ' + k);
    }
  }
  const [host, port] = a.server.split(':');
  a.serverHost = host; a.serverPort = parseInt(port, 10);
  if (a.url === null) a.url = '?Name=' + a.name;
  return a;
}

const args = parseArgs(process.argv);
const logPath = args.log || path.join(__dirname, 'captures',
  'client-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
function out(line) { if (!args.quiet) process.stdout.write(line + '\n'); logStream.write(line + '\n'); }

out('logging to: ' + logPath);

const bot = new BotSession(args);
bot.on('log', out);
bot.on('closed', () => process.exit(0));
bot.start();

// safety: exit after a while if running standalone for a quick probe
if (process.env.KF_CLIENT_TIMEOUT) {
  setTimeout(() => { out('== timeout, exiting =='); process.exit(0); },
    parseInt(process.env.KF_CLIENT_TIMEOUT, 10));
}
