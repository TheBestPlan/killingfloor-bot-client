# Killing Floor Game Protocol (Unreal Engine 2.5)

Killing Floor runs on Unreal Engine 2.5 (the UT2004 / Red Orchestra line, `GameName=rom`). The net engine is **native** (`Engine.dll`/`IpDrv.dll`); none of it lives in UnrealScript. Everything below was reconstructed from:

- decompiled UScript (login/spawn/Ready flow),
- the real UT2004 v3369 sources (text control-channel, login formula),
- **Ghidra** decompilation of `Engine.dll` (KF Steam blob and RPC format),
- live capture against a real server.

---

## 1. Two network layers (don't conflate them)

| Layer                        | Purpose                                          | Implementation                                              |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **GameSpy/Query (UDP)**      | browser/ping/rules/players                       | **scripted** (`IpDrv/UdpGamespyQuery.uc`), port = game+10   |
| **Game NetConnection (UDP)** | gameplay: handshake, channels, bunches, replication | **native** (`[IpDrv.TcpNetDriver]`, physically UDP)      |

The GameSpy layer reads straight out of UScript → `phase0_gamespy_query.py`. The game layer I had to reverse-engineer from scratch.

---

## 2. Transport (bit stream)

Each UDP datagram is an **LSB-first bit stream** (`lib/bitstream.js`):

- `PacketId` = `ReadInt(MAX_PACKETID=16384)` at the start of the packet;
- then a sequence of **records**: each starts with an `IsAck` bit;
  - `IsAck=1` → `ackPacketId = ReadInt(MAX_PACKETID)`;
  - `IsAck=0` → **bunch**;
- at the end, a **stop bit '1'** + zero-pad to the byte (the receiver finds the length from the highest set bit).

**Bunch header:**

```
bControl  = ReadBit
bOpen     = bControl ? ReadBit : 0
bClose    = bControl ? ReadBit : 0
bReliable = ReadBit
ChIndex   = ReadInt(MAX_CHANNELS=1023)
ChSeq     = bReliable ? ReadInt(MAX_CHSEQUENCE=1024) : 0
ChType    = (bReliable||bOpen) ? ReadInt(CHTYPE_MAX=8) : 0
NumBits   = ReadInt(MaxPacket*8)         # MaxPacket ≈ 512
<NumBits bits payload>
```

Channels: **0 = Control** (`CHTYPE_Control=1`), Actor = 2, File = 3.

(De)serialization primitives (`lib/bitstream.js`):

- `WriteInt(value,max)` / `ReadInt(max)` — `ceil(log2(max))` bits (`mask<max` form);
- `FString` — `FCompactIndex` length (+1 for the NUL) + bytes; `len>0` ANSI, `len<0` UNICODE;
- `FCompactIndex` — signed varint: 1st byte `0x80`=sign, `0x40`=continue, `0x3f`=data; following bytes `0x80`=continue, `0x7f`=data.

Implemented and verified: `test/bitstream.test.js` (56/56), `test/netconn.test.js` (19/19).

---

## 3. Control-channel handshake is ASCII TEXT

