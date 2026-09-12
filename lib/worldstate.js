// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Turn decoded actor-channel replication into game state for the GUI:
 *   - my stats (HP/EXP from my PlayerReplicationInfo, armor/load/HP from my pawn),
 *   - map objects (players/monsters) from pawn Location updates.
 *
 * Channels are matched without a package map (which classes them by object index): my PRI is the
 * channel whose open bunch carries my player name; my pawn is the channel whose PlayerReplicationInfo
 * points back at that PRI channel; every actor channel is probed as a pawn and a position is trusted
 * only when it is bounded and continuous with that channel's history (rejects mis-decoded noise).
 */
const { BitReader } = require('./bitstream');
const { PackageSet } = require('./netcache');
const { decodeBunch, readIntUE, readObject, readPackedVector } = require('./repdecode');
const { classifyName } = require('./netobjmap');
const { PackageMap } = require('./pkgmap');

const MAP_BOUND = 30000;      // uu; positions beyond are decode noise
const MAX_STEP = 2600;        // uu between consecutive updates for a real actor (sparse updates + sprinting zeds)
const STALE_MS = 10000;       // keep an object this long after its last clean update (bursty replication)

// Every KF pawn/monster class shares the base-Actor net layout (Location@0, Rotation@2, Velocity@4, Health@58),
// but the TOTAL replicated-field count differs per class and sets the wire handle's bit width. Decoding every
// pawn against one template (KFHumanPawn, len 144) misreads the first handle for any class whose count lands in
// a different bit bracket (Pawn 107 / xPawn 115 / KFMonster 128 = 7 bits vs 129-256 = 8 bits). When a channel's
// class can't be resolved (custom modded pawn), we scan these candidate counts and keep the one whose Location
// decodes bounded + continuous. Covers the stock pawn/monster hierarchy plus common bracket boundaries.
const PAWN_FIELD_COUNTS = [107, 115, 128, 129, 130, 144, 160, 192, 256];

// Standard Killing Floor (build 1065) monster base Health at Normal difficulty, one player. The exact
// class can't be resolved from the wire (it lives in the actor's class ref, a net-index into the
// connection's package map that includes the server's custom map/content packages the client never
// downloads), so instead we name a monster by its Health: the server scales every monster's Health by
// one shared difficulty*player-count modifier, which we fit at runtime, then snap each to this roster.
// ponytail: hardcoded stock roster; modded/custom zeds won't match and stay unnamed (they show HP).
const MONSTER_BASE_HP = {
  Crawler: 65, Clot: 100, Stalker: 125, Gorefast: 150, Bloat: 250,
  Siren: 350, Husk: 500, Scrake: 1000, Fleshpound: 1500, Patriarch: 2000,
};

// Fit the single global Health modifier shared by all live monsters, then name each whose de-scaled
// Health lands on a roster base. Needs >=2 monsters and majority agreement to name anything (a lone
// monster's Health is ambiguous - 500 could be Husk*1 or Scrake*0.5), so it never shows a confident
// wrong label; unmatched monsters get null (the caller falls back to raw HP). samples: [{ch, hp}].
function classifyMonsters(samples, roster = MONSTER_BASE_HP) {
  const out = {};
  for (const s of samples) out[s.ch] = null;
  if (samples.length < 2) return out;
  const bases = Object.values(roster), names = Object.keys(roster);
  const FIT_TOL = 0.08, NAME_TOL = 0.1;
  const nearestErr = (h, m) => Math.min(...bases.map((b) => Math.abs(h / m - b) / b));
  // Modifier floor 0.8: the server scales monster Health from the Normal/solo base UP with difficulty
  // and player count (never far below base), so a sub-0.8 "fit" is an artifact - rejecting it stops the
  // classifier from re-reading a Clot(100) as a de-scaled Gorefast, etc.
  const candidates = [];
  for (const s of samples) for (const b of bases) { const m = s.hp / b; if (m >= 0.8 && m <= 10) candidates.push(m); }
  let best = { m: 1, score: -1, err: Infinity };
  for (const m of candidates) {
    let score = 0, err = 0;
    for (const s of samples) { const e = nearestErr(s.hp, m); if (e <= FIT_TOL) { score++; err += e; } }
    if (score > best.score || (score === best.score && err < best.err)) best = { m, score, err };
  }
  if (best.score < Math.ceil(samples.length / 2)) return out;   // low confidence -> name nothing
  for (const s of samples) {
    let name = null, d = NAME_TOL;
    for (let i = 0; i < bases.length; i++) { const dd = Math.abs(s.hp / best.m - bases[i]) / bases[i]; if (dd < d) { d = dd; name = names[i]; } }
    out[s.ch] = name;
  }
  return out;
}

// A valid replication bunch carries its fields in ascending net-index order; anything else is a
// mis-decode. Used to reject phantom map positions from bunches decoded against the wrong layout.
function monotonic(fields) {
  let prev = -1;
  for (const f of fields) { if (f.index <= prev) return false; prev = f.index; }
  return fields.length > 0;
}

// Pull a player's name out of a PRI's OPEN bunch. The per-field replication decoder can't touch open
// bunches (they lead with an undecodable class ref) and mis-reads the tiny update bunches, so instead
// we scan every bit offset for a valid FString (ANSI or UTF-16) and take the earliest name-like one:
// in a PRI the fields replicate in index order, so PlayerName (57) precedes CharacterName (82).
// ponytail: heuristic string sniff - could latch a stray earlier string; validated on live captures
// (ch67 -> "24kmagick", not the "Harold_Hunt" character that follows it).
// A sniffed name that reads as a monster (stock or a common modded variant), so it never lands in the
// players list. Substring roots catch "MetalClot", "RageScrake", "WTFGoreallyfast", "Fleshpound1" too.
const MONSTER_NAME_RE = /clot|crawler|gorefast|gore|stalker|bloat|siren|scrake|fleshpound|patriarch|husk|brute|zombie|specimen|\bzed\b/i;
function looksLikeMonster(name) { return MONSTER_NAME_RE.test(String(name || '')); }

function extractName(hex, numBits) {
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  for (let s = 0; s + 16 <= numBits; s++) {
    for (const unicode of [false, true]) {
      const br = new BitReader(buf, numBits); br.pos = s;
      let len; try { len = br.readIndex(); } catch (e) { continue; }
      const cnt = unicode ? -len : len;
      if (cnt < 3 || cnt > 25) continue;   // >=2 visible chars (drops stray 1-char decodes)
      if (br.bitsLeft() < cnt * (unicode ? 16 : 8)) continue;
      let str = '', bad = false;
      for (let i = 0; i < cnt - 1; i++) {
        const c = unicode ? (br.readByte() | (br.readByte() << 8)) : br.readByte();
        if (c < 0x20 || c > 0x7e) { bad = true; break; }
        str += String.fromCharCode(c);
      }
      if (bad) continue;
      if (!unicode && br.readByte() !== 0) continue;       // ANSI FString is null-terminated
      if (!/[A-Za-z]/.test(str) || /^\d{15,20}$/.test(str)) continue;   // need a letter; reject SteamIDs
      if (/[\/\\]/.test(str) || /\bhttps?\b/i.test(str)) continue;      // reject URLs/paths (server MOTD etc.)
      if (/^[A-Z][A-Za-z0-9]+\.[A-Z]/.test(str)) continue;             // reject Package.Class names (KFMod.KFGameType)
      return str;
    }
  }
  return null;
}

