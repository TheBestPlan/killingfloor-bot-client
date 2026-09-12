// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Decompile the open-bunch location reader (FUN_103fada0) and neighbours to learn
// the compressed FVector / FRotator net-serialization used by actor replication.
// @category KF
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;

public class vecfmt extends GhidraScript {
    public void run() throws Exception {
        long[] addrs = { 0x103fada0L, 0x103fac60L, 0x103fadd0L, 0x103fab30L, 0x103fab90L, 0x103faa30L };
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        for (long a : addrs) {
            Address addr = toAddr(a);
            Function fn = fm.getFunctionContaining(addr);
            if (fn == null) { println("no function at " + addr); continue; }
            println("\n==================== " + fn.getName() + " @ " + fn.getEntryPoint() + " ====================");
            DecompileResults res = decomp.decompileFunction(fn, 150, monitor);
            if (res != null && res.decompileCompleted()) println(res.getDecompiledFunction().getC());
            else println("<decompile failed>");
        }
    }
}