> **Key correction:** the UE2.5 control channel is **text commands** (FStrings in a bunch on channel 0), **not** the binary `NMT_` enum (that's UE3/UE4). Confirmed against the UT2004 v3369 sources.

Flow (with the KF Steam extension — see §4):

```
C→S: HELLO REVISION=0 MINVER=%i VER=%i STEAMID=%I64u
S→C: STEAMENCRYPTIONKEY %s                              (KF extension, Steam step)
C→S: STEAMCLIENTBLOB SIZE=.. CHUNK=.. BLOB=..  ×16      (Steam ticket, hex chunks)
C→S: STEAMTICKET SIZE=1 CHUNK=0..3                      (terminator; CHUNK=3 = validation trigger)
S→C: CHALLENGE VER=%i CHALLENGE=%i STATS=%i SEC=%i GZ=%i
C→S: NETSPEED %i        (opt.)
C→S: LOGIN RESPONSE=%i URL=%s
S→C: USES GUID=.. PKG=.. FLAGS=.. SIZE=.. GEN=.. FNAME=..   ×N
C→S: HAVE GUID=.. GEN=..                                     ×N   (this avoids download)
S→C: WELCOME LEVEL=.. ...
C→S: JOIN
S→C: FAILCODE STEAMAUTH / STEAMVACBANNED / ...  (on rejection)
```

**Login authorization is a trivial int function** (NOT a CD-key, NOT MD5, NOT Steam), from UT2004 v3369 `UGameEngine::ChallengeResponse`:

```c
RESPONSE = (Challenge*237) ^ 0x93fe92Ce ^ (Challenge>>16) ^ (Challenge<<16)
```

Implemented in `phase2_client.js` (`challengeResponse`).

---

## 4. KF Steam handshake (reverse-engineered via Ghidra)

KF/Tripwire bolted their own Steam step on top of UT2004. From `Engine.dll`:

- `HELLO ... STEAMID=%I64u` — client sends its SteamID;
- server → `STEAMENCRYPTIONKEY ...` (its SteamID + SECURE);
- client builds the blob (see below) and sends `STEAMCLIENTBLOB` + `STEAMTICKET`;
- server: `SendUserConnectAndAuthenticate(blob, SIZE)` → validation → `CHALLENGE` or `FAILCODE`.

**`STEAMCLIENTBLOB` format** (from decompiling `NotifyReceivedText` / the client builder):

1. client takes an auth blob (for Goldberg — any ≥24 bytes; for real Steam — a ticket from `InitiateGameConnection`, see §6);
2. **hex-encodes** each byte (lowercase `%02x`), zero-padded;
3. sends **16 chunks**: `STEAMCLIENTBLOB SIZE=<real size> CHUNK=0..15 BLOB=<256 hex = 128 bytes>`;
4. sends **4 terminators**: `STEAMTICKET SIZE=1 CHUNK=0..3`.

The server decodes the hex, packs it **128 bytes/chunk** into the `conn+0x478` buffer (offset `CHUNK*128`, `CHUNK<32`), and on **`STEAMTICKET CHUNK=3`** calls `SendUserConnectAndAuthenticate`.

Implementation — `phase2_client.js`: `sendSteamBlob()` + the `STEAMENCRYPTIONKEY` handler.

### Steam auth: two ways through

- **Goldberg on the server**: with an unknown ticket format and `block_unknown_clients=0` (default), `validateTicket` sets `data.id = fallbackID` from the client IP and **approves**. Minimum — a blob ≥ `STEAM_TICKET_MIN_SIZE = 24` bytes that doesn't match the `HEMU`/`rev`/`0x14` magics. The bot sends 0xAA.
- **Real Steam**: needs a genuine ticket (see §6); the server validates against the Steam backend.

---

## 5. Login → spawn → Ready (from UScript)

After `JOIN` the server: `PreLogin` (ban check) → `Login` → spawns `KFPlayerController` in `Spectating`→`PlayerWaiting`. The bot is a connected spectator.

'Ready' at the game-logic level = the reliable RPC **`ServerRestartPlayer()`** (`Controller.uc:168`, `KFPlayerController.uc:738`): sets `PlayerReplicationInfo.bReadyToPlay=true`. Optionally `SelectVeterancy(<perk>)` before it. Once everyone's ready the server → `StartMatch` → `RestartPlayer` → spawns `KFHumanPawn`. KF is always `bDelayedStart=true` (lobby/ready).

---

## 6. Real Steam ticket (FFI to steam_api.dll)

To pass auth on a **real** server, the bot generates a genuine ticket through `steam_api.dll`:

- `ISteamUser017::InitiateGameConnection` (vtable **idx 3, offset 0x0c**) → `int InitiateGameConnection(void* blob, int cbMax, CSteamID serverID, uint32 ip, uint16 port, bool secure)`;
- returns a ~212-byte ticket (standard GC: first uint32 = `0x14` = `STEAM_APPTICKET_GCLen`, SteamID inside at offset **0x0c**).

`steam_api.dll` is 32-bit → needs a 32-bit process (`_steam32/`). koffi can't do `__thiscall` through a pointer → a machine-code thunk `stdcall→thiscall`. Full write-up in [GOTCHAS.md](GOTCHAS.md).

---

## 7. Phase 3 — RPC `ServerRestartPlayer` (Ready) — format + field index

From `Engine.dll` (`AActor::ProcessRemoteFunction` → `ReplicateFunction`): an outgoing RPC = **a reliable bunch on the actor's actor channel, payload = `WriteInt(FieldNetIndex, GetMaxIndex())`** followed by each parameter via `NetSerializeItem` (for a parameterless function that's the whole payload). The server reads `ReadInt(FClassNetCache::GetMaxIndex())`.

