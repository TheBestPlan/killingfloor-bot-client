# Local dedicated server: Goldberg + ready mutator

Only needed for **scenario A** (own server, bot spawns). For production (scenario B) no server is needed. Commands run from the tool folder `killingfloor-bot-client/`.

Current state (already set up in this project):

- server: `Killing Floor Dedicated Server - Win32` (Steam app 215360), via the `_kfds` junction;
- Goldberg `steam_api.dll` + `steam_settings/steam_interfaces.txt` installed on the server;
- mutator `BotHelper.MutBotAutoReady` built (`_kfds/System/BotHelper.u`);
- server port is **7817** (changed from 7707, uplink disabled — see below).

Below is how to reproduce this from scratch.

---

## 1. Junction without spaces (required)

UCC.exe breaks on spaces in the path (see [GOTCHAS.md](GOTCHAS.md) §6). Create a junction:

```bash
node make-junction.js
# creates junction killingfloor-bot-client/_kfds -> "Killing Floor Dedicated Server - Win32"
# finds the server folder on its own (Steam libraries / next to the repo); otherwise:
#   node make-junction.js "<path to server>"   or   set KF_SERVER_DIR=<path>
```

The `_kfds` junction lives **inside the project** — from here on all paths are relative (`_kfds/...`).

---

## 2. Goldberg (Steam emulation on the server)

Goldberg (gbe_fork) is already downloaded into `_goldberg/`, the x86 binary extracted to `_goldberg/extracted/steam_api.dll`.

Install onto the server:

```bash
DS="_kfds/System"      # path via the in-project junction (see §1)
# back up the original
cp "$DS/steam_api.dll" "$DS/steam_api.dll.orig"
# Goldberg
cp _goldberg/extracted/steam_api.dll "$DS/steam_api.dll"
# appid
printf '1250' > "$DS/steam_appid.txt"
```

**Critical:** generate `steam_interfaces.txt` from the ORIGINAL dll (otherwise GS-auth won't activate):

```bash
mkdir -p "$DS/steam_settings"
# extract interface versions from steam_api.dll.orig (the key one is SteamGameServer011)
node _ghidra/scanstr.js ... # or by hand, list below
printf '1250' > "$DS/steam_settings/steam_appid.txt"
```

Contents of `steam_settings/steam_interfaces.txt` (for this KF build):

```
STEAMAPPS_INTERFACE_VERSION005
STEAMUSERSTATS_INTERFACE_VERSION011
SteamClient012
SteamFriends013
SteamGameServer011
SteamGameServerStats001
SteamMatchMaking009
SteamMatchMakingServers002
SteamNetworking005
SteamUser017
SteamUtils006
```

After starting the server the log should show `Steam auth system activation successful` + `Connected to Steam Servers` (emulated). If `activation failed` — there's no `steam_interfaces.txt`.

> **Revert to original:** `cp "$DS/steam_api.dll.orig" "$DS/steam_api.dll"` + delete `steam_settings/`.

---

## 3. Ready mutator (bot spawns)

UScript can't read the native net-cache, so the server drives "Ready". The mutator source is versioned in the repo — `server-mutator/MutBotAutoReady.uc`: on a timer it finds spectators and sets `bReadyToPlay=true` (→ `StartMatch` → spawn), logging `[BotAutoReady] ON MAP: ... pawn=KFHumanPawn`.

Build (`ucc make`, from the System folder via the junction):

```bash
# copy the source from the repo into the server tree (once / after edits), via the _kfds junction
mkdir -p _kfds/BotHelper/Classes
cp server-mutator/MutBotAutoReady.uc _kfds/BotHelper/Classes/MutBotAutoReady.uc

cd _kfds/System
# in KillingFloor.ini under [Editor.EditorEngine] add:  EditPackages=BotHelper
rm -f BotHelper.u
./UCC.exe make -nohomedir
# -> "Mutator exported successfully: BotHelper.MutBotAutoReady", BotHelper.u created
```

(the server must be stopped for this — otherwise `BotHelper.u` is locked).

---

## 4. Port and disabling uplink

To free up 7707 (if you want the relay on it) — the server port is changed to **7817** in `KillingFloor.ini [URL] Port=7817`. Changing the port kills the GameSpy-query actor, so uplink is disabled (in `[IpDrv.MasterServerUplink]`):

```
DoUplink=False
UplinkToGamespy=False
DoLANBroadcast=False
SendStats=False
```

If you don't need the relay — restore port 7707 and enable uplink (then there's no port conflict).

---

## 5. Launching the server

```bash
# sysDir defaults to the in-project _kfds/System (the first argument can be omitted)
node launch-server.js _kfds/System \
     KF-BioticsLab "VACSecured=false?MaxPlayers=6?AdminName=Admin?AdminPassword=kf123?Mutator=BotHelper.MutBotAutoReady"
```

`launch-server.js` starts `UCC.exe` via Node spawn (correct quoting of argv[0]). The server log goes to the background task's output. Wait for the line `Steam auth system activation successful`.

To test a **custom gametype** locally (stock is `KFmod.KFGameType`), set `KF_GAME`; the gametype's packages must be on the server's path (copy them into `_kfds/System/`), and campaign/objective modes need their own map (a standard `KF-` map forces `KFGameType`):

```bash
# real Story campaign on a story map
KF_GAME="KFStoryGame.KFStoryGameInfo" node launch-server.js _kfds/System KFO-Transit \
     "VACSecured=false?MaxPlayers=6?Mutator=BotHelper.MutBotAutoReady"
```

Check the port:

```bash
powershell.exe -NoProfile -Command "(Get-NetUDPEndpoint -LocalPort 7817 -ErrorAction SilentlyContinue|Measure-Object).Count"
```

---

## 6. Running the bot against your own server

```bash
node phase2_client.js --server 127.0.0.1:7817 --name Bot --ver 3339 --minver 3339 \
     --ready --ready-delay 5000 --leave-delay 10000
```

Success in the server log:

```
New Player Bot
[BotAutoReady] READY -> Bot
START MATCH
[BotAutoReady] ON MAP: Bot pawn=KFHumanPawn health=100 at <x,y,z>
```

---

## Stopping / cleanup

```bash
taskkill //F //IM UCC.exe        # stop the server
# revert Goldberg (if you need to return to live mode):
cp "_kfds/System/steam_api.dll.orig" "_kfds/System/steam_api.dll"
rm -rf "_kfds/System/steam_settings"
```
