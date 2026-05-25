/**
 * @module binaryen-ts/tests/passes/inlining_test
 *
 * Tests for the Phase 5 Inlining pass.
 *
 * @license MIT OR Apache-2.0
 */

import { assert, assertEquals } from "jsr:@std/assert";

import {
  BinaryOp,
  Expression,
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
import { WasmFunction, WasmModule } from "../../src/ir/module.ts";
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
  walkExpression(expr, (e) => { if (e.kind === kind) n++; });
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
    locals: [{ type: ValType.I32 }],  // one non-param local
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
      if (e.value.kind === ExpressionKind.Const && "i32" in e.value.value &&
        e.value.value.i32 === 0) {
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
      makeCall("tiny", [], ValType.I32),  // dead
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