// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Decompile UE2 replication functions by (demangled) name to learn the RPC wire format.
// @category KF
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import java.util.*;

public class rpcfmt extends GhidraScript {
    public void run() throws Exception {
        String[] names = {
            "ProcessRemoteFunction", "ReceivedBunch", "SendBunch", "ReplicateActor",
            "ReceivedRawBunch", "ReplicateFunction"
        };
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        FunctionManager fm = currentProgram.getFunctionManager();
        Set<String> done = new HashSet<String>();
        for (Function fn : fm.getFunctions(true)) {
            String nm = fn.getName();
            boolean hit = false;
            for (String t : names) if (nm.contains(t) && !nm.startsWith("Catch")) { hit = true; break; }
            if (!hit) continue;
            String key = fn.getEntryPoint().toString();
            if (done.contains(key)) continue;
            done.add(key);
            println("\n==================== " + fn.getName() + " @ " + key + " ====================");
            DecompileResults res = decomp.decompileFunction(fn, 240, monitor);
            if (res != null && res.decompileCompleted())
                println(res.getDecompiledFunction().getC());
            else
                println("<decompile failed>");
        }
        println("\n(total functions decompiled: " + done.size() + ")");
    }
}
