// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Electron main process. Owns the window and a single forked "runner" child that
 * hosts a BotSession (one bot for v1). Acts purely as an IPC bridge:
 *   renderer --(ipcMain)--> main --(child.send)--> runner --> BotSession command
 *   BotSession event --> runner (process.send) --> main --> webContents.send --> renderer
 *
 * The bot runs in a forked child for crash isolation (it parses untrusted UDP from
 * a game server) and because that is the same shape a future multi-bot version uses.
 * The runner is plain Node (dgram, no Electron), so it is forked with
 * ELECTRON_RUN_AS_NODE=1 to run under Electron's bundled Node.
 */
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---- Virtual Map background: render the connected server's map top-down (cached) ----
// Writable data (settings.ini, cache/) lives next to the program. For a portable build process.execPath is a
// temp extraction dir, so honor PORTABLE_EXECUTABLE_DIR (the real exe folder) to keep the ini/cache.
function appDir() {
  if (!app.isPackaged) return app.getAppPath();
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}
function mapCacheDir() { return path.join(appDir(), 'cache', 'maps'); }
function renderMapBackground(payload) {
  try {
    const { mapName, systemDir } = payload || {};
    if (!mapName) return;
    const { findMapRom, renderTopDown } = require('./lib/maprender');
    const rom = findMapRom(mapName, systemDir);
    if (!rom) { toRenderer('mapImage', { mapName, image: null, reason: 'no local .rom (not downloaded)' }); return; }
    const size = fs.statSync(rom).size;
    // unchanged map (same size) => reuse cache; -v2 = renderer generation (meshes/terrain/hillshade)
    const key = mapName.replace(/[^\w.-]/g, '_') + '-' + size + '-v2';
    const dir = mapCacheDir(); fs.mkdirSync(dir, { recursive: true });
    const jpg = path.join(dir, key + '.jpg'), meta = path.join(dir, key + '.json');
    if (fs.existsSync(jpg) && fs.existsSync(meta)) {
      const bounds = JSON.parse(fs.readFileSync(meta, 'utf8'));
      toRenderer('mapImage', { mapName, image: 'data:image/jpeg;base64,' + fs.readFileSync(jpg).toString('base64'), bounds, cached: true });
      return;
    }
    const r = renderTopDown(rom, 2048, systemDir);
    if (!r) { toRenderer('mapImage', { mapName, image: null, reason: 'map parse failed' }); return; }
    const jpeg = nativeImage.createFromBuffer(r.png).toJPEG(90);
    fs.writeFileSync(jpg, jpeg); fs.writeFileSync(meta, JSON.stringify(r.bounds));
    toRenderer('mapImage', { mapName, image: 'data:image/jpeg;base64,' + jpeg.toString('base64'), bounds: r.bounds });
  } catch (e) { toRenderer('mapImage', { image: null, reason: 'render error: ' + (e && e.message || e) }); }
}

