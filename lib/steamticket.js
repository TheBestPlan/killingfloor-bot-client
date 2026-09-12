// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Real Steam auth via the game's steam_api.dll (SteamUser017), through Node FFI (koffi).
 * Needs Steam running + logged into an account that owns Killing Floor (AppID 1250).
 *
 * Flow (mirrors KF's own client, reversed from Engine.dll):
 *   SteamAPI_Init() -> SteamUser() -> ISteamUser017 vtable:
 *     idx 2 (off 0x08) GetSteamID()             -> our real SteamID (used in HELLO)
 *     idx 3 (off 0x0c) InitiateGameConnection() -> the auth blob the server validates
 *                                                  via SendUserConnectAndAuthenticate.
 * The blob is then hex-chunked into STEAMCLIENTBLOB exactly like the stock client.
 */
const koffi = require('koffi');
const fs = require('fs');
const { findSteamApiDll } = require('./findsteam');

let state = null;

function init(dllPath) {
  if (state) return state;
  // SteamAPI_Init identifies this process as app 1250 via steam_appid.txt in the CWD.
  if (!fs.existsSync('steam_appid.txt')) fs.writeFileSync('steam_appid.txt', '1250');

  // Auto-detected from the local Steam install (override with env KF_STEAM_API_DLL or dllPath arg).
  const dll = dllPath || findSteamApiDll();
  if (!dll) throw new Error('steam_api.dll not found — install KF via Steam, set KF_STEAM_API_DLL, or pass dllPath');
  const lib = koffi.load(dll);
  const SteamAPI_Init = lib.func('bool __cdecl SteamAPI_Init()');
  const SteamUser = lib.func('void* __cdecl SteamUser()');

  if (!SteamAPI_Init()) {
    throw new Error('SteamAPI_Init() failed — start Steam, log into an account that owns KF (AppID 1250)');
  }
  const user = SteamUser();
  if (!user || koffi.address(user) === 0n) throw new Error('SteamUser() returned null');

  // ISteamUser* -> vtable -> method pointers
  const vtable = koffi.decode(user, 'void *');     // *user = vtable
  const pGetSteamID = koffi.decode(vtable, 8, 'void *');   // index 2 -> offset 0x08
  const pInitiate = koffi.decode(vtable, 12, 'void *');    // index 3 -> offset 0x0c

  // Wrap the vtable function pointers (x86 __thiscall: `this` in ECX).
  const GetSteamID = koffi.func(pGetSteamID, koffi.proto('uint64 __thiscall GetSteamID(void *self)'));
  const InitiateGameConnection = koffi.func(pInitiate, koffi.proto(
    'int __thiscall InitiateGameConnection(void *self, void *blob, int cbMax, uint64 serverID, uint32 ip, uint16 port, bool secure)'));

  state = { lib, user, GetSteamID, InitiateGameConnection };
  return state;
}

// Our real 64-bit SteamID (decimal string), for the HELLO line.
function getSteamID() {
  const s = init();
  return s.GetSteamID(s.user).toString();
}

// Produce the auth blob for a given game server. serverIP is host-order uint32.
function getAuthBlob(serverSteamID, serverIP, serverPort, secure) {
  const s = init();
  const blob = Buffer.alloc(2048);
  const n = s.InitiateGameConnection(s.user, blob, blob.length,
    BigInt(serverSteamID), serverIP >>> 0, serverPort & 0xffff, secure ? 1 : 0);
  if (n <= 0) throw new Error('InitiateGameConnection returned ' + n);
  return blob.slice(0, n);
}

module.exports = { init, getSteamID, getAuthBlob };
