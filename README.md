# Killing Floor Bot Client

**English** · [Русский](./docs/translations/README.ru.md) · [Español](./docs/translations/README.es.md) · [Português](./docs/translations/README.pt.md) · [Lietuvių](./docs/translations/README.lt.md) · [Polski](./docs/translations/README.pl.md) · [Français](./docs/translations/README.fr.md) · [中文](./docs/translations/README.zh.md) · [日本語](./docs/translations/README.ja.md)

L2Walker-style headless client for Killing Floor (Unreal Engine 2.5). Speaks the native Unreal Engine 2 network protocol over UDP — no game client launch, no injection. Connects as a real client, passes Steam auth, and enters the game.

> The result of deep reverse-engineering of the native UE2.5 netcode (the UT2004 / Red Orchestra line), the KF-specific Steam handshake, and the RPC format. Full documentation lives in [`docs/`](docs/): [USAGE](docs/USAGE.md) · [PROTOCOL](docs/PROTOCOL.md) · [GOTCHAS](docs/GOTCHAS.md) · [SERVER-SETUP](docs/SERVER-SETUP.md) · [GUI](docs/GUI.md). Built and run on Node.js (≥ 18); package manager is **pnpm**. `pnpm test` runs the suite.

## What works today (verified live)

| Capability                                                                 | Status                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| UE2.5 transport (bitstream / packet / bunch / control channel)             | done — 56/56 + 19/19 round-trip tests; live against the real engine       |
| KF Steam handshake (HELLO+STEAMID → STEAMENCRYPTIONKEY → STEAMCLIENTBLOB)  | done — reverse-engineered and implemented                                 |
| Steam auth — own server via **Goldberg** (dummy blob)                      | done — bot passes auth                                                     |
| Steam auth — **real production** server, genuine account ticket            | done — **bot joined a live game**                                         |
| Full handshake (CHALLENGE → LOGIN → USES/HAVE → WELCOME → JOIN)            | done — 10/10 e2e                                                           |
| Spawn on the map (via a server-side ready mutator)                         | done — `KFHumanPawn` with HP and coordinates                              |
| GameSpy server query (Phase 0)                                             | done — `phase0_gamespy_query.py`                                          |
| "Clean" client-side Ready RPC (`ServerRestartPlayer`)                      | partial — format reversed; needs the net index from one capture (see [PROTOCOL](docs/PROTOCOL.md)) |