// ---- HOST/CHAR history in a plain ini next to the program (L2Walker-style) ----
// Dropdowns are filled from it; every successful Login appends the server+name.
function iniPath() { return path.join(appDir(), 'settings.ini'); }
function readHistory() {
  const out = { servers: [], names: [], steamKey: '', lang: '' };
  try {
    let sec = null;
    for (const line of fs.readFileSync(iniPath(), 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s[0] === ';') continue;
      const sm = /^\[(.+)\]$/.exec(s);
      if (sm) { sec = sm[1].toLowerCase(); continue; }
      const eq = s.indexOf('=');
      if (eq < 0 || !sec) continue;
      const key = s.slice(0, eq).trim().toLowerCase();
      const val = s.slice(eq + 1).trim();
      if (val && (sec === 'servers' || sec === 'names')) out[sec].push(val);
      else if (sec === 'steam' && key === 'webapikey') out.steamKey = val;
      else if (sec === 'ui' && key === 'language') out.lang = val;
    }
  } catch (e) { /* no ini yet */ }
  return out;
}
function writeHistory(h) {
  const lines = ['; Killing Floor Bot Client — settings, saved next to the program', '', '[servers]'];
  h.servers.forEach((v, i) => lines.push((i + 1) + '=' + v));
  lines.push('', '[names]');
  h.names.forEach((v, i) => lines.push((i + 1) + '=' + v));
  lines.push('', '[steam]',
    '; Free Steam Web API key for the Server Browser master list — get one at https://steamcommunity.com/dev/apikey',
    'webApiKey=' + (h.steamKey || ''));
  lines.push('', '[ui]',
    '; Interface language: en ru es pt lt pl fr zh ja (blank = English)',
    'language=' + (h.lang || ''));
  try { fs.writeFileSync(iniPath(), lines.join('\r\n') + '\r\n', 'utf8'); } catch (e) { /* ignore */ }
}
// Create the ini next to the exe on first run so the key field is discoverable (edit it by hand or in Setup->Steam).
function ensureIni() { try { if (!fs.existsSync(iniPath())) writeHistory({ servers: [], names: [], steamKey: '' }); } catch (e) { /* ignore */ } }
function addHistory(server, name) {
  const h = readHistory();
  const push = (arr, v) => { v = String(v || '').trim(); return v ? [v, ...arr.filter((x) => x !== v)].slice(0, 20) : arr; };
  h.servers = push(h.servers, server);
  h.names = push(h.names, name);
  writeHistory(h);
  return h;
}
ipcMain.handle('bot:history:get', () => readHistory());
ipcMain.handle('bot:history:add', (_e, a) => addHistory(a && a.server, a && a.name));
ipcMain.handle('bot:steam:setkey', (_e, key) => { const h = readHistory(); h.steamKey = String(key || '').trim(); writeHistory(h); return h.steamKey; });
ipcMain.handle('bot:lang:set', (_e, lang) => { const h = readHistory(); h.lang = String(lang || '').trim(); writeHistory(h); return h.lang; });

// ---- Server Browser: Steam master list + GameTracker overlay, and per-server A2S live query ----
// The Steam Web API is rate-limited (~1/min) and needs a key; when a fetch comes back empty we fall back to
// the last good list cached on disk. That list is just IP+name - the renderer re-runs A2S on it, so ping /
// players / wave come back live even off a day-old cache. Servers rarely change address.
function serverCachePath() { return path.join(appDir(), 'cache', 'serverlist.json'); }
function seedListPath() { return path.join(app.getAppPath(), 'assets', 'serverlist.json'); }   // bundled (read-only, in the asar)
ipcMain.handle('browser:list', async () => {
  const cacheFile = serverCachePath();
  let res;
  try { const { fetchServers } = require('./lib/serverbrowser'); res = await fetchServers({ steamKey: readHistory().steamKey }); }
  catch (e) { res = { servers: [], errors: ['list failed: ' + (e && e.message || e)], counts: {} }; }
  if ((res.counts && res.counts.steam) > 0) {
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), servers: res.servers })); } catch (e) { /* ignore */ }
    return res;
  }
  // No fresh Steam data (no key / rate-limited). Fall back to the last good on-disk cache, then to the
  // seed list bundled with the app so even a first run with no key shows servers (re-queried live via A2S).
  const why = readHistory().steamKey ? 'Steam rate-limited, retry in ~1 min' : 'add a Steam Web API key (Setup→Steam) for a live list';
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.servers && cached.servers.length) {
      const ageMin = Math.round((Date.now() - cached.at) / 60000);
      return { servers: cached.servers, errors: [...(res.errors || []), 'cached list (' + ageMin + ' min old) — ' + why], counts: { steam: 0, gametracker: (res.counts && res.counts.gametracker) || 0, cached: cached.servers.length } };
    }
  } catch (e) { /* no cache yet */ }
  try {
    const seed = JSON.parse(fs.readFileSync(seedListPath(), 'utf8'));
    if (seed.servers && seed.servers.length) {
      return { servers: seed.servers, errors: [...(res.errors || []), 'bundled seed list — ' + why], counts: { steam: 0, gametracker: (res.counts && res.counts.gametracker) || 0, seed: seed.servers.length } };
    }
  } catch (e) { /* no seed bundled */ }
  return res;
});
ipcMain.handle('browser:query', async (_e, a) => {
  if (!a || !a.ip) return null;
  try { const { queryServer } = require('./lib/serverbrowser'); return await queryServer(a.ip, a.queryPort, a.gamePort); }
  catch (e) { return null; }
});

