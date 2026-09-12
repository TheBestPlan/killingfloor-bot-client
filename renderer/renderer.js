// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Renderer (page) logic. No Node access - talks only to window.kfbot (preload).
 * L2Walker-style shell: menu bar, HOST/CHAR toolbar with Login/Logout/Restart,
 * HP/AP/EXP/Load stat bars, a Virtual Map canvas, docked panels, log filter tabs
 * + command input, and a classic status bar. Server/name inputs remember every
 * successful login (localStorage) and offer them as dropdowns.
 *
 * HP/AP/EXP/Load, target bars and map positions fill from 'stats'/'target'/
 * 'mapObjects' events; the bot only emits those once inbound actor/property
 * replication is decoded (not yet), so they show "—" until then.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // i18n.js owns the dictionaries and the live re-render; setT() writes a translated string AND
  // remembers its key on the element, so switching language redraws it without a reconnect.
  const I18N = window.KFI18N;
  const t = (k, v) => I18N.t(k, v);
  const setT = (el, k, v) => I18N.setText(el, k, v);
  // Frameless-window title-bar controls. Guarded so a browser preview without the
  // preload bridge still loads.
  if (window.kfbot && window.kfbot.win) {
    $('tb-min').addEventListener('click', () => window.kfbot.win.minimize());
    $('tb-max').addEventListener('click', () => window.kfbot.win.maximize());
    $('tb-close').addEventListener('click', () => window.kfbot.win.close());
    window.kfbot.win.onMaximized((max) => { $('tb-max').textContent = String.fromCharCode(max ? 0xE923 : 0xE922); });   // restore / maximize glyph
  }
  const STAGES = ['init', 'hello', 'steamauth', 'login', 'welcomed', 'joining', 'in-level'];
  const MAX_LOG_LINES = 12000;   // trim ceiling for high-volume Sys/Events; chat + errors are never trimmed

  let running = false;
  let curServer = '', curName = '', curMap = '';
  let uptimeBase = 0, uptimeTimer = null;
  let activeFilter = 'all';   // active log-tab filter; 'chat' makes the input send Say
  let selfAlive = false, selfPositioned = false;   // gate the self map dot + Move clicks (from 'stats')
  let slowShown = false;                            // slow-download dialog shown once per connect

  // ---- HOST/CHAR history (dropdowns), persisted by main to an ini next to the app (L2Walker-style) ----
  function fillDatalist(id, arr) { $(id).innerHTML = (arr || []).map((v) => { const o = document.createElement('option'); o.value = v; return o.outerHTML; }).join(''); }
  function applyHist(h) { h = h || {}; fillDatalist('dl-servers', h.servers); fillDatalist('dl-names', h.names); if (h.steamKey != null && !$('f-steamKey').value) $('f-steamKey').value = h.steamKey; }
  function refreshHistLists() { window.kfbot.getHistory().then((h) => { applyHist(h); I18N.apply((h && h.lang) || 'en'); }); }

  // ---- config ----
  const intOrNull = (v) => { v = String(v).trim(); return v === '' ? null : parseInt(v, 10); };
  function buildConfig() {
    return {
      server: $('f-server').value.trim(),
      name: $('f-name').value.trim() || 'Bot',
      ver: parseInt($('f-ver').value, 10),
      minver: parseInt($('f-minver').value, 10),
      netspeed: parseInt($('f-netspeed').value, 10),
      sendNetspeed: true,
      ready: $('f-ready').checked,
      readyDelay: parseInt($('f-readyDelay').value, 10),
      leaveDelay: parseInt($('f-leaveDelay').value, 10),
      realSteam: $('f-realSteam').checked,
      pcChannel: intOrNull($('f-pcChannel').value),
      restartIndex: intOrNull($('f-restartIndex').value),
      netMax: parseInt($('f-netMax').value, 10) || 1024,
      connectTimeout: parseInt($('f-connectTimeout').value, 10) || 30000,
      steamidOverride: $('f-steamid').value.trim() || null,   // blank = use the logged-in Steam account
      pkgDownload: $('f-pkgDownload').checked,
    };
  }

  // ---- lifecycle ----
  function setRunning(on) {
    running = on;
    $('btn-login').disabled = on;                       // Connect
    $('btn-logout').disabled = $('btn-ready').disabled = !on;   // Disconnect / Ready; Restart is always enabled
  }
  // Window title (Electron mirrors document.title to the OS titlebar): download progress while loading,
  // then "Connected (name)" as a spectator / "Playing (name)" once spawned, else the bare app name.
  const APP_TITLE = 'Killing Floor Bot Client';
  function setTitle(prefix) { document.title = prefix ? prefix + ' - ' + APP_TITLE : APP_TITLE; }
  function updateConnTitle() { if (running && mapReady) setTitle(t(selfAlive ? 'title.playing' : 'title.connected') + ' (' + (curName || 'Bot') + ')'); }
  function startUptime() {
    uptimeBase = performance.now(); if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = setInterval(() => { const s = Math.floor((performance.now() - uptimeBase) / 1000);
      setT('sb-uptime', 'sb.uptime', { t: String((s / 60) | 0).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') }); }, 1000);
  }
  function stopUptime() { if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; } }

  // A fresh random valid individual SteamID64 (base 76561197960265728 + a 32-bit account id).
  function genSteamId() { return (76561197960265728n + BigInt(Math.floor(Math.random() * 4294967295) + 1)).toString(); }

  function doStart() {
    cancelReconnect();
    if ($('f-randomId').checked) $('f-steamid').value = genSteamId();   // regenerate a random id for each connect
    const cfg = buildConfig();
    if (!cfg.server || cfg.server.indexOf(':') < 0) { appendLog('!! ' + t('log.enterServer')); return; }
    curServer = cfg.server; curName = cfg.name; curMap = '';
    $('st-map').textContent = '—';
    window.kfbot.addHistory(cfg.server, cfg.name).then(applyHist);   // remember every Login'd HOST/CHAR in the ini
    clearObjects(); resetStats(); resetMap();
    setRunning(true);
    setT('sb-state', 'sb.connecting');
    $('sb-mode').textContent = cfg.realSteam ? 'REAL-STEAM' : 'SYNTH';
    setT('st-mode', cfg.realSteam ? 'mode.real' : 'mode.synth');
    applyState('init'); startUptime(); setTitle('');
    window.kfbot.start(cfg);
  }
  const doStop = () => { cancelReconnect(); window.kfbot.stop(); };
  function doRestart() { if (!running) return doStart(); window.kfbot.stop(); setTimeout(doStart, 700); }

  // Server travel: a KF server ends a round / rotates the map by CLOSING every client's connection; the
  // real client silently reconnects to the new map. Mirror that - an in-level kick schedules an automatic
  // reconnect (bounded, cancelled by Disconnect) instead of dying with a dialog.
  let reconnTimer = null, reconnTries = 0;
  function cancelReconnect() { if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; } }
  function scheduleReconnect() {
    if (reconnTries >= 5 || !$('f-server').value.trim()) return false;
    reconnTries++;
    appendLog('>>> ' + t('log.reconnect', { n: reconnTries }));
    setT('sb-state', 'sb.mapChange');
    cancelReconnect();
    reconnTimer = setTimeout(() => { reconnTimer = null; doStart(); }, 3000);
    return true;
  }

  // ---- state / stat bars ----
  function applyState(state) {
    $('st-state').textContent = state;
  }
  const pctOf = (v, m) => (m > 0 ? Math.round((v / m) * 100) : 0);
  function setStat(fill, val, pct, text, on) {
    $(fill).style.width = Math.max(0, Math.min(100, pct)) + '%';
    const e = $(val); e.textContent = text; e.classList.toggle('on', !!on);
  }
  function resetStats() {
    // Not on a server / not spawned yet -> the bars show nothing at all.
    [['bar-hp', 'val-hp'], ['bar-ap', 'val-ap'], ['bar-exp', 'val-exp'], ['bar-load', 'val-load'], ['bar-thp', 'val-thp'], ['bar-tap', 'val-tap']]
      .forEach(([f, v]) => setStat(f, v, 0, '', false));
    $('st-level').textContent = '—'; $('st-perk').textContent = '—';
  }
  function applyStats(s) {
    s = s || {};
    if (s.alive !== undefined) { selfAlive = !!s.alive; selfPositioned = !!s.positioned; drawMap(); updateConnTitle(); }
    // When not alive, the HP bar reads the reason (dead / between waves) so the missing self dot is
    // explained; the actual HP only shows while alive.
    if (s.alive === false) {
      setStat('bar-hp', 'val-hp', 0, '', false);   // no body on the map -> the bar stays blank
    } else if (s.hp != null) setStat('bar-hp', 'val-hp', pctOf(s.hp, s.hpMax), s.hp + '/' + s.hpMax, true);
    if (s.armor != null) setStat('bar-ap', 'val-ap', pctOf(s.armor, s.armorMax), s.armor + '/' + s.armorMax, true);
    if (s.expPct != null) setStat('bar-exp', 'val-exp', s.expPct, (+s.expPct).toFixed(2) + '%', true);
    if (s.load != null) setStat('bar-load', 'val-load', pctOf(s.load, s.loadMax), s.load + '/' + s.loadMax, true);
    if (s.perk) $('st-perk').textContent = s.perk;
    if (s.level != null) $('st-level').textContent = s.level;
  }
  function applyTarget(t) {
    t = t || {};
    if (t.hp != null) setStat('bar-thp', 'val-thp', pctOf(t.hp, t.hpMax), t.hp + '/' + t.hpMax, true);
    if (t.armor != null) setStat('bar-tap', 'val-tap', pctOf(t.armor, t.armorMax), t.armor + '/' + t.armorMax, true);
  }

  // ---- virtual map ----
  const mapCv = $('map'), mapCtx = mapCv.getContext('2d');
  let mapScale = 10;
  let playBounds = null, autoFitDone = false, userZoomed = false;   // real play area + one-time zoom-to-fit gate
  let panPxX = 0, panPxY = 0;   // right-mouse-drag view pan (screen px), independent of the self-following camera
  let mapReady = false;         // draw the map only once admitted (handshake done + resources downloaded)
  let mapStatus = null;         // { k, v } i18n key of the centered message shown while !mapReady
  let mapBg = null;   // { img: HTMLImageElement, bounds:{minX,maxX,minY,maxY} } - server map top-down
  // Persistent per-channel object store so dots glide instead of blink/teleport (L2Walker-style
  // smoothing). Replication is bursty: each snapshot opens a straight glide segment from the dot's
  // current rendered position to the fresh server position, run over the measured update interval, so
  // dots slide continuously instead of snapping-then-freezing. The render loop runs every frame while
  // connected (not only "while something moved"), which is what removes the jerk.
  const mapStore = new Map();   // chIndex -> { type,name,hp, x,y (rendered), px,py (seg start), tx,ty (target), segStart, seen }
  let camX = 0, camY = 0;   // camera follows the self dot's rendered position
  const MAP_GRACE_MS = 800, MAP_SNAP = 6000;   // jumps bigger than SNAP are real teleports/respawns -> no glide
  let mapRaf = null, updInterval = 200, lastIngestAt = 0;   // updInterval: smoothed snapshot cadence (ms)
  const mapFlags = () => ({ mon: $('m-mon').checked, player: $('m-player').checked, item: $('m-item').checked, trader: $('m-trader').checked, door: $('m-door').checked, mover: $('m-mover').checked });
  const findSelf = () => { for (const e of mapStore.values()) if (e.type === 'self') return e; return null; };

  // Recently-dropped moving actors: relevancy churn closes a zed's channel and reopens it under a new
  // index moments later - seeding the new dot from its grave keeps that one actor gliding, not teleporting.
  const graves = [];
  function takeGrave(type, x, y, now) {
    let best = -1, bestD = 900;
    for (let i = 0; i < graves.length; i++) {
      const g = graves[i];
      if (g.type !== type || now - g.t > 2500) continue;
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? graves.splice(best, 1)[0] : null;
  }
  // Merge a fresh snapshot. A glide segment opens only when an object's DATA moved, and runs over that
  // object's own measured update interval - a zed replicated once a second glides for a second, while the
  // 60ms self stream stays tight. Snap real teleports; drop absent objects once the grace elapses.
  function ingestMapObjects(list) {
    const now = performance.now();
    if (lastIngestAt) updInterval = Math.max(80, Math.min(600, updInterval * 0.6 + (now - lastIngestAt) * 0.4));
    lastIngestAt = now;
    const present = new Set();
    for (const o of (list || [])) {
      present.add(o.chIndex);
      let e = mapStore.get(o.chIndex);
      if (!e) {
        e = { x: o.x, y: o.y, px: o.x, py: o.y, tx: o.x, ty: o.y, segStart: now, updT: updInterval, chgAt: now };
        const g = takeGrave(o.type, o.x, o.y, now);
        if (g) { e.x = g.x; e.y = g.y; e.px = g.x; e.py = g.y; e.segStart = now; }   // continue the old glide path
        mapStore.set(o.chIndex, e);
      }
      e.type = o.type; e.name = o.name || null; e.hp = o.hp != null ? o.hp : null; e.yaw = o.yaw; e.z = o.z != null ? o.z : 0; e.seen = now;
      e.vx = o.vx || 0; e.vy = o.vy || 0;
      // Accumulate the REAL play area from live unit positions - the map .rom bounds cover the whole geometry
      // (skybox / kill-zone), often ~10x larger than where players and zeds actually are, so fitting the view
      // to the .rom bounds renders the play area tiny and its motion reads as too fast. Track the units instead.
      if (o.type === 'self' || o.type === 'player' || o.type === 'mon') {
        if (!playBounds) playBounds = { minX: o.x, maxX: o.x, minY: o.y, maxY: o.y };
        else { if (o.x < playBounds.minX) playBounds.minX = o.x; if (o.x > playBounds.maxX) playBounds.maxX = o.x; if (o.y < playBounds.minY) playBounds.minY = o.y; if (o.y > playBounds.maxY) playBounds.maxY = o.y; }
      }
      if (o.x !== e.tx || o.y !== e.ty) {                 // the data actually moved -> new glide segment
        const dt = now - (e.chgAt || now);
        if (dt > 0 && dt < 3000) e.updT = Math.max(80, Math.min(1500, (e.updT || updInterval) * 0.5 + dt * 0.5));
        e.chgAt = now;
        if (Math.hypot(o.x - e.x, o.y - e.y) > MAP_SNAP) { e.x = o.x; e.y = o.y; }   // teleport / respawn -> snap
        e.px = e.x; e.py = e.y; e.tx = o.x; e.ty = o.y; e.segStart = now;
      }
    }
    for (const [ch, e] of mapStore) if (!present.has(ch) && now - e.seen > MAP_GRACE_MS) {
      if (e.type === 'mon' || e.type === 'player') { graves.push({ type: e.type, x: e.x, y: e.y, t: now }); if (graves.length > 48) graves.shift(); }
      mapStore.delete(ch);
    }
    maybeAutoFit();
    startMapLoop();
  }
  // One-time zoom-to-fit the REAL play area (accumulated unit positions) once enough of it has been seen, so
  // the map fills the view at the true unit scale instead of shrinking to the whole-geometry .rom bounds.
  // Skipped once the user has zoomed manually (userZoomed), so it never fights a deliberate zoom.
  function maybeAutoFit() {
    if (autoFitDone || userZoomed || !playBounds || !mapReady || !mapCv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = mapCv.width / dpr, H = mapCv.height / dpr;
    if (!W || !H) return;
    const spanX = playBounds.maxX - playBounds.minX, spanY = playBounds.maxY - playBounds.minY;
    if (Math.max(spanX, spanY) < 2000) return;   // wait until a real slice of the play area is known
    const needDiv = Math.max(spanX / (W * 0.8), spanY / (H * 0.8));   // fit with ~20% margin
    let sc = needDiv / 8;
    sc = sc < 1 ? Math.round(sc * 4) / 4 : Math.round(sc);
    sc = Math.max(0.25, Math.min(50, sc));
    autoFitDone = true;
    setScale(sc);
  }
  function stepMapPositions() {
    const now = performance.now();
    for (const e of mapStore.values()) {
      // Velocity dead-reckoning (like a real client's simulated proxy): glide toward the last position
      // extrapolated by the replicated velocity, capped at 0.9s so a stale vector can't run away.
      const ex = (e.vx || e.vy) ? Math.min(0.9, Math.max(0, (now - (e.chgAt || now)) / 1000)) : 0;
      const gx = e.tx + (e.vx || 0) * ex, gy = e.ty + (e.vy || 0) * ex;
      // Glide duration = the measured update interval, but stretched so the glide SPEED never exceeds a
      // realistic per-actor ceiling (uu/s). KF replicates a relevant pawn's Location sparsely (a zed's
      // target can hold for ~1s then jump 300-500uu); gliding that jump over the short update interval
      // reads as a teleport. Capping the speed slides even a big/sparse jump smoothly, while a normal
      // small update still glides over the tight update rate. Ceilings sit above real top speeds (raging
      // Fleshpound ~600, sprinting player ~440) so genuine movement isn't visibly lagged.
      const SPEED_CAP = e.type === 'self' ? 800 : e.type === 'player' ? 650 : e.type === 'mon' ? 620 : 400;
      const dist = Math.hypot(gx - e.px, gy - e.py);
      const base = Math.max(100, Math.min(1600, (e.updT || updInterval) * 1.15));
      const dur = Math.max(base, (dist / SPEED_CAP) * 1000);
      const f = Math.min(1, (now - e.segStart) / dur);
      e.x = e.px + (gx - e.px) * f; e.y = e.py + (gy - e.py) * f;
    }
    // Camera rides the self dot's already-smooth rendered position.
    const self = findSelf();
    if (self) { camX = self.x; camY = self.y; }
  }
  function startMapLoop() { if (mapRaf == null) mapRaf = requestAnimationFrame(mapTick); }
  function mapTick() { mapRaf = null; stepMapPositions(); drawMap(); if (running && mapReady) mapRaf = requestAnimationFrame(mapTick); }
  function resetMap() { mapStore.clear(); graves.length = 0; mapBg = null; camX = camY = 0; lastIngestAt = 0; slowShown = false; panPxX = panPxY = 0; mapReady = false; mapStatus = { k: 'sb.connecting' }; playBounds = null; autoFitDone = false; userZoomed = false; drawMap(); }
  function sizeMap() {
    // Back the canvas at device resolution so 1px marker outlines stay crisp on scaled displays.
    const w = mapCv.clientWidth | 0, h = mapCv.clientHeight | 0;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (w && h && (mapCv.width !== bw || mapCv.height !== bh)) { mapCv.width = bw; mapCv.height = bh; }
    drawMap();
  }
  // World coordinate at the centre of the visible area - the inverse of the dot projection in drawMap,
  // so a pan tells you exactly where you're looking. z rides from the self dot's floor height when known.
  function updateCoordReadout() {
    const coord = $('m-coord'); if (!coord) return;
    const div = mapScale * 8;
    const viewX = Math.round(camX - panPxX * div), viewY = Math.round(camY + panPxY * div);
    const self = findSelf();
    coord.textContent = 'x: ' + viewX + ', y: ' + viewY + ', z: ' + Math.round((self && self.z) || 0);
  }
  function drawMap() {
    const dpr = window.devicePixelRatio || 1;
    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in CSS units on the device-res backing store
    const w = mapCv.width / dpr, h = mapCv.height / dpr, cx = w / 2, cy = h / 2;
    const ox = cx + panPxX, oy = cy + panPxY;   // projection origin, shifted by the right-mouse pan
    updateCoordReadout();                        // world coordinate at the view centre (always, even idle)
    mapCtx.fillStyle = '#396da5'; mapCtx.fillRect(0, 0, w, h);
    // Until we're admitted (handshake done AND server resources downloaded) the player isn't really in the
    // game, so show nothing but a status line while a connect is in progress - and a blank map when idle
    // (no connect yet / after disconnect), so the initial state has no misleading "Connecting…" text.
    if (!mapReady) {
      if (mapStatus) {
        mapCtx.fillStyle = 'rgba(255,255,255,0.6)';
        mapCtx.font = '13px "Segoe UI", Tahoma, sans-serif'; mapCtx.textAlign = 'center'; mapCtx.textBaseline = 'middle';
        mapCtx.fillText(t(mapStatus.k, mapStatus.v), cx, cy);
      }
      return;
    }
    // Server map top-down, placed at its world bounds and scaled by the same camera as the dots.
    if (mapBg && mapBg.img && $('m-realmap').checked) {
      const div = mapScale * 8, b = mapBg.bounds;
      const px = ox + (b.minX - camX) / div, py = oy - (b.maxY - camY) / div;   // top-left (minX, maxY)
      const iw = (b.maxX - b.minX) / div, ih = (b.maxY - b.minY) / div;
      try { mapCtx.drawImage(mapBg.img, px, py, iw, ih); } catch (e) {}
    }
    mapCtx.strokeStyle = 'rgba(255,255,255,0.10)'; mapCtx.lineWidth = 1;
    const step = Math.max(18, 360 / mapScale);
    mapCtx.beginPath();
    for (let x = ((ox % step) + step) % step; x < w; x += step) { mapCtx.moveTo(x + 0.5, 0); mapCtx.lineTo(x + 0.5, h); }
    for (let y = ((oy % step) + step) % step; y < h; y += step) { mapCtx.moveTo(0, y + 0.5); mapCtx.lineTo(w, y + 0.5); }
    mapCtx.stroke();
    mapCtx.strokeStyle = 'rgba(255,255,255,0.22)'; mapCtx.beginPath();
    mapCtx.moveTo(ox + 0.5, 0); mapCtx.lineTo(ox + 0.5, h); mapCtx.moveTo(0, oy + 0.5); mapCtx.lineTo(w, oy + 0.5); mapCtx.stroke();
    const f = mapFlags();
    const div = mapScale * 8;
    const SZ = 9;   // every actor drawn as the same-size square with a 1-device-px outline
    const snap = (v) => (Math.round(v * dpr) + 0.5) / dpr;   // align to the physical pixel grid
    const boxSz = Math.round(SZ * dpr) / dpr;
    const box = (x, y, color) => {
      mapCtx.strokeStyle = color; mapCtx.lineWidth = 1 / dpr;
      mapCtx.strokeRect(snap(x - SZ / 2), snap(y - SZ / 2), boxSz, boxSz);
    };
    // players blue, monsters red, items gold, trader yellow, doors pink, movers cyan
    const COLOR = { player: '#3aa0ff', mon: '#ff3030', item: '#f0c020', trader: '#ffd000', door: '#ff40c0', mover: '#22c8e0' };
    for (const e of mapStore.values()) {
      if (e.type === 'self') continue;   // self is drawn centered below, always visible
      if (!f[e.type]) continue;          // layer toggled off
      const px = ox + (e.x - camX) / div, py = oy - (e.y - camY) / div;
      if (px < -30 || px > w + 30 || py < -30 || py > h + 30) continue;   // cull offscreen
      box(px, py, COLOR[e.type] || '#ffffff');   // unfilled square, identical for every actor type
      // Label every dot: the precise name when known, else a generic type word so a square is never blank
      // (custom KF15Beta zeds whose class/Health never resolve otherwise carried no label at all).
      const label = e.name || (e.type === 'mon' ? t('map.zed') : e.type === 'player' ? t('map.player') : null);
      if (label) drawMapLabel(label, px, py - SZ / 2 - 2);
    }
    // My own green marker at the camera centre (shifted by any pan). Only while alive AND we actually know
    // our position - a dead / respawning / spectating player has no body, so we must not draw a phantom.
    if (selfAlive && selfPositioned) {
      box(ox, oy, '#22c55e');
      if (curName) drawMapLabel(curName, ox, oy - SZ / 2 - 2);
    }
  }
  // Nickname above a player dot: dark outline under white text so it stays readable on any tile.
  function drawMapLabel(text, x, y) {
    mapCtx.font = '10px "Segoe UI", Tahoma, sans-serif';
    mapCtx.textAlign = 'center'; mapCtx.textBaseline = 'bottom';
    mapCtx.lineWidth = 3; mapCtx.strokeStyle = 'rgba(0,0,0,0.8)'; mapCtx.strokeText(text, x, y);
    mapCtx.fillStyle = '#fff'; mapCtx.fillText(text, x, y);
  }
  if (window.ResizeObserver) new ResizeObserver(sizeMap).observe(mapCv.parentElement);
  window.addEventListener('resize', sizeMap);
  // Left-click a point on the map -> run there (ServerMove). Canvas point -> world coords (drawMap's
  // transform, including the current pan). Right-drag pans and must not move the player.
  mapCv.addEventListener('click', (e) => {
    if (panMoved) { panMoved = false; return; }   // ignore the click that ends a right-drag pan
    if (!mapReady) return;
    if (!selfAlive) {   // no point moving a pawn that isn't alive on the map
      appendLog('>> ' + t('log.moveIgnored'));
      return;
    }
    const r = mapCv.getBoundingClientRect();
    const worldX = camX + (e.clientX - r.left - r.width / 2 - panPxX) * (mapScale * 8);
    const worldY = camY - (e.clientY - r.top - r.height / 2 - panPxY) * (mapScale * 8);
    window.kfbot.cmd({ cmd: 'move', x: Math.round(worldX), y: Math.round(worldY) });
    appendLog('>> ' + t('log.moveTo', { x: Math.round(worldX), y: Math.round(worldY) }));
  });
  // Right-mouse drag pans the view - independent of the self-following camera and of left-click Move-to.
  let panning = false, panLastX = 0, panLastY = 0, panMoved = false;
  mapCv.addEventListener('contextmenu', (e) => e.preventDefault());   // suppress the browser menu on RMB
  mapCv.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    panning = true; panMoved = false; panLastX = e.clientX; panLastY = e.clientY;
    mapCv.classList.add('panning'); e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    panPxX += e.clientX - panLastX; panPxY += e.clientY - panLastY;
    panLastX = e.clientX; panLastY = e.clientY; panMoved = true;
    drawMap();
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 2 && panning) { panning = false; mapCv.classList.remove('panning'); } });
  ['m-mon', 'm-player', 'm-item', 'm-trader', 'm-door', 'm-mover', 'm-realmap'].forEach((id) => $(id).addEventListener('change', drawMap));
  function setScale(v) {   // shared by the slider and the wheel; 1:0.25 (closest) .. 1:50 (overview)
    const oldDiv = mapScale * 8;
    v = Math.max(0.25, Math.min(50, v));
    mapScale = v < 1 ? Math.round(v * 4) / 4 : Math.round(v);   // 0.25 grid once zoomed past 1:1, whole steps above
    const newDiv = mapScale * 8;
    // Zoom around the CURRENT view centre, not world origin: the view-centre world point is camX - panPxX*div,
    // so keep panPxX*div invariant (scale the pan) - otherwise a zoom drifts the framed point toward (0,0).
    if (oldDiv !== newDiv && (panPxX || panPxY)) { const k = oldDiv / newDiv; panPxX *= k; panPxY *= k; }
    $('m-scale').value = mapScale; $('m-scaleval').textContent = '1:' + mapScale;
    drawMap();
  }
  $('m-scale').addEventListener('input', (e) => { userZoomed = true; setScale(+e.target.value); });
  // Reset View: undo any right-drag pan so the map recenters on the player (origin when not spawned) - the
  // default framing you get on connect, so a stray pan can't leave you lost far from your real coordinates.
  $('m-reset').addEventListener('click', () => {
    panPxX = panPxY = 0;
    if (!findSelf() && mapBg) { camX = (mapBg.bounds.minX + mapBg.bounds.maxX) / 2; camY = (mapBg.bounds.minY + mapBg.bounds.maxY) / 2; }
    drawMap();
  });
  // Mouse wheel over the map zooms by a fixed step of 1 per tick: up = zoom in (scale −1), down = zoom out.
  mapCv.addEventListener('wheel', (e) => {
    e.preventDefault();
    userZoomed = true;   // a manual zoom disables the one-time auto-fit
    const zoomIn = e.deltaY < 0;   // wheel up = zoom in (smaller scale)
    // Fine 0.25 steps only while below/at 1:1 zooming IN; zooming OUT past 1:1 must use whole steps, else
    // 1 + 0.25 = 1.25 rounds back to 1 and the wheel sticks at 1:1 (the reported bug).
    const step = zoomIn ? (mapScale <= 1 ? 0.25 : 1) : (mapScale < 1 ? 0.25 : 1);
    setScale(mapScale + (zoomIn ? -step : step));
  }, { passive: false });

  // ---- world objects ----
  function clearObjects() { setActors(0); applyWorld({}); }
  function setActors(n) { setT('sb-objs', 'sb.objects', { n }); }

  // ---- world panel tabs (Players / Monsters / Items) ----
  document.querySelectorAll('#p-objs .otab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('#p-objs .otab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('#p-objs .objview').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== t.dataset.view));
  }));

  // ---- Players / Monsters / Items (from the 'world' event, ~1s) ----
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function fillList(bodyId, rows, cells) {
    $(bodyId).innerHTML = rows.map((r) => '<tr>' + cells(r).map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('');
  }
  let lastWorld = {};   // last snapshot, so a language switch can re-render the tables
  function applyWorld(w) {
    w = lastWorld = w || {};
    const players = w.players || [], monsters = w.monsters || [], items = w.items || [];
    // Items = actual pickups only (ammo / weapons / medkits / armor). Traders (ShopVolume) and doors
    // (KFDoorMover / KFTraderDoor) are their own kinds - shown on the Virtual Map, not in this list.
    fillList('players-body', players, (p) => [
      p.ch,
      (p.self ? '★ ' : '') + p.name,
      p.hp != null ? p.hp : '—',
      t(p.spawned ? 'world.alive' : (p.hp === 0 ? 'world.dead' : (p.confirmed ? 'world.deadSpec' : 'world.spec'))),
    ]);
    fillList('monsters-body', monsters, (m) => [m.ch, m.name || t('map.zed'), m.hp != null ? m.hp : '—']);
    fillList('items-body', items, (i) => [i.ch, i.name]);
    $('cnt-players').textContent = players.length;
    $('cnt-monsters').textContent = monsters.length;
    $('cnt-items').textContent = items.length;
    applyWave(w.wave);
  }

  // Live wave state from the server's GameReplicationInfo (decoded like a real client's HUD): current wave,
  // trader countdown, wave-in-progress + alive-monster count. Hidden until the GRI channel yields any of it.
  function applyWave(wv) {
    const wrap = $('wave-wrap');
    if (!wv || (wv.waveNumber == null && wv.timeToNextWave == null && wv.waveInProgress == null && wv.maxMonsters == null)) {
      wrap.classList.add('hidden'); return;
    }
    wrap.classList.remove('hidden');
    // KFGameType.GetCurrentWaveNum() = WaveNumber + 1, i.e. the number the in-game HUD shows.
    // WaveNumber at its default (0, wave one) is never replicated - so no value means wave 1, not "—".
    const cur = (wv.waveNumber != null ? wv.waveNumber : 0) + 1;
    $('st-wave').textContent = wv.finalWave ? cur + '/' + wv.finalWave : String(cur);
    if (wv.waveInProgress) {
      // The real HUD's "specimens remaining" is KFGRI.MaxMonsters (zeds alive + still to spawn) -
      // counting only the nearby replicated dots undercounted badly ("Zeds 0/113").
      const rem = wv.maxMonsters != null ? wv.maxMonsters : (wv.aliveMonsters != null ? wv.aliveMonsters : '?');
      setT('st-wavestate', 'wave.inProgress', { n: rem });
    } else if (wv.timeToNextWave != null && wv.timeToNextWave > 0) {
      setT('st-wavestate', 'wave.next', { n: wv.timeToNextWave });
    } else {
      setT('st-wavestate', 'wave.trader');
    }
  }

  // ---- log ----
  const logEl = $('log');
  // Keep each tab's full history scrollable until exit: trim only the oldest high-volume Sys/Events
  // lines past the ceiling, never chat or error lines (low volume, worth keeping the whole session).
  function trimLog() {
    let over = logEl.childNodes.length - MAX_LOG_LINES;
    let node = logEl.firstChild;
    while (over > 0 && node) {
      const next = node.nextSibling;
      if (node.classList && !node.classList.contains('chat') && !node.classList.contains('err')) { logEl.removeChild(node); over--; }
      node = next;
    }
  }
  function appendLog(line) {
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
    const div = document.createElement('div');
    div.className = 'line' + (/(!!|\[stderr\])/.test(line) ? ' err' : /^(>>>|==)/.test(line) ? ' evt' : '');
    div.textContent = line; logEl.appendChild(div);
    trimLog();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  // Clean chat line ("Nick: message") for the Chat tab - no ">>> SAY"/"[CHAT]" protocol noise.
  function appendChat(from, text) {
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
    const div = document.createElement('div');
    div.className = 'line chat';
    if (from) { const b = document.createElement('b'); b.textContent = from + ': '; div.appendChild(b); }
    div.appendChild(document.createTextNode(text == null ? '' : String(text)));
    logEl.appendChild(div);
    trimLog();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  // Clear only the active tab's lines (Events/Errors/Chat); the Sys/all tab shows everything, so it clears all.
  function clearActiveLog() {
    if (activeFilter === 'all') { logEl.innerHTML = ''; return; }
    logEl.querySelectorAll('.line.' + activeFilter).forEach((n) => n.remove());
  }
  function runCommand(raw) {
    const c = raw.trim().toLowerCase(); if (!c) return;
    if (c === 'clear') return void clearActiveLog();
    if (['start', 'login', 'connect'].includes(c)) return doStart();
    if (['stop', 'logout', 'disconnect'].includes(c)) return doStop();
    if (c === 'restart') return doRestart();
    if (c === 'ready') return window.kfbot.cmd('ready');
    if (c === 'leave') return window.kfbot.cmd('leave');
    if (c.startsWith('say ')) return window.kfbot.cmd({ cmd: 'say', text: raw.trim().slice(4) });
    if (c.startsWith('teamsay ')) return window.kfbot.cmd({ cmd: 'say', text: raw.trim().slice(8), team: true });
    appendLog('!! ' + t('log.unknownCmd', { raw }));
  }

  // ---- events ----
  // Resource-download progress bar (in the toolbar spot the old Cancel/ForceATK buttons held).
  function showDownload(p) {
    $('dl-wrap').classList.remove('hidden');
    const pct = p && p.pct != null ? p.pct : 0;
    $('dl-fill').style.width = pct + '%';
    const mb = (n) => ((n || 0) / 1048576).toFixed(1);
    $('dl-text').textContent = (p && p.name ? p.name + ' ' : '') + pct + '% (' + mb(p && p.bytes) + '/' + mb(p && p.size) + ' MB)';
    setTitle($('dl-text').textContent);   // keep the window title in sync with the download status
  }
  function hideDownload() { $('dl-wrap').classList.add('hidden'); }

  function handleBotEvent(msg) {
    const { name, payload } = msg;
    switch (name) {
      case 'log': appendLog(String(payload)); break;
      case 'state': applyState(payload.to); break;
      case 'status':
        $('st-name').textContent = payload.name; $('st-server').textContent = payload.server;
        $('st-steamid').textContent = payload.steamid;
        if (!$('f-steamid').value) $('f-steamid').value = payload.steamid || '';   // show resolved ID, but never clobber a user-entered one
        setActors(payload.actorChannelCount); break;
      case 'actorChannel': setActors(payload.count != null ? payload.count : 0); break;   // Actors table filled from 'world'.actors
      case 'stats': applyStats(payload); break;
      case 'target': applyTarget(payload); break;
      case 'mapObjects': ingestMapObjects(Array.isArray(payload) ? payload : (payload && payload.objects) || []); break;
      case 'world': applyWorld(payload); break;
      case 'mapImage':
        if (payload && payload.mapName) curMap = payload.mapName;   // shown in Char->Map once fully joined
        if (payload && payload.image) {
          const img = new Image();
          img.onload = () => {
            mapBg = { img, bounds: payload.bounds };
            // Until the self dot exists the camera idles at world 0,0 - many maps are built off-centre,
            // so frame the map itself; once spawned the camera follows the player as usual.
            if (!findSelf() && payload.bounds) { camX = (payload.bounds.minX + payload.bounds.maxX) / 2; camY = (payload.bounds.minY + payload.bounds.maxY) / 2; }
            drawMap();
          };
          img.src = payload.image;
          appendLog('>>> ' + t('log.mapRendered', { name: payload.mapName, how: t(payload.cached ? 'log.fromCache' : 'log.rendered') }));
        } else { mapBg = null; if (payload && payload.reason) appendLog(t('log.mapBg', { reason: payload.reason })); drawMap(); }
        break;
      case 'chat': appendChat(payload && payload.from, payload && (payload.text != null ? payload.text : payload)); break;
      case 'connecting': {
        const stage = (payload && payload.stage) || '';
        const secs = Math.round((payload && payload.elapsedMs || 0) / 1000);
        if (stage === 'downloading' && payload.progress) {
          const p = payload.progress;
          showDownload(p);
          mapStatus = { k: 'map.downloading', v: { pct: p.pct != null ? p.pct + '%' : '' } };
          if (p.name) setT('sb-state', 'sb.downloading', { name: p.name, pct: p.pct || 0 });
          else setT('sb-state', 'map.downloading', { pct: (p.pct || 0) + '%' });
          if (payload.downloadSlow && !slowShown) { slowShown = true; showSlowDl(payload.downloadSlow); }
        } else {
          hideDownload();
          mapStatus = { k: 'map.connectingStage', v: { stage } };
          const inflight = payload && payload.inflight ? t('sb.inflight', { n: payload.inflight }) : '';
          setT('sb-state', 'sb.connectingStage', { stage, secs, inflight });
        }
        drawMap();
        break;
      }
      case 'admitted': mapReady = true; reconnTries = 0; hideDownload(); mapStatus = null; drawMap(); updateConnTitle(); $('st-map').textContent = curMap || '—'; setT('sb-state', 'sb.admitted'); break;
      case 'ready': setT('sb-state', 'sb.readySent'); break;
      case 'leaving': setT('sb-state', 'sb.leaving'); break;
      case 'failed': mapReady = false; mapStatus = null; hideDownload(); drawMap(); setTitle(''); $('st-map').textContent = '—'; showKicked(payload, 'dlg.connectFailed'); break;
      case 'kicked': {
        const wasInLevel = mapReady;
        mapReady = false; mapStatus = null; hideDownload(); drawMap(); setTitle(''); $('st-map').textContent = '—';
        // In-level close = server travel (round end / map rotation) -> reconnect like the real client.
        if (wasInLevel && scheduleReconnect()) { setRunning(false); stopUptime(); }
        else showKicked(payload);
        break;
      }
      case 'closed': mapReady = false; mapStatus = null; hideDownload(); setRunning(false); stopUptime(); setT('sb-state', 'sb.disconnected'); drawMap(); setTitle(''); $('st-map').textContent = '—'; break;
      case 'exit': mapReady = false; mapStatus = null; hideDownload(); setRunning(false); stopUptime(); setT('sb-state', 'sb.stopped'); drawMap(); setTitle(''); $('st-map').textContent = '—'; break;
    }
  }
  window.kfbot.onEvent(handleBotEvent);
  window.__kfinject = handleBotEvent;   // test hook: feed captured/synthetic events for headless visual checks

  // ---- buttons ----
  $('btn-login').addEventListener('click', doStart);
  $('btn-logout').addEventListener('click', doStop);
  $('btn-restart').addEventListener('click', doRestart);
  $('btn-ready').addEventListener('click', () => window.kfbot.cmd('ready'));
  $('f-realSteam').addEventListener('change', reflectMode);
  // Random ID: when on, fill the ID field with a random valid SteamID64 and lock it (regenerated on connect).
  $('f-randomId').addEventListener('change', () => {
    const on = $('f-randomId').checked;
    $('f-steamid').readOnly = on;
    $('f-steamid').value = on ? genSteamId() : '';
  });
  function reflectMode() { const rs = $('f-realSteam').checked; $('sb-mode').textContent = rs ? 'REAL-STEAM' : 'SYNTH'; setT('st-mode', rs ? 'mode.real' : 'mode.synth'); }
  $('cmd').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value; e.target.value = '';
    if (activeFilter === 'chat') {
      const t = v.trim(); if (!t) return;
      window.kfbot.cmd({ cmd: 'say', text: t });   // server echoes it back to the Chat tab; no local echo (would double it)
    } else runCommand(v);
  });
  $('btn-clear').addEventListener('click', (e) => { e.preventDefault(); clearActiveLog(); });

  // ---- Char panel tabs ----
  document.querySelectorAll('#p-char .ptab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  function selectTab(name) {
    document.querySelectorAll('#p-char .ptab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('#p-char .tabpage').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== name));
  }

  // ---- log filter tabs ----
  document.querySelectorAll('.ctab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.ctab').forEach((x) => x.classList.remove('active')); t.classList.add('active');
    activeFilter = t.dataset.filter;
    logEl.className = activeFilter === 'all' ? '' : 'f-' + activeFilter;
    I18N.setPlaceholder('cmd', activeFilter === 'chat' ? 'ph.chat' : 'ph.command');
    logEl.scrollTop = logEl.scrollHeight;   // switching tabs jumps to the newest line
  }));

  // ---- panel collapse ----
  function togglePanel(id) { const p = $(id); if (p) { p.classList.toggle('collapsed'); if (id === 'p-map') sizeMap(); } }
  document.querySelectorAll('.panel .panel-btns i.x').forEach((x) => x.addEventListener('click', () => togglePanel(x.closest('.panel').id)));

  // ---- menu bar ----
  const menus = Array.from(document.querySelectorAll('#menubar .menu'));
  const closeMenus = () => menus.forEach((m) => m.classList.remove('open'));
  menus.forEach((m) => {
    // closest('.mi'), not the target's own class: item labels sit in a <span> so a language switch can
    // rewrite them, and a click on that span must still count as a click on the item.
    m.addEventListener('click', (e) => { if (e.target.closest('.mi')) return; if (m.dataset.act) { menuAction(m.dataset.act); closeMenus(); return; } const open = m.classList.contains('open'); closeMenus(); if (!open) m.classList.add('open'); });
    m.addEventListener('mouseenter', () => { if (menus.some((x) => x.classList.contains('open'))) { closeMenus(); m.classList.add('open'); } });
  });
  // Items without an action (the Language submenu parent) must not close the menu on click.
  document.querySelectorAll('#menubar .mi').forEach((mi) => mi.addEventListener('click', () => { if (!mi.dataset.act) return; menuAction(mi.dataset.act); closeMenus(); }));
  document.addEventListener('click', (e) => { if (!e.target.closest('#menubar')) closeMenus(); });
  function menuAction(a) {
    if (a === 'start') return doStart(); if (a === 'stop') return doStop(); if (a === 'restart') return doRestart();
    if (a === 'exit') return window.close();
    if (a === 'toggle-map') return togglePanel('p-map'); if (a === 'toggle-char') return togglePanel('p-char');
    if (a === 'toggle-objs') return togglePanel('p-objs'); if (a === 'toggle-log') return togglePanel('p-log');
    if (a === 'clearlog') return void clearActiveLog();
    if (a && a.indexOf('tab-') === 0) return selectTab(a.slice(4));
    if (a === 'about') return void $('about').classList.remove('hidden');
    if (a === 'server-browser') return openBrowser();
  }

  // ---- Setup -> Language ----
  // Every locale from the README; picking one repaints the UI at once and is remembered in settings.ini.
  function markLangMenu() { document.querySelectorAll('#lang-pop .mi').forEach((m) => m.classList.toggle('on', m.dataset.lang === I18N.lang)); }
  I18N.LANGS.forEach(([code, label]) => {
    const mi = document.createElement('div');
    mi.className = 'mi'; mi.dataset.lang = code; mi.textContent = label;
    mi.addEventListener('click', () => { I18N.apply(code); window.kfbot.setLang(code); closeMenus(); });
    $('lang-pop').appendChild(mi);
  });
  // Live parts the DOM scan can't reach: canvas labels, the rebuilt world tables, the command
  // placeholder (its key depends on the active log tab) and the submenu's check mark.
  I18N.onChange(() => {
    I18N.setPlaceholder('cmd', activeFilter === 'chat' ? 'ph.chat' : 'ph.command');
    applyWorld(lastWorld); drawMap(); markLangMenu();
  });

  // ---- about ----
  $('about-x').addEventListener('click', () => $('about').classList.add('hidden'));
  $('about-ok').addEventListener('click', () => $('about').classList.add('hidden'));
  $('about').addEventListener('click', (e) => { if (e.target.id === 'about') $('about').classList.add('hidden'); });

  // ---- kicked / disconnected dialog ----
  // titleKey present => a connect-time failure, not an in-game kick.
  function showKicked(reason, titleKey) {
    setRunning(false); stopUptime();
    const title = t(titleKey || 'dlg.kicked'), why = reason || t('log.kickDefault');
    setT('sb-state', 'sb.kickedState', { title, reason: why });
    appendLog('!! ' + t('log.kicked', { title, reason: why }));
    setT('kick-title', titleKey || 'dlg.disconnected');
    $('kick-reason').textContent = reason || t('dlg.kickDefault');
    $('kick').classList.remove('hidden');
  }
  const hideKick = () => $('kick').classList.add('hidden');
  $('kick-x').addEventListener('click', hideKick);
  $('kick-ok').addEventListener('click', hideKick);
  $('kick').addEventListener('click', (e) => { if (e.target.id === 'kick') hideKick(); });

  // ---- slow-download dialog: shown once when a download crawls; Continue keeps waiting, Cancel disconnects ----
  function showSlowDl(info) {
    $('slowdl-reason').textContent = t('slowdl.text', { rate: info.rateKB || '?', mb: info.mb || '0', pct: info.pct || 0 });
    $('slowdl').classList.remove('hidden');
  }
  const hideSlowDl = () => $('slowdl').classList.add('hidden');
  $('slowdl-continue').addEventListener('click', () => { hideSlowDl(); window.kfbot.cmd({ cmd: 'ackslowdl' }); });   // keep waiting regardless of speed
  $('slowdl-x').addEventListener('click', () => { hideSlowDl(); window.kfbot.cmd({ cmd: 'ackslowdl' }); });
  $('slowdl-cancel').addEventListener('click', () => { hideSlowDl(); window.kfbot.stop(); });

  // ---- Server Browser ----
  let browserRows = [], browserGen = 0, browserSel = null, browserRenderTimer = null;
  // Column sort (click a header to toggle asc/desc). Columns: 0 IP, 1 Name, 2 Players, 3 List, 4 Wave, 5 Ping, 6 Pw.
  let browserSort = { i: 2, dir: -1 };   // default: most players first
  function sortVal(r, i) {
    switch (i) {
      case 0: return (r.connect || '').toLowerCase();
      case 1: return (r.name || '').toLowerCase();
      case 2: return r.players != null ? r.players : -1;
      case 3: return (r.players_list || []).length;
      // Wave sorts by the current wave first, final wave second (like the real client's browser sort);
      // servers without wave data compare as -1, so DESC puts them last.
      case 4: { const m = /^(\d+)\/(\d+)/.exec(r.wave || ''); return m ? +m[1] * 1000 + +m[2] : -1; }
      case 5: return r.ping != null ? r.ping : (r.pingFailed ? 1e9 : 1e8);   // unqueried mid, dead last
      case 6: return r.password ? 1 : 0;
      default: return 0;
    }
  }
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let browserPositioned = false;
  function centerBrowser() {
    const dlg = document.querySelector('#browser .dialog');
    dlg.style.left = Math.max(0, (window.innerWidth - dlg.offsetWidth) / 2) + 'px';
    dlg.style.top = Math.max(0, (window.innerHeight - dlg.offsetHeight) / 2) + 'px';
  }
  // Clamp the dialog fully inside the window (after a window resize, or if it was resized/moved out).
  function clampBrowser() {
    const dlg = document.querySelector('#browser .dialog');
    if (!dlg || $('browser').classList.contains('hidden')) return;
    const maxX = Math.max(0, window.innerWidth - dlg.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - dlg.offsetHeight);
    dlg.style.left = Math.min(maxX, Math.max(0, parseFloat(dlg.style.left) || 0)) + 'px';
    dlg.style.top = Math.min(maxY, Math.max(0, parseFloat(dlg.style.top) || 0)) + 'px';
  }
  function openBrowser() {
    $('browser').classList.remove('hidden');
    if (!browserPositioned) { centerBrowser(); browserPositioned = true; }
    if (!browserRows.length) refreshBrowser();
    $('browser-search').focus();
  }
  // Drag the window by its title bar (left mouse). resize:both in CSS handles resizing.
  (() => {
    const dlg = document.querySelector('#browser .dialog');
    const bar = dlg.querySelector('.panel-title.dlg');
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.panel-btns')) return;   // the ✕ button, not a drag
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = dlg.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // Keep the whole dialog inside the app window: right/bottom edges may not pass the window edges.
      const maxX = Math.max(0, window.innerWidth - dlg.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - dlg.offsetHeight);
      dlg.style.left = Math.min(maxX, Math.max(0, ox + e.clientX - sx)) + 'px';
      dlg.style.top = Math.min(maxY, Math.max(0, oy + e.clientY - sy)) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();
  window.addEventListener('resize', clampBrowser);   // keep it in bounds if the app window shrinks
  // Resizable table columns: a grabber on each header's right edge, drag to set width (min 40px).
  (() => {
    const ths = [...document.querySelectorAll('#browser .browsertbl thead th')];
    ths.forEach((th, i) => {
      // Click the header (not its resize grabber) to sort by that column; click again to flip asc/desc.
      th.style.cursor = 'pointer';
      th.addEventListener('click', (e) => {
        if (e.target.classList.contains('col-resizer')) return;
        browserSort = browserSort.i === i ? { i, dir: -browserSort.dir } : { i, dir: i >= 2 && i <= 3 ? -1 : 1 };
        ths.forEach((t) => t.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(browserSort.dir > 0 ? 'sort-asc' : 'sort-desc');
        renderBrowser();
      });
      if (i === ths.length - 1) return;   // last column takes the remaining space, no resizer
      const rz = document.createElement('div');
      rz.className = 'col-resizer';
      th.appendChild(rz);
      rz.addEventListener('mousedown', (e) => {
        const sx = e.clientX, sw = th.offsetWidth;
        const move = (ev) => { th.style.width = Math.max(40, sw + ev.clientX - sx) + 'px'; };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        e.preventDefault(); e.stopPropagation();
      });
    });
  })();
  function closeBrowser() { browserGen++; $('browser').classList.add('hidden'); }   // bump gen to cancel in-flight queries
  function setBrowserStatus(text) { const el = $('browser-status'); el.textContent = text; el.title = text; }   // title = full-text tooltip when clipped

  async function refreshBrowser() {
    const gen = ++browserGen;
    browserSel = null; $('browser-connect').disabled = true; $('browser-refresh').disabled = true;
    setBrowserStatus(t('browser.loading'));
    const res = await window.kfbot.serverList();
    if (gen !== browserGen) return;
    browserRows = (res.servers || []).map((s) => ({ ...s }));
    const c = res.counts || {};
    const src = c.cached ? t('browser.srcCached', { n: c.cached }) : c.seed ? t('browser.srcSeed', { n: c.seed })
      : t('browser.srcLive', { s: c.steam || 0, g: c.gametracker || 0 });
    setBrowserStatus(t('browser.count', { n: browserRows.length, src }) + (res.errors && res.errors.length ? ' — ' + res.errors.join('; ') : ''));
    renderBrowser();
    $('browser-refresh').disabled = false;
    queryAll(gen);
  }

  function renderBrowser() {
    const q = $('browser-search').value.trim().toLowerCase();
    let rows = browserRows;
    if (q) rows = rows.filter((r) => (r.name + ' ' + r.connect + ' ' + (r.map || '')).toLowerCase().indexOf(q) >= 0);
    rows = rows.slice().sort((a, b) => { const va = sortVal(a, browserSort.i), vb = sortVal(b, browserSort.i); return (va < vb ? -1 : va > vb ? 1 : 0) * browserSort.dir; });
    $('browser-body').innerHTML = rows.map((r) => {
      const list = (r.players_list && r.players_list.length) ? r.players_list.join(', ') : '';
      const num = (r.players != null ? r.players : '?') + '/' + (r.maxPlayers != null ? r.maxPlayers : '?');
      const ping = r.ping != null ? r.ping + 'ms' : (r.pingFailed ? '—' : '…');
      const sel = r.connect === browserSel ? ' class="sel"' : '';
      return '<tr data-addr="' + escHtml(r.connect) + '"' + sel + '>' +
        '<td class="c-ip">' + escHtml(r.connect) + '</td>' +
        '<td class="c-name" title="' + escHtml(r.name) + '">' + escHtml(r.name) + '</td>' +
        '<td class="c-num">' + escHtml(num) + '</td>' +
        '<td class="c-list" title="' + escHtml(list) + '">' + escHtml(list) + '</td>' +
        '<td class="c-wave">' + escHtml(r.wave || '—') + '</td>' +
        '<td class="c-ping">' + escHtml(ping) + '</td>' +
        '<td class="c-pw" title="' + (r.password ? 'Password protected' : '') + '">' + (r.password ? '🔒' : '') + '</td></tr>';
    }).join('');
  }
  function scheduleRender() { if (browserRenderTimer) return; browserRenderTimer = setTimeout(() => { browserRenderTimer = null; renderBrowser(); }, 250); }

  // Query every server for live ping/players/wave (bounded concurrency), guarded by the refresh generation.
  async function queryAll(gen) {
    const targets = browserRows.slice();
    let idx = 0;
    async function worker() {
      while (idx < targets.length && gen === browserGen) {
        const r = targets[idx++];
        const q = await window.kfbot.serverQuery(r.ip, r.queryPort, r.gamePort);
        if (gen !== browserGen) return;
        if (q) {
          r.ping = q.ping; r.players = q.numPlayers; r.maxPlayers = q.maxPlayers; r.players_list = q.players_list;
          if (q.password != null) r.password = !!q.password;
          if (q.wave) r.wave = q.wave; if (q.map) r.map = q.map;
          if (q.gamePort) r.connect = r.ip + ':' + q.gamePort;
        } else r.pingFailed = true;
        scheduleRender();
      }
    }
    await Promise.all(Array.from({ length: 24 }, worker));
    if (gen === browserGen) { renderBrowser(); setBrowserStatus(t('browser.online', { online: browserRows.filter((r) => r.ping != null).length, total: browserRows.length })); }
  }

  function browserConnect() { if (!browserSel) return; $('f-server').value = browserSel; closeBrowser(); doStart(); }
  $('browser-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    browserSel = tr.dataset.addr; $('browser-connect').disabled = false;
    $('browser-body').querySelectorAll('tr').forEach((x) => x.classList.toggle('sel', x.dataset.addr === browserSel));
  });
  $('browser-body').addEventListener('dblclick', () => { if (browserSel) browserConnect(); });
  $('browser-connect').addEventListener('click', browserConnect);
  $('browser-refresh').addEventListener('click', refreshBrowser);
  $('browser-close').addEventListener('click', closeBrowser);
  $('browser-x').addEventListener('click', closeBrowser);
  $('browser').addEventListener('click', (e) => { if (e.target.id === 'browser') closeBrowser(); });
  $('browser-search').addEventListener('input', renderBrowser);
  $('f-steamKey').addEventListener('change', () => window.kfbot.setSteamKey($('f-steamKey').value.trim()));

  // ---- debug snapshot (autotest/diagnostics): read-only view of the live render state, so a headless
  // probe can assert on dot positions/types the way the eye reads the map. No effect on normal operation.
  window.__kfdebug = () => ({
    running, selfAlive, selfPositioned, curName, curMap, mapReady,
    mapScale, camX: Math.round(camX), camY: Math.round(camY),
    bg: mapBg ? mapBg.bounds : null,
    objs: [...mapStore.entries()].map(([ch, e]) => ({
      ch, type: e.type, name: e.name || null, hp: e.hp != null ? e.hp : null,
      x: Math.round(e.x), y: Math.round(e.y), tx: Math.round(e.tx), ty: Math.round(e.ty),
    })),
  });

  // ---- init ----
  refreshHistLists(); resetStats(); reflectMode(); setRunning(false); sizeMap();
})();