class WorldState {
  constructor(systemDir, myName, opts = {}) {
    this.systemDir = systemDir;
    this.usesOrder = [];          // package-map order captured from the handshake's USES lines
    this.pkgMap = null;           // PackageMap: exact class-ref index -> class name (built from the .u files)
    this.classOf = {};            // channel -> resolved class name
    this.mapActors = null;        // static trader/door positions read from the map .rom (server-only actors)
    this._mapActorsTried = false;
    this.ps = new PackageSet(systemDir);
    this.pawn = this.ps.netFields('KFHumanPawn');
    this.pri = this.ps.netFields('KFPlayerReplicationInfo');
    this.pc = this.ps.netFields('KFPlayerController');
    // KFGameReplicationInfo carries the live wave state a real client shows (wave number, trader countdown,
    // wave-in-progress). A custom GRI (modded KFGameTypeX) extends this class, so the inherited fields keep
    // these net indices. FinalWave is bNetInitial (rides the open bunch), so it's best-effort.
    this.gri = this.ps.netFields('KFGameReplicationInfo');
    this.griIdx = {
      waveNumber: this.field(this.gri, 'WaveNumber'), finalWave: this.field(this.gri, 'FinalWave'),
      waveInProgress: this.field(this.gri, 'bWaveInProgress'), timeToNextWave: this.field(this.gri, 'TimeToNextWave'),
      maxMonsters: this.field(this.gri, 'MaxMonsters'),
    };
    this.griChannel = null;
    this.wave = null;   // { wave, finalWave, waveInProgress, timeToNextWave, maxMonsters, aliveMonsters }
    this.priNames = {};          // PRI channel -> player name (for chat "from")
    this.priHealth = {};         // PRI channel -> PlayerHealth (KF replicates every player's HP on their PRI,
                                 // scoreboard-style - gives other players' alive/dead/HP with no pawn link)
    this.openBunches = {};       // channel -> latest open bunch {hex, numBits} (name is sniffed from here)
    this._nameChecked = {};      // channels whose open bunch we've already sniffed for a name
    this.mySteamId = opts.steamId || null;   // reliable self anchor: my PRI's open bunch carries this
    this.pendingChat = [];       // inbound chat messages, drained by the session
    this.idx = {
      health: this.field(this.pawn, 'Health'), velocity: this.field(this.pawn, 'Velocity'),
      shield: this.field(this.pawn, 'ShieldStrength'),
      weight: this.field(this.pawn, 'CurrentWeight'), maxWeight: this.field(this.pawn, 'MaxCarryWeight'),
      healthMax: this.field(this.pawn, 'HealthMax'), pawnPRI: this.field(this.pawn, 'PlayerReplicationInfo'),
      playerHealth: this.field(this.pri, 'PlayerHealth'), vet: this.field(this.pri, 'ClientVeteranSkillLevel'),
      playerName: this.field(this.pri, 'PlayerName'),
      veryShortAdjust: this.field(this.pc, 'VeryShortClientAdjustPosition'),
      clientAdjust: this.field(this.pc, 'ClientAdjustPosition'),   // full correction: TimeStamp, Loc x/y/z, Vel...
      clientRestart: this.field(this.pc, 'ClientReStart'),   // server tells us WHICH pawn we possess
      pcPawn: this.field(this.pc, 'Pawn'),                   // Controller.Pawn replicated on our PC channel = our pawn
    };
    // KFPlayerController overrides ClientReStart, so the net table holds both the base (PlayerController) and
    // the derived index; the server may send either - accept all of them.
    this.clientRestartHandles = new Set(this.pc.filter((f) => f.isFunc && f.name === 'ClientReStart').map((f) => f.index));
    this.serverAckPawn = null;   // pawn channel the server's ClientReStart told us to possess (authoritative)
    this.unpossessed = false;    // Controller.Pawn was replicated as None -> we died / went spectator
    // The server picks ONE of four position-correction RPCs by how far our reported ClientLoc has drifted:
    // Very Short (tiny), Short, full ClientAdjust (adds velocity), or Long (adds state/physics). All carry
    // NewLoc X/Y/Z as consecutive floats, so any of them confirms possession and gives our authoritative
    // position - detecting only VeryShort missed the corrections servers send when we lag far behind.
    this.adjustHandles = new Set([
      this.field(this.pc, 'VeryShortClientAdjustPosition'), this.field(this.pc, 'ShortClientAdjustPosition'),
      this.field(this.pc, 'ClientAdjustPosition'), this.field(this.pc, 'LongClientAdjustPosition'),
    ].filter((i) => i >= 0));
    this.selfAdjustPos = null;   // my authoritative position from the server's move corrections
    this.corrCount = 0;          // corrections received (lets the mover tell "no news" from "same-spot news")
    this.corrected = false;      // true once a real ClientAdjustPosition arrived => possession is confirmed
    this.myName = myName;
    this.now = opts.now || (() => 0);       // injectable clock (Date-free core)
    this.myPri = null; this.myPawn = null;
    this.myPlayerHealth = null;              // from my PRI, used to spot my pawn among pawns
    this.myHealthSeen = new Set();           // distinct PlayerHealth values I've had
    this.pawns = new Set();                  // channels that have shown a sane pawn Health
    this.pawnHealthSeen = {};                // channel -> Set of its Health values (overlap picks my pawn)
    this.priChannels = new Set();            // channels a pawn's PlayerReplicationInfo pointed at (real PRIs)
    this.playerPawns = new Set();            // pawn channels owned by another player's PRI (map = blue)
    this.pawnOwner = {};                     // pawn channel -> its PRI channel (for the nickname)
    this.myPawnSeen = 0;                     // last time my pawn got a fresh Health/position (staleness guard)
    this.myPawnHp = null;                    // last Health decoded for my own pawn
    this.pawnHp = {};                        // pawn channel -> last Health (for the players list)
    this.stats = { hp: null, hpMax: 100, armor: null, armorMax: 100, expPct: null, load: null, loadMax: 100 };
    this.objects = {};                       // chIndex -> { type, x, y, z, t }
    this._netByClass = {};                   // resolved class name -> its net-field cache (correct handle widths)
    this._locMax = {};                       // channel -> the field-count that decodes its Location (custom classes)
    this._scanTries = {};                    // channel -> field-count scan attempts (bounded; non-pawns never lock)
    this._isPawnCls = {};                    // class name -> is it a Pawn subclass (players/monsters, not effects)
    this.selfEstimate = null;                // dead-reckoned own position, seeded + snapped by corrections
    // The server's package-map size (MaxObjectIndex) sizes every static object ref (Mesh/Material/class)
    // in the wire - without it the decoder desyncs at the first such field, hiding EXP/Load/etc. It's a
    // per-connection constant we recover by brute force: the value that makes the most pawn update
    // bunches decode fully is it. Server-agnostic; no package downloads needed.
    this.maxObjIndex = 0;
    this._objSample = [];
    this._objEstimated = false;
    this.debugSelf = false;        // opt-in self-position tracing (botsession's periodic _debugSelfTick reads it)
  }

  // Score a candidate MaxObjectIndex by sampled pawn bunches that decode complete, in-order AND with
  // sane values. Value sanity is what separates the true value from a smaller M that mis-frames the
  // static ref yet still happens to decode monotonically into garbage floats.
  _scoreObjIndex(m) {
    let ok = 0;
    for (const [bits, hex] of this._objSample) {
      const d = decodeBunch(hex, bits, this.pawn, { maxObjectIndex: m });
      if (!d.complete || !d.fields.length) continue;
      let prev = -1, good = true;
      for (const f of d.fields) {
        if (f.index <= prev) { good = false; break; }
        prev = f.index;
        if (typeof f.value === 'number' && (!isFinite(f.value) || Math.abs(f.value) > 1e7)) { good = false; break; }
        if (Array.isArray(f.value) && f.value.some((c) => Math.abs(c) > 3e4)) { good = false; break; }   // vector out of world bounds
      }
      if (good) ok++;
    }
    return ok;
  }

  // Recover MaxObjectIndex: coarse-scan for the peak, refine, and lock ONLY when the peak decisively
  // beats the M=0 baseline (i.e. static-ref bunches now decode) - otherwise keep sampling.
  _estimateObjIndex() {
    if (this._objEstimated || this._objSample.length < 60) return;
    const base = this._scoreObjIndex(0);
    const decisive = base + Math.max(4, (base * 0.03) | 0);
    // Strong prior: when only a small tail of the package list is missing, the object table is exact up to
    // the gap, so the true MaxObjectIndex sits just above pkgMap.baseObjectIndex (the missing tail rarely
    // crosses a power-of-two, so the same bit width decodes the refs). Try that narrow band first - it locks
    // from far fewer samples than the blind 4096..2^20 sweep and never invents a value the bunches reject.
    const prior = this._pkgBase || 0;
    if (prior >= 64) {
      let best = { m: prior, s: this._scoreObjIndex(prior) };
      for (let m = prior; m <= prior + 4096; m += 64) { const s = this._scoreObjIndex(m); if (s > best.s) best = { m, s }; }
      if (best.s >= decisive) { this.maxObjIndex = best.m; this._objEstimated = true; return; }
    }
    if (this._objSample.length < 250) return;   // no usable prior - the blind sweep needs a full sample set
    let best = { m: 0, s: base };
    for (let m = 4096; m <= (1 << 20); m = Math.floor(m * 1.18)) { const s = this._scoreObjIndex(m); if (s > best.s) best = { m, s }; }
    if (best.m && best.s >= decisive) {
      for (let m = Math.floor(best.m * 0.85); m <= best.m * 1.15; m += Math.max(500, (best.m * 0.02) | 0)) { const s = this._scoreObjIndex(m); if (s > best.s) best = { m, s }; }
      this.maxObjIndex = best.m;
      this._objEstimated = true;
    }
  }

  // Reader for a replicated FRotator. Default `gated8` mirrors UE2.5 UStructProperty::NetSerializeItem for the
  // atomic Rotator (FRotator::SerializeCompressed in Engine.dll): a presence bit per axis, and when set the
  // top byte (Pitch>>8) - the low byte is never sent. A wrong format desyncs the tail, which the monotonic/sane
  // gates then reject, so this only ever LETS MORE decode when correct (Health/PRI that sit after Rotation).
  // Other candidates kept behind KF_ROTFMT for future reverse work.
  _rotator(br) {
    const fmt = this._rotFmt !== undefined ? this._rotFmt : (this._rotFmt = process.env.KF_ROTFMT || 'gated8');
    try {
      if (fmt === 'i3x16') return { value: [br.readBits(16), br.readBits(16), br.readBits(16)], ok: true };
      if (fmt === 'i3x8') return { value: [br.readByte(), br.readByte(), br.readByte()], ok: true };
      if (fmt === 'gated16') { const v = []; for (let i = 0; i < 3; i++) v.push(br.readBit() ? br.readBits(16) : 0); return { value: v, ok: true }; }
      if (fmt === 'gated8') { const v = []; for (let i = 0; i < 3; i++) v.push(br.readBit() ? br.readByte() : 0); return { value: v, ok: true }; }
      if (fmt === 'packed') return readPackedVector(br);
    } catch (e) { /* ran off the end */ }
    return { ok: false, reason: 'rotator' };
  }

  get _objOpts() {
    const o = this.maxObjIndex ? { maxObjectIndex: this.maxObjIndex } : {};
    o.rotator = (br) => this._rotator(br);
    return o;
  }

