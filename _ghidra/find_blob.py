# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 TheBestPlan

# Ghidra post-script (Jython): locate the KF STEAMCLIENTBLOB handler and decompile it.
# Finds UTF-16LE strings, their code xrefs, and decompiles the containing functions.
# @category KF
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

TARGETS = [
    "STEAMCLIENTBLOB",
    "Server recieved client blob",
    "Blobsize whack",
    "STEAMENCRYPTIONKEY",
    "invalid chunk",
    "invalid index",
]

def wide_bytes(s):
    b = []
    for ch in s:
        b.append(ord(ch) & 0xff)
        b.append(0)
    return bytes(bytearray(b))

def find_all(pat):
    mem = currentProgram.getMemory()
    out = []
    start = currentProgram.getMinAddress()
    monitor = ConsoleTaskMonitor()
    while True:
        a = mem.findBytes(start, pat, None, True, monitor)
        if a is None:
            break
        out.append(a)
        start = a.add(2)
        if len(out) > 40:
            break
    return out

def main():
    listing = currentProgram.getListing()
    fm = currentProgram.getFunctionManager()
    decomp = DecompInterface()
    decomp.openProgram(currentProgram)
    monitor = ConsoleTaskMonitor()

    funcs_to_dump = {}  # entry addr -> func

    for t in TARGETS:
        addrs = find_all(wide_bytes(t))
        print("=== STRING '%s' : %d location(s) ===" % (t, len(addrs)))
        for a in addrs:
            print("  @ %s" % a)
            refs = getReferencesTo(a)
            for r in refs:
                fr = r.getFromAddress()
                fn = fm.getFunctionContaining(fr)
                if fn is not None:
                    print("    xref from %s in FUNC %s (%s)" % (fr, fn.getName(), fn.getEntryPoint()))
                    funcs_to_dump[fn.getEntryPoint().toString()] = fn
                else:
                    print("    xref from %s (no function)" % fr)

    print("\n\n########## DECOMPILED HANDLER FUNCTIONS (%d) ##########\n" % len(funcs_to_dump))
    for entry, fn in funcs_to_dump.items():
        print("\n==================== FUNC %s @ %s ====================" % (fn.getName(), entry))
        res = decomp.decompileFunction(fn, 120, monitor)
        if res is not None and res.decompileCompleted():
            print(res.getDecompiledFunction().getC())
        else:
            print("  <decompile failed>")

main()
