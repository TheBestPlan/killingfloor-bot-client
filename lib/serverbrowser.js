// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Server Browser data sources for the KF bot client.
 *   - Steam master list via the Web API IGameServersService/GetServerList (appid 1250). The retired
 *     hl2master UDP endpoint no longer resolves and the in-game browser goes through the Steam client,
 *     so a free Steam Web API key is the stand-in for that master list. This is the authoritative source
 *     (every KF server registers with Steam); it is rate-limited (~1 request/minute), so callers cache.
 *   - GameTracker (scraped, browser UA) overlays servers Steam missed. KF1 coverage there is thin, so it
 *     usually adds nothing - kept because the spec asks for it and it is free where Steam needs a key.
 *   - Per-server Valve A2S query (on the Steam query port) fills the live list columns Steam doesn't give:
 *     ping (round-trip) and the player list (A2S_PLAYER). Steam's `addr` is the query port; its
 *     `gameport` is the port players actually connect to.
 *   - Per-server UT2004-native query on gameport+1 for the Wave column - the same wire the real client's
 *     ServerQueryClient uses to fill ServerResponseLine (CurrentWave/FinalWave sit right after MaxPlayers).
 * The renderer has no Node, so main.js calls this over IPC.
 */
const https = require('https');
const dgram = require('dgram');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const KF_APPID = 1250;