  // A fresh-spawn open bunch is [static class ref][packed spawn location]; once MaxObjectIndex is known
  // we can skip the class ref and read that location - an initial position for actors whose per-field
  // Location updates never decode cleanly (so pawns stop blinking in/out). Returns {x,y,z,classIdx} or null.
  spawnInfo(ch) {
    if (!this.maxObjIndex) return null;
    if (this._spawnCache && this._spawnCacheM === this.maxObjIndex && ch in this._spawnCache) return this._spawnCache[ch];
    const ob = this.openBunches[ch];
    let out = null;
    if (ob) {
      try {
        const br = new BitReader(Buffer.from(ob.hex, 'hex'), ob.numBits);
        if (br.readBit() === 0) {                              // 0 = static class ref (fresh spawn)
          const classIdx = readIntUE(br, this.maxObjIndex);
          const [x, y, z] = readPackedVector(br).value;
          if (!br.error && Math.max(Math.abs(x), Math.abs(y)) >= 300 &&
              Math.abs(x) <= MAP_BOUND && Math.abs(y) <= MAP_BOUND && Math.abs(z) <= MAP_BOUND) out = { x, y, z, classIdx };
        }
      } catch (e) { out = null; }
    }
    if (this._spawnCacheM !== this.maxObjIndex) { this._spawnCache = {}; this._spawnCacheM = this.maxObjIndex; }
    this._spawnCache[ch] = out;
    return out;
  }

  // Build the EXACT net object table from the .u files the client has (game install + server dir +
  // cache), using the captured USES order. When every package is present this also gives the exact
  // MaxObjectIndex, so no brute force is needed and class-ref decode is precise.
  _ensurePkgMap() {
    if (!this.usesOrder.length) return;
    // Rebuild when the USES list has GROWN since the last build. Modded servers stream ServerPackages for tens
    // of seconds after JOIN, so a build off the early subset locks a short MaxObjectIndex and every class ref
    // misframes - monsters never resolve and are invisible while they attack. Reparsing hundreds of packages
    // is costly, so throttle to once every 2s: it self-limits once the list stops growing (length unchanged).
    if (this.pkgMap) {
      if (this.usesOrder.length === this._pkgUsesLen) return;
      if (this.now() - (this._pkgBuiltAt || 0) < 2000) return;
      this.classOf = {}; this._spawnCache = null; this._spawnCacheM = undefined; this._netByClass = {};
      this._mapActorsTried = false; this.mapActors = null;
      this._objEstimated = false; this.maxObjIndex = 0; this._pkgBase = 0;
    }
    this._pkgUsesLen = this.usesOrder.length;
    this._pkgBuiltAt = this.now();
    this.pkgMap = new PackageMap(this.usesOrder, this.systemDir);
    this.pkgMap.build();
    if (this.pkgMap.complete && this.pkgMap.maxObjectIndex) {
      this.maxObjIndex = this.pkgMap.maxObjectIndex;   // exact - skip the brute-force estimator
      this._objEstimated = true;
    } else if (this.pkgMap.baseObjectIndex) {
      // Incomplete (a custom content/code package we can't fetch): resolve() is still correct for every ref
      // before the gap. Object refs are read with ceil(log2(MaxObjectIndex)) bits, so as long as the missing
      // tail doesn't push the true size across the next power of two, baseObjectIndex decodes them bit-exact.
      // When base has comfortable headroom below that boundary, trust it immediately (works on quiet servers
      // that never emit enough pawn bunches to sample); otherwise seed the estimator to confirm the exact size.
      const base = this.pkgMap.baseObjectIndex;
      this._pkgBase = base;
      const nextPow2 = 1 << (32 - Math.clz32(base));
      if (nextPow2 - base > 4096) { this.maxObjIndex = base; this._objEstimated = true; }
    }
  }

  // Rebuild the package map after packages that were missing/corrupt have been re-fetched to disk. A single
  // absent package left MaxObjectIndex brute-forced (and wrong), so once the gap is filled we recompute the
  // EXACT table and drop every class resolution that was made against the wrong index.
  rebuildPkgMap() {
    this.pkgMap = null; this._mapActorsTried = false; this.mapActors = null;
    this._objEstimated = false; this.maxObjIndex = 0; this._pkgBase = 0;
    this.classOf = {}; this._spawnCache = null; this._spawnCacheM = undefined;
    this._netByClass = {};   // class tables may now resolve differently (fresh packages registered)
    this._ensurePkgMap();
    return !!(this.pkgMap && this.pkgMap.complete);
  }

  // The spawn class-ref index from a channel's open bunch (bit 0 = static class ref, then the compact index),
  // WITHOUT requiring the trailing packed location to decode sanely. A modded actor's open bunch can lay out
  // whatever it likes after the class ref, so gating class resolution on a bounded spawn position (as spawnInfo
  // does, correctly, for the POSITION) threw away a perfectly good class index and left most channels of a
  // heavy mod unresolved (KFTurbo: 185/198 unresolved -> no other pawns/PRIs visible -> possession never anchors).
  classIdxFor(ch) {
    if (!this.maxObjIndex) return null;
    const ob = this.openBunches[ch];
    if (!ob) return null;
    try {
      const br = new BitReader(Buffer.from(ob.hex, 'hex'), ob.numBits);
      if (br.readBit() !== 0) return null;                 // not a static class-ref spawn bunch
      const idx = readIntUE(br, this.maxObjIndex);
      return br.error ? null : idx;
    } catch (e) { return null; }
  }

  // Resolved class name for a channel (from its spawn class ref), cached once resolved. A class from a
  // DOWNLOADED custom package is fed into the net cache (with its whole superclass chain) so netFields()
  // yields the same table the real client builds after downloading - modded PC/pawn decode + RPC max.
  classFor(ch) {
    if (this.classOf[ch] != null) return this.classOf[ch];
    this._ensurePkgMap();
    if (!this.pkgMap) return null;
    const idx = this.classIdxFor(ch);
    const loc = idx != null && this.pkgMap.resolveLoc(idx);
    if (loc) { this.classOf[ch] = loc.cls; this._teachClassChain(loc.cls, loc); }
    return loc ? loc.cls : null;
  }

  // Make every link of `name`'s superclass chain resolvable by the net cache: register the owning parsed
  // package of each link the stock set doesn't know (custom chains can hop across several downloaded
  // packages). Without the full chain netFields() silently truncates and every index is wrong.
  _teachClassChain(name, loc) {
    let c = name, guard = 0;
    while (c && guard++ < 32) {
      if (!this.ps.classLoc[c]) {
        const l = (c === name && loc) ? loc : (this.pkgMap && this.pkgMap.findClass(c));
        if (!l || !l.pkg) return;
        this.ps.addParsed(l.pkgName, l.pkg);
        if (!this.ps.classLoc[c]) return;   // package registered but class still unknown - give up quietly
        delete this._netByClass[c];         // drop a stale "unknown" verdict cached before the teach
      }
      c = this.ps.superOf(c);
    }
  }

  // Cached netFields for a class. A null cache entry means "was unknown when last asked" - retry, because
  // _teachClassChain may have registered the class's package since (downloads land mid-session).
  netFieldsByClass(cls) {
    if (this._netByClass[cls] === undefined || this._netByClass[cls] === null) {
      const nf = this.ps.netFields(cls);
      this._netByClass[cls] = nf.length ? nf : null;
    }
    return this._netByClass[cls];
  }

  // True when class `cls` has `base` somewhere in its resolved hierarchy; false if the class is unknown.
  _hierarchyHas(cls, base) {
    try { return this.ps.hierarchy(cls).includes(base); } catch (e) { return false; /* unknown class */ }
  }

  // Is this resolved class a Pawn subclass (a player or monster) rather than a weapon/effect/pickup that also
  // carries a Location? Only Pawns become map dots - a Syringe or blood puff must not plot as a monster.
  _isPawnClass(cls) {
    if (this._isPawnCls[cls] !== undefined) return this._isPawnCls[cls];
    return (this._isPawnCls[cls] = this._hierarchyHas(cls, 'Pawn'));
  }

  // Map-dot category for a resolved pawn class. classifyName handles stock names; for a CUSTOM (KF15Beta /
  // total-conversion) pawn whose name it doesn't match, decide by HIERARCHY - a KFMonster subclass is a
  // monster, any other Pawn is a player. Without this, custom human pawns (whose class isn't literally
  // "KFHumanPawn") fell through to null and plotted as red monster dots instead of blue player dots.
  _pawnCategory(cls) {
    if (!cls) return null;
    const named = classifyName(cls);
    if (named === 'mon' || named === 'player') return named;
    if (this._hierarchyHas(cls, 'KFMonster')) return 'mon';
    if (this._isPawnClass(cls)) return 'player';
    return named;
  }

  // A synthetic net cache of a given field-count for a custom class we can't resolve. Every pawn/monster
  // shares KFHumanPawn's low indices (Location@0..Health@58), so reusing them at the target length gives the
  // right handle bit-width and correct types for the base fields we read.
  _candidateNet(max) {
    if (!this._candNet) this._candNet = {};
    if (this._candNet[max]) return this._candNet[max];
    const base = this.pawn;
    let nf;
    if (max <= base.length) nf = base.slice(0, max);
    else { nf = base.slice(); while (nf.length < max) nf.push({ index: nf.length, name: 'pad' + nf.length, type: 'ByteProperty', isFunc: false }); }
    this._candNet[max] = nf;
    return nf;
  }

