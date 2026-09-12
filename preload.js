// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Preload - the only bridge between the sandboxed renderer and the main process.
 * Exposes a tiny, explicit `window.kfbot` API over ipcRenderer; the page itself
 * has no Node access (contextIsolation + nodeIntegration:false).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kfbot', {
  start: (cfg) => ipcRenderer.send('bot:start', cfg),
  stop: () => ipcRenderer.send('bot:stop'),
  cmd: (c) => ipcRenderer.send('bot:cmd', c),
  // HOST/CHAR history, persisted to an ini file next to the app (like L2Walker).
  getHistory: () => ipcRenderer.invoke('bot:history:get'),
  addHistory: (server, name) => ipcRenderer.invoke('bot:history:add', { server, name }),
  setSteamKey: (key) => ipcRenderer.invoke('bot:steam:setkey', key),
  setLang: (lang) => ipcRenderer.invoke('bot:lang:set', lang),
  // Server Browser: master list (Steam + GameTracker) and a per-server live A2S query.
  serverList: () => ipcRenderer.invoke('browser:list'),
  serverQuery: (ip, queryPort, gamePort) => ipcRenderer.invoke('browser:query', { ip, queryPort, gamePort }),
  // handler receives { name, payload }; returns an unsubscribe function.
  onEvent: (handler) => {
    const listener = (_e, msg) => handler(msg);
    ipcRenderer.on('bot:event', listener);
    return () => ipcRenderer.removeListener('bot:event', listener);
  },
  // Frameless-window title-bar controls (L2Walker-style caption).
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    onMaximized: (handler) => { const l = (_e, v) => handler(v); ipcRenderer.on('win:maximized', l); return () => ipcRenderer.removeListener('win:maximized', l); },
  },
});
