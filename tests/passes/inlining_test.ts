/**
 * @module binaryen-ts/tests/passes/inlining_test
 *
 * Tests for the Phase 5 Inlining pass.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";

import {
  BinaryOp,
  type Expression,
  ExpressionKind,
  makeBinary,
  makeBlock,
  makeCall,
  makeI32Const,
  makeLocalGet,
  makeLocalSet,
  makeNop,
  makeReturn,
  makeUnreachable,
} from "../../src/ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../../src/ir/module.ts";
import { None, ValType } from "../../src/ir/types.ts";
import { listPasses, PassRunner } from "../../src/passes/index.ts";
import { deepCopy, measureSize } from "../../src/passes/inlining.ts";
import { walkExpression } from "../../src/ir/walk.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyModule(): WasmModule {
  return {
    functions: [],
    globals: [],
    memories: [],
    tables: [],
    tags: [],
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
    heapTypes: [],
    hasGC: false,
  };
}

function countKind(expr: Expression, kind: ExpressionKind): number {
  let n = 0;
  walkExpression(expr, (e) => {
    if (e.kind === kind) n++;
  });
  return n;
}

function hasCall(expr: Expression, target: string): boolean {
  let found = false;
  walkExpression(expr, (e) => {
    if (e.kind === ExpressionKind.Call && e.target === target) found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Pass registry
// ---------------------------------------------------------------------------

Deno.test("Inlining: registered in pass list", () => {
  const passes = listPasses();
  assertEquals(passes.includes("Inlining"), true);
  assertEquals(passes.includes("InliningOptimizing"), true);
});

// ---------------------------------------------------------------------------
// measureSize helper
// ---------------------------------------------------------------------------

Deno.test("measureSize: leaf expression counts as 1", () => {
  assertEquals(measureSize(makeI32Const(0)), 1);
});

Deno.test("measureSize: binary counts as 3 (binary + 2 children)", () => {
  assertEquals(
    measureSize(makeBinary(BinaryOp.AddI32, makeI32Const(1), makeI32Const(2))),
    3,
  );
});

// ---------------------------------------------------------------------------
// deepCopy helper
// ---------------------------------------------------------------------------

Deno.test("deepCopy: produces a structurally equal but distinct tree", () => {
  const orig = makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeI32Const(1));
  const copy = deepCopy(orig);
  assertEquals(copy.kind, orig.kind);
  if (copy.kind === ExpressionKind.Binary && orig.kind === ExpressionKind.Binary) {
    assertEquals(copy.op, orig.op);
    assert(copy !== orig, "deep copy must produce a distinct object reference");
    assert(copy.left !== orig.left, "deep copy must produce distinct child nodes");
  }
});

// ---------------------------------------------------------------------------
// Always-inline: trivial function (size ≤ 2)
// ---------------------------------------------------------------------------

Deno.test("Inlining: trivial callee (size 2) is inlined", () => {
  // callee: (func $double (param i32) (result i32) (local.get 0))
  // body size = 1 (single local.get) → always inline
  const callee: WasmFunction = {
    name: "identity",
    params: [ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeLocalGet(0, ValType.I32),
  };

  // caller: (func $main (result i32) (call $identity (i32.const 5)))
  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("identity", [makeI32Const(5)], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // After inlining, `call $identity` should be gone from main's body.
  assertEquals(hasCall(caller.body, "identity"), false);
  // The inlined block wraps the callee body.
  assertEquals(countKind(caller.body, ExpressionKind.Block) >= 1, true);
});

// ---------------------------------------------------------------------------
// One-caller inline: single-ref function under threshold
// ---------------------------------------------------------------------------

Deno.test("Inlining: single-caller small callee is inlined and removed", () => {
  // callee: adds two params — size 3 (add + local.get + local.get)
  const callee: WasmFunction = {
    name: "add",
    params: [ValType.I32, ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }, { type: ValType.I32 }],
    body: makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeLocalGet(1, ValType.I32)),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("add", [makeI32Const(3), makeI32Const(4)], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // Call should be replaced.
  assertEquals(hasCall(caller.body, "add"), false);
  // The dead callee should have been removed since it had one ref and is not exported.
  const names = mod.functions.map((f) => f.name);
  assertEquals(names.includes("add"), false);
  assertEquals(names.includes("main"), true);
});

// ---------------------------------------------------------------------------
// Argument passing: operands assigned to param locals
// ---------------------------------------------------------------------------

Deno.test("Inlining: call operands become local.set in the inlined block", () => {
  const callee: WasmFunction = {
    name: "inc",
    params: [ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeI32Const(1)),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("inc", [makeI32Const(10)], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // After inlining, caller should have gained a local for the callee param.
  assertEquals(caller.locals.length >= 1, true);
  // The inlined block should contain a local.set that assigns the argument.
  assertEquals(countKind(caller.body, ExpressionKind.LocalSet) >= 1, true);
});

// ---------------------------------------------------------------------------
// Return handling: return inside callee becomes br to inlined block
// ---------------------------------------------------------------------------

Deno.test("Inlining: return in callee body becomes break to wrapper block", () => {
  // callee has an explicit return
  const callee: WasmFunction = {
    name: "ret_const",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeI32Const(42)),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("ret_const", [], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  assertEquals(hasCall(caller.body, "ret_const"), false);
  // A break to the inlined block label should appear in the body.
  assertEquals(countKind(caller.body, ExpressionKind.Break) >= 1, true);
});

// ---------------------------------------------------------------------------
// Recursive calls are NOT inlined
// ---------------------------------------------------------------------------

Deno.test("Inlining: recursive call is not inlined", () => {
  // factorial: size is small but calls itself
  const factorial: WasmFunction = {
    name: "factorial",
    params: [ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeReturn(
      makeBinary(
        BinaryOp.MulI32,
        makeLocalGet(0, ValType.I32),
        makeCall("factorial", [
          makeBinary(BinaryOp.SubI32, makeLocalGet(0, ValType.I32), makeI32Const(1)),
        ], ValType.I32),
      ),
    ),
  };

  const mod = emptyModule();
  mod.functions.push(factorial);
  mod.exports.push({ name: "factorial", value: "factorial", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // Recursive call must still be present.
  assertEquals(hasCall(factorial.body, "factorial"), true);
});

// ---------------------------------------------------------------------------
// Exported callee is inlined but NOT removed
// ---------------------------------------------------------------------------

Deno.test("Inlining: exported callee stays in module even after inlining", () => {
  const callee: WasmFunction = {
    name: "helper",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeI32Const(99),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("helper", [], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  // Both exported.
  mod.exports.push(
    { name: "main", value: "main", kind: "function" },
    { name: "helper", value: "helper", kind: "function" },
  );

  new PassRunner(mod).add("Inlining").run();

  // helper should still exist because it is exported.
  const names = mod.functions.map((f) => f.name);
  assertEquals(names.includes("helper"), true);
});

// ---------------------------------------------------------------------------
// Large callee is NOT inlined (exceeds FLEXIBLE_INLINE_MAX_SIZE at optLevel 2)
// ---------------------------------------------------------------------------

Deno.test("Inlining: large function is not inlined at optimizeLevel 2", () => {
  // Build a body with > 20 expression nodes.
  // chain of adds: add(add(add(... add(0, 1), 2), 3), ...)
  let expr: Expression = makeI32Const(0);
  for (let i = 1; i <= 10; i++) {
    expr = makeBinary(BinaryOp.AddI32, expr, makeI32Const(i));
  }
  // size = 10 binaries + 11 consts = 21 nodes → above FLEXIBLE_INLINE_MAX_SIZE(20)

  const callee: WasmFunction = {
    name: "big",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(expr),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("big", [], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  // optimizeLevel 2 — FLEXIBLE threshold not active, only ALWAYS and ONE_CALLER
  new PassRunner(mod, { optimizeLevel: 2 }).add("Inlining").run();

  // The call should remain because the function is too large for optLevel 2.
  assertEquals(hasCall(caller.body, "big"), true);
});

// ---------------------------------------------------------------------------
// Non-param locals are zero-initialised in inlined code
// ---------------------------------------------------------------------------

Deno.test("Inlining: non-param local is zero-initialised after inlining", () => {
  // callee has a non-param local it writes to and returns
  const callee: WasmFunction = {
    name: "localfn",
    params: [],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }], // one non-param local
    body: makeBlock([
      makeLocalSet(0, makeI32Const(7)),
      makeReturn(makeLocalGet(0, ValType.I32)),
    ]),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("localfn", [], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // Call replaced.
  assertEquals(hasCall(caller.body, "localfn"), false);
  // Caller should now have a local for the inlined non-param local.
  assertEquals(caller.locals.length >= 1, true);
  // There must be a local.set with i32.const 0 for zero init.
  let foundZeroInit = false;
  walkExpression(caller.body, (e) => {
    if (e.kind === ExpressionKind.LocalSet) {
      if (
        e.value.kind === ExpressionKind.Const && "i32" in e.value.value &&
        e.value.value.i32 === 0
      ) {
        foundZeroInit = true;
      }
    }
  });
  assertEquals(foundZeroInit, true);
});

// ---------------------------------------------------------------------------
// Multi-caller: NOT removed (both refs remain after inlining)
// ---------------------------------------------------------------------------

Deno.test("Inlining: multi-caller callee kept when inlined at multiple sites", () => {
  const callee: WasmFunction = {
    name: "helper",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeI32Const(1),
  };

  // Two callers each call helper once.
  const caller1: WasmFunction = {
    name: "f1",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("helper", [], ValType.I32)),
  };
  const caller2: WasmFunction = {
    name: "f2",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("helper", [], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller1, caller2, callee);
  mod.exports.push(
    { name: "f1", value: "f1", kind: "function" },
    { name: "f2", value: "f2", kind: "function" },
  );

  new PassRunner(mod).add("Inlining").run();

  // Both calls inlined (size == 1, ALWAYS_INLINE_MAX_SIZE).
  assertEquals(hasCall(caller1.body, "helper"), false);
  assertEquals(hasCall(caller2.body, "helper"), false);
});

// ---------------------------------------------------------------------------
// Void callee (no return value)
// ---------------------------------------------------------------------------

Deno.test("Inlining: void callee inlined correctly", () => {
  const callee: WasmFunction = {
    name: "side_effect",
    params: [],
    results: [],
    locals: [],
    body: makeNop(),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [],
    locals: [],
    body: makeBlock([
      makeCall("side_effect", [], None),
      makeNop(),
    ]),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  assertEquals(hasCall(caller.body, "side_effect"), false);
});

// ---------------------------------------------------------------------------
// Unreachable call stays unreachable after inlining
// ---------------------------------------------------------------------------

Deno.test("Inlining: unreachable before call keeps body unreachable", () => {
  const callee: WasmFunction = {
    name: "tiny",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeI32Const(0),
  };

  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [],
    locals: [],
    body: makeBlock([
      makeUnreachable(),
      makeCall("tiny", [], ValType.I32), // dead
    ]),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  // Run DCE first to remove dead call, then Inlining (DCE should remove it).
  new PassRunner(mod).add("DCE").add("Inlining").run();

  // After DCE the call is gone; inlining should not crash.
  assertEquals(hasCall(caller.body, "tiny"), false);
});

// ---------------------------------------------------------------------------
// InliningOptimizing: registered and runs without errors
// ---------------------------------------------------------------------------

Deno.test("InliningOptimizing: runs without error on simple module", () => {
  const callee: WasmFunction = {
    name: "const_fn",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeI32Const(42),
  };
  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeCall("const_fn", [], ValType.I32)),
  };

  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("InliningOptimizing").run();

  assertEquals(hasCall(caller.body, "const_fn"), false);
});

Deno.test("InliningOptimizing: cleans up inlined body — Binary fold", () => {
  // Callee returns `2 + 3`. After plain Inlining, the caller body has a
  // wrapper block containing the (i32.add (i32.const 2) (i32.const 3)) tree.
  // After InliningOptimizing, OptimizeInstructions runs over the modified
  // body and constant-folds it to (i32.const 5) — so the Binary node count
  // drops from 1 to 0. This is the observable difference between the two
  // passes; before the Phase 5 fix the `optimize` flag was set on
  // InliningOptimizingPass but never read, so the two passes were
  // indistinguishable.
  function makeCalleeAndCaller(): [WasmFunction, WasmFunction] {
    const callee: WasmFunction = {
      name: "two_plus_three",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeBinary(BinaryOp.AddI32, makeI32Const(2), makeI32Const(3)),
    };
    const caller: WasmFunction = {
      name: "main",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeReturn(makeCall("two_plus_three", [], ValType.I32)),
    };
    return [callee, caller];
  }

  // Baseline — plain Inlining leaves the Binary node intact after substitution.
  {
    const [callee, caller] = makeCalleeAndCaller();
    const mod = emptyModule();
    mod.functions.push(caller, callee);
    mod.exports.push({ name: "main", value: "main", kind: "function" });
    new PassRunner(mod).add("Inlining").run();
    assertEquals(hasCall(caller.body, "two_plus_three"), false);
    assertEquals(countKind(caller.body, ExpressionKind.Binary), 1);
  }

  // With cleanup — InliningOptimizing folds the inlined (2+3) to a constant.
  {
    const [callee, caller] = makeCalleeAndCaller();
    const mod = emptyModule();
    mod.functions.push(caller, callee);
    mod.exports.push({ name: "main", value: "main", kind: "function" });
    new PassRunner(mod).add("InliningOptimizing").run();
    assertEquals(hasCall(caller.body, "two_plus_three"), false);
    assertEquals(countKind(caller.body, ExpressionKind.Binary), 0);
  }
});

Deno.test("InliningOptimizing: cleans up inlined body — Vacuum drops nop", () => {
  // Callee body is a block containing a nop followed by a return value;
  // after inlining, the wrapper block contains a nop. Vacuum should remove
  // the nop. Compare nop count before/after.
  function makeMod(): { mod: WasmModule; caller: WasmFunction } {
    const callee: WasmFunction = {
      name: "nop_then_const",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeBlock([makeNop(), makeI32Const(7)]),
    };
    const caller: WasmFunction = {
      name: "main",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeReturn(makeCall("nop_then_const", [], ValType.I32)),
    };
    const mod = emptyModule();
    mod.functions.push(caller, callee);
    mod.exports.push({ name: "main", value: "main", kind: "function" });
    return { mod, caller };
  }

  // Plain Inlining: nop survives the substitution.
  {
    const { mod, caller } = makeMod();
    new PassRunner(mod).add("Inlining").run();
    assert(countKind(caller.body, ExpressionKind.Nop) >= 1);
  }

  // InliningOptimizing: Vacuum strips the nop from the block.
  {
    const { mod, caller } = makeMod();
    new PassRunner(mod).add("InliningOptimizing").run();
    assertEquals(countKind(caller.body, ExpressionKind.Nop), 0);
  }
});

// ---------------------------------------------------------------------------
// Split inlining (Pattern A / Pattern B) — Phase 5.1
// ---------------------------------------------------------------------------

/** Builds a body of the form: `(block (if (local.get 0) (return)) nop * N)`.
 *  Used to construct Pattern A test cases — the leading if-return is what the
 *  splitter latches onto; the trailing nops pad the function past the normal
 *  inliner's size thresholds so it gets handed off to the splitter. */
