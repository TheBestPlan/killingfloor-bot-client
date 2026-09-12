// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Forked child process: hosts one BotSession and bridges it to the Electron main
 * process over Node's child IPC.
 *   main -> { type:'start', config } -> new BotSession + wire events
 *   main -> { type:'cmd', cmd:'ready'|'leave'|'stop' } -> drive the session
 *   BotSession event -> process.send({ type:'event', name, payload }) -> main
 *
 * Runs as plain Node (forked with ELECTRON_RUN_AS_NODE=1). The 32-bit Steam helper
 * is still spawned by BotSession as a grandchild, so no native code loads here.
 */
const { BotSession } = require('./lib/botsession');
const fs = require('fs');
const path = require('path');

const EVENTS = ['log', 'state', 'status', 'admitted', 'actorChannel', 'ready', 'leaving', 'failed', 'closed',
  'stats', 'mapObjects', 'target', 'chat', 'connecting', 'world', 'kicked', 'map']; // stats/map/chat/world: inbound replication; connecting: handshake progress; kicked: server closed us; map: server map name
let bot = null;
let logFd = null;   // open fd of this run's capture file

function emit(name, payload) {
  if (process.send) process.send({ type: 'event', name, payload });
}

// Persist every log line to captures/gui-<timestamp>_<ip>-<port>.log so a run can be inspected
// afterwards and located by server. writeSync keeps each line on disk even when the window close kills us.
function openLog(server) {
  try {
    const dir = path.join(__dirname, 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tag = String(server || '').replace(/:/g, '-').replace(/[^\w.-]/g, '');   // "ip:port" -> "ip-port"
    const file = path.join(dir, 'gui-' + ts + (tag ? '_' + tag : '') + '.log');
    logFd = fs.openSync(file, 'a');
    return file;
  } catch (e) { logFd = null; return null; }
}

function writeLog(line) {
  if (logFd === null) return;
  try { fs.writeSync(logFd, new Date().toISOString() + ' ' + line + '\n'); } catch (e) { /* ignore */ }
}

function closeLog() {
  if (logFd !== null) { try { fs.closeSync(logFd); } catch (e) { /* ignore */ } logFd = null; }
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'start') {
    if (bot) { try { bot.stop(); } catch (e) { /* ignore */ } }
    closeLog();
    const file = openLog(m.config && m.config.server);
    bot = new BotSession(m.config || {});
    bot.on('log', writeLog);                 // persist to the capture file
    bot.on('closed', closeLog);
    for (const ev of EVENTS) bot.on(ev, (payload) => emit(ev, payload));   // forward to the GUI
    if (file) { const msg = '== GUI log file: ' + file + ' =='; writeLog(msg); emit('log', msg); }
    try { bot.start(); } catch (e) { emit('failed', 'start: ' + (e && e.message || e)); }
  } else if (m.type === 'cmd') {
    if (!bot) return;
    try {
      if (m.cmd === 'ready') bot.ready();
      else if (m.cmd === 'leave') bot.leave();
      else if (m.cmd === 'stop') bot.stop();
      else if (m.cmd === 'say') bot.sendSay(m.text || '', !!m.team);
      else if (m.cmd === 'move') bot.moveTo(+m.x, +m.y);
      else if (m.cmd === 'movenav') bot.moveToNavTarget();
      else if (m.cmd === 'ackslowdl') bot.ackSlowDownload();
    } catch (e) { emit('log', 'cmd error: ' + (e && e.message || e)); }
  }
});

process.on('uncaughtException', (e) => emit('failed', 'uncaught: ' + (e && e.message || e)));
process.on('exit', closeLog);
process.on('SIGTERM', () => { closeLog(); process.exit(0); });
