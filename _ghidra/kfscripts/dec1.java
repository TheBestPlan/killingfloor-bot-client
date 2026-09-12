// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Decompile specific addresses (the RPC bunch serializer FUN_104d8ce0 and helpers).
// @category KF
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;

public class dec1 extends GhidraScript {
    public void run() throws Exception {
        String[] addrs = { "104d8ce0" };
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        for (String h : addrs) {
            Address a = currentProgram.getAddressFactory().getAddress(h);
            Function fn = fm.getFunctionContaining(a);
            if (fn == null) { println("no func at " + h); continue; }
            println("\n==================== " + fn.getName() + " @ " + fn.getEntryPoint() + " ====================");
            DecompileResults res = decomp.decompileFunction(fn, 240, monitor);
            if (res != null && res.decompileCompleted())
                println(res.getDecompiledFunction().getC());
            else
                println("<decompile failed>");
        }
    }
}
