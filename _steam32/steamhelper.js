// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * 32-bit Steam helper (run by the bundled 32-bit node + koffi-ia32).
 * Loads the real steam_api.dll (SteamUser017) and calls ISteamUser::InitiateGameConnection
 * (vtable idx 3) to produce a real Steam auth ticket for a KF server.
 *   id                                    -> our real SteamID (extracted from a throwaway ticket)
 *   blob <serverID> <ip> <port> <secure>  -> real auth ticket as hex (validated by the server)
 *
 * koffi can't call __thiscall pointers directly, so we emit a tiny stdcall->thiscall thunk
 * (moves `self` into ECX) into RWX memory and call that via koffi (stdcall is supported).
 * Needs Steam running + an account that owns Killing Floor (AppID 1250).
 */
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const { findSteamApiDll } = require('../lib/findsteam');

// Auto-detected from the local Steam install (override with env KF_STEAM_API_DLL).
const STEAM_DLL = findSteamApiDll();
if (!STEAM_DLL || !fs.existsSync(STEAM_DLL)) {
  console.error('STEAM_DLL_NOT_FOUND — install Killing Floor via Steam, or set KF_STEAM_API_DLL');
  process.exit(5);
}

const k32 = koffi.load('kernel32.dll');
const VirtualAlloc = k32.func('void* __stdcall VirtualAlloc(void* addr, size_t size, uint32 type, uint32 protect)');
const RtlMoveMemory = k32.func('void __stdcall RtlMoveMemory(void* dst, void* src, size_t len)');

// stdcall->thiscall trampoline for the function at uint32 `target`:
//   mov ecx,[esp+4]; mov edx,[esp]; add esp,8; push edx; mov eax,target; jmp eax
function makeThunk(target) {
  const code = Buffer.from([
    0x8B, 0x4C, 0x24, 0x04, 0x8B, 0x14, 0x24, 0x83, 0xC4, 0x08,
    0x52, 0xB8, 0, 0, 0, 0, 0xFF, 0xE0,
  ]);
  code.writeUInt32LE(target >>> 0, 12);
  const mem = VirtualAlloc(null, code.length, 0x3000, 0x40); // MEM_COMMIT|RESERVE, PAGE_EXECUTE_READWRITE
  if (!mem) throw new Error('VirtualAlloc failed');
  RtlMoveMemory(mem, code, code.length);
  return mem;
}

let S = null;
function init() {
  if (S) return S;
  const appid = path.join(__dirname, 'steam_appid.txt');
  if (!fs.existsSync(appid)) fs.writeFileSync(appid, '1250');
  try { process.chdir(__dirname); } catch (e) {}

  const lib = koffi.load(STEAM_DLL);
  if (!lib.func('bool __cdecl SteamAPI_Init()')()) { console.error('STEAM_INIT_FAILED'); process.exit(2); }
  const user = lib.func('void* __cdecl SteamUser()')();
  if (!user) { console.error('STEAMUSER_NULL'); process.exit(3); }

  const vtable = koffi.decode(user, 'void *');
  const initiateAddr = koffi.decode(vtable, 12, 'uint32'); // ISteamUser017 idx 3 = InitiateGameConnection
  S = {
    user,
    thunk: makeThunk(initiateAddr),
    proto: koffi.proto('__stdcall', 'IGC', 'int',
      ['void *', 'void *', 'int', 'uint64', 'uint32', 'uint16', 'bool']),
  };
  return S;
}

// Returns the auth blob Buffer for a given game server (host-order uint32 ip).
function makeTicket(serverID, ip, port, secure) {
  const s = init();
  const blob = Buffer.alloc(2048);
  const n = koffi.call(s.thunk, s.proto, s.user, blob, blob.length,
    BigInt(serverID), ip >>> 0, port & 0xffff, !!secure);
  if (n <= 0) { console.error('TICKET_FAILED ' + n); process.exit(4); }
  return blob.slice(0, n);
}

const mode = process.argv[2];
if (mode === 'id') {
  // Throwaway ticket; the local user's SteamID sits at offset 0x0c (standard GC ticket).
  const t = makeTicket('0', 0, 0, false);
  console.log(t.readBigUInt64LE(0x0c).toString());
} else if (mode === 'blob') {
  const t = makeTicket(process.argv[3], parseInt(process.argv[4], 10), parseInt(process.argv[5], 10), process.argv[6] === '1');
  console.log(t.toString('hex'));
} else {
  console.error('usage: steamhelper.js id | blob <serverID> <ip> <port> <secure>');
  process.exit(1);
}
