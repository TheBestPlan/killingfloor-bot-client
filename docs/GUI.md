# Killing Floor Bot Client (GUI)

A classic **L2Walker-style** desktop front-end for `killingfloor-bot-client` (Killing Floor / UE2.5). Built with Electron; the bot engine is the same Node code the headless CLI uses (`lib/botsession.js`). This is the primary way to run the project — `pnpm start` from the repo root.

## Run

```bash
pnpm install     # first time — installs koffi + Electron (or run: node bootstrap.js)
pnpm start
```

> This project uses **pnpm**. pnpm does not run dependency build scripts unless whitelisted, so `pnpm-workspace.yaml` enables Electron's postinstall (`allowBuilds: { electron: true }`) — without it the Electron binary never downloads and you get "Electron failed to install correctly".

## Usage (how to use the window)

### Do I need Steam running?

Depends on the auth mode — the **"Use real Steam ticket"** checkbox on the **Steam** tab:

| Mode | Steam running? | Where to connect |
|---|---|---|
| **Off** (synthetic blob) | no — not needed | your own test server with the **Goldberg** emulator (e.g. `127.0.0.1:7817`) |
| **On** (real ticket) | yes — required, logged into an account that owns Killing Floor (AppID 1250) | a real/secure server (e.g. `eu.killingfloor.net:7707`) |

"On" mode needs the 32-bit Steam helper from `_steam32/` — installed once via `node bootstrap.js` (Tier 2). Without it, real-steam fails with `Steam helper "id" failed`.

### Working order

1. **Main tab** — `Server host:port`, `Player name`; leave `VER`/`MINVER` at `3339` (KF build 1065).
2. **Steam tab** — tick the box only for a real/secure server; for your own Goldberg — off.
3. *(opt.)* **Auto tab** — "Auto-Ready" makes the bot press Ready itself `ready delay` ms after joining and leave `leave delay` ms after that. Off — you drive it with the buttons.
4. **Start** on the toolbar → watch the status bar `init → hello → steamauth → login → … → in-level`. Green lamp = bot in the world (as a spectator); actor channels start appearing in the list on the right.
5. **Ready** — spawn (`ServerRestartPlayer`), **Leave** — clean exit, **Stop** — abort.

Each run's full log is also written to `captures/gui-<timestamp>.log`.

### Interface language

**Setup → Language** switches the whole window between the nine languages the README is translated into (English, Русский, Español, Português, Lietuvių, Polski, Français, 中文, 日本語). The change applies instantly — no restart — and is remembered in `settings.ini` (`[ui] language=`). Default is English.

### Ready / spawn caveat

Connecting and entering the world **as a spectator** work reliably. A guaranteed **spawn on Ready** does not: the `ServerRestartPlayer` RPC needs exact connection indices (the PlayerController actor channel + the function's NetFields index). Options:

- **Own server** — the server-side mutator `server-mutator/MutBotAutoReady.uc` (readies the bot itself) — the most reliable spawn path;
- otherwise — capture the indices with `phase1_relay.js` and enter them on the **Advanced** tab (`PC channel`, `Restart index`).

Without them, "Ready" sends the RPC to channels 1,2 with a guessed index and may not work. v1 — **one bot at a time**; a tool for your own / authorized servers (interop/research).

## How it works

```
renderer (page)  ──ipc──►  main.js  ──fork──►  runner.js ──► BotSession (lib/botsession.js)
   window.kfbot   (preload)           (child)                  └─ UDP ─► KF server
        ▲                                                      └─ spawns 32-bit Steam helper
        └──────────────── bot events (state/log/objects) ──────────────┘
```

- **main.js** — Electron main process; owns the window and one forked bot child; pure IPC bridge.
- **runner.js** — forked Node child that hosts a `BotSession` (crash isolation from untrusted UDP); forked with `ELECTRON_RUN_AS_NODE=1`. Also writes each run's log to `captures/gui-<timestamp>.log`.
- **preload.js** — exposes a minimal sandboxed `window.kfbot` API (`start`/`stop`/`cmd`/`onEvent`).
- **renderer/** — the Win32-style panel: toolbar (Start/Stop/Ready/Leave), Character status with a lifecycle progress bar + lamp, tabbed config (Main/Auto/Steam/Advanced), a "World objects" ListView of opened actor channels, a status bar, and a live log.

No native module (`koffi`) ever loads in Electron or the runner — real-Steam mode still runs only via the bundled 32-bit helper spawned by `BotSession`, so there is no `electron-rebuild` step.

## Quick test target

Point the form at a local server running the Goldberg Steam emulator (see [SERVER-SETUP.md](SERVER-SETUP.md)), e.g. `127.0.0.1:7817`, name `GuiBot`, VER/MINVER `3339`, then **Start**. The status bar should reach `in-level` and the server log should print `New Player GuiBot`. Use **Ready** / **Leave** to drive the session, or enable Auto-Ready on the **Auto** tab.

## Building & releases

Built with [electron-builder](https://www.electron.build/). From the repo root:

```bash
pnpm run pack      # unpacked app in dist/ (quick local smoke test)
pnpm run dist      # installers for the current OS (NSIS + portable on Windows)
pnpm run release   # build + publish to GitHub Releases (needs GH_TOKEN)
```

CI is in `.github/workflows/`:

- **build.yml** — packages on Windows/macOS/Linux for every push/PR (no publish).
- **release.yml** — push a tag `vX.Y.Z` (`git tag v0.1.0 && git push --tags`) to build all three OSes and publish a **draft** GitHub release; review the assets, then publish it.

Targets: Windows NSIS installer + portable exe, macOS dmg/zip (x64 + arm64), Linux AppImage/deb. App icon: `build/icon.png`.

> Real-Steam mode (the 32-bit helper in `_steam32/`) is **not** bundled in release builds — it's a large downloaded component. Packaged builds support the synthetic-blob / own-server (Goldberg) mode; for real Steam tickets, run from source after `node bootstrap.js`. Multi-bot management and a server browser are left for a future version.