  // The net cache to decode a channel's pawn bunches with - the wire handle's bit width is set by the class's
  // total replicated-field count, so it MUST match the server's class. Exact when the class resolves; else lock
  // the field-count once via a full, in-order, Location-led decode (a wrong count desyncs, so it won't lock on
  // garbage), then reuse it. Returns null while a custom class stays unlocked, so we plot nothing rather than noise.
  _pawnNet(ch, hex, numBits, opts) {
    const cls = this.classFor(ch);
    if (cls) {
      const nf = this.netFieldsByClass(cls);
      if (nf) return nf;
    }
    // The object table CONFIRMS this channel is a Pawn subclass, but its custom net table couldn't be built
    // (KF15Beta / total-conversion mods whose pawn class's superclass chain doesn't fully parse from the
    // downloaded package - netFieldsByClass returned null). Location is Actor field 0, shared by EVERY pawn,
    // so it's trustworthy; the only unknown is the handle bit width (set by the class's field count). Below we
    // scan the bracket templates and, for such a confirmed pawn, lock on the one that reads Location@0 + at
    // least one more field in order (two correct handles in a row won't happen by chance), WITHOUT needing the
    // whole bunch to decode - a later custom property we can't size otherwise left every such pawn invisible.
    const clsIsPawn = !!(cls && this._isPawnClass(cls));
    if (this._locMax[ch]) return this._candidateNet(this._locMax[ch]);
    // Bounded scan: most unresolved channels are never pawns (GRI, PRIs, items), so cap the attempts so we
    // don't run 9 trial decodes on every bunch of a non-pawn channel forever (the old per-frame perf freeze).
    if ((this._scanTries[ch] = (this._scanTries[ch] || 0) + 1) > 48) return null;
    for (const max of PAWN_FIELD_COUNTS) {
      const d = decodeBunch(hex, numBits, this._candidateNet(max), opts);
      const f0 = d.fields[0];
      const locOK = f0 && f0.index === 0 && Array.isArray(f0.value) &&
        Math.abs(f0.value[0]) <= MAP_BOUND && Math.abs(f0.value[1]) <= MAP_BOUND;
      const alignOK = (d.complete && monotonic(d.fields)) ||
        (clsIsPawn && d.fields.length >= 2 && monotonic(d.fields));   // confirmed pawn: 2+ in-order fields is enough
      if (locOK && alignOK) {
        this._locMax[ch] = max;
        return this._candidateNet(max);
      }
    }
    return null;
  }

  // Stock world items (pickups/ammo/vest) and traders (ShopVolume) with their spawn positions. Only when
  // the object table is EXACT (every package present) - a brute-forced MaxObjectIndex mis-decodes the
  // class ref by a few and would mislabel, so on modded servers this stays empty rather than wrong.
  worldItems() {
    this._ensurePkgMap();
    const items = [], traders = [], doors = [], movers = [], bucket = { item: items, trader: traders, door: doors, mover: movers };
    if (this.pkgMap && this.pkgMap.complete) {
      for (const ch of Object.keys(this.openBunches)) {
        const c = +ch;
        if (this.pawns.has(c) || c === this.myPri || this.priChannels.has(c)) continue;   // pawns/PRIs handled elsewhere
        const cat = classifyName(this.classFor(c));
        if (!bucket[cat]) continue;
        const sp = this.spawnInfo(c);
        if (!sp) continue;
        bucket[cat].push({ ch: c, name: this.classOf[c], x: sp.x, y: sp.y });
      }
    }
    // Static trader volumes / doors / movers from the loaded map file (never network-replicated). Synthetic
    // negative channels so they never collide with real actor channels in the map store. Split the map's
    // door actors by name: generic movers (Mover/IMover) go to their own layer; only door-named ones stay.
    this._ensureMapActors();
    if (this.mapActors) {
      this.mapActors.traders.forEach((t, i) => traders.push({ ch: -1000 - i, name: t.name, x: t.x, y: t.y }));
      this.mapActors.doors.forEach((d, i) => {
        const isMover = /Mover/i.test(d.name) && !/Door/i.test(d.name);
        (isMover ? movers : doors).push({ ch: (isMover ? -3000 : -2000) - i, name: d.name, x: d.x, y: d.y, yaw: d.yaw });
      });
    }
    return { items, traders, doors, movers };
  }

  // Read the map .rom once for server-only trader/door actors (positions the real client gets from the
  // loaded map, not the wire). Needs the package map's content dirs; retries until the map is built.
  _ensureMapActors() {
    if (this._mapActorsTried) return;
    this._ensurePkgMap();
    if (!this.pkgMap || !this.usesOrder.length) return;   // no dirs yet - try again next snapshot
    this._mapActorsTried = true;
    try { this.mapActors = require('./mapactors').loadMapActors(this.usesOrder, this.pkgMap.dirs); }
    catch (e) { this.mapActors = null; }
  }
  field(cache, name) { const f = cache.find((x) => x.name === name); return f ? f.index : -1; }

  // Player name for a PRI channel: cached, else sniffed from that channel's stored open bunch.
  nameFor(ch) {
    if (ch == null) return null;
    if (this.priNames[ch]) return this.priNames[ch];
    const ob = this.openBunches[ch];
    const n = ob && extractName(ob.hex, ob.numBits);
    if (n) this.priNames[ch] = n;
    return n || null;
  }

  // Real players on the server, each with HP + spawned/spectator state. A PlayerReplicationInfo carries
  // a name but is NOT a pawn, so we take named channels and drop pawns (their sniffed MenuName is what
  // used to leak monsters like "GoreFast" into this list) and anything whose name reads as a monster.
  // Confirmed players (self, or a channel a pawn points at) sort first.
  playerList() {
    for (const ch of Object.keys(this.openBunches)) {
      if (this._nameChecked[ch]) continue;
      this._nameChecked[ch] = true;
      const ob = this.openBunches[ch];
      const n = extractName(ob.hex, ob.numBits);
      if (n && !this.priNames[ch]) this.priNames[ch] = n;
    }
    const ownerOf = {};   // PRI channel -> its pawn channel (reverse pawnOwner), for HP/spawned state
    for (const p of Object.keys(this.pawnOwner)) ownerOf[this.pawnOwner[p]] = +p;
    const out = [];
    for (const chS of Object.keys(this.priNames)) {
      const ch = +chS, name = this.priNames[ch];
      if (!name) continue;
      const nm = name.trim();
      if (nm.length < 3 || (nm.match(/[A-Za-z0-9]/g) || []).length < 2) continue;   // drop garbage sniffs ("L ", "0A")
      if (/^killing\s*floor$/i.test(nm)) continue;      // the game title / GRI, not a player
      if (this.pawns.has(ch)) continue;                 // a pawn (monster / player body) is not a PRI
      if (looksLikeMonster(name)) continue;             // a sniffed monster MenuName is not a player
      const isSelf = ch === this.myPri;
      const pawnCh = isSelf ? this.myPawn : (ownerOf[ch] != null ? ownerOf[ch] : null);
      const priHp = this.priHealth[ch];                  // this player's HP straight off their PRI (scoreboard-style)
      const confirmed = isSelf || pawnCh != null || priHp != null;   // a pawn points at us/them, or the PRI gave HP
      let hp, spawned;
      if (isSelf) { const st = this.selfState(); hp = st.hp; spawned = st.alive; }
      else {
        // Prefer the PRI's PlayerHealth (replicated for every player, present even for players who spawned
        // before we joined) over the pawn's Health. Its absence means we haven't decoded their HP yet -
        // spawned only if a pawn is linked (default-100), else a spectator/not-yet-known.
        const pawnHp = pawnCh != null ? this.pawnHp[pawnCh] : null;
        const known = priHp != null ? priHp : pawnHp;
        spawned = known != null ? known > 0 : (pawnCh != null);
        hp = known != null ? known : (spawned ? 100 : null);
      }
      out.push({ ch, name, hp: hp != null ? hp : null, spawned, self: isSelf, confirmed });
    }
    out.sort((a, b) => (b.confirmed - a.confirmed) || (a.ch - b.ch));
    // Chat/announcer mod actors re-broadcast player names, so an unconfirmed channel that sniffs the
    // same name as a confirmed player (or another kept row) is an echo, not a second player.
    const kept = new Set();
    return out.filter((r) => {
      const k = r.name.trim().toLowerCase();
      if (r.confirmed) { kept.add(k); return true; }
      if (kept.has(k)) return false;
      kept.add(k);
      return true;
    });
  }

  // Inbound chat: TeamMessage(PRI, S, Type) / ClientMessage(S, Type) RPCs on the PlayerController
  // channel. Layout reversed from a live capture: [handle][PRI gate+object][S gate][FString]...
  // Returns { from, text } or null.
  tryChat(rec) {
    if (rec.bOpen) return null;
    const br = new BitReader(Buffer.from(rec.payloadHex, 'hex'), rec.numBits);
    const handle = readIntUE(br, this.pc ? this.pc.length : 281);
    if (handle !== 120 && handle !== 119) return null;   // TeamMessage / ClientMessage
    let fromCh = null;
    if (handle === 120) {                                 // TeamMessage carries the sender PRI first
      br.readBit();
      const o = readObject(br, 0);
      if (!o.ok) return null;
      fromCh = o.channel;
    }
    br.readBit();                                          // string param presence gate
    const text = br.readString();
    if (!text || br.error || !/^[\x20-\x7e]+$/.test(text)) return null;
    return { from: this.nameFor(fromCh) || (fromCh ? 'ch' + fromCh : 'server'), text };
  }

