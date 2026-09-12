# Using Killing Floor Bot Client

All commands run from the project root (the `killingfloor-bot-client/` folder, where `package.json` lives). Game/server paths are detected automatically from the local Steam install; override them if needed via the `KF_GAME_DIR` / `KF_SERVER_DIR` / `KF_STEAM_API_DLL` environment variables.

## Bootstrap from a clean clone

The repo holds **sources only**. Everything downloaded (`node_modules`, 32-bit node, koffi binaries, Goldberg, Ghidra+JDK) is under `.gitignore`. Restore it with one command (Windows, needs 7-Zip):

```bash
node bootstrap.js          # core (pnpm install) + --real-steam (32-bit node + koffi-ia32)
node bootstrap.js --all    # + Goldberg (own server) + Ghidra/JDK (reverse-engineer Engine.dll)
```

The script is idempotent (already-installed stuff is skipped) and downloads:

- **Tier 1 (core)** — `pnpm install` (koffi 64-bit; build allowed in `pnpm-workspace.yaml`) → transport, handshake, dummy-blob;
- **Tier 2 (`--real-steam`)** — 32-bit node `v22.12.0-win-x86` + `koffi-win32-ia32` (the same koffi from Tier 1, copied) into `_steam32/` → real Steam ticket;
- **Tier 3 (`--all`, optional)** — Goldberg `steam_api.dll` (for your own server) + Ghidra 12 + JDK 21 (only if you want to repeat the reverse-engineering; **not needed** to run the bot).

## Prerequisites

- **Node.js ≥ 18** (64-bit) — the main bot. Check: `node --version`.
- **`node bootstrap.js`** once after cloning (see above). Installs `koffi` and (Tier 2) the `_steam32/` helper.
- For a **real Steam ticket** (`--real-steam`): a running **Steam** logged into an account that owns Killing Floor (AppID 1250). `bootstrap.js` drops 32-bit node + koffi-ia32 into `_steam32/`.
- For **your own server**: see [SERVER-SETUP.md](SERVER-SETUP.md) (UCC dedicated server + Goldberg + mutator).

Check everything is in place:

```bash
pnpm test     # bitstream + netconn + relay smoke + handshake e2e — should be all green
```

## Engine version

The KF dedicated server of this generation is **engine 3339 / KF 1065**. The bot sends `MINVER`/`VER` in HELLO. The bot defaults to 3369/3180 (stock UT2004), so for KF you **must** pass:

```
--ver 3339 --minver 3339
```

Wrong version and the server answers `UPGRADE`/`FAILCODE` (see the client log in `captures/`).

---

## Scenario A — your own server (with Goldberg)

Goal: the bot connects to **your** server and **spawns on the map**. Steam emulation (Goldberg) runs on the server, so a dummy-blob is enough for the bot; the server-side mutator does the "press Ready".

Preconditions (one-time, see [SERVER-SETUP.md](SERVER-SETUP.md)):

- a `_kfds` server with Goldberg `steam_api.dll` + `steam_settings/steam_interfaces.txt`;
- the built `BotHelper.MutBotAutoReady` mutator;
- server started with `?Mutator=BotHelper.MutBotAutoReady` (default port **7817**).

Run the bot (full scenario: join → +5s Ready → +10s leave):

```bash
node phase2_client.js --server 127.0.0.1:7817 --name Bot --ver 3339 --minver 3339 \
     --ready --ready-delay 5000 --leave-delay 10000
```

What you'll see in the bot log (`captures/client-*.log`):

```
STATE: ... -> in-level
>>> ADMITTED: server is replicating the world
>>> READY: sending ServerRestartPlayer ...
>>> LEAVING: disconnecting from server
== disconnected, exiting ==
```

And on the server:

```
New Player Bot
[BotAutoReady] READY -> Bot
START MATCH
[BotAutoReady] ON MAP: Bot pawn=KFHumanPawn health=100 at <x,y,z>
```

`ON MAP ... pawn=KFHumanPawn` = the bot actually spawned on the map.