let win = null;
let child = null;

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 640,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#d4d0c8',
    icon: path.join(__dirname, 'build', 'icon.png'),
    frame: false,                 // frameless: the renderer draws its own title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Custom title-bar window controls (frameless) + keep the maximize glyph in sync.
  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:maximize', () => { win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on('win:close', () => win.close());
  const sendMax = () => win.webContents.send('win:maximized', win.isMaximized());
  win.on('maximize', sendMax); win.on('unmaximize', sendMax);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Smoke-boot hook: set KF_GUI_SMOKE=<ms> to auto-quit after load and surface
  // any renderer warnings/errors. Used for headless CI/boot verification.
  if (process.env.KF_GUI_SMOKE) {
    const ms = parseInt(process.env.KF_GUI_SMOKE, 10) || 3000;
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.error('[renderer] ' + message);
    });
    win.webContents.on('did-finish-load', () => {
      console.log('[smoke] window loaded ok');
      // Optional: open the Server Browser and capture it once servers load (browser test).
      if (process.env.KF_GUI_BROWSER) {
        win.webContents.executeJavaScript("document.querySelector('.menu.mbtn').click(); 'opened server browser'")
          .then((r) => console.log('[autotest] ' + r)).catch((e) => console.error('[autotest] ' + e));
        setTimeout(async () => {
          try {
            const rows = await win.webContents.executeJavaScript("({rows: document.querySelectorAll('#browser-body tr').length, status: document.getElementById('browser-status').textContent})");
            console.log('[autotest] browser rows=' + rows.rows + ' status="' + rows.status + '"');
            if (process.env.KF_GUI_CAPTURE) { fs.writeFileSync(process.env.KF_GUI_CAPTURE, (await win.webContents.capturePage()).toPNG()); console.log('[autotest] captured ' + process.env.KF_GUI_CAPTURE); }
            // Verify Connect wiring: select the first row, click Connect, confirm it fills the server field + closes.
            const conn = await win.webContents.executeJavaScript(
              "(()=>{const s=window.kfbot.start;window.kfbot.start=()=>{};const tr=document.querySelector('#browser-body tr');const addr=tr.dataset.addr;tr.click();document.getElementById('browser-connect').click();const r={addr,fserver:document.getElementById('f-server').value,hidden:document.getElementById('browser').classList.contains('hidden')};window.kfbot.start=s;return JSON.stringify(r);})()");
            console.log('[autotest] connect-wiring ' + conn);
            const drag = await win.webContents.executeJavaScript(
              "(()=>{document.querySelector('.menu.mbtn').click();const dlg=document.querySelector('#browser .dialog');const bar=dlg.querySelector('.panel-title.dlg');const rc=bar.getBoundingClientRect();const x=rc.left+40,y=rc.top+8;bar.dispatchEvent(new MouseEvent('mousedown',{button:0,clientX:x,clientY:y,bubbles:true}));window.dispatchEvent(new MouseEvent('mousemove',{clientX:x+5000,clientY:y+5000,bubbles:true}));window.dispatchEvent(new MouseEvent('mouseup',{button:0,clientX:x+5000,clientY:y+5000,bubbles:true}));const b=dlg.getBoundingClientRect();return JSON.stringify({right:Math.round(b.right),bottom:Math.round(b.bottom),winW:window.innerWidth,winH:window.innerHeight,inBounds:b.right<=window.innerWidth+1&&b.bottom<=window.innerHeight+1&&b.left>=-1&&b.top>=-1,resize:getComputedStyle(dlg).resize});})()");
            console.log('[autotest] browser-drag ' + drag);
            const extra = await win.webContents.executeJavaScript(
              "(()=>{const $=id=>document.getElementById(id);$('f-randomId').checked=true;$('f-randomId').dispatchEvent(new Event('change'));const sid=$('f-steamid').value;const th=document.querySelector('#browser .browsertbl thead th');const rz=th.querySelector('.col-resizer');const w0=th.offsetWidth;const r=rz.getBoundingClientRect();const x=r.left+3,y=r.top+5;rz.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:y,bubbles:true}));document.dispatchEvent(new MouseEvent('mousemove',{clientX:x+70,clientY:y,bubbles:true}));document.dispatchEvent(new MouseEvent('mouseup',{clientX:x+70,clientY:y,bubbles:true}));return JSON.stringify({randomSteamId:sid,validId:/^7656119\\d{10}$/.test(sid),idReadonly:$('f-steamid').readOnly,colW0:w0,colW1:th.offsetWidth,colGrew:th.offsetWidth>w0});})()");
            console.log('[autotest] extras ' + extra);
          } catch (e) { console.error('[autotest browser] ' + e); }
          app.quit();
        }, ms);
        return;
      }
      // Optional: verify mouse-wheel zoom on the Virtual Map changes the scale.
      if (process.env.KF_GUI_WHEEL) {
        win.webContents.executeJavaScript(
          "(()=>{const m=document.getElementById('map');const sc=()=>document.getElementById('m-scaleval').textContent;const start=sc();for(let i=0;i<4;i++)m.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));const out=sc();for(let i=0;i<8;i++)m.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true}));const inn=sc();return JSON.stringify({start,afterZoomOut:out,afterZoomIn:inn,sliderMatches:document.getElementById('m-scale').value==='1'===false?document.getElementById('m-scale').value:document.getElementById('m-scale').value});})()"
        ).then((r) => console.log('[autotest] wheel ' + r)).catch((e) => console.error('[autotest] ' + e));
        setTimeout(() => app.quit(), ms);
        return;
      }
      // Optional: feed captured/synthetic bot events into the renderer (no live connect) and screenshot -
      // a headless visual check for map scale / labels when a live GUI can't reach spawn on heavy servers.
      if (process.env.KF_GUI_INJECT) {
        let events = [];
        try { events = JSON.parse(fs.readFileSync(process.env.KF_GUI_INJECT, 'utf8')); } catch (e) { console.error('[inject] bad json: ' + e.message); }
        win.webContents.executeJavaScript(
          "(()=>{const evs=" + JSON.stringify(events) + ";for(const e of evs){try{window.__kfinject(e);}catch(x){}}return JSON.stringify(window.__kfdebug?{scale:__kfdebug().mapScale,dots:__kfdebug().objs.length,alive:__kfdebug().selfAlive,pos:__kfdebug().selfPositioned}:{});})()"
        ).then((r) => console.log('[autotest] inject ' + r)).catch((e) => console.error('[autotest inject] ' + e));
        setTimeout(async () => {
          try {
            if (process.env.KF_GUI_PROBE) console.log('[autotest] probe ' + await win.webContents.executeJavaScript(process.env.KF_GUI_PROBE));
            if (process.env.KF_GUI_CAPTURE) { fs.writeFileSync(process.env.KF_GUI_CAPTURE, (await win.webContents.capturePage()).toPNG()); console.log('[autotest] captured ' + process.env.KF_GUI_CAPTURE); }
          } catch (e) { console.error('[autotest inject cap] ' + e); }
          app.quit();
        }, ms);
        return;
      }
      // Optional: assert every UI requirement in one shot (final check-list).
      if (process.env.KF_GUI_VERIFY) {
        win.webContents.executeJavaScript(
          "(()=>{const $=id=>document.getElementById(id);const labs=[...document.querySelectorAll('.tb-lab')].map(l=>l.textContent.trim());return JSON.stringify({" +
          "pkgDownloadDefaultOn:$('f-pkgDownload').checked," +
          "cancelBtnRemoved:!$('btn-cancel'),forceatkBtnRemoved:!$('btn-forceatk')," +
          "downloadProgressBar:!!$('dl-fill')&&!!$('dl-text')," +
          "dlWrapHiddenInit:$('dl-wrap').classList.contains('hidden')," +
          "noCombatTab:!document.querySelector('[data-tab=\\\"combat\\\"],[data-page=\\\"combat\\\"],#combat-view')," +
          "ipLabel:labs.includes('IP'),idLabelNoColon:labs.includes('ID')&&!labs.includes('ID:')," +
          "scaleBounds:$('m-scale').min==='0.25'&&$('m-scale').max==='50'," +
          "serverBrowserMenu:!!document.querySelector('.menu.mbtn')&&document.querySelector('.menu.mbtn').textContent.includes('Server')," +
          "steamKeyLoadedFromIni:$('f-steamKey').value.length>10," +
          "pkgDownloadOnConnTab:!!$('f-pkgDownload').closest('[data-page=\\\"conn\\\"]')," +
          "mapCanvas:!!$('map')," +
          "connectBtn:$('btn-login').textContent==='Connect',disconnectBtn:$('btn-logout').textContent==='Disconnect'," +
          "restartBtnEnabled:!!$('btn-restart')&&!$('btn-restart').disabled," +
          "leaveBtnRemoved:!$('btn-leave'),enableBtnRemoved:!$('btn-enable'),lampRemoved:!$('lamp')," +
          "browserDraggableResizable:getComputedStyle(document.querySelector('#browser .dialog')).resize==='both'," +
          "toolbarButtonsFitText:[...document.querySelectorAll('#toolbar button')].every(b=>b.scrollWidth<=b.clientWidth+1&&b.offsetWidth>=52)," +
          "charDefaultKFPlayer:$('f-name').value==='KFPlayer'," +
          "randomIdCheckbox:!!$('f-randomId')," +
          "colResizers:document.querySelectorAll('#browser .browsertbl thead th .col-resizer').length>=5," +
          "noCombatRangeRow:!$('m-range')&&!$('m-zval')," +
          "charMapField:!!$('st-map')," +
          "realMapText:$('m-realmap').parentElement.textContent.trim()==='Real Map'&&$('m-realmap').checked," +
          "pluralLabels:$('m-mon').parentElement.textContent.trim()==='Monsters'&&$('m-trader').parentElement.textContent.trim()==='Traders'&&$('m-door').parentElement.textContent.trim()==='Doors'" +
          "});})()"
        ).then((r) => console.log('[autotest] verify ' + r)).catch((e) => console.error('[autotest] ' + e));
        setTimeout(() => app.quit(), ms);
        return;
      }
      // Optional: simulate a resource-download 'connecting' event to verify the progress bar + map gate.
      if (process.env.KF_GUI_DLSIM) {
        win.webContents.send('bot:event', { name: 'connecting', payload: { stage: 'downloading', progress: { name: 'KFMod.u', bytes: 1998000, size: 4242262, pct: 47 } } });
        setTimeout(async () => {
          try {
            const dl = await win.webContents.executeJavaScript("({wrapHidden: document.getElementById('dl-wrap').classList.contains('hidden'), fill: document.getElementById('dl-fill').style.width, text: document.getElementById('dl-text').textContent, title: document.title})");
            console.log('[autotest] dl-bar hidden=' + dl.wrapHidden + ' fill=' + dl.fill + ' text="' + dl.text + '" title="' + dl.title + '"');
            if (process.env.KF_GUI_CAPTURE) { fs.writeFileSync(process.env.KF_GUI_CAPTURE, (await win.webContents.capturePage()).toPNG()); console.log('[autotest] captured ' + process.env.KF_GUI_CAPTURE); }
          } catch (e) { console.error('[autotest dlsim] ' + e); }
          app.quit();
        }, ms);
        return;
      }
      // Optional: auto-connect to KF_GUI_AUTOCONNECT and capture the window to KF_GUI_CAPTURE (map test).
      if (process.env.KF_GUI_AUTOCONNECT) {
        const srv = process.env.KF_GUI_AUTOCONNECT;
        win.webContents.executeJavaScript(
          "(()=>{const $=id=>document.getElementById(id);$('f-server').value=" + JSON.stringify(srv) + ";$('f-realSteam').checked=" + (process.env.KF_GUI_REALSTEAM ? 'true' : 'false') + ";$('f-ready').checked=" + (process.env.KF_GUI_READY ? 'true' : 'false') + ";" + (process.env.KF_GUI_NODL ? "$('f-pkgDownload').checked=false;" : "") + "$('btn-login').click();return 'connecting to '+" + JSON.stringify(srv) + ";})()"
        ).then((r) => console.log('[autotest] ' + r)).catch((e) => console.error('[autotest] ' + e));
        // Optional: periodically dump the renderer's live state to a file (Electron stdout doesn't flush on
        // Windows) so a headless run can see WHERE a heavy eu connect gets stuck (download / admitted / ready
        // / spawn) and confirm the full live loop reaches the map with dots.
        if (process.env.KF_GUI_STATEDUMP) {
          const sd = setInterval(async () => {
            try {
              const s = await win.webContents.executeJavaScript("(window.__kfdebug?JSON.stringify({t:Date.now(),ready:__kfdebug().mapReady,alive:__kfdebug().selfAlive,pos:__kfdebug().selfPositioned,scale:__kfdebug().mapScale,map:__kfdebug().curMap,x:__kfdebug().camX,y:__kfdebug().camY,dots:__kfdebug().objs.length,pl:__kfdebug().objs.filter(o=>o.type==='player').length,mo:__kfdebug().objs.filter(o=>o.type==='mon').length,named:__kfdebug().objs.filter(o=>o.name).length,state:document.getElementById('sb-state').textContent}):'{}')");
              fs.appendFileSync(process.env.KF_GUI_STATEDUMP, s + '\n');
            } catch (e) { /* window busy */ }
          }, 4000);
          setTimeout(() => clearInterval(sd), ms - 1000);
        }
        // Optional: once we're "Playing" (spawned+positioned), left-click the map ~150px from centre to Move-to
        // that world point - proves the green self dot walks (server-agnostic moveto) in the real GUI.
        // KF_GUI_MOVEXY="x,y" = issue a direct move command to an ABSOLUTE world point once alive, bypassing
        // the map click/camera - used to probe (via the local server's GT log) whether a server applies our
        // ServerMove InAccel at all, independent of whether the self dot renders.
        if (process.env.KF_GUI_MOVEXY) {
          const mm = /^(-?\d+),(-?\d+)$/.exec(process.env.KF_GUI_MOVEXY);
          const tx = mm ? +mm[1] : 0, ty = mm ? +mm[2] : 0;
          let issued = false;
          const mvx = setInterval(async () => {
            if (issued) return;
            const alive = await win.webContents.executeJavaScript("(window.__kfdebug?__kfdebug().selfAlive:false)").catch(() => false);
            if (!alive) return;
            await win.webContents.executeJavaScript("window.kfbot.cmd({cmd:'move',x:" + tx + ",y:" + ty + "});'moved'").catch(() => {});
            issued = true; console.log('[autotest] direct move issued to (' + tx + ',' + ty + ')');
          }, 700);
          setTimeout(() => clearInterval(mvx), ms - 2000);
        }
        if (process.env.KF_GUI_MOVE) {
          // KF_GUI_MOVE="dx,dy" = px offset from the map centre (default 150,-90). Clicks ONCE, but only
          // after the self dot has been "Playing" for KF_GUI_MOVE_DELAY ms (default 9s) so the position
          // has settled from spawn - clicking the instant we spawn captures a stale, pre-correction camera.
          const m = /^(-?\d+),(-?\d+)$/.exec(process.env.KF_GUI_MOVE);
          const dx = m ? +m[1] : 150, dy = m ? +m[2] : -90;
          const settle = parseInt(process.env.KF_GUI_MOVE_DELAY, 10) || 9000;
          let clicked = false, positionedSince = 0;
          const mv = setInterval(async () => {
            if (clicked) return;
            // Click only once the self dot is actually POSITIONED (server corrections arrived) - otherwise the
            // camera is still at the origin and the click computes a garbage far/off-map target. Mirrors a
            // real user waiting until they can see their dot before clicking a nearby point.
            const d = await win.webContents.executeJavaScript("(window.__kfdebug?JSON.stringify({p:__kfdebug().selfPositioned,x:__kfdebug().camX,y:__kfdebug().camY}):'null')").then((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).catch(() => null);
            if (!d || !d.p || (d.x === 0 && d.y === 0)) { positionedSince = 0; return; }
            if (!positionedSince) { positionedSince = Date.now(); return; }
            if (Date.now() - positionedSince < settle) return;
            await win.webContents.executeJavaScript(
              "(()=>{const c=document.getElementById('map');const b=c.getBoundingClientRect();const x=b.left+b.width/2+" + dx + ",y=b.top+b.height/2+" + dy + ";c.dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,bubbles:true}));})()"
            ).catch(() => {});
            clicked = true; console.log('[autotest] move-to click issued (settled)');
          }, 900);
          setTimeout(() => clearInterval(mv), ms - 2000);
        }
        if (process.env.KF_GUI_MOVENAV) {
          // Persistent move test: re-issue a REACHABLE-node move whenever we're alive+positioned, every ~12s.
          // A blind px click lands on arbitrary terrain (reads "didn't arrive" even when move-to works), and a
          // single early move misses servers with a deferred first spawn (timer/wave-boundary start) or rapid
          // auto-respawn - a real player keeps moving, so the test must too, re-anchoring after each respawn.
          let lastIssue = 0, posSince = 0;
          const settle = parseInt(process.env.KF_GUI_MOVE_DELAY, 10) || 5000;
          const nav = setInterval(async () => {
            const d = await win.webContents.executeJavaScript("(window.__kfdebug?JSON.stringify({p:__kfdebug().selfPositioned,a:__kfdebug().selfAlive}):'null')").then((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).catch(() => null);
            if (!d || !d.a || !d.p) { posSince = 0; return; }   // not alive/positioned (or just died) - wait for (re)spawn
            if (!posSince) { posSince = Date.now(); return; }    // freshly alive - let the position settle first
            if (Date.now() - posSince < settle || Date.now() - lastIssue < 12000) return;
            await win.webContents.executeJavaScript("window.kfbot.cmd({cmd:'movenav'});'nav'").catch(() => {});
            lastIssue = Date.now(); console.log('[autotest] movenav issued (reachable node)');
          }, 1000);
          setTimeout(() => clearInterval(nav), ms - 2000);
        }
        setTimeout(async () => {
          try {
            const mons = await win.webContents.executeJavaScript(
              "(()=>{const c=document.getElementById('cnt-monsters');const rows=[...document.querySelectorAll('#monsters-body tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim());return JSON.stringify({count:c?c.textContent:'?',rows:rows.slice(0,6)});})()").catch(() => '');
            console.log('[autotest] monsters ' + mons);
            if (process.env.KF_GUI_PAN) {   // simulate a right-mouse drag to verify the Virtual Map pans
              const r = await win.webContents.executeJavaScript(
                "(()=>{const c=document.getElementById('map');const b=c.getBoundingClientRect();const x=b.left+b.width/2,y=b.top+b.height/2;c.dispatchEvent(new MouseEvent('mousedown',{button:2,clientX:x,clientY:y,bubbles:true}));window.dispatchEvent(new MouseEvent('mousemove',{clientX:x+130,clientY:y+80,bubbles:true}));window.dispatchEvent(new MouseEvent('mouseup',{button:2,clientX:x+130,clientY:y+80,bubbles:true}));return 'right-drag +130,+80';})()");
              console.log('[autotest] pan ' + r);
            }
            console.log('[autotest] window title="' + (await win.webContents.executeJavaScript('document.title')) + '"');
            const world = await win.webContents.executeJavaScript(
              "(()=>{const rows=[...document.querySelectorAll('#items-body tr')].map(r=>r.textContent);const bad=rows.filter(t=>/Trader:|Door:|ShopVolume|KFDoorMover|KFTraderDoor/.test(t));return JSON.stringify({map:document.getElementById('st-map').textContent,itemsCount:rows.length,traderDoorInItems:bad.length,sampleItems:rows.slice(0,4)});})()");
            console.log('[autotest] world ' + world);
            if (process.env.KF_GUI_PROBE) {
              try { console.log('[autotest] probe ' + await win.webContents.executeJavaScript(process.env.KF_GUI_PROBE)); }
              catch (e) { console.error('[autotest probe] ' + e); }
            }
            // Optional: zoom in + hide the Items layer so the door (pink) / mover (cyan) strips read clearly.
            if (process.env.KF_GUI_MAPVIEW) {
              await win.webContents.executeJavaScript(
                "(()=>{const $=id=>document.getElementById(id);$('m-item').checked=false;$('m-item').dispatchEvent(new Event('change'));const s=$('m-scale');s.value='" + (process.env.KF_GUI_MAPVIEW) + "';s.dispatchEvent(new Event('input'));return 'mapview set';})()"
              ).catch(() => {});
              await new Promise((r) => setTimeout(r, 500));
            }
            const img = await win.webContents.capturePage();
            if (process.env.KF_GUI_CAPTURE) { fs.writeFileSync(process.env.KF_GUI_CAPTURE, img.toPNG()); console.log('[autotest] captured ' + process.env.KF_GUI_CAPTURE); }
          } catch (e) { console.error('[autotest capture] ' + e); }
          app.quit();
        }, ms);
        return;
      }
      setTimeout(async () => {
        // KF_GUI_PROBE=<js> - evaluate an expression in the page and log it (DOM/geometry checks).
        if (process.env.KF_GUI_PROBE) {
          try { console.log('[autotest] probe ' + await win.webContents.executeJavaScript(process.env.KF_GUI_PROBE)); }
          catch (e) { console.error('[autotest probe] ' + e); }
        }
        try { if (process.env.KF_GUI_CAPTURE) { fs.writeFileSync(process.env.KF_GUI_CAPTURE, (await win.webContents.capturePage()).toPNG()); console.log('[autotest] captured ' + process.env.KF_GUI_CAPTURE); } } catch (e) { /* ignore */ }
        app.quit();
      }, ms);
    });
  }
}

