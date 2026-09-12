// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * BotSession - the headless Killing Floor (UE2.5) client as a reusable,
 * event-driven object. This is the engine behind both the phase2_client.js CLI
 * and the Electron GUI (gui/). It owns one UDP socket + one UEConnection and
 * drives the control-channel handshake to completion:
 *   HELLO -> [STEAMENCRYPTIONKEY/blob] -> CHALLENGE -> [NETSPEED] LOGIN
 *         -> USES/HAVE -> WELCOME -> JOIN -> in-level
 * After JOIN the server admits us and replicates the world on actor channels.
 *
 * The protocol logic is lifted verbatim from the original phase2_client.js; the
 * only changes are: console writes become emit('log', ...), setState() emits a
 * 'state' event, and process.exit() is replaced by a 'closed' event so a host
 * process (GUI runner or CLI) decides what to do.
 *
 * Commands (for live control from a UI):
 *   start()  bind socket + begin handshake
 *   ready()  send ServerRestartPlayer now (Phase 3 spawn)
 *   leave()  graceful disconnect (close control channel)
 *   stop()   leave if joined, else just close; idempotent
 *
 * Events: 'log'(line) 'state'({from,to}) 'status'(snapshot) 'admitted'
 *         'actorChannel'({chIndex,opens,numBits,dataHex,count}) 'ready'
 *         'leaving' 'failed'(reason) 'closed'
 */
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

// Locate a Killing Floor System dir (has Engine.u/KFMod.u) for the net cache; null if none found.
function findSystemDir() {
  const cands = [process.env.KF_SYSTEM_DIR, path.join(__dirname, '..', '_kfds', 'System'),
    'D:/games/SteamLibrary/steamapps/common/KillingFloor/System',
    'C:/Program Files (x86)/Steam/steamapps/common/KillingFloor/System'];
  return cands.find((d) => d && fs.existsSync(path.join(d, 'Engine.u')) && fs.existsSync(path.join(d, 'KFMod.u'))) || null;
}
const { EventEmitter } = require('events');
const { BitWriter } = require('./bitstream');
const { hexdump } = require('./hexdump');
const { UEConnection, CHTYPE } = require('./netconn');
const { WorldState } = require('./worldstate');
const { packageDirs, findGameRoot, findPackageFile, findCachedByGuid } = require('./pkgmap');
const { PackageDownloader } = require('./pkgdownload');

const ENGINE_VERSION = 3369;       // KF is UT2004-lineage; override with cfg.ver if capture differs
const ENGINE_MIN_NET_VERSION = 3180;

// UGameEngine::ChallengeResponse(INT Challenge) from UT2004 v3369 UnGame.cpp:
//   return (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16);
// All math is 32-bit signed/unsigned wrap -> do it in 32-bit space.
function challengeResponse(challenge) {
  const c = challenge | 0;
  return (Math.imul(c, 237) ^ 0x93fe92ce ^ (c >> 16) ^ (c << 16)) | 0;
}

// Config defaults. _steam32 lives one level up from lib/.
function defaults() {
  return {
    server: '127.0.0.1:7707', name: 'Bot', netspeed: 15000, url: null,
    ready: false, pcChannel: null, restartIndex: null, selectVetIndex: null,
    systemDir: findSystemDir(), rpcClass: 'KFPlayerController',
    ver: ENGINE_VERSION, minver: ENGINE_MIN_NET_VERSION, sendNetspeed: true,
    steamid: '76561197960681930', blob: '', blobSize: null,
    readyDelay: 5000, leaveDelay: 10000, netMax: 1024, connectTimeout: 30000, kickSilenceMs: 30000,
    realSteam: false, captureRepl: false, debug: false,   // debug: per-packet hexdump/SEND/RECV/ACK spam (floods the GUI)
    steamNode: path.join(__dirname, '..', '_steam32', 'node-v22.12.0-win-x86', 'node.exe'),
    steamHelper: path.join(__dirname, '..', '_steam32', 'steamhelper.js'),
  };
}

