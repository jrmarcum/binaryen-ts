/**
 * @module binaryen-ts/passes/remove-unused-module-elements
 *
 * RemoveUnusedModuleElements pass — global dead-code elimination.
 *
 * Removes function definitions and global variable definitions that are
 * provably unreachable from the module's public interface (exports and
 * element segments). Imported functions and globals are never removed
 * (they exist in the host environment regardless).
 *
 * **Reachability algorithm**:
 * 1. Seed the live set with all functions referenced by exports (kind
 *    `"function"`) and by element segments (indirect-call tables).
 * 2. Repeat until fixed point: for each live function, walk its body
 *    and add any directly called function names to the live set.
 * 3. Remove all non-imported functions not in the live set.
 * 4. Collect all global names referenced by live functions and global
 *    initialisers; remove non-imported globals not in that set.
 * 5. Remove exports that refer to removed functions or globals.
 *
 * **Limitations**: `call_indirect` (indirect calls) use a runtime table
 * index, not a static name. Functions in element segments are kept
 * unconditionally (they are potential indirect-call targets). Dynamic
 * global access patterns introduced by host imports are assumed to be
 * visible and are not analysed.
 *
 * Reference: `upstream/src/passes/RemoveUnusedModuleElements.cpp`
 *
 * @license MIT OR Apache-2.0
 */

import { Expression, ExpressionKind } from "../ir/expressions.ts";
import { WasmModule } from "../ir/module.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";
import { walkExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Removes unreachable functions and globals from the module. */
export class RemoveUnusedModuleElementsPass implements Pass {
  readonly name = "RemoveUnusedModuleElements";
  readonly description =
    "Removes functions and globals not reachable from exports or element segments.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    _removeUnused(module);
  }
}

registerPass(RemoveUnusedModuleElementsPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function _removeUnused(module: WasmModule): void {
  // Set of imported function names — these must never be removed
  const importedFuncs = new Set<string>(
    module.imports
      .filter((imp) => imp.kind === "function")
      .map((imp) => imp.name),
  );
  const importedGlobals = new Set<string>(
    module.imports
      .filter((imp) => imp.kind === "global")
      .map((imp) => imp.name),
  );

  // Index local function definitions for quick lookup
  const funcMap = new Map(module.functions.map((f) => [f.name, f]));

  // --- Step 1: seed with exported functions ---
  const liveFuncs = new Set<string>();

  for (const exp of module.exports) {
    if (exp.kind === "function") liveFuncs.add(exp.value);
  }

  // Functions referenced in element segments (indirect-call targets)
  for (const seg of module.elements) {
    for (const name of seg.data) liveFuncs.add(name);
  }

  // --- Step 2: fixed-point reachability walk ---
  const queue = [...liveFuncs].filter((n) => !importedFuncs.has(n));
  while (queue.length > 0) {
    const name = queue.pop()!;
    const fn = funcMap.get(name);
    if (!fn) continue; // imported or unknown
    _collectCallTargets(fn.body, liveFuncs, queue, importedFuncs);
  }

  // --- Step 3: collect referenced globals (from live functions + global inits) ---
  const liveGlobals = new Set<string>();

  // Globals referenced by live functions
  for (const [name, fn] of funcMap) {
    if (liveFuncs.has(name) || importedFuncs.has(name)) {
      _collectGlobalRefs(fn.body, liveGlobals);
    }
  }

  // Globals referenced by other global initialisers (globals can depend on each other)
  for (const global of module.globals) {
    if (importedGlobals.has(global.name)) continue;
    _collectGlobalRefs(global.init, liveGlobals);
  }

  // Always keep globals that are exported
  for (const exp of module.exports) {
    if (exp.kind === "global") liveGlobals.add(exp.value);
  }

  // --- Step 4: prune non-live, non-imported definitions ---
  const removedFuncs = new Set<string>();
  module.functions = module.functions.filter((fn) => {
    if (liveFuncs.has(fn.name)) return true;
    removedFuncs.add(fn.name);
    return false;
  });

  module.globals = module.globals.filter(
    (g) => importedGlobals.has(g.name) || liveGlobals.has(g.name),
  );

  // --- Step 5: prune exports pointing to removed functions/globals ---
  module.exports = module.exports.filter((exp) => {
    if (exp.kind === "function") return !removedFuncs.has(exp.value);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _collectCallTargets(
  expr: Expression,
  live: Set<string>,
  queue: string[],
  imported: Set<string>,
): void {
  walkExpression(expr, (e) => {
    if (e.kind === ExpressionKind.Call) {
      if (!live.has(e.target) && !imported.has(e.target)) {
        live.add(e.target);
        queue.push(e.target);
      } else if (!live.has(e.target)) {
        live.add(e.target);
      }
    }
    if (e.kind === ExpressionKind.RefFunc) {
      if (!live.has(e.func)) {
        live.add(e.func);
        if (!imported.has(e.func)) queue.push(e.func);
      }
    }
  });
}

function _collectGlobalRefs(expr: Expression, liveGlobals: Set<string>): void {
  walkExpression(expr, (e) => {
    if (e.kind === ExpressionKind.GlobalGet) liveGlobals.add(e.name);
    if (e.kind === ExpressionKind.GlobalSet) liveGlobals.add(e.name);
  });
}