  onBunch(rec) {
    if (rec.bClose) this._forgetChannel(rec.chIndex);   // server destroyed the actor (e.g. our pawn on death)
    if (!rec.payloadHex) return;
    // ClientReStart(Pawn) names the exact pawn the server possessed for us - the authoritative myPawn (no
    // Health guessing) and a definitive PC-channel pin. The server resends it for every unacknowledged move,
    // so catching it is what lets us acknowledge the right pawn and finally get ServerMove applied.
    const restartPawn = this.tryClientRestart(rec);
    if (restartPawn != null) {
      this.myPcChannel = rec.chIndex;
      if (restartPawn > 0) {
        if (this.myPawn !== restartPawn) this.stats.hp = null;   // fresh body: HP reads default-100 until replicated
        this.myPawn = restartPawn; this.serverAckPawn = restartPawn; this.unpossessed = false;
      }
      return;
    }
    const pcPawn = this.tryPcPawn(rec);
    if (pcPawn != null) {   // Controller.Pawn property = the pawn the server possessed for us (authoritative)
      this.myPcChannel = rec.chIndex;
      if (pcPawn > 0) {
        if (this.myPawn !== pcPawn) this.stats.hp = null;
        this.myPawn = pcPawn; this.serverAckPawn = pcPawn; this.unpossessed = false;
      } else if (this.myPawn != null) { this.serverAckPawn = null; this.unpossessed = true; }   // died / spectating
      return;
    }
    const chat = this.tryChat(rec);
    if (chat) { this.chatChannel = rec.chIndex; this.pendingChat.push(chat); return; }   // a chat bunch is not a PRI/pawn
    const adjust = this.tryClientAdjust(rec);
    if (adjust) {   // server correcting my position - accept only a local nudge, not a decode-noise teleport
      const prev = this.selfPos();
      if (!prev || Math.hypot(adjust.x - prev.x, adjust.y - prev.y) < 8000) {
        this.selfAdjustPos = adjust; this.myPcChannel = rec.chIndex; this.corrected = true; this.corrCount++;
        this.selfEstimate = { x: adjust.x, y: adjust.y, z: adjust.z };   // snap the dead-reckoning to server truth
        // A correction is our authoritative position. If we haven't pinned our own pawn (custom PC never
        // gave us Pawn/ClientReStart decodably), the candidate pawn sitting nearest that position IS ours -
        // the most reliable possession signal, independent of decoding the PC channel.
        if (this.myPawn == null) {
          let best = null, bestD = 700;
          for (const ch of this.candidatePawns()) {
            const o = this.objects[ch];
            if (!o) continue;
            const d = Math.hypot(o.x - adjust.x, o.y - adjust.y);
            if (d < bestD) { bestD = d; best = ch; }
          }
          if (best != null) this.myPawn = best;
        }
        if (this.myPawn != null) this.objects[this.myPawn] = { ...(this.objects[this.myPawn] || {}), type: 'self', x: adjust.x, y: adjust.y, z: adjust.z, t: this.now() };
      }
      return;
    }
    if (rec.bOpen) {
      // Keep the latest open bunch per channel; names are sniffed from here (nameFor), not the
      // per-field decoder (which can't parse an open bunch's leading class ref).
      this.openBunches[rec.chIndex] = { hex: rec.payloadHex, numBits: rec.numBits };
      if (!this.openAt) this.openAt = {};
      if (this.openAt[rec.chIndex] == null) this.openAt[rec.chIndex] = this.now();   // channel-open time: our just-spawned pawn is the newest
      // Identify my own PRI: by SteamID in the open bunch, or by a sniffed name that contains my
      // configured name (servers often prefix a country/clan tag, e.g. "[CAN] GuiBot").
      if (this.myPri == null) {
        const sniffed = extractName(rec.payloadHex, rec.numBits);
        const bySteam = this.mySteamId && Buffer.from(rec.payloadHex, 'hex').includes(Buffer.from(String(this.mySteamId)));
        const byName = sniffed && this.myName && sniffed.toLowerCase().includes(this.myName.toLowerCase());
        if (bySteam || byName) { this.myPri = rec.chIndex; this.priNames[rec.chIndex] = sniffed || this.myName; }
      }
      return;                                 // open bunches lead with the class ref (undecodable per-field)
    }
    this._ensurePkgMap();   // exact MaxObjectIndex from the .u files (sets it directly when nothing's missing)
    this._tryGri(rec);      // live wave state from the GameReplicationInfo channel
    // Feed the MaxObjectIndex estimator; include ref-bearing (larger) bunches - those are what actually
    // discriminate the value - then lock it in once we have a decent spread.
    if (!this._objEstimated && rec.numBits > 12 && rec.numBits < 2000) {
      this._objSample.push([rec.numBits, rec.payloadHex]);
      if (this._objSample.length > 500) this._objSample.shift();
      this._objTick = (this._objTick || 0) + 1;
      if (this._objTick % 80 === 0) this._estimateObjIndex();
    }
    const opts = this._objOpts;
    // PlayerReplicationInfo update bunches carry PlayerHealth (KF replicates it for EVERY player so the
    // scoreboard can show each one's HP). Decode it for my own PRI (my HP/perk) and for every other PRI
    // (their alive/dead/HP in the Players tab, with no pawn link needed). A PRI is my PRI, a channel a
    // pawn pointed at, or a named non-pawn channel. Gate on a clean in-order decode with a sane value so
    // a server whose replication our stock net cache can't parse shows blank, not junk.
    const isPri = rec.chIndex === this.myPri || this.priChannels.has(rec.chIndex) ||
      (this.priNames[rec.chIndex] != null && !this.pawns.has(rec.chIndex) && rec.chIndex !== this.griChannel && rec.chIndex !== this.myPcChannel);
    if (isPri) {
      const dp = decodeBunch(rec.payloadHex, rec.numBits, this.pri, opts);
      if (monotonic(dp.fields)) for (const f of dp.fields) {
        if (f.index === this.idx.playerHealth && f.value >= 0 && f.value <= 6000) {
          this.priHealth[rec.chIndex] = f.value;
          if (rec.chIndex === this.myPri) { this.stats.hp = f.value; this.myPlayerHealth = f.value; if (f.value > 0) this.myHealthSeen.add(f.value); }
        }
        else if (f.index === this.idx.vet && f.value >= 0 && f.value <= 100 && rec.chIndex === this.myPri) this.stats.expPct = f.value;
      }
    }
    // Only Pawn subclasses (players/monsters) are map dots. A resolved non-pawn actor (Syringe, ROBloodPuff,
    // projectiles) also carries a Location@0 and would otherwise decode a spurious "Health" and plot as a
    // monster; skip it. Unresolved custom classes fall through (they may be modded pawns).
    const rcls = this.classFor(rec.chIndex);
    if (rcls && !this._isPawnClass(rcls)) return;
    // Probe as a pawn against the channel's OWN class net layout (the handle bit width is set by the class's
    // field count; decoding every pawn against one template desynced any class in a different bit bracket).
    // Health/PRI/Location live at base-Actor indices shared by every pawn/monster, so this.idx identifies them.
    const net = this._pawnNet(rec.chIndex, rec.payloadHex, rec.numBits, opts);
    if (!net) return;   // custom class not yet decodable - plot nothing rather than a mis-decoded ghost
    const d = decodeBunch(rec.payloadHex, rec.numBits, net, opts);
    if (process.env.KF_DUMP_PAWN_FIELDS) {
      const fs2 = d.fields.map((f) => f.index + (f.value && f.value.kind === 'actor' ? '(a' + f.value.channel + ')' : '')).join(',');
      console.log('[pawnfields] ch=' + rec.chIndex + ' cls=' + (rcls || '?') + ' netLen=' + net.length + ' pri@' + this.idx.pawnPRI + ' hp@' + this.idx.health + ' fields=' + fs2);
    }
    let health = null, loc = null, vel = null;
    for (const f of d.fields) {
      if (f.index === this.idx.health && typeof f.value === 'number') health = f.value;
      else if (f.index === this.idx.velocity && Array.isArray(f.value)) vel = f.value;
      else if (f.index === this.idx.pawnPRI && f.value && f.value.kind === 'actor' && f.value.channel > 0) {
        // A pawn carrying a PlayerReplicationInfo is player-controlled; the PRI channel names it.
        this.pawnOwner[rec.chIndex] = f.value.channel;
        this.priChannels.add(f.value.channel);
        if (f.value.channel === this.myPri) this.myPawn = rec.chIndex;
        else this.playerPawns.add(rec.chIndex);
      }
      else if (f.index === this.idx.shield) this._maybePawnStat('armor', f.value, rec.chIndex);
      else if (f.index === this.idx.weight) this._maybePawnStat('load', f.value, rec.chIndex);
      else if (f.index === this.idx.maxWeight) this._maybePawnStat('loadMax', f.value, rec.chIndex);
      else if (f.index === this.idx.healthMax) this._maybePawnStat('hpMax', f.value, rec.chIndex);
      else if (f.index === 0 && Array.isArray(f.value)) loc = f.value;   // Location
    }
    // Robust owner link: a custom pawn (KF15Beta) lays PlayerReplicationInfo at a non-stock field index, so
    // the fixed idx.pawnPRI check above misses it and the OTHER PLAYER reads as a monster (never blue, no
    // nickname). Fall back to ANY actor-ref field pointing at a channel we already know is a real, named,
    // non-monster PRI - that ref IS the pawn's PRI, so this channel is that player's body.
    if (this.pawnOwner[rec.chIndex] == null) {
      for (const f of d.fields) {
        if (!f.value || f.value.kind !== 'actor' || !(f.value.channel > 0) || f.value.channel === rec.chIndex) continue;
        // Only an ALREADY-SNIFFED PlayerReplicationInfo channel (priNames), not any actor a MenuName sniff
        // happens to name - that over-matched non-PRI actors (Controllers/shared refs) and mis-linked pawns.
        const nm = this.priNames[f.value.channel];
        if (nm && !looksLikeMonster(nm)) {
          this.pawnOwner[rec.chIndex] = f.value.channel;
          this.priChannels.add(f.value.channel);
          if (f.value.channel === this.myPri) this.myPawn = rec.chIndex;
          else this.playerPawns.add(rec.chIndex);
          break;
        }
      }
    }
    // A bounded Location decoded through a valid pawn net proves this channel is a pawn/monster - register
    // it even when Health never replicated. UE2 replicates Health only on CHANGE, so an undamaged zed or a
    // player who spawned before we joined never sends Health; gating tracking on a seen Health (below) hid
    // every full-HP monster and every already-present player, which read as "no dots / teleporting".
    const locBounded = loc && Math.abs(loc[0]) <= MAP_BOUND && Math.abs(loc[1]) <= MAP_BOUND && Math.hypot(loc[0], loc[1]) >= 64;
    if (locBounded && rec.chIndex !== this.myPawn) this.pawns.add(rec.chIndex);
    if (health != null && health >= 0 && health <= 6000) {
      this.pawns.add(rec.chIndex);
      this.pawnHp[rec.chIndex] = health;   // per-pawn Health for the players list
      if (this.myPawn == null && health > 0 && classifyName(this.classFor(rec.chIndex)) !== 'mon') {
        // (never latch a channel the object table resolves to a monster class - that Health-overlap
        //  heuristic used to grab a Clot whose 100 HP coincided with my own, acking a zed as my pawn.)
        (this.pawnHealthSeen[rec.chIndex] = this.pawnHealthSeen[rec.chIndex] || new Set()).add(health);
        // my pawn = the pawn whose Health values overlap my PlayerHealth history the most.
        let n = 0;
        for (const v of this.pawnHealthSeen[rec.chIndex]) if (this.myHealthSeen.has(v)) n++;
        if (n >= 2) this.myPawn = rec.chIndex;
      }
    }
    // My pawn's own Health is ground truth for the HP bar (more reliable than the PRI mirror).
    if (this.myPawn != null && rec.chIndex === this.myPawn && health != null && health >= 0) {
      this.stats.hp = health; this.myPawnHp = health; this.myPawnSeen = this.now();
    }
    // NB: never trust field 0 as Location for our OWN pawn. We are the movement authority, so the server
    // stops replicating our pawn's Location - field 0 then decodes some other property as a junk vector
    // (measured on RD-* custom pawns: field 0 jumped every bunch while a real value sat at index ~101).
    // Self position comes only from the deterministic move corrections and the open-bunch spawn point.
    if (rec.chIndex === this.myPawn) loc = null;
    // Location is net field 0 - read first, before any custom property that could stop the decode - so a
    // bunch that carries it yields a position even when a later field desyncs. _trackPosition's bounds +
    // continuity guards reject the rare mis-decode.
    // A pawn already corroborated as another player (its PlayerReplicationInfo ref pointed at a real PRI, so
    // it sits in playerPawns) is trusted like a spawn point: plot its FIRST bounded Location at once instead
    // of holding it for a second confirming decode. Other players usually stand at the trader and replicate
    // Location too sparsely to ever get that 2nd decode within the confirm window, so the anti-noise gate left
    // them permanently invisible on the map even though the player list shows them. Monsters (never in
    // playerPawns) keep the gate - they move constantly and confirm within one replication burst.
    if (loc && this.pawns.has(rec.chIndex)) this._trackPosition(rec.chIndex, loc, health, vel, this.playerPawns.has(rec.chIndex));
    else if (this.pawns.has(rec.chIndex) && !this.objects[rec.chIndex]) {
      // Spawn-point fallback for actors whose live Location never decodes at all - self + real players only,
      // so the green/blue dot appears at once (a monster shows only once its real position decodes).
      const owner = this.pawnOwner[rec.chIndex];
      const ownerName = owner != null ? this.nameFor(owner) : null;
      const isSelfOrPlayer = rec.chIndex === this.myPawn ||
        (owner != null && (owner === this.myPri || (!!ownerName && !looksLikeMonster(ownerName))));
      if (isSelfOrPlayer) { const sp = this.spawnInfo(rec.chIndex); if (sp) this._trackPosition(rec.chIndex, [sp.x, sp.y, sp.z], health, null, true); }
    }
  }