class BotSession extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = Object.assign(defaults(), cfg);
    if (!this.cfg.serverHost || !this.cfg.serverPort) {
      const [host, port] = String(this.cfg.server).split(':');
      this.cfg.serverHost = host;
      this.cfg.serverPort = parseInt(port, 10);
    }
    if (this.cfg.url == null) this.cfg.url = '?Class=Engine.Pawn?Character=Corporal_Lewis?team=1?VAC=1?Name=' + this.cfg.name;

    this.state = 'init';
    this.actorChannels = {};   // chIndex -> { opens }
    this._fileChannels = new Set();   // channels the server is streaming a downloaded package on
    this._nextFileChannel = 200;      // file channels we open for downloads (high, clear of actor channels)
    this._redirectUrl = null;         // HTTP redirect base (DLMGR) - modded servers ship .uz2 here
    this._httpActive = false;         // an HTTP redirect download is running (holds JOIN, keeps acks flowing)
    this._httpProgress = null;        // { name, bytes, size, pct } for the connecting event
    this._welcomed = false;           // got WELCOME (ignore the server's re-sent ones)
    this._downloadsFinished = false;  // guards the single JOIN after downloads
    this._downloader = null;          // lazily created when we request a package (cfg.pkgDownload)
    this.joined = false;
    this.joinSent = false;     // true once JOIN is on the wire -> start ACKing the server
    this.leaving = false;
    this.closed = false;
    this.serverIPInt = 0;      // host-order uint32 of the server IP, for InitiateGameConnection
    this.helloTries = 0;
    this._timers = [];
    this._ackInterval = null;
    this.sock = null;

    this.conn = new UEConnection(
      (buf) => { if (this.sock) this.sock.send(buf, this.cfg.serverPort, this.cfg.serverHost); },
      {
        log: (l) => this._log(l),
        verbose: this.cfg.debug,
        onControlText: (cmd, rec) => this.handleControl(cmd, rec),
        onBunch: (rec) => this.handleActorBunch(rec),
        onClose: (reason) => this.handleServerClose(reason),
      }
    );

    // Inbound world state (HP/AP/EXP/Load + map objects) - needs the .u net cache.
    this.world = null;
    if (this.cfg.systemDir) {
      try {
        this.world = new WorldState(this.cfg.systemDir, this.cfg.name, { now: () => Date.now(), steamId: this.cfg.steamid });
        if (process.env.KF_DEBUG_SELF || this.cfg.debugSelf) this.world.debugSelf = true;
        if (process.env.KF_CAPTURE_REPL) this.cfg.captureRepl = true;   // raw bunch dump to the log (offline analysis)
      } catch (e) { this._log('world state disabled: ' + e.message); }
    }
    this._worldEmitAt = 0;
    this._worldListAt = 0;
    this._worldTimer = null;
    this._t0 = Date.now();
  }

  // Emit position snapshots at ~10/s (matching KF's ~10 Hz replication) so the renderer's glide
  // interpolation has fine input; the heavier world lists (Players/Monsters/Items) still refresh ~1/s below.
  _scheduleWorldEmit() {
    if (this._worldTimer) return;
    const wait = Math.max(0, 100 - (Date.now() - this._worldEmitAt));
    this._worldTimer = setTimeout(() => {
      this._worldTimer = null; this._worldEmitAt = Date.now();
      this.world.playerList();          // sniff names first so the map snapshot can label player dots
      const snap = this.world.snapshot();
      this._reportDamage(snap.self);    // damage / death / spawn lines for the Events log
      this.emit('stats', { ...snap.stats, ...snap.self });   // stats + alive/spawned/positioned for the UI
      this.emit('mapObjects', snap.objects);
      if (this.world.pendingChat.length) {
        for (const c of this.world.pendingChat.splice(0)) { this._log('[CHAT] ' + c.from + ': ' + c.text); this.emit('chat', c); }
      }
      // World lists (Players/Monsters/Items) refresh ~1/s - cheaper than the 4/s map stream.
      if (Date.now() - this._worldListAt >= 1000) {
        this._worldListAt = Date.now();
        const monsters = snap.objects.filter((o) => o.type === 'mon').map((o) => ({ ch: o.chIndex, name: o.name || 'Zed', hp: o.hp }));
        const items = snap.objects.filter((o) => o.type === 'item').map((o) => ({ ch: o.chIndex, name: o.name }));
        const traders = snap.objects.filter((o) => o.type === 'trader').map((o) => ({ ch: o.chIndex, name: o.name }));
        const doors = snap.objects.filter((o) => o.type === 'door').map((o) => ({ ch: o.chIndex, name: o.name }));
        this.emit('world', { players: this.world.playerList(), monsters, items, traders, doors, wave: snap.wave });
      }
    }, wait);
    this._timers.push(this._worldTimer);
  }

  // Surface HP changes as Events lines: how much damage a hit dealt, healing, death, and (re)spawn.
  // Driven by the ~10/s self snapshot, so hits landing inside one 100 ms window read as a single blow -
  // fine for a readable combat log. HP follows UE2's default rule (a full 100 that never replicated shows
  // as 100), so the first replicated value below 100 correctly reads as the damage that dropped us there.
  // Only HP is tracked: armour has no reliable baseline (its default never replicates), so a hit fully
  // absorbed by armour isn't reported - the death and HP-damage cases the user asked for always are.
  _reportDamage(self) {
    if (!self) return;
    const prev = this._dmgPrev;
    const cur = { alive: !!self.alive, spawned: !!self.spawned, hp: self.hp != null ? self.hp : null };
    this._dmgPrev = cur;
    if (!prev) return;                       // first sample: establish the baseline silently
    const now = Date.now();
    if (prev.alive && !cur.alive) {
      // Alive -> not alive: died (or the server un-possessed us). Debounced so relevancy churn that
      // briefly drops the pawn channel can't spam the log.
      if (now - (this._deathLoggedAt || 0) > 1500) {
        this._deathLoggedAt = now;
        this._log('>>> YOU DIED' + (prev.hp != null ? ' — was ' + prev.hp + ' HP' : ''));
      }
      return;
    }
    if (!prev.alive && cur.alive) {
      if (now - (this._spawnLoggedAt || 0) > 1500) {
        this._spawnLoggedAt = now;
        this._log('>>> spawned — HP ' + (cur.hp != null ? cur.hp : 100));
      }
      return;
    }
    if (prev.alive && cur.alive && prev.hp != null && cur.hp != null && cur.hp !== prev.hp) {
      const d = cur.hp - prev.hp;
      if (d < 0) this._log('>>> took ' + (-d) + ' damage — HP ' + cur.hp);
      else this._log('>>> healed +' + d + ' — HP ' + cur.hp);
    }
  }

  // --- emit helpers ---
  _log(line) { this.emit('log', line); }

  _statusSnapshot() {
    return {
      state: this.state,
      joined: this.joined,
      actorChannelCount: Object.keys(this.actorChannels).length,
      name: this.cfg.name,
      server: this.cfg.serverHost + ':' + this.cfg.serverPort,
      realSteam: !!this.cfg.realSteam,
      steamid: this.cfg.steamid,
    };
  }

  setState(s) {
    const from = this.state;
    this._log('== STATE: ' + from + ' -> ' + s + ' ==');
    this.state = s;
    this.emit('state', { from, to: s });
    this.emit('status', this._statusSnapshot());
  }

  // --- public commands ---
  start() {
    if (this.sock || this.closed) return;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf) => {
      this._lastRecv = Date.now();
      if (this.cfg.debug) { this._log('\n<<< recv ' + buf.length + 'B'); this._log(hexdump(buf, '    ')); }
      this.conn.receive(buf);
    });
    this.sock.on('error', (e) => {
      this._log('[socket error] ' + e.message);
      // On Windows a UDP send to a closed/offline port surfaces asynchronously as ECONNRESET/
      // ECONNREFUSED. Before we're joined that means the server isn't listening - fail with a clear
      // reason instead of silently wedging until the connect timeout.
      const code = e && e.code;
      if (!this.joined && !this.closed && !this.leaving && (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')) {
        this._log('!! server unreachable at ' + this.cfg.serverHost + ':' + this.cfg.serverPort + ' — offline, wrong port, or firewalled (' + code + ')');
        this.setState('failed');
        this.emit('failed', 'unreachable: ' + this.cfg.serverHost + ':' + this.cfg.serverPort + ' (' + code + ')');
        this._close();
      }
    });
    this.sock.bind(0, async () => {
      this._log('== KF headless client ==');
      this._log('server ' + this.cfg.serverHost + ':' + this.cfg.serverPort + '  name="' + this.cfg.name +
        '"  ver=' + this.cfg.ver + '/' + this.cfg.minver + (this.cfg.realSteam ? '  [REAL STEAM]' : ''));
      this.serverIPInt = await this.resolveServerIP();
      // A user-entered SteamID (steamidOverride) always wins - connect under any identity; only fall
      // back to the logged-in account's real SteamID when the field is left blank.
      const sidOverride = this.cfg.steamidOverride && String(this.cfg.steamidOverride).trim();
      if (sidOverride && /^\d{5,20}$/.test(sidOverride)) {
        this.cfg.steamid = sidOverride;
        if (this.world) this.world.mySteamId = this.cfg.steamid;
        this.cfg.url = '?Class=Engine.Pawn?Character=Corporal_Lewis?team=1?VAC=1?Name=' + this.cfg.name;
        this._log('custom SteamID: ' + this.cfg.steamid + (this.cfg.realSteam ? ' (real ticket still fetched for your account)' : ''));
      }
      if (this.cfg.realSteam && !sidOverride) {
        try {
          this.cfg.steamid = this.callSteam('id');
          if (this.world) this.world.mySteamId = this.cfg.steamid;   // self anchor for the map
          this.cfg.url = '?Class=Engine.Pawn?Character=Corporal_Lewis?team=1?VAC=1?Name=' + this.cfg.name; // keep name; SteamID is sent in HELLO
          this._log('real SteamID: ' + this.cfg.steamid + '  server IP int: ' + (this.serverIPInt >>> 0));
        } catch (e) {
          this._log('!! Steam helper "id" failed: ' + (e.message || e));
          this._log('   Start Steam and log into an account that owns Killing Floor (AppID 1250), then retry.');
          this.setState('failed');
          this.emit('failed', 'steam-id: ' + (e.message || e));
          this._close();
          return;
        }
      }
      this.emit('status', this._statusSnapshot());
      this.sendHello();
    });
    // ACK the server from JOIN onward. After JOIN the server opens the world's actor
    // channels with reliable bunches, and reliable delivery stalls if the client never
    // ACKs. Gating this on `joined` deadlocked: `joined` only flips on an inbound actor
    // bunch, which the server won't deliver until its reliable window is ACKed. If the
    // first actor-open packet is lost (real network), the bot would wedge in `joining`.
    // Retransmit unacked reliable bunches (handshake survives dropped packets) + ACK the server.
    // ~11 Hz: fast enough that the streamed ServerMove keep-alive (below) looks like a live client so the
    // server / AFK-kicker never drops us, while still cheaply ACKing + retransmitting.
    this._ackInterval = setInterval(() => { this.conn.retransmit(); if (this.joinSent || this._downloading()) this.conn.flushAcks(); this._probePcChannel(); this._ackPossessionIfNeeded(); this._readyRetryIfNeeded(); this._probePossession(); this._syncPosition(); this._tickMove(); this._debugSelfTick(); this._refetchMissingPackages(); }, 90);
    // Connect watchdog: surface a clear "connecting (stage, Ns)" status and fail cleanly on timeout,
    // instead of silently wedging when a stage's reply never arrives.
    this._connectStart = Date.now();
    this._connectWatch = setInterval(() => this._checkConnect(), 1000);
    this._timers.push(this._connectWatch);
    // Post-join silence watchdog: once in-level the server streams replication constantly, so a long
    // gap means we were kicked or the link dropped. The pre-join watchdog above only covers handshake.
    this._lastRecv = Date.now();
    this._silenceWatch = setInterval(() => this._checkSilence(), 1000);
    this._timers.push(this._silenceWatch);
  }

  _checkSilence() {
    if (!this.joined || this.closed || this.leaving) return;
    if (Date.now() - this._lastRecv >= this.cfg.kickSilenceMs) {
      clearInterval(this._silenceWatch); this._silenceWatch = null;
      this.handleServerClose('no data from server for ' + Math.round(this.cfg.kickSilenceMs / 1000) + 's (kicked or connection lost)');
    }
  }

  // Server closed our connection while in-level (admin kick, ban, session end) - surface it cleanly.
  handleServerClose(reason) {
    if (this.closed || this.leaving) return;
    this._log('!! disconnected by server: ' + reason);
    this.setState('kicked');
    this.emit('kicked', reason);
    this._close();
  }

  _downloading() { return this._httpActive || !!(this._downloader && this._downloader.hasPending()); }

  _checkConnect() {
    if (this.joined || this.closed || this.leaving || this.state === 'failed') {
      if (this._connectWatch) { clearInterval(this._connectWatch); this._connectWatch = null; }
      return;
    }
    // Holding JOIN while an in-game download runs - don't let the handshake watchdog trip; the download
    // has its own progress watchdog. Report byte progress, and detect two failure modes the user must see:
    // a download that STOPS making progress (dead redirect) vs one that only crawls (very slow link).
    if (this._downloading()) {
      this._connectStart = Date.now();
      const progress = this._httpActive ? this._httpProgress : this._downloader.progress();
      const bytes = (progress && progress.bytes) || 0;
      const now = Date.now();
      if (this._dlStartAt == null) { this._dlStartAt = now; this._dlLastBytes = bytes; this._dlLastChange = now; }
      if (bytes > this._dlLastBytes) { this._dlLastBytes = bytes; this._dlLastChange = now; }
      const stalledMs = now - this._dlLastChange;
      // No progress at all for the stall window: the redirect/file channel is dead - stop waiting, surface why.
      if (stalledMs >= (this.cfg.downloadStallMs || 60000)) {
        clearInterval(this._connectWatch); this._connectWatch = null;
        const mb = (bytes / 1048576).toFixed(1);
        this._log('!! download stalled — no progress for ' + Math.round(stalledMs / 1000) + 's at ' + mb + ' MB');
        this.setState('failed');
        this.emit('failed', 'download stalled: no progress for ' + Math.round(stalledMs / 1000) + 's (stuck at ' + mb + ' MB — the server\'s redirect is down or blocking)');
        this._close();
        return;
      }
      // Progressing, but crawling: warn once with a Continue/Cancel choice instead of silently creeping.
      const elapsedDl = now - this._dlStartAt;
      if (!this._dlSlowWarned && !this._dlSlowAck && bytes > 0 && elapsedDl > (this.cfg.downloadSlowAfterMs || 25000)) {
        const rate = bytes / (elapsedDl / 1000);
        if (rate < (this.cfg.downloadSlowRate || 25000)) {
          this._dlSlowWarned = true;
          this.emit('connecting', { stage: 'downloading', elapsedMs: 0, progress, downloadSlow: { rateKB: Math.max(1, Math.round(rate / 1000)), pct: (progress && progress.pct) || 0, mb: (bytes / 1048576).toFixed(1) } });
        }
      }
      this.emit('connecting', { stage: 'downloading', elapsedMs: 0, progress });
      return;
    }
    this._dlStartAt = null; this._dlSlowWarned = false;   // reset stall tracking once past download
    const elapsed = Date.now() - this._connectStart;
    this.emit('connecting', { stage: this.state, elapsedMs: elapsed, inflight: this.conn._outbox.length });
    if (elapsed >= this.cfg.connectTimeout) {
      clearInterval(this._connectWatch); this._connectWatch = null;
      const stalledStage = this.state;
      const why = {
        hello: 'server never answered HELLO — it is offline, the port is wrong, or it refuses our client version (VER/MINVER)',
        steamauth: 'server got HELLO but Steam auth stalled — VAC/Steam ticket rejected, or the server needs a different SteamID',
        login: 'server accepted Steam auth but never sent WELCOME — it may be full, password-protected, or mid map-change',
        welcomed: 'sent JOIN but the server never began replicating — package/version mismatch',
        joining: 'sent JOIN but no world replication arrived — likely a package/version mismatch',
      }[stalledStage] || 'no reply from the server';
      this._log('!! connection timed out at "' + stalledStage + '" after ' + Math.round(elapsed / 1000) + 's: ' + why);
      this.setState('failed');
      this.emit('failed', 'timeout at ' + stalledStage + ': ' + why);
      this._close();
    }
  }

  ready() { this.attemptReady(); }

  // User chose "keep waiting" on the slow-download dialog: stop warning; the stall watchdog still guards a
  // download that fully dies, but slow-but-moving is now accepted.
  ackSlowDownload() { this._dlSlowAck = true; }

  leave() { this.doLeave(); }

  stop() {
    if (this.closed) return;
    if (this.joined && !this.leaving) this.doLeave();
    else this._close();
  }

  // --- handshake / network internals (ported from phase2_client.js) ---
  resolveServerIP() {
    return new Promise((resolve) => {
      require('dns').lookup(this.cfg.serverHost, { family: 4 }, (err, addr) => {
        if (err || !addr) return resolve(0);
        const p = addr.split('.').map(Number);
        resolve((((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0));
      });
    });
  }

  callSteam() {
    const { execFileSync } = require('child_process');
    const a = Array.prototype.slice.call(arguments);
    // stdio stderr='pipe' (captured on failure, not inherited) so the Steam SDK's harmless
    // "Setting breakpad minidump AppID"/"Caching Steam ID [API loaded no]" chatter never leaks
    // to our stderr and floods the GUI Errors tab. On error the thrown err.stderr still has it.
    return execFileSync(this.cfg.steamNode, [this.cfg.steamHelper].concat(a),
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  // Pad to the stock client's chunk layout (16 chunks * 128 bytes) and emit
  // STEAMCLIENTBLOB SIZE=<realsize> CHUNK=0..15 BLOB=<256 hex> + STEAMTICKET CHUNK=0..3.
  sendSteamBlob(blobBytes) {
    const CHUNK_BYTES = 128, N_CHUNKS = 16;
    const realSize = blobBytes.length;
    const buf = Buffer.alloc(N_CHUNKS * CHUNK_BYTES, 0x00);
    blobBytes.copy(buf, 0, 0, Math.min(realSize, buf.length));
    const hex = buf.toString('hex'); // lowercase, like the client's %02x
    for (let k = 0; k < N_CHUNKS; k++)
      this.conn.sendControl('STEAMCLIENTBLOB SIZE=' + realSize + ' CHUNK=' + k + ' BLOB=' + hex.substr(k * CHUNK_BYTES * 2, CHUNK_BYTES * 2));
    for (let c = 0; c < 4; c++) this.conn.sendControl('STEAMTICKET SIZE=1 CHUNK=' + c); // CHUNK=3 = trigger
    this._log('   sent ' + realSize + '-byte blob (16 chunks + STEAMTICKET terminator)');
  }

  handleControl(cmd) {
    const word = cmd.split(/\s+/)[0].toUpperCase();
    if (word === 'STEAMENCRYPTIONKEY') {
      // KF/Tripwire Steam-auth step (reversed from Engine.dll NotifyReceivedText):
      //   server decodes each STEAMCLIENTBLOB (CHUNK<32) as lowercase hex -> 128 bytes/chunk
      //   stored at offset CHUNK*128; STEAMTICKET SIZE=1 CHUNK=3 TRIGGERS the server to call
      //   SendUserConnectAndAuthenticate(blob, SIZE) -> on approve, CHALLENGE.
      // With Goldberg on the server, any blob >=24 bytes not matching the HEMU/"rev"/0x14
      // magics is approved via an IP-derived fallback SteamID (gbe_fork auth.cpp).
      this.setState('steamauth');
      let blobBytes;
      if (this.cfg.realSteam) {
        const sid = (/STEAMID=(-?\d+)/.exec(cmd) || [])[1] || '0';
        const sec = (/SECURE=(\d+)/.exec(cmd) || [])[1] || '0';
        try {
          const hex = this.callSteam('blob', sid, String(this.serverIPInt >>> 0), String(this.cfg.serverPort), sec);
          blobBytes = Buffer.from(hex.trim(), 'hex');
          this._log('   REAL Steam ticket: ' + blobBytes.length + ' bytes (server ' + sid + ' secure=' + sec + ')');
        } catch (e) {
          // The helper writes a clean code to stderr (STEAM_INIT_FAILED etc.) then exits; execFileSync's
          // err.message is the whole "Command failed: <node.exe path> <steamhelper.js> blob ..." line - pure
          // noise in the dialog. Show only the code + a likely cause, not the paths/args.
          const m = (((e.stderr || '') + '')).match(/\b(STEAM_[A-Z_]+|STEAMUSER_NULL|TICKET_FAILED(?:\s+-?\d+)?)\b/);
          const code = (m && m[1]) || (e.killed ? 'STEAM_TIMEOUT' : 'STEAM_TICKET_FAILED');
          const cause = {
            STEAM_INIT_FAILED: 'Steam клиент не запущен',
            STEAM_DLL_NOT_FOUND: 'Killing Floor не установлен через Steam',
            STEAMUSER_NULL: 'нет входа в аккаунт Steam',
            TICKET_FAILED: 'Steam не выдал auth-билет',
            STEAM_TIMEOUT: 'Steam не ответил (таймаут)',
          }[code.split(/\s+/)[0]];
          const msg = 'steam-ticket: ' + code + (cause ? ' — ' + cause : '');
          this._log('!! ' + msg);
          this.setState('failed');
          this.emit('failed', msg);
          return;
        }
      } else {
        const realSize = (this.cfg.blobSize !== null && this.cfg.blobSize !== undefined) ? this.cfg.blobSize : 256;
        blobBytes = Buffer.alloc(realSize, 0xAA);            // non-magic synthetic blob (Goldberg)
      }
      this.sendSteamBlob(blobBytes);
      return;
    }
    if (word === 'CHALLENGE') {
      // CHALLENGE VER=%i CHALLENGE=%i STATS=%i SEC=%i GZ=%i
      const m = /CHALLENGE=(-?\d+)/.exec(cmd);
      const challenge = m ? parseInt(m[1], 10) : 0;
      const resp = challengeResponse(challenge);
      this._log('   challenge=' + challenge + ' -> response=' + resp);
      this.setState('login');
      const lines = [];
      if (this.cfg.sendNetspeed) lines.push('NETSPEED ' + this.cfg.netspeed);
      // cfg.url carries the player-setup options (Class/Character/team/Sex/Name/VAC) built at construct time -
      // a modded GameInfo (KFGameTypeX) needs them to spawn a pawn; the stock server fills defaults if absent.
      lines.push('LOGIN RESPONSE=' + resp + ' URL=' + this.cfg.url);
      this.conn.sendControl(lines);
    } else if (word === 'USES') {
      // USES GUID=%s PKG=%s FLAGS=%i SIZE=%i GEN=%i FNAME=%s  -> claim we already have it.
      // The PKG order IS the net package-map order, which the world decoder needs to resolve class refs.
      this._lastUsesAt = Date.now();   // WELCOME can arrive mid-stream; we must JOIN only after this settles
      const g = /GUID=([0-9A-Fa-f]+)/.exec(cmd);
      const gen = /GEN=(\d+)/.exec(cmd);
      const pkg = /PKG=(\S+)/.exec(cmd);
      const fn = /FNAME=(\S+)/.exec(cmd);
      const sz = /SIZE=(\d+)/.exec(cmd);
      const guid = g ? g[1] : '';
      const generation = gen ? gen[1] : '0';
      const name = pkg ? pkg[1] : '';
      const fname = fn ? fn[1] : (name + '.u');
      if (name && this.world && !this.world.usesOrder.some((u) => u.name === name)) {
        this.world.usesOrder.push({ name, guid, gen: +generation, fname, size: sz ? +sz[1] : 0 });
        // (worldstate._ensurePkgMap rebuilds the object table itself as this list grows, so a modded server
        //  that streams ServerPackages after JOIN converges to the full-list MaxObjectIndex.)
      }
      // Package download: fetch EVERY server package we lack - code, meshes, textures, sounds, the map -
      // exactly like the real client. The net object table numbers refs by summing every USES package's
      // export count in order and STOPS at the first one we're missing, so a single absent mesh (e.g. a
      // custom .ukx early in the list) leaves MaxObjectIndex brute-forced and wrong, which breaks class
      // resolution -> position corrections -> movement. Having every package makes the map exact on any
      // server. No size cap by default (modded packs are GB-scale and the user opted in); set
      // pkgDownloadMaxBytes to bound. Downloads cache under downloads/ so later connects are instant.
      const size = sz ? +sz[1] : 0;
      const cap = this.cfg.pkgDownloadMaxBytes != null ? this.cfg.pkgDownloadMaxBytes : Infinity;
      const forced = this.cfg.pkgDownloadForce && this.cfg.pkgDownloadForce.indexOf(name) >= 0;   // test aid
      const wantIt = this.cfg.pkgDownload && name && size > 0 && size <= cap && (forced || !this._hasPackage(name, guid));
      if (wantIt) {
        this._ensureDownloader();
        this._downloader.want(name, guid, generation, size, fname);
        this._log('   need "' + fname + '" (' + size + ' B) — requesting download (no HAVE)');
        // NOT sending HAVE lets the server keep the download loop going while we fetch this out-of-band.
      } else {
        if (this.cfg.pkgDownload && name && size > cap && !this._hasPackage(name, guid)) {
          this._log('   skip download "' + fname + '" (' + size + ' B > cap) — map stays incomplete, decode limited');
        }
        this.conn.sendControl('HAVE GUID=' + guid + ' GEN=' + generation, { quiet: true });
      }
    } else if (word === 'WELCOME') {
      // server accepted us; real client would load the map. We just JOIN.
      // WELCOME LEVEL=<map> GAME=<class> LONE=<n> - the map name lets the GUI build a top-down background.
      const lvl = /LEVEL=(\S+)/.exec(cmd);
      if (lvl) { this.mapName = lvl[1]; this.emit('map', { mapName: lvl[1], systemDir: this.cfg.systemDir }); }
      if (this._welcomed) return;   // ignore the server's re-sent WELCOMEs (it loops the download negotiation)
      this.setState('welcomed');
      this._welcomed = true;
      // A modded server streams its 700+ USES (ServerPackages) around AND well after the first WELCOME. JOIN
      // before the client has acknowledged them all and the server replicates only the base actors (ch1/ch2)
      // - no pawn, no zeds. So wait for the USES stream to go quiet, then JOIN (the server re-sends WELCOME up
      // to 4x, so this settle-join still lands in the accept window).
      this._joinWhenUsesSettle();
    } else if (word === 'FAILCODE') {
      // The server rejects the login with a code (e.g. "FAILCODE SERVERFULL") - map the common ones to a
      // clear reason so a full / passworded / banned server isn't reported as a vague login timeout.
      const code = (cmd.split(/\s+/)[1] || '').toUpperCase();
      const reasons = {
        SERVERFULL: 'server is full — all player slots are taken',
        NEEDPW: 'server is password-protected',
        WRONGPASSWORD: 'wrong server password',
        BANNED: 'you are banned from this server',
        KICKED: 'kicked by the server',
        SERVERRESTARTING: 'server is restarting',
      };
      const why = reasons[code] || ('login rejected (' + (code || 'unknown code') + ')');
      this._log('!! login rejected: ' + why + '  [' + cmd.trim() + ']');
      this.setState('failed');
      this.emit('failed', why);
      this._close();
    } else if (word === 'FAILURE' || word === 'UPGRADE') {
      this._log('!! server rejected: ' + cmd);
      this.setState('failed');
      this.emit('failed', cmd.replace(/^(FAILURE|UPGRADE)\s*/i, '') || cmd);
      this._close();
    } else if (word === 'DLMGR' || word === 'SKIP') {
      // Download-manager options. An HTTP redirect (IpDrv.HTTPDownload, .uz2) is how modded servers ship
      // content - many decline the in-game File channel entirely, so capture the redirect base and prefer it.
      const cls = /CLASS=(\S+)/.exec(cmd), params = /PARAMS=(\S+)/.exec(cmd);
      if (cls && /HTTPDownload/i.test(cls[1]) && params && /^https?:\/\//i.test(params[1])) this._redirectUrl = params[1];
    }
  }

  // A bunch on a File channel (chType 3) carries a downloading package, not actor replication - route it
  // to the downloader (and keep routing that channel's later bunches, which no longer carry the type).
  _isFileChannel(rec) { return rec.chType === CHTYPE.File || this._fileChannels.has(rec.chIndex); }

  handleActorBunch(rec) {
    if (this._downloader && this._isFileChannel(rec)) {
      this._fileChannels.add(rec.chIndex);
      try { this._downloader.onFileBunch(rec); } catch (e) { this._log('!! download error: ' + (e.message || e)); }
      if (rec.bClose) this._fileChannels.delete(rec.chIndex);
      return;
    }
    if (!this.joined) { this.joined = true; this.onJoined(); }
    // full inbound actor replication dump (for reverse-engineering property layout)
    if (this.cfg.captureRepl) this._log('REPL ch=' + rec.chIndex + ' o=' + (rec.bOpen ? 1 : 0) +
      ' c=' + (rec.bClose ? 1 : 0) + ' bits=' + rec.numBits + ' ' + (rec.payloadHex || ''));
    if (this.world) {
      try { this.world.onBunch(rec); } catch (e) {}
      this._detectPcChannel();   // (throttled) re-pins if the server churns our PlayerController channel
      if (!this._acked && this.world.myPawn != null) { this._acked = true; this.sendAcknowledge(this.world.myPawn); }
      this._scheduleWorldEmit();
    }
    if (rec.bOpen) {
      const ch = this.actorChannels[rec.chIndex] = this.actorChannels[rec.chIndex] || { opens: 0 };
      ch.opens++;
      const dataHex = (rec.payloadHex || '').slice(0, 64);
      if (this.cfg.debug) this._log('   actor channel OPEN ch=' + rec.chIndex + ' (' + rec.numBits + ' bits)  data=' + dataHex);
      this.emit('actorChannel', {
        chIndex: rec.chIndex, opens: ch.opens, numBits: rec.numBits, dataHex,
        count: Object.keys(this.actorChannels).length,
      });
      this.emit('status', this._statusSnapshot());
    }
  }

  onJoined() {
    this.setState('in-level');
    this._log('>>> ADMITTED: server is replicating the world (we are a connected spectator).');
    this.emit('admitted');
    // Auto-Ready: press Ready (ServerReStartPlayer -> bReadyToPlay / RestartPlayer) shortly after admit
    // so the bot readies itself right after connecting. We NEVER auto-leave - the bot stays until the
    // user clicks Leave/Logout (a self-disconnect after a delay used to look like a server kick).
    if (this.cfg.ready) {
      this._log('   Auto-Ready: sending Ready ' + (this.cfg.readyDelay / 1000) + 's after admit');
      this._timers.push(setTimeout(() => this.attemptReady(), this.cfg.readyDelay));
    }
  }

  // Graceful leave: close the control channel (server runs NotifyLogout), then close.
  doLeave() {
    if (this.leaving || this.closed) return;
    this.leaving = true;
    this.setState('leaving');
    this._log('>>> LEAVING: disconnecting from server');
    this.emit('leaving');
    try { this.conn.sendControlClose(); } catch (e) { this._log('  close err: ' + e.message); }
    this._timers.push(setTimeout(() => this._close(), 600));
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    this._log('== disconnected, exiting ==');
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    if (this._ackInterval) { clearInterval(this._ackInterval); this._ackInterval = null; }
    if (this._dlPoll) { clearInterval(this._dlPoll); this._dlPoll = null; }
    this._stopMoveTimer();
    try { if (this.sock) this.sock.close(); } catch (e) {}
    this.sock = null;
    this.emit('closed');
    this.emit('status', this._statusSnapshot());
  }

  // Phase 3 - reversed from Engine.dll AActor::ProcessRemoteFunction -> ReplicateFunction:
  //   a reliable bunch on the actor's channel, payload = WriteInt(FieldNetIndex, GetMaxIndex()).
  // For a no-arg function (ServerRestartPlayer) that is the entire payload.
  sendRpc(chIndex, fieldIndex, netMax) {
    const payload = new BitWriter();
    payload.writeIntUE(fieldIndex, netMax);   // the engine reads the field index value-aware
    this.conn.sendActorBunch(chIndex, payload, { reliable: true });
    this._log('   RPC -> ch=' + chIndex + ' field=' + fieldIndex + ' max=' + netMax + ' (' + payload.bitLength() + ' bits)');
  }

  // Net index + GetMaxIndex for a client->server RPC. A modded server can replace the PlayerController;
  // its inherited RPCs keep the stock indices (custom fields append after in the hierarchy walk), but
  // GetMaxIndex grows with the custom fields - and BOTH sides of the wire (our value-aware handle write,
  // the server's read) use that max. So once our PC channel's class resolves to a downloaded custom class,
  // take index+max from ITS net table - exactly what the real client derives after downloading the package.
  _rpcIndex(funcName) {
    const w = this.world;
    // The PC channel is known either from a decoded correction/restart (myPcChannel) or from the class
    // scan (cfg.pcChannel) - use whichever exists; the value-aware handle width must match the server's
    // class for indices whose encoding differs between the stock and custom GetMaxIndex brackets.
    const pcCh = w ? (w.myPcChannel != null ? w.myPcChannel : this.cfg.pcChannel) : null;
    const cls = pcCh != null ? w.classFor(pcCh) : null;   // classFor caches per channel
    if (cls) {
      const nf = w.netFieldsByClass(cls);
      const f = nf && nf.find((x) => x.name === funcName && x.isFunc);
      if (f) return { index: f.index, max: nf.length };
    }
    if (!this.cfg.systemDir) return null;
    try { return require('./netcache').fieldNetIndex(this.cfg.systemDir, this.cfg.rpcClass, funcName); } catch (e) { return null; }
  }
  // Do we already have this package on disk - by name (client install / server dir / our downloads) or by
  // GUID in the real client's Cache (where playing the server in the retail client stored it)? The GUID
  // check is what avoids re-downloading gigabytes the user already fetched by simply playing the server.
  _hasPackage(name, guid) {
    if (!this._gameRoot) this._gameRoot = findGameRoot(this.cfg.systemDir);
    if (!this._pkgDirs) this._pkgDirs = packageDirs(this._gameRoot, this.cfg.systemDir);
    return !!findPackageFile(name, this._pkgDirs) || !!findCachedByGuid(guid, this._gameRoot);
  }
  _ensureDownloader() {
    if (this._downloader) return;
    this._downloadDir = this.cfg.downloadDir || path.join(__dirname, '..', 'downloads');
    this._downloader = new PackageDownloader({ log: (l) => this._log(l), destDir: this._downloadDir, capture: this.cfg.pkgDownloadCapture });
  }

  // JOIN once the server's USES stream has been quiet for a moment - i.e. every ServerPackage is HAVE'd or
  // queued for download. Joining mid-stream is why a modded server replicated nothing but the PC/GRI.
  _joinWhenUsesSettle() {
    if (this.joinSent || this.closed || this.leaving) return;
    const quietFor = Date.now() - (this._lastUsesAt || 0);
    if (quietFor < 600) {
      clearTimeout(this._joinSettleTimer);
      this._joinSettleTimer = setTimeout(() => this._joinWhenUsesSettle(), 200);
      return;
    }
    // Once the USES stream is quiet: fetch any wanted packages first (the download re-enters here via
    // _finishDownloads). The _downloadsStarted latch is what makes that re-entry go to JOIN instead of
    // looping back into a second (empty) download - the wants() set isn't cleared until the fetch resolves.
    if (!this._downloadsStarted && this._downloader && this._downloader.wants()) { this._downloadsStarted = true; this._startDownloads(); }
    else this._sendJoin();
  }

  _sendJoin() {
    if (this.joinSent || this.closed) return;
    this.conn.sendControl('JOIN');
    this.joinSent = true;
    this.setState('joining');
  }

  // Shared completion: re-scan package dirs, re-render the map (a just-downloaded .rom renders now), JOIN.
  _finishDownloads() {
    if (this._downloadsFinished) return;
    this._downloadsFinished = true;
    this._httpActive = false;
    if (this._dlPoll) { clearInterval(this._dlPoll); this._dlPoll = null; }
    if (this._dlTimeout) { clearTimeout(this._dlTimeout); this._dlTimeout = null; }
    this._pkgDirs = null;   // re-scan so freshly downloaded packages resolve for decode + map render
    this._log('>>> downloads complete — joining once the USES stream settles');
    if (this.mapName) this.emit('map', { mapName: this.mapName, systemDir: this.cfg.systemDir });
    // A modded server resumes streaming the rest of its 700+ ServerPackages AFTER the download+HAVE, so
    // JOIN via the settle path (not directly) - joining mid-stream is why the server then replicates only
    // ch1/ch2 (no pawn/zeds). Treat "downloads just finished" as a fresh USES tick so we wait one window.
    this._lastUsesAt = Date.now();
    this._joinWhenUsesSettle();
  }

  // Redirect servers ship content over HTTP (.uz2). Fetch every wanted package, then JOIN. Anything the
  // redirect lacks falls back to the in-game File channel.
  _startHttpDownloads() {
    const withGuid = Object.entries(this._downloader.pending).map(([guid, info]) => ({ guid, name: info.name, gen: info.gen, fname: info.fname, size: info.size }));
    const total = withGuid.reduce((s, p) => s + (p.size || 0), 0);
    this._log('>>> HTTP redirect download: ' + withGuid.length + ' package(s), ' + Math.round(total / 1048576) + ' MB from ' + this._redirectUrl);
    this._httpActive = true;
    this._httpProgress = { name: '', bytes: 0, size: total, pct: 0 };
    const { httpRedirectDownload } = require('./pkgdownload');
    // No time budget by default: the real client downloads server content for as long as it takes, and the
    // server keeps a downloading client alive as long as it sees progress. We report that progress by sending
    // HAVE for each package the moment it lands (incremental, out-of-band) - that's what stops the server from
    // kicking us off WELCOME mid-download. Set downloadJoinBudgetMs to cap it (0/undefined = unlimited).
    const deadlineMs = this.cfg.downloadJoinBudgetMs || undefined;
    const haveSent = new Set();
    const sendHave = (c) => { if (c && !haveSent.has(c.guid)) { haveSent.add(c.guid); this.conn.sendControl('HAVE GUID=' + c.guid + ' GEN=' + (c.gen || 0), { quiet: true }); } };
    httpRedirectDownload(this._redirectUrl, withGuid, this._downloadDir, { log: (l) => this._log(l), onProgress: (p) => { this._httpProgress = p; }, onComplete: sendHave, deadlineMs })
      .then((result) => {
        this._httpActive = false;
        const completed = (result && result.completed) || [];
        const missed = (result && result.missed) || [];
        for (const c of completed) sendHave(c);   // catch any the incremental hook missed
        this._downloader.pending = {}; this._downloader.channels = {};
        if (result && result.aborted) {
          this._log('>>> download budget reached — joining with ' + completed.length + ' package(s); the rest cache over reconnects');
          this._finishDownloads();
          return;
        }
        for (const m of missed) this._downloader.pending[String(m.guid).toUpperCase()] = { name: m.name, gen: m.gen || 0, size: m.size, fname: m.fname };
        if (missed.length) { this._log('>>> ' + missed.length + ' package(s) not on the redirect — trying in-game File channel'); this._requestFileDownloads(missed); }
        else this._finishDownloads();
      })
      .catch((e) => { this._httpActive = false; this._log('!! redirect download error: ' + (e.message || e)); this._finishDownloads(); });
  }

  // Open one File channel per package and send the FGuid request; the server streams each back. Used when a
  // server has no redirect, and as the fallback for redirect misses.
  _requestFileDownloads(entries) {
    if (!entries.length) return this._finishDownloads();
    this._log('>>> in-game File-channel download: ' + entries.length + ' package(s)');
    for (const info of entries) {
      const g = String(info.guid).toUpperCase();
      const ch = this._nextFileChannel++;
      this._fileChannels.add(ch);
      this._downloader.expect(ch, g);
      const payload = new BitWriter();
      for (let i = 0; i < 4; i++) payload.writeBits(parseInt(g.substr(i * 8, 8), 16) >>> 0, 32);   // FGuid = 4 uint32
      this.conn.sendFileOpen(ch, payload);
      this._log('   [DL] request "' + info.fname + '" on file ch' + ch + ' (' + info.size + ' B)');
    }
    this._dlPoll = setInterval(() => { if (!this._downloader.hasPending()) this._finishDownloads(); }, 500);
    this._dlTimeout = setTimeout(() => { this._log('>>> download timeout — joining anyway'); this._finishDownloads(); }, this.cfg.pkgDownloadTimeout || 180000);
    this._timers.push(this._dlTimeout);
  }

  _startDownloads() {
    if (this._redirectUrl) return this._startHttpDownloads();
    const entries = Object.entries(this._downloader.pending).map(([guid, info]) => ({ guid, name: info.name, gen: info.gen, fname: info.fname, size: info.size }));
    this._requestFileDownloads(entries);
  }

  // Channels to try an RPC on: the pinned PC channel, else a tiny probe set. The PlayerController is
  // essentially always ch1 (sometimes ch2), so we default to [1,2] - NOT a 1..48 sweep. At the ~11 Hz move
  // keep-alive a 48-channel sweep is ~500 bunches/sec that congests the reliable channel so Ready/chat never
  // arrive (the "client hangs, chat doesn't reach the server" regression). The RPC no-ops on a wrong actor.
  _rpcChannels() {
    if (this.cfg.pcChannel != null) return [this.cfg.pcChannel];
    if (this._pcProbeCh != null) return [this._pcProbeCh];   // brute-force PC discovery in progress
    return this.cfg.pcChannels || [1, 2];
  }

  // Some mods replace the PlayerController with a class from a package we can't fetch - the class ref
  // never resolves, no ClientReStart/Pawn property decodes, and RPCs sent to the default channels go
  // nowhere: no corrections, no position, no move (RD-Anschar servers). Brute-force it: rotate the
  // ack + keep-alive move across candidate channels until the server answers with a position
  // correction - the correction pins myPcChannel and everything else follows. Two full passes, then
  // fall back to the defaults (a server that never corrects can't be probed).
  _probePcChannel() {
    const w = this.world;
    if (!w || !this.joined || this.closed || w.myPawn == null) { this._pcProbeCh = null; return; }
    if (this.cfg.pcChannel != null || w.myPcChannel != null || (w.corrCount || 0) > 0) { this._pcProbeCh = null; return; }
    const now = Date.now();
    if (now - (this._pcProbeAt || 0) < 1400) return;
    this._pcProbeAt = now;
    if (!this._pcProbeList || now - (this._pcProbeBuiltAt || 0) > 20000) {
      const cand = new Set([1, 2]);
      for (const chS of Object.keys(w.openBunches || {})) {
        const ch = +chS;
        if (w.pawns.has(ch) || w.priChannels.has(ch) || ch === w.myPri || ch === w.griChannel || this._fileChannels.has(ch)) continue;
        cand.add(ch);
        if (cand.size >= 48) break;
      }
      this._pcProbeList = [...cand];
      this._pcProbeBuiltAt = now;
      if (this._pcProbeIdx == null) this._pcProbeIdx = 0;
    }
    if (this._pcProbeIdx >= this._pcProbeList.length * 2) { this._pcProbeCh = null; return; }   // give up, defaults
    this._pcProbeCh = this._pcProbeList[this._pcProbeIdx % this._pcProbeList.length];
    this._pcProbeIdx++;
    this._log('   PC probe: ch' + this._pcProbeCh + ' (' + this._pcProbeIdx + '/' + this._pcProbeList.length * 2 + ')');
  }

  // Pin the PlayerController's actor channel by resolving each open channel's class ref against the
  // package map (only OUR PC is replicated to us, so a PlayerController class is uniquely ours). Sending
  // client->server RPCs (ServerMove/Acknowledge/Say) on the exact PC channel avoids the field index
  // resolving to a different function on some other actor's channel. Throttled; needs the package map.
  _detectPcChannel() {
    const now = Date.now();
    if (now - (this._lastPcScan || 0) < 1000) return;
    this._lastPcScan = now;
    if (!this.world) return;
    const pin = (ch, how) => {
      if (this.cfg.pcChannel === +ch) return;   // already pinned here - nothing to do
      this.cfg.pcChannel = +ch;
      this._log('   PC channel: ch' + ch + ' (' + how + ')');
      if (this.world.myPawn != null) this.sendAcknowledge(this.world.myPawn);   // re-ack on the pinned channel
    };
    // 1) The channel the server sends our position corrections on IS our PlayerController - works even on
    // modded servers where the package map is incomplete, and re-pins if the server churns the channel.
    if (this.world.myPcChannel != null) return pin(this.world.myPcChannel, 'from position correction');
    // 2) Else resolve each open channel's class ref (only OUR PlayerController is replicated to us).
    if (this.cfg.pcChannel != null) return;   // keep the class-resolved pin until corrections say otherwise
    if (typeof this.world.classFor !== 'function' || !this.world.openBunches) return;
    for (const ch of Object.keys(this.world.openBunches)) {
      let cls = null;
      try { cls = this.world.classFor(+ch); } catch (e) {}
      if (cls && this.world._isPcClass(cls)) return pin(ch, cls);   // by hierarchy - custom PCs aren't named "*PlayerController"
    }
  }

  // ServerAcknowledgePossession(P, NewHand, bNewAutoTaunt) - the client tells the server it controls the
  // pawn; without it the server treats the pawn as server-only and ignores ServerMove. Params are the
  // declared order from Engine.u; the Pawn ref is the dynamic-actor form the server reads in SerializeObject
  // (_ghidra/netfmt-out.log): a set bit then the pawn's channel index (max 1023).
  sendAcknowledge(pawnCh) {
    const info = this._rpcIndex('ServerAcknowledgePossession');
    if (!info) return;
    const payload = new BitWriter();
    payload.writeIntUE(info.index, info.max);
    // Same per-param presence-bit rule as ServerMove: P is present (the pawn ref = presence bit, then the
    // SerializeObject dynamic-actor bit + channel); NewHand/bNewAutoTaunt fall back to their defaults.
    payload.writeBit(1);                 // P present
    payload.writeBit(1);                 // P: dynamic actor ref
    payload.writeIntUE(pawnCh, 1023);    // pawn channel index
    payload.writeBit(0);                 // NewHand default
    payload.writeBit(0);                 // bNewAutoTaunt default
    for (const ch of this._rpcChannels()) this.conn.sendActorBunch(ch, payload, { reliable: true });
    this._log('>>> AcknowledgePossession(ch' + pawnCh + ') idx=' + info.index);
  }

  // Chat: ServerSay(string) - a reliable RPC on the PlayerController channel with one FString param.
  sendSay(text, team = false) {
    const info = this._rpcIndex(team ? 'ServerTeamSay' : 'ServerSay');
    if (!info) { this._log('say: net cache unavailable (need --system-dir)'); return; }
    const payload = new BitWriter();
    payload.writeIntUE(info.index, info.max);   // value-aware field index
    if (this.cfg.sayGate !== false) payload.writeBit(1);   // param-presence gate before the FString
    payload.writeString(String(text));
    for (const ch of this._rpcChannels()) this.conn.sendActorBunch(ch, payload, { reliable: true });
    this._log('>>> SAY "' + text + '" (idx=' + info.index + ' max=' + info.max + ')');
  }

  // After JOIN, if the package map still has a gap, the local copy of that package is missing or corrupt
  // (an old interrupted File-channel download writes a byte-wrong file, which the redirect path decodes
  // correctly). Re-fetch just those from the redirect - which round-trips byte-exact - overwrite the bad
  // copy, and rebuild the map to the EXACT MaxObjectIndex. One gap otherwise brute-forces the whole table
  // and breaks position corrections. Runs once per connect; best-effort (a redirect that lacks it stays a gap).
  _refetchMissingPackages() {
    if (!this.joined || this.closed || this.leaving || this._refetchActive) return;
    const w = this.world;
    if (!w || !w.pkgMap || w.pkgMap.complete) return;   // not built yet, or already exact - nothing to repair
    if (!this._redirectUrl || !this.cfg.pkgDownload) return;
    if (!this._refetchTried) this._refetchTried = new Set();
    // Only packages we haven't already tried to fetch - a redirect that genuinely lacks one stays a gap
    // instead of looping forever. build() now lists EVERY missing package, so we fetch the whole batch.
    const missing = (w.pkgMap.missing || []).filter((n) => !this._refetchTried.has(n));
    const pkgs = missing.map((name) => { const u = w.usesOrder.find((x) => x.name === name); return u && u.guid ? { guid: u.guid, name, gen: u.gen, fname: u.fname || (name + '.u'), size: u.size || 0 } : null; }).filter(Boolean);
    if (!pkgs.length) return;
    for (const p of pkgs) this._refetchTried.add(p.name);
    this._refetchActive = true;
    const dir = this._downloadDir || (this._downloadDir = this.cfg.downloadDir || path.join(__dirname, '..', 'downloads'));
    this._log('>>> repairing ' + pkgs.length + ' missing/corrupt package(s) from redirect: ' + pkgs.map((p) => p.name).join(', '));
    const { httpRedirectDownload } = require('./pkgdownload');
    httpRedirectDownload(this._redirectUrl, pkgs, dir, { log: (l) => this._log(l) })
      .then((result) => {
        this._refetchActive = false; this._pkgDirs = null;
        const complete = w.rebuildPkgMap();   // a fresh gap (build stops numbering at the first) triggers another pass next tick
        this._log('>>> package repair: fetched ' + ((result.completed || []).length) + '/' + pkgs.length + ' — pkgComplete=' + complete + ' maxObj=' + w.maxObjIndex);
      })
      .catch((e) => { this._refetchActive = false; this._log('!! package repair failed: ' + (e.message || e)); });
  }

  // Load the map's PathNode/ReachSpec navigation graph once the package map knows the content dirs.
  // A far move-to then routes along the map's real walkable network instead of a straight line into walls.
  _ensureNav() {
    if (this._navTried || !this.world) return;
    this.world._ensurePkgMap();
    if (!this.world.pkgMap || !this.world.usesOrder.length) return;   // dirs unknown yet - retry on next moveTo
    this._navTried = true;
    try { this._nav = require('./navgraph').loadNavGraph(this.world.usesOrder, this.world.pkgMap.dirs); }
    catch (e) { this._nav = null; }
    this._log('nav graph: ' + (this._nav ? this._nav.size + ' nodes (ReachSpec-routed move)' : 'unavailable — straight-line move'));
  }

  // Move to a nav-graph node that is genuinely reachable from here (a ReachSpec route exists), ~1500uu away.
  // Mirrors a player clicking open, on-mesh floor: it makes "arrived" mean "the move worked" instead of
  // "the blind screen point happened to miss a wall" - the honest way to measure move-to across many maps.
  moveToNavTarget() {
    this._ensureNav();
    const here = this.world && this.world.selfPos();
    if (!this._nav || !here) { this._log('movenav: no nav graph or position yet'); return; }
    // Prefer the NEAREST reachable node in [500, 2500]uu: a short hop completes in ~3s so it can finish inside
    // the brief alive window a hostile / rapid-auto-respawn server leaves (a long target dies mid-route). It's
    // still nav-ROUTED (moveTo routes >450uu) so the leg follows walkable floor around walls, not a straight
    // line into geometry. Picked only when a ReachSpec route actually exists (genuinely reachable).
    let best = null, bestD = Infinity;
    for (const [, n] of this._nav.nodes) {
      const d = Math.hypot(n.x - here.x, n.y - here.y);
      if (d < 500 || d > 2500 || d >= bestD) continue;
      const path = this._nav.findPath(here, n);
      if (!path || !path.length) continue;               // no ReachSpec route -> unreachable, skip
      bestD = d; best = n;
    }
    if (!best) { this._log('movenav: no reachable nav node in range (map has ' + this._nav.size + ' nodes)'); return; }
    this.moveTo(best.x, best.y);
  }

  // Run toward a world point via ServerMove(TimeStamp, InAccel, ClientLoc, NewFlags, ClientRoll, View).
  // ponytail: best-effort param encoding - the RPC index/channel path is proven, but the movement
  // param layout (compressed view, per-param gate bits) still needs live calibration against a moving
  // pawn; ceiling: bot won't actually run until that's confirmed. Sent unreliably like the real client.
  // Click-to-run: set a destination and stream ServerMove toward it every tick (like the stock client),
  // stopping when we arrive or after a timeout. Streaming is what makes the pawn actually travel and
  // what draws the server's position corrections; a single move barely nudges it.
  moveTo(x, y) {
    if (!this._rpcIndex('ServerMove')) { this._log('move: net cache unavailable (need --system-dir)'); return; }
    // Movement is meaningless unless we're actually alive on the map - a dead / respawning / spectator
    // player has no pawn to drive, so refuse the command with a clear reason instead of streaming into void.
    const st = this.world && this.world.selfState();
    if (st && !st.alive) {
      this._log('move ignored — not alive on the map (' + (st.spawned ? 'HP ' + (st.hp == null ? '?' : st.hp) : 'dead / spectating / between waves') + ')');
      return;
    }
    this._ensureNav();
    const known = this.world && this.world.selfPos();
    // Route through the map's nav graph when we know where we are; the click point itself is the last leg.
    let path = [{ x, y, z: known ? known.z : 0 }];
    let dist = known ? Math.hypot(x - known.x, y - known.y) : 0;
    // Nav-route anything past a very short step: even a ~500uu straight line can clip a wall/corner and pin the
    // pawn against geometry; the ReachSpec path follows walkable floor around it. Sub-450uu goes direct (cheap).
    if (this._nav && known && dist > 450) {
      const wps = this._nav.findPath(known, { x, y, z: known.z });
      if (wps && wps.length) {
        path = wps.concat([{ x, y, z: wps[wps.length - 1].z }]);
        dist = 0;
        let prev = known;
        for (const p of path) { dist += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
      }
    }
    this._movePath = path;
    this._moveTarget = path[0];
    this._movePawn = this.world && this.world.myPawn != null ? this.world.myPawn : null;   // abort if this body dies/respawns
    this._finalTarget = { x, y };
    this._moveProg = null; this._moveProgAt = Date.now(); this._stallCount = 0;   // reset anti-stall tracking
    // Budget the whole route: path length at a conservative walk speed, plus slack for corrections.
    this._moveUntil = Date.now() + Math.max(this.cfg.moveTimeoutMs || 12000, (dist / 150) * 1000 + 8000);
    // Stream ServerMove densely (like the stock client's per-frame cadence) - sparse moves let the pawn
    // decelerate to a stop between them, so a fast dedicated ticker is what makes it actually travel.
    if (!this._moveTimer) this._moveTimer = setInterval(() => this._tickMove(), this.cfg.moveTickMs || 60);
    this._lastMoveTickAt = 0;
    this._tickMove();
    const via = path.length > 1 ? ' via ' + path.length + ' waypoints' : '';
    if (known) this._log('>>> MOVE to (' + Math.round(x) + ',' + Math.round(y) + ') from (' + Math.round(known.x) + ',' + Math.round(known.y) + ')' + via);
    else this._log('>>> MOVE to (' + Math.round(x) + ',' + Math.round(y) + ')' + via + ' — position refines from server corrections');
  }

  // Opt-in (KF_DEBUG_SELF) periodic snapshot of the self-position pipeline - independent of any decode
  // path, so it reports even when the pawn bunch never reaches the decoder. Answers "why no self dot".
  _debugSelfTick() {
    const w = this.world;
    if (!w || !w.debugSelf || !this.joined) return;
    const now = Date.now();
    if (now - (this._dbgSelfAt || 0) < 3000) return;
    this._dbgSelfAt = now;
    const sp = w.selfPos();
    const pcChDbg = w.myPcChannel != null ? w.myPcChannel : this.cfg.pcChannel;
    const pcCls = pcChDbg != null ? (w.classFor(pcChDbg) || '?') : '-';
    const mv = this._rpcIndex('ServerMove');
    this._log('[self] myPawn=' + w.myPawn + ' myPri=' + w.myPri + ' pos=' + (sp ? Math.round(sp.x) + ',' + Math.round(sp.y) : 'null') +
      ' corr=' + (w.corrCount || 0) + ' maxObj=' + w.maxObjIndex + ' cls=' + (w.myPawn != null ? (w.classFor(w.myPawn) || '?') : '-') +
      ' pcCls=' + pcCls + ' rpc=' + (this.cfg.pcChannel != null ? this.cfg.pcChannel : '?') + ' mv=' + (mv ? mv.index + '/' + mv.max : 'null') +
      ' hp=' + w.stats.hp + ' cand=[' + (typeof w.candidatePawns === 'function' ? w.candidatePawns().join(',') : '') + '] probe=' + (this._possCand != null ? this._possCand : '-') +
      ' obj=' + (w.myPawn != null && w.objects[w.myPawn] ? Math.round(w.objects[w.myPawn].x) + ',' + Math.round(w.objects[w.myPawn].y) : 'null'));
    this._log('[world] ' + w.debugSummary());
  }

  _stopMoveTimer() {
    if (this._moveTimer) { clearInterval(this._moveTimer); this._moveTimer = null; }
    this._movePath = null;
  }

  // Track the pawn's real speed from consecutive server corrections; the local simulation walks at that
  // measured pace, so the dot neither crawls behind a fast perk nor overshoots a slow, blocked pawn.
  _updateMeasuredSpeed() {
    const w = this.world;
    const corr = w && w.selfAdjustPos;
    if (!corr) return;
    const now = Date.now();
    const cnt = w.corrCount || 0;
    if (cnt === this._lastCorrCnt) return;   // no correction = the server accepted our ClientLoc: sim is on track
    this._lastCorrCnt = cnt;
    const last = this._lastCorrSeen;
    if (!last || Math.hypot(corr.x - last.x, corr.y - last.y) > 30) {
      // A correction that MOVED us: measure the pawn's real pace from the correction stream so the dot
      // glides at the pawn's true GroundSpeed instead of a guess.
      if (last && now > last.at) {
        const v = Math.hypot(corr.x - last.x, corr.y - last.y) / ((now - last.at) / 1000);
        if (isFinite(v) && v > 20 && v < 1200) this._simSpeed = Math.max(120, Math.min(600, (this._simSpeed || 200) * 0.6 + v * 0.4));
      }
      this._lastCorrSeen = { x: corr.x, y: corr.y, at: now };
      this._blockedSince = 0;
    } else {
      // Same-spot corrections: the pawn is blocked. Only bleed speed off after it's been pinned for a
      // moment (a single same-spot correction is normal mid-stride) so a moving pawn's dot doesn't stall.
      if (!this._blockedSince) this._blockedSince = now;
      this._lastCorrSeen = { x: corr.x, y: corr.y, at: now };
      if (now - this._blockedSince > 500) this._simSpeed = Math.max(30, (this._simSpeed || 200) * 0.7);
    }
  }

  _tickMove() {
    if (!this._moveTarget) { this._stopMoveTimer(); return; }
    if (Date.now() > this._moveUntil) {
      const at = this.world && this.world.selfPos();
      this._log('move: timed out' + (at ? ' at (' + Math.round(at.x) + ',' + Math.round(at.y) + ')' : ''));
      this._moveTarget = null; this._stopMoveTimer(); return;
    }
    const w = this.world;
    if (w && this._movePawn != null && w.myPawn != null && w.myPawn !== this._movePawn) {
      this._log('move: possessed pawn changed (death/respawn) — cancelling stale route');
      this._moveTarget = null; this._movePath = null; this._stopMoveTimer(); return;
    }
    if (w && w.stats && w.stats.hp === 0) return;   // dead pawns don't move
    const info = this._rpcIndex('ServerMove');
    if (!info) return;
    const loc = (w && w.selfPos()) || this._lastLoc || { x: 0, y: 0, z: 0 };
    if (w && w.selfPos()) this._lastLoc = loc;
    this._updateMeasuredSpeed();
    // Waypoint bookkeeping: pop each leg as we reach it; the final leg uses the arrival radius.
    while (this._movePath && this._movePath.length > 1 &&
           Math.hypot(this._movePath[0].x - loc.x, this._movePath[0].y - loc.y) < 180) {
      this._movePath.shift();
      this._moveTarget = this._movePath[0];
    }
    // Anti-stall: when the SERVER-confirmed position stops advancing though we haven't arrived, the pawn is
    // wedged against geometry - and the LEASH then freezes the on-screen estimate too, so the square "stops
    // going". Re-route around the obstacle via the nav graph; on a repeated stall, nudge sideways to unstick.
    const svPos = (w && w.selfPos()) || loc;
    if (!this._moveProg || Math.hypot(svPos.x - this._moveProg.x, svPos.y - this._moveProg.y) > 120) {
      this._moveProg = { x: svPos.x, y: svPos.y }; this._moveProgAt = Date.now(); this._stallCount = 0;
    } else if (Date.now() - (this._moveProgAt || 0) > 2500 && this._finalTarget) {
      this._moveProgAt = Date.now();
      this._stallCount = (this._stallCount || 0) + 1;
      let rerouted = false;
      if (this._nav && this._stallCount <= 2) {
        const wps = this._nav.findPath(svPos, { x: this._finalTarget.x, y: this._finalTarget.y, z: svPos.z });
        if (wps && wps.length) {
          this._movePath = wps.concat([{ x: this._finalTarget.x, y: this._finalTarget.y, z: svPos.z }]);
          this._moveTarget = this._movePath[0]; rerouted = true;
          this._log('move: stalled at (' + Math.round(svPos.x) + ',' + Math.round(svPos.y) + ') — re-routing (' + this._movePath.length + ' wp)');
        }
      }
      if (!rerouted) {
        const t0 = this._moveTarget || this._finalTarget;
        const a = Math.atan2(t0.y - svPos.y, t0.x - svPos.x) + Math.PI / 2;
        this._moveTarget = { x: svPos.x + Math.cos(a) * 250, y: svPos.y + Math.sin(a) * 250, z: svPos.z };
        this._movePath = [this._moveTarget, { x: this._finalTarget.x, y: this._finalTarget.y, z: svPos.z }];
        this._log('move: still stuck — sidestep nudge');
      }
    }
    const tgt = this._moveTarget;
    const dx = tgt.x - loc.x, dy = tgt.y - loc.y, len = Math.hypot(dx, dy);
    if (len < 120 && (!this._movePath || this._movePath.length <= 1)) {   // arrived
      this._log('<<< MOVE arrived at (' + Math.round(loc.x) + ',' + Math.round(loc.y) + ')');
      this._moveTarget = null; this._stopMoveTimer(); return;
    }
    // Progress telemetry ~every 2s: current position, active leg, measured speed, legs left.
    const tnow = Date.now();
    if (tnow - (this._moveLogAt || 0) > 2000) {
      this._moveLogAt = tnow;
      this._log('move: at (' + Math.round(loc.x) + ',' + Math.round(loc.y) + ') -> (' + Math.round(tgt.x) + ',' + Math.round(tgt.y) +
        ') ~' + Math.round(this._simSpeed || 190) + 'uu/s, ' + (this._movePath ? this._movePath.length : 1) + ' wp left, corr=' + ((w && w.corrCount) || 0));
    }
    // InAccel toward the target. The server renormalizes it to the pawn's AccelRate, so magnitude only needs
    // to reach that rate; a live client capture on a modded server sent ~30k, so match that to run full-tilt
    // on high-speed servers while stock servers just clamp it down.
    const ACCEL = 30000;
    // Client-side simulation, like the real client: advance our own position estimate along the route at the
    // measured walk speed and report THAT as ClientLoc. The server corrects any drift (and each correction
    // snaps the estimate), while the leash below stops the estimate from running ahead of a blocked pawn.
    const now = Date.now();
    const dt = this._lastMoveTickAt ? Math.min(0.2, (now - this._lastMoveTickAt) / 1000) : 0;
    this._lastMoveTickAt = now;
    if (w && !w.selfEstimate && (loc.x || loc.y)) w.selfEstimate = { ...loc };   // seed from spawn before the first correction
    if (w && w.selfEstimate && len > 1 && dt > 0) {
      const step = Math.min(len, (this._simSpeed || 190) * dt);
      const nx = loc.x + (dx / len) * step, ny = loc.y + (dy / len) * step;
      const corr = w.selfAdjustPos;
      const LEASH = 400;   // max lead over the last server-confirmed position
      if (!corr || Math.hypot(nx - corr.x, ny - corr.y) <= LEASH) {
        w.selfEstimate = { x: nx, y: ny, z: loc.z };
        if (w.myPawn != null) w.objects[w.myPawn] = { ...(w.objects[w.myPawn] || {}), type: 'self', x: nx, y: ny, z: loc.z, t: w.now() };
      }
    }
    const sim = (w && w.selfEstimate) || loc;
    // Confirm possession mid-move: if the server has never corrected us (corr=0) we can't tell whether it's
    // actually applying our moves or the sim is walking a phantom. Report a deliberately-offset ClientLoc to
    // force a ClientAdjustPosition - the server corrects the CLIENT (never mis-moves the pawn), so this both
    // proves the pawn is ours and hands us the real position. Once corrections flow, report the true sim.
    const clientLoc = (w && (w.corrCount || 0) === 0) ? { x: sim.x + 700, y: sim.y, z: sim.z } : sim;
    this._sendServerMove(info, clientLoc, (dx / len) * ACCEL, (dy / len) * ACCEL);
  }

  // Build + send one ServerMove RPC, in the exact native wire layout reversed from a live client capture
  // (round-trips byte-for-byte). Every param is preceded by a presence bit: bit 1 + value when the value is
  // meaningful, bit 0 alone when it is the default (the real client omits the zero flags/view entirely).
  // Field order + the packed-vector form (writePackedVector) are confirmed against the capture. Sent
  // unreliably like the stock client's per-frame move.
  _sendServerMove(info, loc, ax, ay) {
    // TimeStamp tracks the client's Level.TimeSeconds, which starts at ~0 on connect; base + real elapsed
    // keeps it monotonic and every per-move DeltaTime realistic so the server never rejects a move as stale.
    this._moveTs = (this.cfg.moveTsBase != null ? this.cfg.moveTsBase : 0) + (Date.now() - (this._t0 || Date.now())) / 1000;
    const { writePackedVector } = require('./repdecode');
    const payload = new BitWriter();
    const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); payload.writeBits(b.readUInt32LE(0), 32); };
    payload.writeIntUE(info.index, info.max);       // value-aware field index
    // Params: TimeStamp InAccel ClientLoc NewActions DoubleClickMove ClientRoll View FreeAimRot OldTimeDelta OldAccel
    payload.writeBit(1); f32(this._moveTs);                                 // TimeStamp
    payload.writeBit(1); writePackedVector(payload, ax, ay, 0);             // InAccel (server renormalizes to AccelRate)
    payload.writeBit(1); writePackedVector(payload, loc.x, loc.y, loc.z);   // ClientLoc
    payload.writeBit(0);   // NewActions   = 0 (movement flags)
    payload.writeBit(0);   // DoubleClickMove = DCLICK_None
    payload.writeBit(0);   // ClientRoll   = 0
    payload.writeBit(0);   // View         = 0 (aim; irrelevant to accel-driven movement)
    payload.writeBit(0);   // FreeAimRot   omitted
    payload.writeBit(0);   // OldTimeDelta omitted
    payload.writeBit(0);   // OldAccel     omitted
    for (const ch of this._rpcChannels()) this.conn.sendActorBunch(ch, payload, { reliable: false });
  }

  // Once our own pawn's channel is identified (its PRI == ours), tell the server we control it so it accepts
  // our ServerMoves and streams back position corrections. The FIRST ack often lands before the server-side
  // possession is ready (especially on modded servers that replicate the pawn late), so re-send it every
  // ~1.5s until the server starts correcting us (which pins the PC channel) - that's what unblocks position
  // + move-to on modded servers. A respawn gives a new pawn channel, which resets the retry.
  _ackPossessionIfNeeded() {
    const w = this.world; if (!w) return;
    // Acknowledge the pawn the server replicated as Controller.Pawn / named in ClientReStart (authoritative),
    // else our best-guess pawn. The server only runs the pawn's movement physics while AcknowledgedPawn==Pawn,
    // so we re-send the ack periodically (position corrections keep arriving whether or not it's set, so they
    // can't confirm it) until our pawn has clearly travelled - real movement proves possession took.
    const mp = w.serverAckPawn != null ? w.serverAckPawn : w.myPawn;
    if (mp == null) { this._ackedPawn = null; this._ackTries = 0; return; }
    const now = Date.now();
    if (mp !== this._ackedPawn) { this._ackedPawn = mp; this._ackTries = 0; this._lastAckAt = 0; this._ackAnchor = null; }
    const p = w.selfPos && w.selfPos();
    if (p && !this._ackAnchor) this._ackAnchor = { x: p.x, y: p.y };
    const moved = p && this._ackAnchor && Math.hypot(p.x - this._ackAnchor.x, p.y - this._ackAnchor.y) > 300;
    // While the PC-channel probe rotates, every candidate needs its own ack - don't stop at the cap.
    if (moved || ((this._ackTries || 0) >= 30 && this._pcProbeCh == null) || now - (this._lastAckAt || 0) < 1200) return;
    this._lastAckAt = now; this._ackTries = (this._ackTries || 0) + 1;
    this.sendAcknowledge(mp);
  }

  // Brute-force possession: some custom gametypes (Story-mode PlayerControllers) never send Pawn /
  // ClientReStart in a form we can decode off the PC channel (that channel is mostly RPCs decodeBunch
  // can't parse), so we spawn a body but never learn WHICH pawn is ours. The server only applies our
  // ServerMove - and only then streams ClientAdjustPosition corrections - while AcknowledgedPawn == our
  // pawn. So when we're alive server-side (PRI PlayerHealth > 0) yet myPawn is null, ack each candidate
  // pawn in turn (~1.2 s each) and keep the one the server starts correcting: that ack is what took.
  _probePossession() {
    const w = this.world;
    if (!w || !this.joined || this.closed || this.leaving) return;
    if (w.myPawn != null) { this._possCand = null; return; }             // possessed the normal way - done
    if (!this._everReadied) return;                                      // only after we asked to spawn
    if (this.cfg.pcChannel == null && w.myPcChannel == null) return;     // need a PC channel to ack on
    const now = Date.now();
    const corr = w.corrCount || 0;
    // The candidate we're currently acking started getting corrections -> it's ours.
    if (this._possCand != null && corr > (this._possBaseCorr || 0)) {
      w.myPawn = this._possCand; w.serverAckPawn = this._possCand; this._acked = true;
      this._log('>>> possession found by probe: ch' + this._possCand + ' (server began correcting)');
      this._possCand = null;
      return;
    }
    if (now - (this._possAt || 0) < 1200) return;   // hold this candidate's window; moves stream via _syncPosition
    this._possAt = now;
    const cands = w.candidatePawns();
    if (!cands.length) { this._possCand = null; return; }
    if (!this._possList || !this._possList.length || now - (this._possBuiltAt || 0) > 12000) { this._possList = cands; this._possBuiltAt = now; this._possIdx = 0; }
    this._possCand = this._possList[this._possIdx % this._possList.length];
    this._possIdx++;
    this._possBaseCorr = corr;
    this.sendAcknowledge(this._possCand);
  }

  // Continuous idle ServerMove (zero accel) streamed once in-level, the way a real client sends a move
  // every frame. This keeps the connection alive - a client that stops sending moves looks frozen/AFK and
  // the server (or an AFK-kicker mutator) drops it after ~30s - and pulls back our authoritative position
  // via VeryShortClientAdjustPosition. Skipped while a click-move is streaming (that sends its own moves).
  _syncPosition() {
    if (!this.joined || this.closed || this.leaving || this._moveTarget) return;
    const info = this._rpcIndex('ServerMove');
    if (!info) return;
    const w = this.world;
    // Stream an idle ServerMove every tick the way a real client does - this keeps us from looking AFK
    // AND is what makes the server answer with a ClientAdjustPosition, our only reliable self position on
    // servers whose custom pawn class we can't decode. Once we have a pawn we always stream: a known
    // position (spawn point / prior correction) is the ideal ClientLoc, but even ClientLoc (0,0) is worth
    // sending to elicit that first correction - silence guarantees we never learn where we are.
    if (!w) return;
    const ACCEL = 30000;
    let loc, ax = 0, ay = 0;
    if (w.myPawn != null) {
      loc = w.selfPos() || { x: 0, y: 0, z: 0 };
      // Bootstrap the first correction: once we own a pawn but the server has never corrected us (corr=0),
      // a static offset ClientLoc alone stays silent - the server only sends ClientAdjustPosition when it
      // actually MOVES the pawn (via our Accel) and the result diverges from our ClientLoc. So drive a small
      // oscillating acceleration: the pawn jitters in place (direction flips each tick, no net travel) while
      // the server keeps correcting, which self-confirms possession WITHOUT waiting for a user move - critical
      // on populated servers where zeds may kill us within a couple seconds of spawning.
      if ((w.corrCount || 0) === 0) {
        const s = (this._bootFlip = !this._bootFlip) ? 1 : -1;
        ax = ACCEL * s; ay = ACCEL * s;
        loc = { x: loc.x + 700 * s, y: loc.y + 700 * s, z: loc.z };
      }
    } else if (this._possCand != null) {
      // Possession probe: drive the candidate pawn with an oscillating accel + offset ClientLoc so the server,
      // IF it accepted our ack for this pawn, answers with a correction (which the probe detects as ours).
      const o = w.objects[this._possCand];
      const base = o ? { x: o.x, y: o.y, z: o.z || 0 } : { x: 0, y: 0, z: 0 };
      const s = (this._bootFlip = !this._bootFlip) ? 1 : -1;
      ax = ACCEL * s; ay = ACCEL * s;
      loc = { x: base.x + 700 * s, y: base.y + 700 * s, z: base.z };
    } else return;
    this._sendServerMove(info, loc, ax, ay);
  }

  // Fill restartIndex/netMax (and selectVetIndex) from the net cache built off the
  // server's .u files, unless the caller pinned them. See docs/PROTOCOL.md §7/§8.
  _calibrateRpc(funcName, indexKey) {
    if (this.cfg[indexKey] != null) return { index: this.cfg[indexKey], max: this.cfg.netMax };   // user pinned it
    // Fresh each call (never cached into cfg): the PC class can resolve to a custom one mid-session,
    // and its larger GetMaxIndex must win over the stock table used before it resolved.
    const info = this._rpcIndex(funcName);
    if (info) return info;
    return { index: this.cfg[indexKey], max: this.cfg.netMax };
  }

  attemptReady() {
    if (!this.joined || this.closed) { this._log('   Ready ignored (not in-level)'); return; }
    this.setState('readying');
    this._sendRestartPlayer();
    this._readyRequested = true; this._readyTries = 1; this._lastReadyAt = Date.now();
    this.emit('ready');
  }

  _sendRestartPlayer() {
    const { index: idx, max } = this._calibrateRpc('ServerReStartPlayer', 'restartIndex');
    // Belt-and-suspenders: send Ready to the pinned PC channel AND the usual 1/2, deduplicated. Before the
    // PC channel resolves (custom gametypes pin it late) a Ready to only 1/2 can miss, and an empty server's
    // "start the wave on first Ready" moment then passes with us un-ready'd - a permanent spectator. Ready is
    // low-rate (every few seconds) so the extra one channel can't congest the reliable window.
    const chans = [...new Set([this.cfg.pcChannel, this.world && this.world.myPcChannel, 1, 2].filter((c) => c != null))];
    this._everReadied = true;   // enables the possession probe (we've asked the server to spawn us)
    this._log('>>> READY: sending ServerRestartPlayer (idx=' + idx + ' max=' + max + ') on ch ' + chans.join(','));
    for (const ch of chans) this.sendRpc(ch, idx, max);
  }

  // The first ServerReStartPlayer can land before the modded GameInfo is ready to spawn us (it may only spawn
  // at a wave boundary / trader time, or the RPC hit the wrong channel before the PC channel was pinned), so
  // re-send it until our own pawn is identified. Stops as soon as we have a body, on a bounded number of tries.
  _readyRetryIfNeeded() {
    if (this.closed || this.leaving || !this.joined || !this._everReadied) return;
    if (this.world && this.world.myPawn != null) { this._readySpawnedOnce = true; return; }   // have a body
    const now = Date.now();
    // Keep re-sending ServerReStartPlayer whenever we have NO pawn - not just once. This covers BOTH a
    // deferred first spawn (spawn only at a wave boundary / trader, minutes away) AND re-spawning after
    // death on timer / auto-respawn gametypes: a single Ready then silence left us a permanent spectator
    // after the first death. Fast while we've never spawned, slower once we have (respawn timers are longer).
    const interval = this._readySpawnedOnce ? 4000 : 3000;
    if (now - (this._lastReadyAt || 0) < interval) return;
    this._lastReadyAt = now;
    this._sendRestartPlayer();
  }

  // --- handshake kickoff with simple resend until we get a reply ---
  sendHello() {
    if (this.state !== 'init' && this.state !== 'hello') return;
    this.setState('hello');
    // KF build 1065 HELLO carries the client SteamID: "HELLO REVISION=0 MINVER=%i VER=%i STEAMID=%I64u".
    // Sent once; the reliable-bunch retransmit resends it until the server's STEAMENCRYPTIONKEY arrives.
    this.conn.sendControl('HELLO REVISION=0 MINVER=' + this.cfg.minver + ' VER=' + this.cfg.ver + ' STEAMID=' + this.cfg.steamid);
  }
}

module.exports = { BotSession, challengeResponse, ENGINE_VERSION, ENGINE_MIN_NET_VERSION, CHTYPE };
