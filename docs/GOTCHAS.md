# Gotchas

The implementation timeline was full of surprises. Collected here so we don't hit them twice.

---

## A. Protocol and reverse-engineering

1. **Control channel is ASCII text, not a binary `NMT_` enum.** At first I assumed a binary enum (`NMT_Hello`, …) — that's **UE3/UE4**. In UE2.5/KF the control channel exchanges **text commands** (`HELLO`, `CHALLENGE`, `LOGIN`, `USES`, `HAVE`, `WELCOME`, `JOIN`) — FStrings inside a bunch on channel 0. Confirmed against the UT2004 v3369 sources.

2. **Login authorization is a trivial integer function**, NOT CD-key/MD5/Steam: `RESPONSE = (Ch*237) ^ 0x93fe92Ce ^ (Ch>>16) ^ (Ch<<16)`. CD-key/MD5 functions do exist in the engine, but **not on the login path** (they're in the optional anti-cheat).

3. **`WriteInt`/`ReadInt` symmetry.** Implemented the `mask<max` form (fixed bit count) on both sides. For power-of-2 bounds (16384/1024/8/4096) and the small values of the single non-pow2 bound (`MAX_CHANNELS=1023`, channels 0..510) this matches the engine. The edge case (channel 511..1022) is theoretical, never hit in practice.

4. **Packet stop bit.** UE2 doesn't send a packet length — the receiver finds it by the **highest set bit** (the last '1' = stop bit, then zero-pad). Easy to forget and desync.

5. **GameSpy query port = game port + 10** (for KF: 7707 → 7717). This is the only layer readable directly from UScript.

---

## B. Building and running the dedicated server (UCC)

6. **Spaces in the path break UCC.exe.** The folder `Killing Floor Dedicated Server - Win32` contains spaces. UCC.exe (old UE2) **naively splits its command line on spaces** and takes a path fragment ("Dedicated") for the map name → `Failed to enter Dedicated: Can't find file`. **Fix:** a junction to a space-free path (`_kfds`) + launch via **`launch-server.js`** (Node `child_process.spawn` quotes argv[0] correctly). Direct launch from Git Bash or `cmd //c` doesn't help (MSYS mangles the quotes).

7. **`SteamAPI_Init failed` on the server is only a warning**, not fatal: the server comes up on an anonymous Steam game-server login and without a running Steam client (but then it doesn't validate tickets).

8. **Changing the server port kills the GameSpy query actor.** If you change `[URL] Port` in the ini, startup crashes with `UdpGamespyQuery PreBeginPlay Assertion failed`. **Fix:** disable uplink/LAN in the ini (`DoUplink=False`, `UplinkToGamespy=False`, `DoLANBroadcast=False`) — the query actor doesn't spawn.

9. **`BotHelper.u` is locked by a running server** — before `ucc make`, stop the server (`taskkill /F /IM UCC.exe`), otherwise `Device or resource busy`.

---

## C. Steam authentication (the main barrier)

10. **Old client build ≠ server build 1065.** The client game-install binaries (Steam → `KillingFloor`) do **NOT** call `BeginAuthSession` — hence an early false conclusion "Steam isn't needed". The real **dedicated server build 1065** does a full Steam GS-auth in the handshake. Always check the exact build you're testing against.

11. **`STEAMCLIENTBLOB`: 16 chunks + terminator, not 1 chunk.** The server decodes hex at **128 bytes per chunk** (offset `CHUNK*128`, `CHUNK<32`), and kicks off validation with **`STEAMTICKET SIZE=1 CHUNK=3`**. One chunk with no terminator → the server silently waits forever. Encoding is **lowercase hex** (`%02x`).

12. **`STEAM_TICKET_MIN_SIZE = (4+8+8+4) = 24` bytes.** My first dummy blob was 8 bytes → rejected. Need ≥24 bytes that don't collide with the magics `HEMU` (0x554d4548), `rev` (0x726576 at off 8), `0x14` (at off 0). The `0xAA` pattern is safe.

13. **Goldberg: a regular build with no config gives `Steam auth system activation failed`.** The GS interface isn't exposed. **Fix:** generate **`steam_settings/steam_interfaces.txt`** from the _original_ `steam_api.dll` (key string `SteamGameServer011`) + `steam_appid.txt=1250`. After that — `activation successful` + `Connected to Steam Servers` (emulated offline).

14. **Goldberg approves any unknown blob ≥24 bytes** via a `fallbackID` from the client IP (`SendUserConnectAndAuthenticate` → `validateTicket`, `block_unknown_clients=0` by default). In the log: `GS Approve ... SteamID [1:2130706433]` (2130706433 = 127.0.0.1).

15. **Real production can't be fooled.** There it's real Steam (`SECURE=1`) — to a dummy blob it answers `FAILCODE STEAMAUTH`. You need a genuine ticket (section E).

---

## D. Traffic capture (why the relay doesn't catch the real client)

16. **The real KF client, connecting to a Steam server, goes through Steam networking**, not direct UDP. The `KillingFloor.exe` process during "Connecting" **doesn't open a UDP socket** (verified with `netstat`/`Get-NetUDPEndpoint`); the server sees no plain-UDP connection. → **A UDP-MITM relay can't catch the real client at all.** Even a client with **Goldberg** drops into the Goldberg-LAN network (socket 47585), bypassing the relay. The relay only catches a plain-UDP client (our bot).

17. **Per-field net logs (`Invalid replicated field`, `Received RPC`) — `NAME_DevNetTraffic`, compiled out in the release `Engine.dll`.** Even with suppression removed in the ini, you only see `Channel %i got close-notify`. So you can't calibrate the RPC index by brute force over the logs.

---

## E. Real Steam ticket — FFI

18. **AppID 1250 conflict: server + client.** If the server holds 1250 in a running Steam, the Steam launcher refuses to start the game: "Game already running". **Order:** first launch the client through Steam (Play), then the server (GS-init coexists with a running game). And the client launched **directly via the exe** (bypassing Play) hangs on getting a Steam ticket without `steam_appid.txt`.

19. **`steam_api.dll` is 32-bit — a 64-bit process won't load it** (`Cannot load 'Intel 386+' DLL in 'AMD x64' process`). → need **32-bit Node** (`_steam32/node-v22.12.0-win-x86/`). The main bot is 64-bit, so the Steam part is split into a subprocess helper.

20. **koffi 3.x stores the native binary in `@koromix/koffi-win32-<arch>`** (optionalDependencies), NOT in `koffi/build/`. Under 32-bit node, `npm install @koromix/koffi-win32-ia32` failed on permissions → **downloaded the tarball straight from the npm registry** and unpacked `koffi.node` into `_steam32/node_modules/@koromix/koffi-win32-ia32/`.

21. **koffi can't call `__thiscall` through a pointer** (only cdecl/stdcall; `koffi.proto` with thiscall → "Only Cdecl and Stdcall callbacks are supported"). **Solution:** a tiny machine-code **thunk `stdcall→thiscall`** in RWX memory (`VirtualAlloc`), called through koffi as stdcall:

    ```
    8B 4C 24 04   mov ecx, [esp+4]   ; self -> ECX
    8B 14 24      mov edx, [esp]     ; retaddr
    83 C4 08      add esp, 8         ; drop retaddr + self
    52            push edx           ; retaddr back
    B8 <target>   mov eax, target
    FF E0         jmp eax            ; realfunc (thiscall) does its own ret N
    ```

    The stack balances: realfunc's `ret N` cleans its own args, `self` was removed by the thunk, the stdcall balance is fine.

22. **koffi's `bool` argument requires JS `true`/`false`**, not `1`/`0` ("Unexpected Number value, expected boolean"). That was the "crash" of the blob mode (the error was swallowed).

23. **koffi chokes on a `uint64` RETURN** (mistakes it for a struct-return with a hidden pointer). `GetSteamID` (vtable idx 2) returns uint64 → crash. **Workaround:** don't call SteamID, **read it from the ticket itself** (offset **0x0c**, standard GC ticket: first uint32 = `0x14` = `STEAM_APPTICKET_GCLen`).

24. **Useful `steam_api.dll` exports:** `SteamUser` (flat, returns `ISteamUser*`), `SteamAPI_Init`. Vtable `ISteamUser017`: `GetSteamID` = **idx 2 (0x08)**, `InitiateGameConnection` = **idx 3 (0x0c)**. `InitiateGameConnection` returns **int** (fine for koffi), the `serverID` argument is **uint64** (fine).

25. **`InitiateGameConnection` yields a ~212-byte ticket**, bound to (serverSteamID, serverIP in host order, serverPort, secure). The bot resolves the host-order IP from DNS; takes serverSteamID from `STEAMENCRYPTIONKEY`; secure from `SECURE=`.

---

## F. Ghidra (reverse-engineering Engine.dll)

26. **Ghidra 12 runs `.py` only through PyGhidra** (needs Python). Without Python — write **Java** scripts (Ghidra supports them natively). Class name == file name.

27. **A duplicate class name across different scriptPath folders breaks the OSGi bundle** for the whole directory ("Failed to get OSGi bundle"). Keep a single copy of a script; on jams clear the cache `%APPDATA%\ghidra\<ver>\osgi`. Better to keep scripts in an isolated subfolder (`_ghidra/kfscripts/`).

28. **UE's guard/unguard macros split the SEH catch into separate `Catch@...` functions** — the function-name string (`AActor::ProcessRemoteFunction`) sits in the catch stub, not in the body. Search for the **main function by symbol** (`fm.getFunctions().getName().contains(...)`); Ghidra demangles `Engine.dll` names.

29. Setup: JDK 21 + Ghidra 12 (`_ghidra/`), wrapper `run-ghidra.js` (sets `JAVA_HOME`/`PATH`). `-process` (without a `-noanalysis` re-import) reuses an already-analyzed project — fast.

---

## G. UnrealScript (server mutator)

30. **No `.Find()` on dynamic arrays** in this UScript → manual loop (`for i ... if arr[i]==`).
31. **`continue` is supported** (but `.Find` is not; don't confuse the two).
32. **No `int(x)` cast when `x` is already int** ("No need to cast IntProperty to itself") — `Pawn.Health` is already int.
33. **UScript can't read the native net cache** (`FClassNetCache`/`FieldNetIndex`) — you can't make a UScript hook that dumps net indices for RPC. So "Ready" is done with a mutator (`bReadyToPlay=true`), not a pure client RPC.
34. **`Mutator` is set via the launch URL** `?Mutator=BotHelper.MutBotAutoReady` + a build with `ucc make` and `EditPackages=BotHelper` in the ini.

---

## H. Environment and tooling

35. **`curl` couldn't reach `nodejs.org`** (though GitHub worked) — downloaded 32-bit Node via `powershell.exe -Command Invoke-WebRequest`.
36. The GUI game client (`KillingFloor.exe`) is launched manually; the headless dedicated server (UCC) can be started straight from Node.
37. **`Python` isn't installed** (only the Store stub); run `phase0_gamespy_query.py` after installing Python. Everything else runs on Node (which is present).
38. **7-Zip** (`C:\Program Files\7-Zip\7z.exe`) was used to unpack Goldberg/Node/Ghidra/tarballs.

---

## I. Move-to and possession

39. **`ClientAdjustPosition` NewLoc is NOT the floats right after `TimeStamp`.** A `name newState` + `EPhysics newPhysics` (~24 bits) sits between them, and the trailing `NewVel`/`NewBase` bytes bit-shift into *more* "sane"-looking float triples — so **scan for the FIRST sane `[present-bit][float32]×3` triple**, not the last (the last latched onto junk and walked the self dot the opposite way). Reversed byte-exact against the local server's `[GT]` pawn Location.

40. **Don't gate possession on correction cadence.** A "mis-latch" guard that released a pawn after ~6 s of no correction *thrashed* possession on heavier/slower servers — a correctly-owned pawn can legitimately go seconds without a correction mid-move (KFStatsX: `corr=4` + a stationary pawn *with* the guard, `corr=302` + a moving arriving pawn *without* it). A self-inflicted regression, caught only on a **stable local server**. Correction rate varies with server load; it is not a possession signal.

41. **A pawn's own `Location` isn't replicated to its owner** (authority-hidden — field-0 is junk). Self-position comes only from the `ClientAdjustPosition` correction stream; a *static* offset ClientLoc never elicits one (the server corrects only when it actually moves the pawn), so bootstrap with a small **oscillating acceleration** until the first correction lands.

42. **"Unresolved channel" ≠ decode bug.** On heavy mods (KFTurbo) most "unresolved" channels are pre-placed **map actors** (`LevelInfo`, trader doors) — instances, not static class refs, so they correctly don't resolve as a class. The decoder is fine; `pawns=0` there is mid-wave deferred spawn (a populated survival server doesn't spawn a mid-wave joiner), not a numbering fault.

---

## Short recap: "how to get past Steam"

- **Own server** → install Goldberg + `steam_interfaces.txt`, the bot sends a dummy blob (0xAA, ≥24 bytes), Goldberg approves; spawn via the server mutator.
- **Real server** → launch Steam (an account with KF), the bot generates a real ticket through the 32-bit FFI helper (`InitiateGameConnection`), the server validates against Steam.