  // Live wave state from the GameReplicationInfo channel: decode update bunches against the GRI net layout
  // and accumulate WaveNumber / TimeToNextWave / bWaveInProgress / MaxMonsters (each replicates on change).
  // The channel is pinned the first time a clean decode yields a sane wave field, so a pawn bunch that
  // happens to decode monotonically can't hijack it.
  _tryGri(rec) {
    if (rec.bOpen || !this.gri || this.gri.length === 0 || this.griIdx.waveNumber < 0) return;
    if (this.griChannel != null && rec.chIndex !== this.griChannel) return;
    if (this.pawns.has(rec.chIndex) || rec.chIndex === this.myPri || this.priChannels.has(rec.chIndex)) return;
    const d = decodeBunch(rec.payloadHex, rec.numBits, this.gri, this._objOpts);
    if (!d.complete || !monotonic(d.fields)) return;
    let wave = null, finalWave = null, ttn = null, inProgress = null, maxMon = null, hit = false;
    for (const f of d.fields) {
      if (f.index === this.griIdx.waveNumber && typeof f.value === 'number') { wave = f.value; hit = true; }
      else if (f.index === this.griIdx.finalWave && typeof f.value === 'number') { finalWave = f.value; hit = true; }
      else if (f.index === this.griIdx.timeToNextWave && typeof f.value === 'number') { ttn = f.value; hit = true; }
      else if (f.index === this.griIdx.waveInProgress) { inProgress = !!f.value; hit = true; }
      else if (f.index === this.griIdx.maxMonsters && typeof f.value === 'number') { maxMon = f.value; hit = true; }
    }
    if (!hit) return;
    // Sanity-gate before trusting the channel (a mis-decode elsewhere can't fake all of these at once).
    if (wave != null && (wave < 0 || wave > 30)) return;
    if (finalWave != null && (finalWave < 1 || finalWave > 64)) return;
    if (ttn != null && (ttn < 0 || ttn > 6000)) return;
    if (maxMon != null && (maxMon < 0 || maxMon > 100000)) return;
    if (this.griChannel == null) this.griChannel = rec.chIndex;
    const w = this.wave || {};
    if (wave != null) w.waveNumber = wave;   // key must match the renderer's HUD reader
    if (finalWave != null) w.finalWave = finalWave;
    if (ttn != null) w.timeToNextWave = ttn;
    if (inProgress != null) w.waveInProgress = inProgress;
    if (maxMon != null) w.maxMonsters = maxMon;
    this.wave = w;
  }

  _maybePawnStat(key, value, chIndex) {
    if (this.myPawn == null || chIndex !== this.myPawn) return;   // only my identified pawn feeds my stat bars
    if (typeof value !== 'number' || !isFinite(value) || value < 0 || value > 1e5) return;   // reject mis-decode garbage
    if (key === 'armor' || key === 'load' || key === 'loadMax' || key === 'hpMax') value = Math.round(value);
    this.stats[key] = value;
  }

  _trackPosition(chIndex, loc, health, vel, trusted) {
    const [x, y, z] = loc;
    if (Math.abs(x) > MAP_BOUND || Math.abs(y) > MAP_BOUND || Math.abs(z) > MAP_BOUND) return;
    if (Math.hypot(x, y) < 64) return;   // within ~1m of world origin = a mis-decode, never a real actor
    // Playable-area gate from the map .rom: a decode outside where the game can happen is junk even when
    // self-consistent (KF15Beta custom pawns mis-decode a stable field as a near-axis "Location").
    const mb = this.mapActors && this.mapActors.bounds;
    if (mb && (x < mb.minX || x > mb.maxX || y < mb.minY || y > mb.maxY || z < mb.minZ || z > mb.maxZ)) return;
    const prev = this.objects[chIndex];
    if (prev && Math.hypot(x - prev.x, y - prev.y) > MAX_STEP) return;   // discontinuity = decode noise
    // A NEW dot needs a second bounded decode within MAX_STEP to confirm - a single junk decode used to
    // paint a ghost far outside the map for STALE_MS (seen on KF15Beta customs). Trusted sources (spawn
    // points, self corrections) skip this; a moving pawn confirms within one replication burst.
    // But when real map bounds loaded (mb), the tight playable-area gate above already rejects exactly those
    // far-outside-map ghosts, so require only the FIRST bounded Location: zeds replicate Location ~1% of
    // bunches, so a near moving zed's 2nd decode rarely lands within the window and the gate left it held
    // forever - invisible while it dealt damage. Keep the gate only where the .rom gave no anchors (custom
    // maps without bot pathing), where it's the sole anti-noise layer.
    if (!prev && !trusted && chIndex !== this.myPawn && !mb) {
      this._pendingPos = this._pendingPos || {};
      const p = this._pendingPos[chIndex];
      if (!(p && this.now() - p.t < 4000 && Math.hypot(x - p.x, y - p.y) <= MAX_STEP)) {
        this._pendingPos[chIndex] = { x, y, t: this.now() };
        return;
      }
      delete this._pendingPos[chIndex];
    }
    // Player-vs-monster: a pawn is a PLAYER only when its PRI ref is corroborated - it points at a channel
    // with a real, non-monster player name (or at our own PRI). A zed's bunch sometimes mis-decodes a field
    // as PlayerReplicationInfo pointing at a junk channel; trusting that flag alone painted zeds blue.
    const owner = this.pawnOwner[chIndex];
    const ownerName = owner != null ? this.nameFor(owner) : null;
    // The resolved pawn class is the strongest signal now that the object table is exact: a ZombieXXX
    // channel is a monster no matter what its bunch mis-decoded, and a KFHumanPawn is a player. Fall back
    // to the PRI-name heuristic only when the class doesn't resolve (early package gap).
    const cat = this._pawnCategory(this.classFor(chIndex));
    const isPlayer = cat === 'player' || (cat !== 'mon' && owner != null && (owner === this.myPri || (!!ownerName && !looksLikeMonster(ownerName))));
    const type = chIndex === this.myPawn ? 'self' : (isPlayer ? 'player' : 'mon');
    const name = ownerName;
    const hp = (health != null && health >= 0 && health <= 6000) ? health : (prev ? prev.hp : null);
    const hpMax = Math.max((prev && prev.hpMax) || 0, hp || 0) || null;   // peak Health ~ spawn Health, for naming
    // Replicated Velocity (uu/s) lets the renderer dead-reckon the dot between updates, like a real
    // client's simulated proxy. Keep the last one (it replicates only on change); vt staleness-gates it.
    const sane = (v) => Array.isArray(v) && v.every((c) => isFinite(c) && Math.abs(c) < 4000);
    const vx = sane(vel) ? vel[0] : (prev ? prev.vx : 0), vy = sane(vel) ? vel[1] : (prev ? prev.vy : 0);
    const vt = sane(vel) ? this.now() : (prev ? prev.vt : 0);
    this.objects[chIndex] = { type, x, y, z, t: this.now(), name, hp, hpMax, vx: vx || 0, vy: vy || 0, vt: vt || 0 };
  }