// KF/UT server names embed Unreal colour codes (ESC 0x1b + 3 RGB bytes) and other control bytes that only
// the original game client renders - everywhere else they show as squares/@ garbage. Strip them so the
// browser reads cleanly. Also drops lone control chars / backticks and collapses the whitespace they leave.
function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b[\s\S]{0,3}/g, '')      // KF colour escape: ESC + up to 3 RGB bytes
    .replace(/[\x00-\x1f\x7f`]+/g, ' ')   // remaining control chars / backticks
    .replace(/\s{2,}/g, ' ').trim();
}

// Current wave for the browser column, from the engine's native UT2004-style query on gameport+1 - the same
// wire the real client's ServerQueryClient uses to fill GameInfo.ServerResponseLine, where KF's engine build
// inserts CurrentWave/FinalWave (int32s) right after MaxPlayers. (The A2S keywords "d;1;2" tokens are NOT
// wave data - parsing them was wrong.) Request: 79 00 00 00 00 (info); reply: 80 00 00 00 00 + the struct.
// Strings are FCompactIndex-length-prefixed (length includes the trailing NUL; 0 = empty; names ≥ 64
// chars spill into a second length byte - bit 0x40 = continuation) and may embed KF colour codes.
function parseUt2Info(b) {
  if (!b || b.length < 30 || b[0] !== 0x80 || b[4] !== 0x00) return null;
  let i = 5;
  const u32 = () => { const v = b.readUInt32LE(i); i += 4; return v; };
  const cidx = () => {
    const b0 = b[i++];
    let v = b0 & 0x3f;
    if (b0 & 0x40) { let sh = 6, bn; do { bn = b[i++]; v |= (bn & 0x7f) << sh; sh += 7; } while (bn & 0x80); }
    return (b0 & 0x80) ? -v : v;
  };
  const pstr = () => { const n = cidx(); if (n <= 0) return ''; const s = b.slice(i, i + n - 1).toString('latin1'); i += n; return s; };
  try {
    u32();                                     // ServerID
    pstr();                                    // IP (blank when the server itself answers)
    const gamePort = u32();
    u32();                                     // QueryPort
    const name = pstr(), map = pstr(), gameType = pstr();
    const numPlayers = u32(), maxPlayers = u32();
    const currentWave = u32(), finalWave = u32();
    u32();                                     // Ping (always 0 from the server; we measure RTT ourselves)
    const flags = u32();                       // bit 1 = passworded (UT2k4Browser_ServersList.BuildFlagString)
    if (currentWave > 999 || finalWave > 999) return null;
    return {
      gamePort: gamePort || null, name: cleanName(name), map: cleanName(map), gameType,
      numPlayers, maxPlayers, password: !!(flags & 1),
      wave: (currentWave || finalWave) ? currentWave + '/' + finalWave : null,
    };
  } catch (e) { return null; }
}

function ut2Query(ip, gamePort, timeout = 2200) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(v); };
    setTimeout(() => fin(null), timeout);
    sock.on('message', (b) => { const r = parseUt2Info(b); fin(r ? { ...r, ping: Date.now() - t0 } : null); });
    sock.on('error', () => fin(null));
    const req = () => sock.send(Buffer.from([0x79, 0, 0, 0, 0]), gamePort + 1, ip, (e) => { if (e) fin(null); });
    req();
    setTimeout(() => { if (!done) req(); }, Math.floor(timeout / 2));   // one UDP retry, single-packet loss is common
  });
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': BROWSER_UA, ...headers } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}

// Steam master truth via the Web API (needs a free key). `addr` is the query port, `gameport` the connect
// port; we key/query on addr and connect on gameport.
async function steamList(key) {
  if (!key) return [];
  const filter = encodeURIComponent('\\appid\\' + KF_APPID);
  const { status, body } = await httpsGet('https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=' + encodeURIComponent(key) + '&filter=' + filter + '&limit=5000');
  if (status !== 200) throw new Error('steam web api HTTP ' + status + (status === 403 ? ' (bad key)' : ''));
  const parsed = JSON.parse(body);
  const servers = (parsed.response && parsed.response.servers) || [];
  return servers.map((s) => {
    const ip = String(s.addr).split(':')[0];
    const queryPort = +String(s.addr).split(':')[1];
    const gamePort = s.gameport != null ? +s.gameport : queryPort;
    return {
      ip, queryPort, gamePort, connect: ip + ':' + gamePort, addr: ip + ':' + gamePort,
      name: cleanName(s.name), players: s.players != null ? s.players : null,
      maxPlayers: s.max_players != null ? s.max_players : null, map: s.map || '',
      players_list: null, wave: null, ping: null, source: 'steam',   // wave comes from ut2Query per server
    };
  });
}

// GameTracker overlay: scrape the Killing Floor search results. The game code is "killingfloor" (NOT
// "kf" - that text search returns other games); keep only genuine killingfloor-icon rows.
async function gametrackerList() {
  const { status, body } = await httpsGet('https://www.gametracker.com/search/killingfloor/?searchipp=50');
  if (status !== 200) throw new Error('gametracker HTTP ' + status);
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(body))) {
    const row = m[1];
    const info = /server_info\/([0-9.]+):([0-9]+)\//.exec(row);
    if (!info) continue;
    const icon = /game_icons\d*\/([a-z0-9]+)\.png/i.exec(row);
    if (!icon || icon[1].toLowerCase() !== 'killingfloor') continue;   // strict: real Killing Floor rows only
    const name = /server_info\/[0-9.:]+\/">([\s\S]*?)<\/a>/.exec(row);
    const players = /<td>\s*(\d+)\/(\d+)\s*<\/td>/.exec(row);
    const cells = row.match(/<td>([\s\S]*?)<\/td>/g) || [];
    const clean = (s) => cleanName(s.replace(/<[^>]+>/g, ''));   // strip HTML tags then KF colour/control codes
    const map = cells.length ? clean(cells[cells.length - 1]) : '';
    const ip = info[1], gamePort = +info[2];
    out.push({
      ip, queryPort: gamePort, gamePort, connect: ip + ':' + gamePort, addr: ip + ':' + gamePort,
      name: name ? clean(name[1]) : '',
      players: players ? +players[1] : null, maxPlayers: players ? +players[2] : null,
      map, players_list: null, wave: null, ping: null, source: 'gametracker',
    });
  }
  return out;
}

// Steam is truth; GameTracker adds any connect-addr Steam didn't list.
function mergeServers(steam, gametracker) {
  const byAddr = new Map();
  for (const s of steam) byAddr.set(s.connect, s);
  for (const g of gametracker) if (!byAddr.has(g.connect)) byAddr.set(g.connect, g);
  return [...byAddr.values()];
}

async function fetchServers({ steamKey } = {}) {
  const [st, gt] = await Promise.allSettled([steamList(steamKey), gametrackerList()]);
  const steam = st.status === 'fulfilled' ? st.value : [];
  const tracker = gt.status === 'fulfilled' ? gt.value : [];
  const errors = [];
  if (st.status === 'rejected') errors.push('Steam: ' + (st.reason && st.reason.message || st.reason));
  if (gt.status === 'rejected') errors.push('GameTracker: ' + (gt.reason && gt.reason.message || gt.reason));
  if (!steamKey) errors.push('Steam: no Web API key configured (settings.ini [steam] webApiKey=) — GameTracker only');
  return { servers: mergeServers(steam, tracker), errors, counts: { steam: steam.length, gametracker: tracker.length } };
}

// ---- Valve A2S (Source query) with the challenge handshake ----
function a2s(ip, port, header, payloadAfter, timeout = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let done = false, challenged = false;
    const fin = (v) => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => fin(null), timeout);
    const send = (challenge) => {
      const parts = [Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, header])];
      if (payloadAfter) parts.push(payloadAfter);
      if (challenge) parts.push(challenge);
      else if (header !== 0x54) parts.push(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]));
      sock.send(Buffer.concat(parts), port, ip, (e) => { if (e) fin(null); });
    };
    sock.on('message', (b) => {
      const type = b[4];
      if ((type === 0x41 || type === 0x45) && !challenged && header !== 0x54) { challenged = true; send(b.slice(5, 9)); return; }
      if (type === 0x41 && !challenged && header === 0x54) { challenged = true; send(b.slice(5, 9)); return; }
      clearTimeout(timer);
      fin({ ping: Date.now() - t0, type, buf: b });
    });
    sock.on('error', () => fin(null));
    send(null);
  });
}

function readCStr(b, i) { let s = i; while (i < b.length && b[i] !== 0) i++; return [b.slice(s, i).toString('utf8'), i + 1]; }

// KF's own GameSpy v1 query lives on gameport+10 (UdpGamespyQuery binds GetServerPort()+10). Many KF servers
// answer it even when their Steam A2S query port is unreachable, so it's the ping/players fallback for rows
// A2S can't reach. Request \basic\info\ and parse the \key\value\ reply (no wave - GameSpy rules lack it).
function gamespyQuery(ip, port, timeout = 2200) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now();
    let done = false, acc = '';
    const fin = (v) => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => fin(acc ? { ping: Date.now() - t0, raw: acc } : null), timeout);
    sock.on('message', (b) => {
      acc += b.toString('latin1');
      if (acc.includes('\\final\\')) { clearTimeout(timer); fin({ ping: Date.now() - t0, raw: acc }); }
    });
    sock.on('error', () => fin(null));
    sock.send(Buffer.from('\\basic\\info\\', 'latin1'), port, ip, (e) => { if (e) fin(null); });
  });
}
function gamespyPairs(raw) {
  const toks = raw.split('\\'); if (toks[0] === '') toks.shift();
  const o = {}; for (let i = 0; i + 1 < toks.length; i += 2) o[toks[i]] = toks[i + 1];
  return o;
}

// One server's live details for the list: ping + players count/list (A2S_INFO/A2S_PLAYER) and the wave
// (ut2Query on gameport+1, queried concurrently). A2S_INFO's Extra-Data-Flags carry the actual connect
// port (0x80) - authoritative when Steam's gameport is missing, since the Steam `addr` port is the query
// port, not the one players open.
async function queryServer(ip, queryPort, gamePortHint) {
  const [info, u2first] = await Promise.all([
    a2s(ip, queryPort, 0x54, Buffer.from('Source Engine Query\0', 'latin1')),
    gamePortHint ? ut2Query(ip, gamePortHint) : Promise.resolve(null),
  ]);
  let u2 = u2first;
  if (!info || info.type !== 0x49) {
    // A2S unreachable on the Steam query port - the UT2004 query alone still covers every column but the
    // player names; failing that, KF's GameSpy query on gameport+10 gives ping + players count (no wave).
    if (u2) {
      return {
        ping: u2.ping, name: u2.name, map: u2.map, numPlayers: u2.numPlayers, maxPlayers: u2.maxPlayers,
        gamePort: u2.gamePort || gamePortHint, password: u2.password, players_list: null, wave: u2.wave,
      };
    }
    if (gamePortHint) {
      const gs = await gamespyQuery(ip, gamePortHint + 10);
      if (gs) {
        const p = gamespyPairs(gs.raw);
        const np = parseInt(p.numplayers, 10), mp = parseInt(p.maxplayers, 10);
        return {
          ping: gs.ping, name: cleanName(p.hostname || ''), map: p.mapname || p.maptitle || '',
          numPlayers: isNaN(np) ? null : np, maxPlayers: isNaN(mp) ? null : mp, gamePort: gamePortHint,
          password: p.password === '1', players_list: null, wave: null,
        };
      }
    }
    return null;
  }
  const b = info.buf;
  let i = 6;
  let name, map, folder, game, version;
  [name, i] = readCStr(b, i); [map, i] = readCStr(b, i); [folder, i] = readCStr(b, i); [game, i] = readCStr(b, i);
  i += 2;                                   // steam appid (short)
  const numPlayers = b[i++], maxPlayers = b[i++];
  i += 3;                                   // bots, server type, environment
  const visibility = b[i++];                // 0 = public, 1 = private (password-protected)
  i += 1;                                    // VAC
  [version, i] = readCStr(b, i);
  // Extra-Data-Flags: the connect port (0x80), authoritative for the address players open.
  let gamePort = null;
  if (i < b.length) {
    const edf = b[i++];
    if ((edf & 0x80) && i + 2 <= b.length) { gamePort = b.readUInt16LE(i); i += 2; }
  }
  // A2S revealed a connect port the Steam hint didn't know - retry the wave query on the real port.
  if (!u2 && gamePort && gamePort !== gamePortHint) u2 = await ut2Query(ip, gamePort);
  const out = { ping: info.ping, name: cleanName(name), map, numPlayers, maxPlayers, gamePort, password: visibility === 1, players_list: null, wave: u2 ? u2.wave : null };

  const pl = await a2s(ip, queryPort, 0x55, null);
  if (pl && pl.type === 0x44) {
    const pb = pl.buf; let j = 5; const n = pb[j++]; const names = [];
    for (let k = 0; k < n && j < pb.length; k++) { j++; let nm; [nm, j] = readCStr(pb, j); j += 8; nm = cleanName(nm); if (nm) names.push(nm); }
    out.players_list = names;
  }
  return out;
}

module.exports = { fetchServers, steamList, gametrackerList, queryServer, mergeServers, parseUt2Info, ut2Query, cleanName };