The three runtime values it needs come from `KFPlayerController`'s **net cache**, which the engine derives from the loaded `.u` files at connect time. UScript can't read them, but they can be **computed offline from the same `.u` files** — that's what `lib/upackage.js` + `lib/netcache.js` do (see §8). For KF build 1065:

| Field (`KFPlayerController`)   | `FieldNetIndex` | `GetMaxIndex` (bit width) |
| ------------------------------ | --------------- | ------------------------- |
| `ServerReStartPlayer` (Ready)  | 61              | 281 (9 bits)              |
| `ServerMove`                   | 75              | 281                       |
| `ServerAcknowledgePossession`  | 104             | 281                       |
| `SelectVeterancy`              | 252             | 281                       |

**Confirmed live:** a bot sending `ServerReStartPlayer(61, 281)` on its PlayerController channel readies itself (no mutator), and `ServerSay`(135)/`ServerTeamSay`(136) post chat that the server broadcasts. Two things matter for RPCs with params:

- **The field index is written value-aware** (`writeIntUE`, `(Value+Mask)<Max`), not the framing `Mask<Max` form. They differ by a bit for some values (135→281 = 8 bits value-aware vs 9 bits framing); a wrong width shifts every following param. `ServerReStartPlayer` only worked by luck (61/281 is 8 bits either way).
- **Each parameter is preceded by a presence bit**, then the value via `NetSerializeItem` (string = FString). So `ServerSay("hi")` = `writeIntUE(135,281)` · `bit 1` · FString.

**Inbound chat** (`lib/worldstate.js` `tryChat`) — `TeamMessage(PRI, S, Type)` arrives as an RPC on the PlayerController channel: `[handle=120][PRI: bit + actor-object(11b)][S: bit + FString]…`. Reversed and confirmed live (a bot sees its own message echoed). `ClientMessage`(119) is the system-message variant.

**`ServerMove`(75)** is the movement RPC. KF's signature (export order) is `ServerMove(int OldAccel, byte NewActions, float TimeStamp, vector InAccel, vector ClientLoc, byte OldTimeDelta, int View, int FreeAimRot, byte ClientRoll, byte DoubleClickMove)`. Findings from live testing:

- **RPC param gating is per property class.** `Object`/`Str` params carry a presence bit (chat); `Int/Byte/Float/Struct` do **not**. Sending presence bits for the numeric/struct params misaligned the stream into garbage that crashed `TickLevel`; sending all params with **no gate bits** (and vectors as three full floats, not the actor-location packed form) stopped the crash — the alignment is correct.
The move now **works** — the pawn moves in response. Three things had to be right:

- **Param declaration order** (not export order). The `.u` property header is `[compactA][compactB][Next][u32 ArrayDim][u32 Flags]` — the **3rd compact is `UField.Next`**. Following it through ServerMove's Children gives the real wire order: `TimeStamp, InAccel, ClientLoc, NewActions, DoubleClickMove, ClientRoll, View, FreeAimRot, OldTimeDelta, OldAccel` (TimeStamp first, like classic UT2004). Export order put a large InAccel value in the TimeStamp slot → huge DeltaTime → crash.
- **Every param takes a presence bit** (confirmed by decoding an inbound `ReceiveLocalizedMessage`, whose `Int` param carried a gate=0). Send `bit 1` + value per param.
- **`TimeStamp`/`ClientLoc`.** With the order fixed, `Acceleration` goes non-zero and the pawn moves; the server corrects it back toward the claimed `ClientLoc`. The owner's own pawn `Location` is **NOT replicated to the owner** (authority-hidden — field-0 is junk), so self-position comes from the server's **`ClientAdjustPosition`** correction stream, not the pawn's Location (see §8). `moveTo` is guarded to need a self position first, so it never crashes a server.