  // Pawns that could be OURS - a human-type pawn not already owned by another player. Used to brute-force
  // possession when the PC channel never yields Pawn/ClientReStart in a decodable form (Story-mode custom
  // PlayerControllers): the session acks each in turn and keeps the one the server starts correcting.
  candidatePawns() {
    const out = [], seen = new Set();
    const consider = (ch) => {
      if (seen.has(ch)) return; seen.add(ch);
      if (this.playerPawns.has(ch)) return;                                // another player's body
      if (this.pawnOwner[ch] != null && this.pawnOwner[ch] !== this.myPri) return;
      if (classifyName(this.classFor(ch)) === 'mon') return;              // a monster is never our pawn
      out.push(ch);
    };
    for (const ch of this.pawns) consider(ch);
    // Our OWN pawn is authority-hidden - its Location is junk (nulled) and Health is the unreplicated
    // default, so it never lands in `pawns`. But its class ref DOES resolve to a human pawn. Include every
    // open channel whose class is a human Pawn subclass so the possession probe can ack our own body.
    for (const chS of Object.keys(this.openBunches)) {
      const ch = +chS;
      const cls = this.classFor(ch);
      if (cls && this._isPawnClass(cls) && classifyName(cls) !== 'mon') consider(ch);
    }
    // Under heavy open-bunch churn (KFTurbo) our own just-spawned pawn's class ref can churn away before we
    // decode it, so it stays UNRESOLVED and never enters `out` above even though a couple of other pawns did -
    // and it's usually the newest open channel. So ALWAYS also fold in every open channel that isn't known
    // infrastructure (PC / PRI / GRI / chat) and isn't a resolved monster/PC/other-player, not only when `out`
    // is empty. Acking a wrong one is a harmless no-op, and the server's correction for the RIGHT one is matched
    // to it by position. Newest-first (below) + a cap keep the probe from rotating through a huge actor list.
    const extras = [];
    for (const chS of Object.keys(this.openBunches)) {
      const ch = +chS;
      if (seen.has(ch)) continue;
      if (ch === this.myPri || ch === this.myPcChannel || ch === this.griChannel || ch === this.chatChannel) continue;
      if (this.priChannels.has(ch) || this.playerPawns.has(ch)) continue;
      const cls = this.classFor(ch);
      if (cls && (this._isPcClass(cls) || classifyName(cls) === 'mon' || !this._isPawnClass(cls))) continue;   // known non-pawn
      extras.push(ch);
    }
    if (this.openAt) extras.sort((a, b) => (this.openAt[b] || 0) - (this.openAt[a] || 0));
    for (const ch of extras.slice(0, 24)) consider(ch);
    // Our own body is the pawn the server opened MOST RECENTLY (it just spawned it on our Ready), so ack
    // the newest candidate first - on a fast-death public server the probe must find us in one or two acks,
    // not rotate through two dozen candidates over half a minute (by which point we've already died).
    if (this.openAt) out.sort((a, b) => (this.openAt[b] || 0) - (this.openAt[a] || 0));
    return out;
  }

  // The server tells us which pawn we possess via ClientReStart(Pawn) on our PlayerController channel (sent on
  // spawn, and again for every ServerMove we send before acknowledging). Reading it gives the AUTHORITATIVE
  // pawn channel - no Health-overlap guessing - and confirms this channel is our PC. Returns the pawn channel,
  // 0 when possessing None (dead/spectator), or null if the bunch isn't a ClientReStart.
  tryClientRestart(rec) {
    if (rec.bOpen || !this.pc || this.idx.clientRestart < 0) return null;
    if (!this._isControllerChannel(rec.chIndex)) return null;   // only OUR PlayerController carries ClientReStart
    const cls = this.classFor(rec.chIndex);
    let pcLen = this.pc.length;
    if (cls) { const nf = this.netFieldsByClass(cls); if (nf) pcLen = nf.length; }
    const br = new BitReader(Buffer.from(rec.payloadHex, 'hex'), rec.numBits);
    if (!this.clientRestartHandles.has(readIntUE(br, pcLen))) return null;
    if (br.readBit() !== 1) return 0;                       // NewPawn param present? 0 => possessing None
    const obj = readObject(br, this.maxObjIndex);
    if (br.error || !obj.ok || obj.kind !== 'actor' || obj.channel <= 0) return null;
    return obj.channel;
  }

  // Is a class a PlayerController - by NAME or, crucially, by HIERARCHY? Custom gametypes name their
  // controller anything (ULMod's is not "*PlayerController"), so a name test alone missed them and left
  // the PC channel unpinned -> no possession, no move. The class must be taught first (classFor does that).
  _isPcClass(cls) {
    if (!cls) return false;
    if (!this._pcClsCache) this._pcClsCache = {};
    if (cls in this._pcClsCache) return this._pcClsCache[cls];
    const is = /PlayerController/i.test(cls) || this._hierarchyHas(cls, 'PlayerController');
    return (this._pcClsCache[cls] = is);
  }

  // Is this channel our PlayerController? Only it carries ClientReStart / ClientAdjustPosition, so gating on
  // it stops a pawn/monster bunch from false-matching those handles and hijacking possession/self-position.
  _isControllerChannel(ch) {
    if (ch === this.myPcChannel) return true;
    const cls = this.classFor(ch);
    if (cls) return this._isPcClass(cls);
    return this.myPcChannel == null;   // class unknown + no PC pinned yet: allow (bootstrap), the payload checks still filter
  }

  // Our Controller.Pawn is replicated on the PlayerController channel as an ObjectProperty - the definitive
  // "which pawn is mine" (the server sets it on possession). Returns the pawn channel, 0 for None, or null.
  tryPcPawn(rec) {
    if (rec.bOpen || !this.pc || this.idx.pcPawn < 0 || !this._isControllerChannel(rec.chIndex)) return null;
    const cls = this.classFor(rec.chIndex);
    let pcNet = this.pc;
    if (cls) { const nf = this.netFieldsByClass(cls); if (nf) pcNet = nf; }
    const br = new BitReader(Buffer.from(rec.payloadHex, 'hex'), rec.numBits);
    if (readIntUE(br, pcNet.length) === this.idx.pcPawn) {   // fast path: Pawn is the first (only-changed) field
      const obj = readObject(br, this.maxObjIndex);
      if (!br.error && obj.ok) return obj.kind === 'actor' && obj.channel > 0 ? obj.channel : 0;
    }
    // Pawn bundled behind other changed fields (ViewRotation/Rotation/etc.). Decode the whole bunch with the
    // rotator reader and take the Pawn field ONLY from a fully-coherent decode (complete + strictly monotonic);
    // a wrong rotator format desyncs the tail, so gating on coherence keeps a garbage Pawn ref from possessing us.
    const d = decodeBunch(rec.payloadHex, rec.numBits, pcNet, this._objOpts);
    if (!d.complete || !monotonic(d.fields)) return null;
    const pf = d.fields.find((f) => f.index === this.idx.pcPawn);
    if (!pf || !pf.value || pf.value.kind !== 'actor') return null;
    return pf.value.channel > 0 ? pf.value.channel : 0;
  }

  // The four position-correction RPC handles + the specific VeryShort/ClientAdjust indices for a channel's
  // class. Taken from the RESOLVED custom PlayerController when known (a subclass can place ClientAdjustPosition
  // at a different net index than stock - using the constructor's stock handles then rejected every correction,
  // so the server moved our pawn but we never learned its position: corr stayed 0). Cached per class.
  _adjustInfo(cls) {
    const nf = cls && this.netFieldsByClass(cls);
    if (!nf) return { handles: this.adjustHandles, veryShort: this.idx.veryShortAdjust, clientAdjust: this.idx.clientAdjust };
    if (!this._adjCache) this._adjCache = {};
    if (this._adjCache[cls]) return this._adjCache[cls];
    const at = (n) => { const f = nf.find((x) => x.name === n && x.isFunc); return f ? f.index : -1; };
    const veryShort = at('VeryShortClientAdjustPosition'), clientAdjust = at('ClientAdjustPosition');
    const handles = new Set([veryShort, at('ShortClientAdjustPosition'), clientAdjust, at('LongClientAdjustPosition')].filter((i) => i >= 0));
    return (this._adjCache[cls] = { handles, veryShort, clientAdjust });
  }

