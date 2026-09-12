// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

//=============================================================================
// MutBotAutoReady — server-side "press Ready" for connected players.
//
// UnrealScript cannot read the native FClassNetCache, so historically a headless
// client couldn't learn ServerRestartPlayer's net field index to send the RPC
// itself; this mutator did, server-side, exactly what the Ready button does
// (set bReadyToPlay) so a bot that merely CONNECTS spawns on the map.
//
// The client can now compute that index offline from the .u files (see
// lib/netcache.js / docs/PROTOCOL.md §7), so bAutoReady can be turned off to let
// the bot press Ready itself; the per-tick [GT] line then reports the ready state
// and pawn health so that RPC path can be validated against ground truth.
//=============================================================================
class MutBotAutoReady extends Mutator;

var bool bAutoReady;              // server-side fallback: mark players ready so they spawn
var bool bKeepAlive;              // test aid: keep bots at full health
var bool bClearZeds;              // test aid: destroy all monsters so a bot can move unobstructed
var bool bRespawnCycle;           // test aid: reproduce a timer/auto-respawn gametype — periodically destroy the
                                  // bot's pawn so it must re-possess + resume move-to (the goal's нестандартный респавн)
var float RespawnPeriod;          // seconds between forced respawns
var float DeferSpawnSecs;         // test aid: delay the FIRST spawn (nonstandard start mechanic)
var array<string> spawnLogged;
var float LastCycleAt;
var float MatchStartAt;

function PostBeginPlay()
{
    Super.PostBeginPlay();
    SetTimer(2.0, true);
    Log("[BotAutoReady] active bAutoReady=" $ bAutoReady);
    if (Level.Game != None && Level.Game.BroadcastHandler != None)
    {
        Level.Game.BroadcastHandler.RegisterBroadcastHandler(Spawn(class'BotChatLog'));
        Log("[BotAutoReady] chat oracle registered");
    }
}

function Timer()
{
    local Controller C;
    local PlayerController PC;
    local KFMonster M;

    // Test aid: clear every monster so a bot's move-to isn't body-blocked or killed.
    if (bClearZeds)
        foreach DynamicActors(class'KFMonster', M)
            M.Destroy();

    if (MatchStartAt == 0.0)
        MatchStartAt = Level.TimeSeconds;

    // Test aid: reproduce a timer/auto-respawn gametype deterministically — periodically destroy the bot's
    // pawn so the client must re-possess and resume move-to on a fresh body, exactly the нестандартный респавн.
    if (bRespawnCycle && Level.TimeSeconds - LastCycleAt > RespawnPeriod && Level.TimeSeconds - MatchStartAt > 12.0)
    {
        LastCycleAt = Level.TimeSeconds;
        for (C = Level.ControllerList; C != None; C = C.NextController)
        {
            PC = PlayerController(C);
            if (PC != None && PC.Pawn != None && PC.PlayerReplicationInfo != None && !PC.PlayerReplicationInfo.bOnlySpectator)
            {
                Log("[BotAutoReady] RESPAWN-CYCLE destroy pawn -> " $ PC.PlayerReplicationInfo.PlayerName);
                PC.Pawn.Destroy();
            }
        }
    }

    for (C = Level.ControllerList; C != None; C = C.NextController)
    {
        PC = PlayerController(C);
        if (PC == None || PC.PlayerReplicationInfo == None)
            continue;

        // Explicit "on the map" confirmation (once per player).
        if (PC.Pawn != None && !AlreadyOnMap(PC.PlayerReplicationInfo.PlayerName))
        {
            spawnLogged[spawnLogged.Length] = PC.PlayerReplicationInfo.PlayerName;
            Log("[BotAutoReady] ON MAP: " $ PC.PlayerReplicationInfo.PlayerName
                $ " pawn=" $ PC.Pawn.Class.Name
                $ " health=" $ PC.Pawn.Health
                $ " at " $ PC.Pawn.Location);
        }

        // Per-tick ground truth: ready state (so an external Ready RPC is observable)
        // plus pawn health/location once spawned.
        if (PC.Pawn != None && bKeepAlive)
            PC.Pawn.Health = PC.Pawn.default.Health;   // test aid: keep bots alive to observe movement

        if (PC.Pawn != None)
            Log("[GT] " $ PC.PlayerReplicationInfo.PlayerName
                $ " ready=" $ PC.PlayerReplicationInfo.bReadyToPlay
                $ " hp=" $ PC.Pawn.Health
                $ " x=" $ PC.Pawn.Location.X $ " y=" $ PC.Pawn.Location.Y $ " z=" $ PC.Pawn.Location.Z
                $ " vx=" $ int(PC.Pawn.Velocity.X) $ " vy=" $ int(PC.Pawn.Velocity.Y)
                $ " ax=" $ int(PC.Pawn.Acceleration.X) $ " ay=" $ int(PC.Pawn.Acceleration.Y));
        else
            Log("[GT] " $ PC.PlayerReplicationInfo.PlayerName
                $ " ready=" $ PC.PlayerReplicationInfo.bReadyToPlay
                $ " spec=" $ PC.PlayerReplicationInfo.bOnlySpectator
                $ " waiting=" $ Level.Game.bWaitingToStartMatch
                $ " nopawn");

        if (bAutoReady && !PC.PlayerReplicationInfo.bOnlySpectator && PC.Pawn == None)
        {
            if (Level.Game.bWaitingToStartMatch)
            {
                if (!PC.PlayerReplicationInfo.bReadyToPlay)
                {
                    PC.PlayerReplicationInfo.bReadyToPlay = true;
                    Log("[BotAutoReady] READY -> " $ PC.PlayerReplicationInfo.PlayerName);
                }
            }
            // Nonstandard START mechanic: hold the first spawn until DeferSpawnSecs have passed (the client
            // must ready + wait, like joining a gametype that only spawns at a wave/story boundary).
            else if (Level.TimeSeconds - MatchStartAt >= DeferSpawnSecs)
            {
                Level.Game.RestartPlayer(C);
                Log("[BotAutoReady] SPAWN -> " $ PC.PlayerReplicationInfo.PlayerName);
            }
        }
    }
}

function bool AlreadyOnMap(string n)
{
    local int i;
    for (i = 0; i < spawnLogged.Length; i++)
        if (spawnLogged[i] == n)
            return true;
    return false;
}

defaultproperties
{
    bAutoReady=True
    bKeepAlive=True
    bClearZeds=False
    bRespawnCycle=False
    RespawnPeriod=22.0
    DeferSpawnSecs=0.0
    GroupName="BotAutoReady"
    FriendlyName="Bot Auto Ready"
    Description="Server-side: marks connected players ready so they spawn."
}