**Move-to is solved end-to-end** (`botsession.moveTo` / `_tickMove`): the pawn walks to a clicked/nav-routed point and the self dot follows, verified against the local dedicated server's ground truth (pawn travels at GroundSpeed) and by `<<< MOVE arrived` on live servers. Making possession stick took: (1) **self-confirm bootstrap** — a possessed-but-uncorrected pawn (`corr=0`) never gets a correction from a *static* offset ClientLoc, so `_syncPosition` drives a small **oscillating acceleration** until the first correction lands (the server only corrects when it actually moves the pawn); (2) routing the move through the map **nav graph** (ReachSpec A\*) so it follows walkable floor around walls; (3) re-issuing after a deferred/timer respawn and aborting a stale route when the possessed pawn changes. Confirmed on 13+ servers across 7 gametype/PC families (stock KFMod, ULMod/`KFPCServ`, KFStatsX/`KFSXPlayerController`, ScrnBalanceSrv, KF15Beta, Umbrella/UZ, `KFStoryGame` campaign) + the local dedicated server. Non-arrivals reduce to server-side spawn timing (populated survival servers don't spawn a mid-wave joiner) and the bot having no combat AI (an unarmed pawn dies if instantly swarmed) — both match real-client behaviour, not a move-mechanism defect.

`botsession.js` fills these from the net cache when `--system-dir <…\System>` is given (`_calibrateRpc`), so the bot can press Ready itself on **any** server whose `.u` set it has, instead of relying on the server-side mutator (`BotHelper.MutBotAutoReady`, `bReadyToPlay=true` — still the fallback when no `.u` files are available). The PC actor-channel index is the one remaining runtime value; it comes off the wire (§8), not the `.u` files (a channel sweep or the PlayerController's replicated `Pawn` ref finds it).

The Ghidra project and scripts are in `_ghidra/` (`rpcfmt.java` → `rpc-out.log`, `netfmt.java` → `netfmt-out.log`, `dec1.java`).

---

## 8. Inbound replication decode + net cache

The server streams the world as **replicated-property bunches** on actor channels. Decoding them (HP, armor, perk, positions) needs the per-class **net cache**: the ordered list of replicated fields, each with the net index used on the wire. The engine builds it from the `.u` files; `lib/upackage.js` (UE2 `.u` reader) + `lib/netcache.js` rebuild the same thing offline.

**`.u` package reader** (`lib/upackage.js`): parses the header/name/import/export tables (KF magic `0x9E2A83C2`, file version 128) and resolves object refs. A class's fields are the exports whose Outer is that class; a **property** is replicated when `PropertyFlags & CPF_Net (0x20)`, a **function** when `FunctionFlags & FUNC_Net (0x40)` (net functions append a 2-byte `RepOffset`, so their flags sit at `serialSize-6`, else `serialSize-4`).

> **PropertyFlags is not at a fixed offset.** The UProperty header is `[3 FCompactIndex][u32 ArrayDim][u32 PropertyFlags]`; the 3rd compact is variable-length, so `PropertyFlags` lands at offset 7/8/9 depending on the property (`Location/Rotation/Role/Velocity/Owner` at 7, `Instigator` at 8, …). A hardcoded offset-8 read silently dropped every net prop whose flags sat elsewhere — ~30 Actor props — which shifted **every** net index and broke both the Ready RPC and inbound decode. `propertyFlags()` now parses the header.

**Net cache** (`lib/netcache.js`): walk the class hierarchy base→derived across packages (`KFHumanPawn`: `Object→Actor→Pawn→UnrealPawn→xPawn→KFPawn→KFHumanPawn`, spanning `KFMod/XGame/Engine/Core`), and number every replicated field (properties + net functions, in export order) with a running index. That count is `GetMaxIndex`. **Validated against ground truth** by decoding the capture at known string values — the bot's own name and character land exactly: `KFPlayerReplicationInfo.PlayerName = wire index 57` (`"TestBot"`), `CharacterName = 82` (`"Police_Sergeant_Davin"`); `KFHumanPawn.Health = 58` (GetMaxIndex 144). Self-test: `test/netcache.test.js`.

**Bunch loop** (from `UActorChannel::ReceivedBunch`, `_ghidra/rpc-out.log`):

```
if bOpen: actor = SerializeObject(bunch)      # spawns the actor from its class ref
loop:
  handle = ReadInt(GetMaxIndex)               # value-aware (Value+Mask)<Max form
  field  = NetCache.GetFromIndex(handle)
  if field is a property:
    if ArrayDim != 1: arrayIndex = ReadByte   # static arrays only
    value = field.NetSerializeItem(bunch)      # per-type, see below
  else (function/RPC):
    for each param: [optional 1 gate bit] param.NetSerializeItem(bunch)
```

**`SerializeObject` = net GUID** (from `UPackageMapLevel::SerializeObject`, `_ghidra/netfmt-out.log`):

```
bit = ReadBit
if bit == 1:  idx = ReadInt(1024)  -> Connection.Channels[idx].Actor   # dynamic actor (idx 0 = null)
if bit == 0:  idx = ReadInt(MaxObjectIndex) -> PackageMap.IndexToObject(idx)  # static package object
```

So **actor references travel as channel indices** — e.g. `PlayerController.Pawn` (index 21) or `Pawn.PlayerReplicationInfo` name the target channel directly, which is how a channel is tied to its actor without the package map. Static objects (classes, meshes) still need the package-map object ordering (`MaxObjectIndex`).

**Decoder** (`lib/repdecode.js`, `lib/worldstate.js`): `decodeBunch` walks the property loop with the type readers — `Int/Byte/Bool/Float` = `32/8/1/32` bits, `Str` = FString, `Object` = the net GUID above (actor→channel resolves without a package map). **Packed vector** (reversed from `Engine.dll FUN_103fada0`, `_ghidra/vecfmt-out.log`): components are rounded to ints, then `numBits = ReadInt(20)+1; bias = 2^(numBits+1); each = ReadInt(2^(numBits+2)) - bias` — validated against monster movement tracks. `WorldState` turns this into GUI state: my PRI is the channel whose open bunch carries my name (`PlayerHealth`→HP, `ClientVeteranSkillLevel`→EXP); my pawn is the pawn channel whose `Health` tracks my `PlayerHealth`; every pawn channel's `Location` feeds the map (bounded + continuous = real). **Confirmed live:** HP decoded off the wire dropping `92→0` as the bot took damage.

**Self-position via `ClientAdjustPosition`** (`WorldState.tryClientAdjust` / `selfPos`): the owner's own pawn `Location` is authority-hidden, so the only source of truth is the server's correction RPCs — `VeryShort`/`Short`/`Long`/`ClientAdjustPosition` on the PC channel. Their `NewLocX/Y/Z` is **three consecutive `[present-bit][float32]` params (33 bits each), NOT immediately after `TimeStamp`** — a `name newState` + `EPhysics newPhysics` (~24 bits) sits between them on every variant. Reversed byte-exact against the local server's `[GT]` pawn Location: read the payload and take the **FIRST** sane present-framed float triple (the trailing `NewVel`/`NewBase` bytes bit-shift into more "sane" triples, so taking the last latched onto junk and walked the dot the wrong way). Custom PlayerControllers place these RPCs at different net indices, so the handles come from the resolved PC class (`_adjustInfo`), not the stock cache.

**Package-map object ordering** is solved (`lib/pkgmap.js`): the net object table = the running sum of each `ServerPackages`/`USES` package's export count, in USES order (map package first, then Engine/Core, …). `MaxObjectIndex` is that total; `classIdxFor` reads an open bunch's static class ref (`bit=0` → `ReadInt(MaxObjectIndex)`) and `resolveLoc` maps it to the owning package's class export — so channels classify off their real class, no pawn-probe heuristic needed. `FRotator` net form is `gated8` (`FRotator::SerializeCompressed`: a presence bit per axis, then the top byte `Pitch>>8`); it is NOT a possession lever, though — a server never replicates view rotation back to the owning client, so the PC channel carries no `Rotation`.

**Still open / limited:**

- **`ShieldStrength`/`CurrentWeight`** (armor/load) still decode only when they sit before an undecodable struct in a given bunch.
- **Heavy total-conversion mods** whose `ServerPackages` stream is long enough that the client must JOIN before it fully arrives (e.g. KFTurbo, 700+ packages): the object table is built from a partial USES set. Decode of the channels we *do* see is correct (the many "unresolved" channels are pre-placed map actors — `LevelInfo`, trader doors — which are instances, not class refs, and correctly don't resolve). Possession there is limited by mid-wave spawn timing, not the decoder.

---

## Sources

- Decompiled KF UnrealScript.
- UT2004 v3369 sources (text protocol, login formula).
- Ghidra decompilation of `Engine.dll` (Steam blob, RPC format) — `_ghidra/`.
- Goldberg (gbe_fork) `auth.cpp` (server-side validation logic) — `github.com/Detanup01/gbe_fork`.
- Architecture reference: `github.com/xMlex/l2walker` (Java, but L2 protocol, not UE).
