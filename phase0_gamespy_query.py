#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 TheBestPlan

"""
Phase 0 KF client — GameSpy v1 UDP query.

Self-contained, no deps. Speaks the *scripted* query layer of Killing Floor
(UE2.5), implemented in IpDrv/Classes/UdpGamespyQuery.uc. This is the only KF
network layer that is fully documented in UnrealScript and can be spoken without
reversing the native netcode — it is the first brick of an L2Walker-style bot and
a sanity check that sockets/ports/firewall are good before tackling the game
NetConnection (see docs/PROTOCOL.md, Phase 0).

Request : a datagram of backslash tokens, e.g. \\basic\\\\info\\\\rules\\\\players\\
Response : one or more UDP packets of \\key\\value\\... terminated, each tagged
           \\queryid\\<N>.<M>\\ and the last carrying \\final\\.

Query port is the GAME port + 10 (UdpGamespyQuery binds GetServerPort()+10).
KF default game port 7707 -> query port 7717.

Usage:
    python phase0_gamespy_query.py <host> [query_port] [--game-port 7707] [--query status]
Examples:
    python phase0_gamespy_query.py 127.0.0.1
    python phase0_gamespy_query.py kf.example.com 7717
    python phase0_gamespy_query.py 1.2.3.4 --game-port 7707 --query "basic info players rules"
"""
import argparse
import socket
import sys
import time


def build_query(types):
    # \type1\\type2\\type3\  (KF dispatches each token in ParseNextQuery)
    return ("\\" + "\\\\".join(types) + "\\").encode("latin-1")


def parse_kv(raw):
    """Split a \\k\\v\\k\\v... blob into ordered (key, value) pairs."""
    toks = raw.split("\\")
    if toks and toks[0] == "":
        toks = toks[1:]
    pairs = []
    it = iter(toks)
    for k in it:
        v = next(it, "")
        pairs.append((k, v))
    return pairs


def query(host, query_port, types, timeout=3.0):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    payload = build_query(types)
    addr = (host, query_port)
    print(f"-> {host}:{query_port}  {payload!r}")
    sock.sendto(payload, addr)

    chunks = []
    got_final = False
    deadline = time.time() + timeout
    while not got_final and time.time() < deadline:
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            break
        text = data.decode("latin-1", errors="replace")
        chunks.append(text)
        if "\\final\\" in text or text.endswith("\\final"):
            got_final = True
    sock.close()
    if not chunks:
        print("!! no response (server down / wrong query port / firewall).")
        print("   query port should be GAME_PORT + 10 (default 7707 -> 7717).")
        return None
    return "".join(chunks)


def main():
    ap = argparse.ArgumentParser(description="KF GameSpy v1 query (Phase 0 bot brick)")
    ap.add_argument("host")
    ap.add_argument("query_port", nargs="?", type=int, default=None,
                    help="GameSpy query UDP port (default = game_port + 10)")
    ap.add_argument("--game-port", type=int, default=7707,
                    help="game port, used to derive query port if not given (default 7707)")
    ap.add_argument("--query", default="basic info players rules",
                    help='space-separated query types (default "basic info players rules"; '
                         'or just "status")')
    ap.add_argument("--timeout", type=float, default=3.0)
    args = ap.parse_args()

    qport = args.query_port if args.query_port is not None else args.game_port + 10
    types = args.query.split()

    raw = query(args.host, qport, types, args.timeout)
    if raw is None:
        sys.exit(1)

    pairs = parse_kv(raw)

    # split server fields vs player_N / frags_N / ping_N / team_N rows
    server = []
    players = {}
    meta = {"queryid", "final"}
    for k, v in pairs:
        if k in meta:
            continue
        if "_" in k and k.rsplit("_", 1)[1].isdigit():
            base, idx = k.rsplit("_", 1)
            players.setdefault(int(idx), {})[base] = v
        else:
            server.append((k, v))

    print("\n=== SERVER ===")
    for k, v in server:
        print(f"  {k:<16} {v}")

    if players:
        print("\n=== PLAYERS ===")
        for idx in sorted(players):
            p = players[idx]
            print(f"  [{idx}] {p.get('player','?'):<20} "
                  f"frags={p.get('frags','?'):<5} "
                  f"ping={p.get('ping','?'):<5} team={p.get('team','?')}")
    else:
        print("\n(no player rows returned)")


if __name__ == "__main__":
    main()