  tryClientAdjust(rec) {
    if (rec.bOpen || !this.pc || !this._isControllerChannel(rec.chIndex)) return null;
    const buf = Buffer.from(rec.payloadHex, 'hex'), bits = rec.numBits;
    const br = new BitReader(buf, bits);
    // Read the handle with THIS channel's resolved-class field count, and match/interpret it against that
    // class's correction indices (custom subclasses widen the handle AND can move the correction RPCs).
    const cls = this.classFor(rec.chIndex);
    const adj = this._adjustInfo(cls);
    if (!adj.handles.size) return null;
    let pcLen = this.pc.length;
    if (cls) { const nf = this.netFieldsByClass(cls); if (nf) pcLen = nf.length; }
    const handle = readIntUE(br, pcLen);
    if (!adj.handles.has(handle)) return null;   // one of the four (Very)Short/Long ClientAdjustPosition RPCs
    const sane = (v) => [v.x, v.y, v.z].every((c) => isFinite(c) && Math.abs(c) < MAP_BOUND) &&
      !([v.x, v.y, v.z].some((c) => c !== 0 && Math.abs(c) < 1)) && !(Math.abs(v.x) < 20 && Math.abs(v.y) < 20);
    // Every correction variant carries NewLocX/Y/Z as three consecutive [present-bit][float32] params (33 bits
    // each) - but NOT immediately after TimeStamp: a `name newState` + `EPhysics newPhysics` (~24 bits, variable)
    // sits between them on ALL of them (reversed byte-exact against the server's [GT] pawn Location: X@66/Y@99/
    // Z@132 in a veryShort bunch). So scan for the FIRST sane present-framed float triple after the handle -
    // NOT the last (the trailing NewVel/NewBase bytes bit-shift into more "sane" triples, and taking the last
    // latched onto them, decoding a garbage position that walked the self dot the wrong way).
    const readFloatAt = (pos) => { const b = new BitReader(buf, bits); b.pos = pos; const t = Buffer.alloc(4); t.writeUInt32LE(b.readBits(32) >>> 0, 0); return t.readFloatLE(0); };
    const presentAt = (pos) => { const b = new BitReader(buf, bits); b.pos = pos; const val = b.readBit(); return val === 1 && !b.error; };
    for (let s = br.pos; s + 99 <= bits; s++) {
      if (!presentAt(s) || !presentAt(s + 33) || !presentAt(s + 66)) continue;
      const v = { x: readFloatAt(s + 1), y: readFloatAt(s + 34), z: readFloatAt(s + 67) };
      if (sane(v)) return v;
    }
    return null;
  }

  // Last known position of my own pawn (for the ServerMove ClientLoc and the self dot), or null. My position
  // is NOT replicated to me (I'm the movement authority), so it comes only from the server's move corrections
  // (selfEstimate, snapped to each ClientAdjustPosition); before the first one, fall back to the spawn point so
  // the green dot appears at once. The correction stream is what makes the dot move - the renderer glides it.
  selfPos() {
    if (this.selfEstimate) return this.selfEstimate;
    if (this.selfAdjustPos) return this.selfAdjustPos;
    if (this.myPawn != null) { const sp = this.spawnInfo(this.myPawn); if (sp) return { x: sp.x, y: sp.y, z: sp.z }; }
    return null;
  }

  // The server closed a channel - the actor is gone (our pawn on death, a player who left, a killed zed).
  // Drop everything keyed on it so stale data can't linger (a dead pawn must stop counting as "alive").
  _forgetChannel(ch) {
    if (this.openAt) delete this.openAt[ch];
    if (this._pendingPos) delete this._pendingPos[ch];
    delete this.openBunches[ch]; delete this.objects[ch]; delete this._nameChecked[ch];
    delete this.pawnHp[ch]; delete this.pawnHealthSeen[ch]; delete this.pawnOwner[ch]; delete this.priNames[ch]; delete this.priHealth[ch];
    this.pawns.delete(ch); this.playerPawns.delete(ch); this.priChannels.delete(ch);
    for (const p of Object.keys(this.pawnOwner)) if (this.pawnOwner[p] === ch) delete this.pawnOwner[p];
    if (ch === this.myPawn) {
      this.myPawn = null; this.myPawnHp = null; this.selfAdjustPos = null; this.selfEstimate = null;
      this.stats.hp = 0;   // our body is gone = we are dead until the next possession (ClientReStart)
    }
    if (ch === this.myPri) this.myPri = null;
  }

  // Am I alive on the map? `alive` gates Move: a living body has HP>0 (the PRI's PlayerHealth, which
  // decodes even before we can pin our own pawn). Between waves / after death there is no pawn and HP is
  // 0/absent, so alive is false - no need to read server-specific "respawn" chat. `positioned` (we know
  // where we are) additionally gates the self dot; `spawned` = we've identified our own pawn.
  selfState() {
    const hpRaw = this.stats.hp;
    // We have a body the moment our own pawn's channel is identified (its PlayerReplicationInfo == ours) -
    // don't wait for a clean Location decode, which a modded custom pawn class may never give us cleanly.
    const spawned = this.myPawn != null;
    const positioned = this.selfPos() != null;
    // A live pawn means alive - unless the server replicated Controller.Pawn = None (we died and the ragdoll
    // channel lingers). If HP decoded, honour it. UE2 never replicates a property equal to its class default,
    // so a fresh pawn's Health (default 100) simply never arrives: alive + no HP = the default 100.
    const alive = spawned ? (!this.unpossessed && (hpRaw == null || hpRaw > 0)) : (hpRaw != null && hpRaw > 0);
    const hp = hpRaw != null ? hpRaw : (alive ? 100 : null);
    return { alive, spawned, positioned, hp };
  }

  // One-line diagnostic of the live decode pipeline (opt-in KF_DEBUG_WORLD): how many actor channels we
  // hold open bunches for, how many decode as pawns, how many live positions we track and of what type,
  // and whether the package map is exact. Answers "why are there no monster/player dots".
  debugSummary() {
    const live = Object.values(this.objects);
    const by = (tp) => live.filter((o) => o.type === tp).length;
    const miss = this.pkgMap && this.pkgMap.missing && this.pkgMap.missing.length
      ? ' missing=' + this.pkgMap.missing.length + '(' + this.pkgMap.missing[0] + ')' : '';
    const dots = Object.entries(this.objects)
      .filter(([, o]) => o.type === 'mon' || o.type === 'player')
      .slice(0, 8)
      .map(([ch, o]) => o.type + '#' + ch + '@' + Math.round(o.x) + ',' + Math.round(o.y))
      .join(' ');
    return 'open=' + Object.keys(this.openBunches).length + ' pawns=' + this.pawns.size +
      ' playerPawns=' + this.playerPawns.size + ' pri=' + this.priChannels.size +
      ' live[self=' + by('self') + ' player=' + by('player') + ' mon=' + by('mon') + ']' +
      ' pkgComplete=' + !!(this.pkgMap && this.pkgMap.complete) + ' maxObj=' + this.maxObjIndex + miss +
      (dots ? ' | ' + dots : '');
  }

  snapshot() {
    const t = this.now();
    for (const ch of Object.keys(this.objects)) if (t - this.objects[ch].t > STALE_MS) delete this.objects[ch];
    const monNames = classifyMonsters(
      Object.entries(this.objects)
        .filter(([, o]) => o.type === 'mon' && o.hpMax != null)
        .map(([ch, o]) => ({ ch: +ch, hp: o.hpMax })),
    );
    // Monster label: the exact class name (e.g. ZombieScrake -> "Scrake") when the object table is exact,
    // else the reliable Health-roster guess. On a brute-forced map the class ref is imprecise, so we don't
    // trust it for names there.
    const exact = this.pkgMap && this.pkgMap.complete;
    const zedName = (c) => c && c.replace(/^Zombie/, '').replace(/_STANDARD$/i, '').replace(/Base$/, '');
    const objects = [];
    for (const [chS, o] of Object.entries(this.objects)) {
      const ch = +chS;
      let type = o.type, name = o.type === 'mon' ? (monNames[ch] || null) : (o.name || null);
      if (exact) {
        const cls = this.classFor(ch);
        const cat = this._pawnCategory(cls);
        if (o.type === 'mon') {
          if (cat === 'mon') name = zedName(cls);           // real zed -> exact name
          else if (cat === 'player') type = 'player';       // a player mis-typed as monster
          else if (cat) continue;                           // item/trader/etc decoded as a pawn -> not a monster
          // cat null (unresolved custom class) -> keep the Health-roster guess
        }
      }
      objects.push({ chIndex: ch, type, x: o.x, y: o.y, z: o.z != null ? o.z : 0, name, hp: o.hp != null ? o.hp : null,
        vx: o.vx || 0, vy: o.vy || 0, vt: o.vt || 0 });
    }
    // Static items + traders (spawn positions) as their own map layers.
    const wi = this.worldItems();
    for (const it of wi.items) objects.push({ chIndex: it.ch, type: 'item', x: it.x, y: it.y, name: it.name, hp: null });
    for (const tr of wi.traders) objects.push({ chIndex: tr.ch, type: 'trader', x: tr.x, y: tr.y, name: tr.name, hp: null });
    for (const d of wi.doors) objects.push({ chIndex: d.ch, type: 'door', x: d.x, y: d.y, name: d.name, hp: null, yaw: d.yaw });
    for (const mv of wi.movers) objects.push({ chIndex: mv.ch, type: 'mover', x: mv.x, y: mv.y, name: mv.name, hp: null, yaw: mv.yaw });
    // Live wave state (from the GRI) + alive-monster count (numMonsters isn't replicated, so count the
    // monster dots we're tracking). The GUI shows these the way a real client's HUD does.
    let wave = null;
    if (this.wave) {
      const aliveMonsters = objects.filter((o) => o.type === 'mon').length;
      wave = { ...this.wave, aliveMonsters };
    }
    // self state rides alongside - the renderer gates the self dot / Move on it (a dead / respawning /
    // spectating player has no body on the map, so it must not be drawn there). Stats mirror UE2's
    // default-value rule: an alive pawn whose Health/armor never replicated is at the class defaults.
    const self = this.selfState();
    const stats = { ...this.stats };
    if (self.alive) {
      if (stats.hp == null) stats.hp = 100;
      if (stats.armor == null) stats.armor = 0;
    }
    return { stats, objects, self, wave };
  }
}

module.exports = { WorldState, extractName, classifyMonsters, MONSTER_BASE_HP };