> Note: the spawn is triggered by the server-side mutator (on its own 2-second timer), so the actual spawn happens shortly after joining, not exactly 5s later. The "clean" client-side Ready RPC is not fully calibrated yet (see [PROTOCOL.md](PROTOCOL.md#phase-3--rpc-serverrestartplayer-ready)).

---

## Scenario B — a real server (real Steam ticket)

Goal: the bot connects to a **real production server** under your Steam account, passes **real Steam/VAC authentication**, and enters a live game.

Preconditions:

1. **Start Steam** and log into an account that owns KF (AppID 1250).
2. The `_steam32/` helper is ready (32-bit node + koffi-ia32 + `steamhelper.js`).

Run:

```bash
node phase2_client.js --server eu.killingfloor.net:7707 --name SteamBot --ver 3339 --minver 3339 --real-steam
```

What `--real-steam` does:

1. at startup it calls the 32-bit helper `id` → your real SteamID → sends it in HELLO;
2. on `STEAMENCRYPTIONKEY` it calls the helper `blob <serverSteamID> <hostIP> <port> <secure>` → `ISteamUser::InitiateGameConnection` generates a **real 212-byte ticket** → sends it in chunks;
3. the server validates the ticket through real Steam → `CHALLENGE` → then the rest of the handshake.

Success in the log:

```
real SteamID: 76561198260781598 ...
<- CTRL "STEAMENCRYPTIONKEY ... SECURE=1"
   REAL Steam ticket: 212 bytes ...
<- CTRL "CHALLENGE VER=3339 ..."        ← production accepted the ticket
... USES/HAVE ... 79 actor channels     ← entered the live world
```

If you see `FAILCODE STEAMAUTH`, the ticket was rejected: check that Steam is running and the account owns KF, and that the server really runs on real Steam (not Goldberg). If the helper prints `STEAM_INIT_FAILED`, Steam isn't running / isn't logged in.

> This is a legitimate path: the bot is a real Steam client of your account. On your own servers — no questions asked.

---

## Testing the Steam helper by hand

You can call the helper directly (for debugging), with the 32-bit node from `_steam32/`:

```bash
cd _steam32
./node-v22.12.0-win-x86/node.exe steamhelper.js id
# -> your SteamID

./node-v22.12.0-win-x86/node.exe steamhelper.js blob <serverSteamID> <hostIP> <port> <1|0>
# -> hex of the real ticket
```

`hostIP` — the server IP as a host-order uint32 (a.b.c.d → a<<24|b<<16|c<<8|d). The bot computes it itself from DNS.

---

## All `phase2_client.js` options

```
--server host:port    target server (default 127.0.0.1:7707)
--name <str>          player name (default Bot)
--ver / --minver <n>  engine version in HELLO (for KF: 3339 / 3339)
--url <str>           login-URL options (default "?Name=<name>")
--netspeed <n>        requested netspeed (10000); --no-netspeed to not send NETSPEED

--real-steam          use a REAL Steam ticket (via the _steam32 helper). Otherwise dummy-blob.
--steamid <id>        SteamID for HELLO (ignored with --real-steam — the real one is used)
--blob <hex>          (without --real-steam) dummy-blob contents; default 0xAA
--blob-size <n>       (without --real-steam) dummy-blob size in bytes (default 256, ≥24)
--steam-node <path>   path to the 32-bit node.exe for the helper

--ready               scenario: after joining, send Ready and then leave
--ready-delay <ms>    delay before Ready after joining (5000)
--leave-delay <ms>    delay before leaving after Ready (10000)
--pc-channel <n>      (Phase 3) actor-channel index of the PlayerController
--restart-index <n>   (Phase 3) net index of the ServerRestartPlayer function
--net-max <n>         (Phase 3) WriteInt bound for the function index (1024)

--log <path>          log-file path (default captures/client-<time>.log)
--quiet               don't mirror to stdout
```

The `KF_CLIENT_TIMEOUT=<ms>` environment variable — auto-exit after N ms (handy for probes).

---

## Relay (traffic capture / debugging)

A UDP-MITM between a real client and the server + a packet disassembler:

```bash
node phase1_relay.js --listen 7708 --server 127.0.0.1:7707 --log captures/cap.log
# in the game/bot: open <this-host>:7708
```

Writes a hexdump + a breakdown of every packet (bunches, control text). Important gotcha: **a real KF client connecting to a Steam server switches to Steam networking and is NOT visible to the UDP relay** — the relay only catches a client over plain UDP (our bot, or a client with Goldberg, see [GOTCHAS.md](GOTCHAS.md)).