function toRenderer(name, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('bot:event', { name, payload });
}

function stopChild() {
  if (child) {
    try { child.removeAllListeners(); child.kill(); } catch (e) { /* ignore */ }
    child = null;
  }
}

ipcMain.on('bot:start', (_e, cfg) => {
  stopChild();
  child = fork(path.join(__dirname, 'runner.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', (m) => {
    if (!m || m.type !== 'event') return;
    if (m.name === 'map') { renderMapBackground(m.payload); return; }   // build the top-down background here (fs + nativeImage)
    toRenderer(m.name, m.payload);
  });
  if (child.stdout) child.stdout.on('data', (d) => toRenderer('log', String(d).replace(/\r?\n$/, '')));
  if (child.stderr) child.stderr.on('data', (d) => toRenderer('log', '[stderr] ' + String(d).replace(/\r?\n$/, '')));
  child.on('exit', (code) => { toRenderer('exit', { code }); child = null; });
  child.send({ type: 'start', config: cfg });
});

ipcMain.on('bot:stop', () => { if (child) child.send({ type: 'cmd', cmd: 'stop' }); });
ipcMain.on('bot:cmd', (_e, cmd) => {
  if (!child) return;
  child.send(typeof cmd === 'object' ? { type: 'cmd', ...cmd } : { type: 'cmd', cmd });
});

app.whenReady().then(() => { ensureIni(); createWindow(); });

app.on('window-all-closed', () => {
  stopChild();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', stopChild);