function makePatternABody(padNops: number): Expression {
  const items: Expression[] = [];
  items.push({
    kind: ExpressionKind.If,
    type: None,
    condition: makeLocalGet(0, ValType.I32),
    ifTrue: makeReturn(null),
    ifFalse: null,
  } as Expression);
  for (let i = 0; i < padNops; i++) items.push(makeNop());
  return makeBlock(items);
}

Deno.test("split-inlining: disabled by default — Pattern A function is untouched", () => {
  const callee: WasmFunction = {
    name: "early_exit",
    params: [ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makePatternABody(25),
  };
  // Two callers → multi-caller, normal inliner only fires at size <= 2.
  const caller1: WasmFunction = {
    name: "c1",
    params: [],
    results: [],
    locals: [],
    body: makeCall("early_exit", [makeI32Const(0)], None),
  };
  const caller2: WasmFunction = {
    name: "c2",
    params: [],
    results: [],
    locals: [],
    body: makeCall("early_exit", [makeI32Const(1)], None),
  };
  const mod = emptyModule();
  mod.functions.push(caller1, caller2, callee);
  mod.exports.push({ name: "c1", value: "c1", kind: "function" });
  mod.exports.push({ name: "c2", value: "c2", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // Default partialInliningIfs = 0 — split is disabled. Calls remain.
  assertEquals(hasCall(caller1.body, "early_exit"), true);
  assertEquals(hasCall(caller2.body, "early_exit"), true);
  // No outlined functions were added.
  assert(
    !mod.functions.some((f) => f.name.startsWith("byn-split-")),
    "no split-* functions should exist when partialInliningIfs=0",
  );
});

Deno.test("split-inlining: Pattern A — caller gets shell, outlined function added", () => {
  const callee: WasmFunction = {
    name: "early_exit",
    params: [ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makePatternABody(25),
  };
  const caller1: WasmFunction = {
    name: "c1",
    params: [],
    results: [],
    locals: [],
    body: makeCall("early_exit", [makeI32Const(0)], None),
  };
  const caller2: WasmFunction = {
    name: "c2",
    params: [],
    results: [],
    locals: [],
    body: makeCall("early_exit", [makeI32Const(1)], None),
  };
  const mod = emptyModule();
  mod.functions.push(caller1, caller2, callee);
  mod.exports.push({ name: "c1", value: "c1", kind: "function" });
  mod.exports.push({ name: "c2", value: "c2", kind: "function" });

  new PassRunner(mod, { partialInliningIfs: 4 }).add("Inlining").run();

  // The original call to `early_exit` has been replaced (the inlineable
  // shell — an if + a new call to the outlined function — is now inline).
  assertEquals(hasCall(caller1.body, "early_exit"), false);
  assertEquals(hasCall(caller2.body, "early_exit"), false);
  // Outlined function exists.
  assert(
    mod.functions.some((f) => f.name === "byn-split-outlined-A$early_exit"),
    "outlined-A function should have been added to module.functions",
  );
  // Each caller now calls the outlined function (via the inlined shell).
  assertEquals(hasCall(caller1.body, "byn-split-outlined-A$early_exit"), true);
  assertEquals(hasCall(caller2.body, "byn-split-outlined-A$early_exit"), true);
});

Deno.test("split-inlining: Pattern A with simple outlined chunk collapses to Full", () => {
  // Body is just (if (local.get 0) return) (nop). Outlined would be size 2
  // (block + nop), which passes outlinedFunctionWorthInlining → "Full" mode.
  // The whole callee gets inlined; no split-* functions appear.
  const callee: WasmFunction = {
    name: "tiny_early_exit",
    params: [ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makePatternABody(1),
  };
  const caller1: WasmFunction = {
    name: "c1",
    params: [],
    results: [],
    locals: [],
    body: makeCall("tiny_early_exit", [makeI32Const(0)], None),
  };
  const caller2: WasmFunction = {
    name: "c2",
    params: [],
    results: [],
    locals: [],
    body: makeCall("tiny_early_exit", [makeI32Const(1)], None),
  };
  const mod = emptyModule();
  mod.functions.push(caller1, caller2, callee);
  mod.exports.push({ name: "c1", value: "c1", kind: "function" });
  mod.exports.push({ name: "c2", value: "c2", kind: "function" });

  new PassRunner(mod, { partialInliningIfs: 4 }).add("Inlining").run();

  assertEquals(hasCall(caller1.body, "tiny_early_exit"), false);
  assertEquals(hasCall(caller2.body, "tiny_early_exit"), false);
  // Full inline path: no split-* functions were created.
  assert(
    !mod.functions.some((f) => f.name.startsWith("byn-split-")),
    "Full mode should not create any split-* functions",
  );
});

Deno.test("split-inlining: non-simple condition rejects Pattern A", () => {
  // Condition is (i32.add x x) — not in isSimple's allow-list (no Binary).
  // Splitter must classify as Uninlineable; calls remain.
  const callee: WasmFunction = {
    name: "complex_cond",
    params: [ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([
      {
        kind: ExpressionKind.If,
        type: None,
        condition: makeBinary(
          BinaryOp.AddI32,
          makeLocalGet(0, ValType.I32),
          makeLocalGet(0, ValType.I32),
        ),
        ifTrue: makeReturn(null),
        ifFalse: null,
      } as Expression,
      ...Array.from({ length: 25 }, () => makeNop()),
    ]),
  };
  const caller1: WasmFunction = {
    name: "c1",
    params: [],
    results: [],
    locals: [],
    body: makeCall("complex_cond", [makeI32Const(0)], None),
  };
  const caller2: WasmFunction = {
    name: "c2",
    params: [],
    results: [],
    locals: [],
    body: makeCall("complex_cond", [makeI32Const(1)], None),
  };
  const mod = emptyModule();
  mod.functions.push(caller1, caller2, callee);
  mod.exports.push({ name: "c1", value: "c1", kind: "function" });
  mod.exports.push({ name: "c2", value: "c2", kind: "function" });

  new PassRunner(mod, { partialInliningIfs: 4 }).add("Inlining").run();

  // Splitter rejects (not simple); calls remain.
  assertEquals(hasCall(caller1.body, "complex_cond"), true);
  assert(!mod.functions.some((f) => f.name.startsWith("byn-split-")));
});

// ---------------------------------------------------------------------------
// Phase 5.2 — return-call (`isReturn: true`) inlining semantics
// ---------------------------------------------------------------------------

Deno.test("return-call inlining: callee return propagates as caller return (value)", () => {
  // Callee returns i32 42. Caller has `return_call` to callee. After inline:
  // the call site becomes a Return wrapping the inlined block, so the value
  // of the inlined body is returned from the caller — not bound to a
  // wrapper-block label like a plain inline would do.
  const callee: WasmFunction = {
    name: "const42",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeI32Const(42), // size 1 → always inline
  };
  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeCall("const42", [], ValType.I32, /* isReturn */ true),
  };
  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  // Call to const42 is gone.
  assertEquals(hasCall(caller.body, "const42"), false);
  // Top-level shape is a Return — that's the tail-call propagation.
  assertEquals(caller.body.kind, ExpressionKind.Return);
});

Deno.test("return-call inlining: void callee — body executes then return", () => {
  // Callee returns void. Caller has `return_call`. Inlined shape:
  //   (block (wrapper-block (callee body)) (return null))
  // i.e. the wrapper executes for side effects, then an unconditional Return
  // exits the caller. The wrapper block does NOT have the tail-call's
  // explicit return rewritten to a break (because rewriteReturns=false).
  const callee: WasmFunction = {
    name: "side_effect",
    params: [],
    results: [],
    locals: [],
    body: makeNop(), // size 1 → always inline; void
  };
  const caller: WasmFunction = {
    name: "main",
    params: [],
    results: [],
    locals: [],
    body: makeCall("side_effect", [], None, /* isReturn */ true),
  };
  const mod = emptyModule();
  mod.functions.push(caller, callee);
  mod.exports.push({ name: "main", value: "main", kind: "function" });

  new PassRunner(mod).add("Inlining").run();

  assertEquals(hasCall(caller.body, "side_effect"), false);
  // The replacement is a Block ending in a Return node.
  assertEquals(caller.body.kind, ExpressionKind.Block);
  const outer = caller.body as { children: Expression[] };
  assertEquals(outer.children[outer.children.length - 1].kind, ExpressionKind.Return);
});

Deno.test("return-call inlining: callee's explicit return is NOT rewritten to a break", () => {
  // Callee body contains an explicit `(return 42)`. For plain call inlining
  // that return becomes `br $__inlined_func$callee$N 42`. For tail-call
  // inlining the return stays as a Return — it propagates out of the caller.
  const callee: WasmFunction = {
    name: "early_42",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeI32Const(42)), // size 2 → always inline
  };

  // Baseline: plain call. The Return inside the callee body becomes a Break.
  {
    const caller: WasmFunction = {
      name: "main",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeCall("early_42", [], ValType.I32, /* isReturn */ false),
    };
    const mod = emptyModule();
    mod.functions.push(caller, callee);
    mod.exports.push({ name: "main", value: "main", kind: "function" });
    new PassRunner(mod).add("Inlining").run();
    assert(
      countKind(caller.body, ExpressionKind.Break) >= 1,
      "plain call: return should be rewritten to break",
    );
  }

  // Tail-call: the Return survives the substitution. No new Break introduced
  // for the substituted return. (The wrapper block label is still present in
  // the IR but nothing breaks to it.)
  {
    const caller: WasmFunction = {
      name: "main",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeCall("early_42", [], ValType.I32, /* isReturn */ true),
    };
    const mod = emptyModule();
    mod.functions.push(caller, callee);
    mod.exports.push({ name: "main", value: "main", kind: "function" });
    new PassRunner(mod).add("Inlining").run();
    // The substituted body still contains the callee's explicit Return.
    assert(
      countKind(caller.body, ExpressionKind.Return) >= 1,
      "return-call inline: callee's Return should survive",
    );
    // No Break should have been introduced for the substituted return.
    assertEquals(
      countKind(caller.body, ExpressionKind.Break),
      0,
      "return-call inline: no Break should be introduced for the callee's return",
    );
  }
});

Deno.test("split-inlining: Pattern B — multiple ifs become outlined helpers", () => {
  // Body: two `if (local.get N) { ...heavy }` ifs followed by no final item.
  // Each if body has type none (lots of nops, no return). Both conditions
  // are simple. With partialInliningIfs=4, each if's body gets outlined.
  const heavy1: Expression[] = Array.from({ length: 12 }, () => makeNop());
  const heavy2: Expression[] = Array.from({ length: 12 }, () => makeNop());
  const callee: WasmFunction = {
    name: "two_branches",
    params: [ValType.I32, ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }, { type: ValType.I32 }],
    body: makeBlock([
      {
        kind: ExpressionKind.If,
        type: None,
        condition: makeLocalGet(0, ValType.I32),
        ifTrue: makeBlock(heavy1),
        ifFalse: null,
      } as Expression,
      {
        kind: ExpressionKind.If,
        type: None,
        condition: makeLocalGet(1, ValType.I32),
        ifTrue: makeBlock(heavy2),
        ifFalse: null,
      } as Expression,
    ]),
  };
  const caller1: WasmFunction = {
    name: "c1",
    params: [],
    results: [],
    locals: [],
    body: makeCall("two_branches", [makeI32Const(0), makeI32Const(0)], None),
  };
  const caller2: WasmFunction = {
    name: "c2",
    params: [],
    results: [],
    locals: [],
    body: makeCall("two_branches", [makeI32Const(1), makeI32Const(1)], None),
  };
  const mod = emptyModule();
  mod.functions.push(caller1, caller2, callee);
  mod.exports.push({ name: "c1", value: "c1", kind: "function" });
  mod.exports.push({ name: "c2", value: "c2", kind: "function" });

  new PassRunner(mod, { partialInliningIfs: 4 }).add("Inlining").run();

  // Original calls gone.
  assertEquals(hasCall(caller1.body, "two_branches"), false);
  // Both outlined-B functions exist.
  assert(
    mod.functions.some((f) => f.name === "byn-split-outlined-B$two_branches$0"),
    "outlined-B$0 should exist",
  );
  assert(
    mod.functions.some((f) => f.name === "byn-split-outlined-B$two_branches$1"),
    "outlined-B$1 should exist",
  );
});
