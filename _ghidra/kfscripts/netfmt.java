// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Decompile UE2 package-map / bit-reader / net-cache functions to pin down the
// net-GUID (SerializeObject), field-index (ReadInt), net-cache ordering and
// per-type NetSerializeItem wire formats.
// @category KF
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import java.util.*;

public class netfmt extends GhidraScript {
    public void run() throws Exception {
        // SerializeObject is an exported virtual (found); the package-map/net-cache
        // builders (IndexToObject/GetClassNetCache/...) are internal and unnamed in
        // Ghidra — reach them via the UPackageMap vtable slots, not by name.
        String[] names = {
            "SerializeObject", "CanSerializeObject",
            "IndexToObject", "GetIndexFromObject", "GetClassNetCache",
            "GetFromIndex", "GetFromField", "GetMaxIndex", "NetSerializeItem"
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
            String parent = fn.getParentNamespace() != null ? fn.getParentNamespace().getName() : "";
            println("\n==================== " + parent + "::" + fn.getName() + " @ " + key + " ====================");
            DecompileResults res = decomp.decompileFunction(fn, 180, monitor);
            if (res != null && res.decompileCompleted())
                println(res.getDecompiledFunction().getC());
            else
                println("<decompile failed>");
        }
        println("\n(total functions decompiled: " + done.size() + ")");
    }
}
