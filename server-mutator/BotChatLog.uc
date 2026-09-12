// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

//=============================================================================
// BotChatLog — a BroadcastHandler that logs chat text server-side, so the
// headless client's ServerSay (write) and TeamMessage (read) paths can be
// validated against ground truth. Registered by MutBotAutoReady.
//=============================================================================
class BotChatLog extends BroadcastHandler;

function BroadcastText(PlayerReplicationInfo SenderPRI, PlayerController Receiver, coerce string Msg, optional name Type)
{
    if (SenderPRI != None && Receiver != None && Receiver.PlayerReplicationInfo == SenderPRI)
        Log("[CHATLOG] from=" $ SenderPRI.PlayerName $ " type=" $ Type $ " msg=" $ Msg);
    Super.BroadcastText(SenderPRI, Receiver, Msg, Type);
}