Steam authentication was the key barrier, and it is solved **two ways** — see [Quick start](#quick-start) below.

## Bootstrap from a clean clone (Windows)

Git holds **source only**. Everything downloaded — `node_modules`, 32-bit node, koffi binaries, Goldberg, Ghidra+JDK — is under `.gitignore` and restored with one command:

```bash
node bootstrap.js          # core (pnpm) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineering)
```

Idempotent (anything already installed is skipped). Needs internet and 7-Zip. Then `pnpm test`. What gets downloaded and why is described in [docs/USAGE.md](docs/USAGE.md).

## GUI (classic L2Walker style)

An Electron desktop wrapper around the bot — a window with a Start/Stop/Ready/Leave toolbar, connection status, config tabs, and a log. The desktop GUI is the primary way to run; the headless CLI scenarios below drive the same engine. Launch and a **step-by-step guide (whether Steam is needed, the working order, the spawn caveat)** are in [docs/GUI.md](docs/GUI.md):

```bash
pnpm install && pnpm start
```

## Quick start

Two working scenarios — pick by situation.

### A. Own server (Goldberg) → bot spawns on the map

For testing / bot-running on a server **you own** and can modify. The server runs the **Goldberg Steam Emulator** `steam_api.dll`, whose game-server `BeginAuthSession` approves any ticket offline — so the server reaches `OnGSClientApprove` and proceeds to `CHALLENGE`, and the bot's dummy `STEAMCLIENTBLOB` (any non-empty, well-formed blob ≥ 24 bytes) passes. Details in [USAGE.md](docs/USAGE.md) and [SERVER-SETUP.md](docs/SERVER-SETUP.md).

```bash
# (the _kfds server already has Goldberg + the BotHelper.MutBotAutoReady mutator, see SERVER-SETUP.md)
node phase2_client.js --server 127.0.0.1:7817 --name Bot --ver 3339 --minver 3339 \
     --ready --ready-delay 5000 --leave-delay 10000
```

### B. Real production server → bot joins with a genuine Steam ticket

The bot generates an authentic Steam ticket via `steam_api.dll` (a 32-bit FFI helper) from an account that owns KF — a **legitimate** client as far as Steam is concerned. Needs Steam running under that account. Details in [USAGE.md](docs/USAGE.md).

```bash
node phase2_client.js --server eu.killingfloor.net:7707 --name SteamBot --ver 3339 --minver 3339 --real-steam
```

> Engine version for these servers is **3339** (not 3369) — pass `--ver 3339 --minver 3339`.

## External dependencies (NOT part of the repository)

The repository is self-contained in terms of **code**: after `node bootstrap.js` it runs without copying anything from other folders. But it relies on large third-party components you install yourself — the tool finds them from the Steam install (or via env `KF_GAME_DIR` / `KF_SERVER_DIR` / `KF_STEAM_API_DLL`). What's needed for each scenario:

| Dependency                                                                          | Why / for which scenario                                                     | How it's installed              | Where it's found                                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| **Killing Floor** (client, Steam AppID **1250**), Steam running under this account  | Scenario B — genuine Steam ticket (`--real-steam`). Provides `steam_api.dll` | Install from Steam, log in      | auto: Steam libraries → `KillingFloor/System/steam_api.dll`; env `KF_STEAM_API_DLL` |
| **Killing Floor Dedicated Server** (Steam app **215360**)                           | Scenario A — your own server, the bot spawns                                 | SteamCMD / Steam                | auto: Steam libraries or next to the repo; env `KF_SERVER_DIR`; junction `_kfds`     |
| **7-Zip**                                                                            | `bootstrap.js` (unpacking the download)                                      | install 7-Zip                   | `C:\Program Files\7-Zip\7z.exe`                                                      |
| **Goldberg, Ghidra+JDK**                                                             | Scenario A only (Steam emulation on the server) and reverse-engineering      | fetched by `bootstrap.js --all` | into `_goldberg/`, `_ghidra/` (gitignored)                                           |

Neither the game, nor the server, nor the Steam DLL are **copied** into the repository (multi-gigabyte / licensed third-party installs) — they're only referenced. For scenario B (production) you don't need your own server; for scenario A you don't need `--real-steam`.

## File map

```
killingfloor-bot-client/
├─ docs/                   # documentation (translations/ holds the localized READMEs)
├─ bootstrap.js            # restores the download from a clean clone (see USAGE.md)
├─ phase2_client.js        # MAIN client-bot (handshake → in-game → scenario)
├─ phase1_relay.js         # UDP MITM relay + packet disassembler (for capture/debugging)
├─ phase0_gamespy_query.py # GameSpy server query (Python; optional)
├─ launch-server.js        # launches a local dedicated server (Node spawn, fixes spaces in path)
├─ make-junction.js        # junction to the server path without spaces (needed for UCC.exe)
├─ run-local-server.ps1    # alternative server launch (PowerShell)
├─ lib/
│  ├─ bitstream.js         # FBitReader/Writer, FString, FCompactIndex (UE2 bit stream)
│  ├─ netconn.js           # packets/bunch + control-channel + disconnect
│  ├─ botsession.js        # engine state machine (start/ready/leave/stop + events) — shared by CLI and GUI
│  ├─ steamticket.js       # (stub) FFI to steam_api.dll — NOT used directly (see _steam32)
│  └─ hexdump.js
├─ test/                   # bitstream / netconn / relay smoke / handshake e2e (pnpm test)
├─ main.js / preload.js / runner.js  # Electron GUI: main process, sandbox bridge, forked bot host
├─ renderer/               # GUI page (Win32-style panel, L2Walker-style)
├─ server-mutator/         # source of the server mutator MutBotAutoReady.uc (built into _kfds)
├─ _steam32/               # 32-bit Steam helper (node x86 + koffi-ia32 + steamhelper.js)
├─ _goldberg/              # downloaded Goldberg (gbe_fork) steam_api.dll (gitignored, fetched by bootstrap)
├─ _ghidra/                # Ghidra 12 + JDK 21 + Engine.dll reverse-engineering scripts
└─ captures/               # client logs and relay captures
```

The server-side part (the "press Ready for the bot" mutator) is versioned in the repo; for the build it's copied into the server tree:

```
server-mutator/MutBotAutoReady.uc          # source in the repo
   └─(copy for the build)→ _kfds/BotHelper/Classes/MutBotAutoReady.uc  # junction to the server
```

## Client options

```
--server host:port   target server (default 127.0.0.1:7707)
--name <str>         player name (default Bot)
--url <str>          login URL options (default "?Name=<name>")
--netspeed <n>       requested netspeed (default 10000); --no-netspeed to omit
--ver/--minver <n>   engine net version sent in HELLO (default 3369/3180)
--ready              after JOIN, send ServerRestartPlayer (needs the two indices below)
--pc-channel <n>     actor channel index of our PlayerController (from capture)
--restart-index <n>  NetFields index of ServerRestartPlayer (from capture)
--log <path>         capture log path
--quiet              don't echo to stdout
```

## Protocol facts

Verified against real UT2004 v3369 engine source and live KF traffic (full write-up in [PROTOCOL.md](docs/PROTOCOL.md)):

- **Control channel is ASCII text**, not a binary enum: `HELLO REVISION=0 MINVER=3180 VER=3369` → `CHALLENGE … CHALLENGE=<int> …` → `LOGIN RESPONSE=<int> URL=<url>` → `USES …`/`HAVE …` → `WELCOME` → `JOIN`.
- **Login auth is a trivial integer scramble** — no CD-key, no MD5: `RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)` (UT2004 `UGameEngine::ChallengeResponse`). Implemented in `phase2_client.js`.
- **KF Steam handshake** (reversed from the server's `Engine.dll` + live traffic): `HELLO … STEAMID=%I64u` → server `STEAMENCRYPTIONKEY %s` → client `STEAMCLIENTBLOB SIZE/CHUNK/BLOB` (Steam auth ticket) → server `SendUserConnectAndAuthenticate` → async `OnGSClientApprove/Deny` → only then `CHALLENGE`.
- Transport is a **bit-stream**: packet = `PacketId` then bunches; bunch header = `bControl/bOpen/bClose/bReliable/ChIndex/ChSeq/ChType/NumBits` + payload; trailing stop bit. Constants `MAX_PACKETID=16384`, `MAX_CHSEQUENCE=1024`, `MAX_CHANNELS=1023`, `CHTYPE_Control=1/Actor=2/File=3`.

## Run the tests

```bash
pnpm test          # bitstream + netconn + relay smoke + handshake e2e
```

## Live validation runbook (needs the real game — do this yourself)

These steps need the real game running, so run them yourself to validate against the real engine and to capture the Phase 3 (client-side Ready) indices.

**1. Start a local server** (headless, no 3D):

```powershell
pwsh -File run-local-server.ps1            # KF-BioticsLab on udp/7707
```

(or host a listen server from the game menu: Host Game.)

**2a. Capture a REAL client's handshake** (ground truth + Phase 3 indices):

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707
```

Then in the real Killing Floor console: `open 127.0.0.1:7708`, pick a perk, hit **Ready**. The relay logs every packet (hexdump + disassembly) to `captures/`. Look for:

- the exact `HELLO`/`CHALLENGE`/`LOGIN`/`USES`/`WELCOME`/`JOIN` lines (if the disassembly is clean, our codec matches the real engine);
- after JOIN, the **actor channel index** the server uses for your PlayerController, and
- the **reliable bunch your real client sends when you press Ready** — its channel index = `--pc-channel`, and the leading packed int in its payload = the `ServerRestartPlayer` NetFields function index = `--restart-index`.

**2b. Try our headless client** directly against the server:

```bash
node phase2_client.js --server 127.0.0.1:7707 --name Bot
# once you have the indices from 2a:
node phase2_client.js --server 127.0.0.1:7707 --name Bot --ready \
     --pc-channel <N> --restart-index <M>
```

If the server replies `FAILURE …`, the message says why (password, version, GUID). Adjust `--ver/--minver`, `--url`, etc. and retry; the client logs everything to `captures/`.

## Documentation

- **[USAGE.md](docs/USAGE.md)** — how to use it: prerequisites, options, both scenarios step by step.
- **[PROTOCOL.md](docs/PROTOCOL.md)** — the reverse-engineered protocol: UE2.5 transport, KF Steam handshake, RPC format.
- **[GOTCHAS.md](docs/GOTCHAS.md)** — every nuance and pitfall we hit (required reading).
- **[SERVER-SETUP.md](docs/SERVER-SETUP.md)** — local dedicated server + Goldberg + building the mutator.
- **[GUI.md](docs/GUI.md)** — the Electron desktop GUI (`pnpm start`): window controls, Steam modes, the spawn caveat.

## Disclaimer

This is a personal reverse-engineering and protocol-interoperability project, published for research and educational purposes. Use it only against servers you own or are explicitly authorized to test. Running a non-official client, reverse-engineering the engine, or generating Steam auth tickets may violate the game's EULA and the Steam Subscriber Agreement — you alone are responsible for how you use this code. It is provided **as is**, without any warranty (see the license). Not affiliated with Tripwire Interactive or Valve.

## License

Copyright (c) 2026 TheBestPlan.

Released under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later). See [LICENSE](LICENSE) for the full text. This program is free software: you can redistribute it and/or modify it under those terms, and it comes with **no warranty**.
