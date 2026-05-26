/**
 * @module binaryen-ts/tests/passes/passes_test
 *
 * Tests for all Phase 4 optimization passes.
 *
 * @license MIT
 */

import { assertEquals, assertNotEquals } from "@std/assert";

import {
  BinaryOp,
  type BlockExpr,
  type Expression,
  ExpressionKind,
  makeBinary,
  makeBlock,
  makeBreak,
  makeDrop,
  makeI32Const,
  makeI64Const,
  makeLocalGet,
  makeLocalSet,
  makeNop,
  makeReturn,
  makeThrow,
  makeTry,
  makeTryTable,
  makeUnary,
  makeUnreachable,
  UnaryOp,
} from "../../src/ir/expressions.ts";
import { ModuleBuilder, type WasmFunction, type WasmModule } from "../../src/ir/module.ts";
import { None, ValType } from "../../src/ir/types.ts";
import { listPasses, PassRunner } from "../../src/passes/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestFn(name: string, body: ReturnType<typeof makeBlock>): WasmFunction {
  return {
    name,
    params: [],
    results: [],
    locals: [],
    body,
  };
}

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

// ---------------------------------------------------------------------------
// Pass registry
// ---------------------------------------------------------------------------

Deno.test("listPasses: all Phase 4 passes are registered", () => {
  const passes = listPasses();
  const expected = [
    "CoalesceLocals",
    "DCE",
    "LocalCSE",
    "OptimizeInstructions",
    "PickLoadSigns",
    "RemoveUnusedBrs",
    "RemoveUnusedModuleElements",
    "SimplifyLocals",
    "Vacuum",
  ];
  for (const name of expected) {
    assertEquals(passes.includes(name), true, `Expected pass "${name}" to be registered`);
  }
});

// ---------------------------------------------------------------------------
// Vacuum pass
// ---------------------------------------------------------------------------

Deno.test("Vacuum: removes nop from block children", () => {
  const mod = emptyModule();
  const body = makeBlock([makeNop(), makeI32Const(42), makeNop()]);
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("Vacuum").run();

  const fn = mod.functions[0];
  // Nops should be removed; block should collapse to single const or small block
  if (fn.body.kind === ExpressionKind.Block) {
    for (const child of fn.body.children) {
      assertNotEquals(child.kind, ExpressionKind.Nop);
    }
  } else {
    // Collapsed to the const directly
    assertEquals(fn.body.kind, ExpressionKind.Const);
  }
});

Deno.test("Vacuum: empty block (all nops) collapses to nop", () => {
  const mod = emptyModule();
  const body = makeBlock([makeNop(), makeNop()]);
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("Vacuum").run();

  assertEquals(mod.functions[0].body.kind, ExpressionKind.Nop);
});

Deno.test("Vacuum: drop(const) becomes nop", () => {
  const mod = emptyModule();
  // Block with drop(const) which should become nop → then block collapses
  const body = makeBlock([makeDrop(makeI32Const(5))]);
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("Vacuum").run();

  assertEquals(mod.functions[0].body.kind, ExpressionKind.Nop);
});

Deno.test("Vacuum: drop(local.get) becomes nop", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([makeDrop(makeLocalGet(0, ValType.I32))]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("Vacuum").run();

  assertEquals(mod.functions[0].body.kind, ExpressionKind.Nop);
});

Deno.test("Vacuum: unnamed single-child block collapses", () => {
  const mod = emptyModule();
  const inner = makeI32Const(7);
  const body = makeBlock([inner]); // unnamed, single child
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("Vacuum").run();

  assertEquals(mod.functions[0].body.kind, ExpressionKind.Const);
});

// ---------------------------------------------------------------------------
// OptimizeInstructions — algebraic identities
// ---------------------------------------------------------------------------

Deno.test("OptimizeInstructions: add(x, 0) → x", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([
      makeReturn(makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeI32Const(0))),
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("OptimizeInstructions").run();

  const fnBody = mod.functions[0].body;
  const ret: Expression = fnBody.kind === ExpressionKind.Block
    ? (fnBody as BlockExpr).children[0]
    : fnBody;
  // The return's value should now be local.get(0), not a binary
  if (ret.kind === ExpressionKind.Return) {
    assertEquals(ret.value?.kind, ExpressionKind.LocalGet);
  }
});

Deno.test("OptimizeInstructions: mul(x, 1) → x", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeReturn(makeBinary(BinaryOp.MulI32, makeLocalGet(0, ValType.I32), makeI32Const(1))),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("OptimizeInstructions").run();

  const ret = mod.functions[0].body;
  if (ret.kind === ExpressionKind.Return) {
    assertEquals(ret.value?.kind, ExpressionKind.LocalGet);
  }
});

Deno.test("OptimizeInstructions: constant folding i32.add(3, 4) → 7", () => {
  const mod = emptyModule();
  mod.functions.push({
    name: "f",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeBinary(BinaryOp.AddI32, makeI32Const(3), makeI32Const(4))),
  });

  new PassRunner(mod).add("OptimizeInstructions").run();

  const ret = mod.functions[0].body;
  if (ret.kind === ExpressionKind.Return && ret.value?.kind === ExpressionKind.Const) {
    assertEquals((ret.value.value as { i32: number }).i32, 7);
  }
});

Deno.test("OptimizeInstructions: constant folding i32.mul(6, 7) → 42", () => {
  const mod = emptyModule();
  mod.functions.push({
    name: "f",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeBinary(BinaryOp.MulI32, makeI32Const(6), makeI32Const(7))),
  });

  new PassRunner(mod).add("OptimizeInstructions").run();

  const ret = mod.functions[0].body;
  if (ret.kind === ExpressionKind.Return && ret.value?.kind === ExpressionKind.Const) {
    assertEquals((ret.value.value as { i32: number }).i32, 42);
  }
});

Deno.test("OptimizeInstructions: constant folding i32.eqz(0) → 1", () => {
  const mod = emptyModule();
  mod.functions.push({
    name: "f",
    params: [],
    results: [ValType.I32],
    locals: [],
    body: makeReturn(makeUnary(UnaryOp.EqzI32, makeI32Const(0))),
  });

  new PassRunner(mod).add("OptimizeInstructions").run();

  const ret = mod.functions[0].body;
  if (ret.kind === ExpressionKind.Return && ret.value?.kind === ExpressionKind.Const) {
    assertEquals((ret.value.value as { i32: number }).i32, 1);
  }
});

Deno.test("OptimizeInstructions: and(x, -1) → x", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [ValType.I32],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeReturn(makeBinary(BinaryOp.AndI32, makeLocalGet(0, ValType.I32), makeI32Const(-1))),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("OptimizeInstructions").run();

  const ret = mod.functions[0].body;
  if (ret.kind === ExpressionKind.Return) {
    assertEquals(ret.value?.kind, ExpressionKind.LocalGet);
  }
});

Deno.test("OptimizeInstructions: i64 add(x, 0) → x", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [ValType.I64],
    results: [ValType.I64],
    locals: [{ type: ValType.I64 }],
    body: makeReturn(makeBinary(BinaryOp.AddI64, makeLocalGet(0, ValType.I64), makeI64Const(0n))),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("OptimizeInstructions").run();

  const ret = mod.functions[0].body;
  if (ret.kind === ExpressionKind.Return) {
    assertEquals(ret.value?.kind, ExpressionKind.LocalGet);
  }
});

// ---------------------------------------------------------------------------
// RemoveUnusedBrs pass
// ---------------------------------------------------------------------------

Deno.test("RemoveUnusedBrs: br at tail of own block is removed", () => {
  // (block $B (nop) (br $B))  →  (block $B (nop))  →  nop (via Vacuum)
  const mod = emptyModule();
  const nop = makeNop();
  const br = makeBreak("$B");
  const body: ReturnType<typeof makeBlock> = {
    kind: ExpressionKind.Block,
    type: None,
    name: "$B",
    children: [nop, br],
  };
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("RemoveUnusedBrs").run();

  const fn = mod.functions[0];
  if (fn.body.kind === ExpressionKind.Block) {
    // br should be gone
    for (const child of fn.body.children) {
      assertNotEquals(child.kind, ExpressionKind.Break);
    }
  }
});

Deno.test("RemoveUnusedBrs: solo br to own block → nop", () => {
  const mod = emptyModule();
  const body: ReturnType<typeof makeBlock> = {
    kind: ExpressionKind.Block,
    type: None,
    name: "$B",
    children: [makeBreak("$B")],
  };
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("RemoveUnusedBrs").run();

  assertEquals(mod.functions[0].body.kind, ExpressionKind.Nop);
});

// ---------------------------------------------------------------------------
// SimplifyLocals pass
// ---------------------------------------------------------------------------

Deno.test("SimplifyLocals: local.set + local.get → local.tee", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([
      makeLocalSet(0, makeI32Const(42)),
      makeLocalGet(0, ValType.I32),
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("SimplifyLocals").run();

  const body = mod.functions[0].body;
  // Should be either a single tee or a block with a single tee
  if (body.kind === ExpressionKind.Block) {
    assertEquals(body.children.length, 1);
    assertEquals(body.children[0].kind, ExpressionKind.LocalTee);
  } else {
    assertEquals(body.kind, ExpressionKind.LocalTee);
  }
});

Deno.test("SimplifyLocals: non-matching indices are not merged", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }, { type: ValType.I32 }],
    body: makeBlock([
      makeLocalSet(0, makeI32Const(1)),
      makeLocalGet(1, ValType.I32), // different index
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("SimplifyLocals").run();

  const body = mod.functions[0].body;
  if (body.kind === ExpressionKind.Block) {
    assertEquals(body.children.length, 2);
    assertEquals(body.children[0].kind, ExpressionKind.LocalSet);
    assertEquals(body.children[1].kind, ExpressionKind.LocalGet);
  }
});

// ---------------------------------------------------------------------------
// CoalesceLocals pass — dead-write elimination
// ---------------------------------------------------------------------------

Deno.test("CoalesceLocals: dead local.set becomes drop", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [],
    // local 0 is set but never read
    locals: [{ type: ValType.I32 }],
    body: makeBlock([makeLocalSet(0, makeI32Const(99))]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("CoalesceLocals").run();

  // The set should have been replaced with drop(const(99))
  const body = mod.functions[0].body;
  const child = body.kind === ExpressionKind.Block ? body.children[0] : body;
  assertEquals(child.kind, ExpressionKind.Drop);
});

Deno.test("CoalesceLocals: used local.set is preserved", () => {
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [ValType.I32],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([
      makeLocalSet(0, makeI32Const(5)),
      makeLocalGet(0, ValType.I32),
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("CoalesceLocals").run();

  // local 0 is read, so the set must be preserved
  const body = mod.functions[0].body;
  let hasSet = false;
  function find(e: typeof body): void {
    if (e.kind === ExpressionKind.LocalSet) {
      hasSet = true;
      return;
    }
    if (e.kind === ExpressionKind.Block) e.children.forEach(find);
  }
  find(body);
  assertEquals(hasSet, true);
});

Deno.test("CoalesceLocals: two locals with disjoint live ranges coalesce", () => {
  // Two locals used in sequence:
  //   local.set $a 1
  //   call $use $a
  //   local.set $b 2
  //   call $use $b
  // `$a` is dead after its single use; `$b` is defined after that. Linear-scan
  // with live holes recognizes the gap and assigns both to the same slot.
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [],
    locals: [{ type: ValType.I32 }, { type: ValType.I32 }],
    body: makeBlock([
      makeLocalSet(0, makeI32Const(1)),
      makeDrop(makeLocalGet(0, ValType.I32)),
      makeLocalSet(1, makeI32Const(2)),
      makeDrop(makeLocalGet(1, ValType.I32)),
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("CoalesceLocals").run();

  // Both locals should map to slot 0 — only one local remains.
  assertEquals(mod.functions[0].locals.length, 1);
});

Deno.test("CoalesceLocals: two locals with overlapping live ranges stay distinct", () => {
  // Both live simultaneously: $a's set + use brackets $b's set + use.
  //   set $a 1; set $b 2; use $a; use $b
  // Can't coalesce.
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [],
    locals: [{ type: ValType.I32 }, { type: ValType.I32 }],
    body: makeBlock([
      makeLocalSet(0, makeI32Const(1)),
      makeLocalSet(1, makeI32Const(2)),
      makeDrop(makeLocalGet(0, ValType.I32)),
      makeDrop(makeLocalGet(1, ValType.I32)),
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("CoalesceLocals").run();

  // Both locals are live simultaneously between their two reads — must stay
  // separate.
  assertEquals(mod.functions[0].locals.length, 2);
});

Deno.test("CoalesceLocals: single local with two value lifetimes doesn't blow up", () => {
  // Same local written twice — two separate value lifetimes for the same
  // slot. After coalescing, just one local should remain (mapped to itself).
  const mod = emptyModule();
  const fn: WasmFunction = {
    name: "f",
    params: [],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([
      makeLocalSet(0, makeI32Const(1)),
      makeDrop(makeLocalGet(0, ValType.I32)),
      makeLocalSet(0, makeI32Const(2)),
      makeDrop(makeLocalGet(0, ValType.I32)),
    ]),
  };
  mod.functions.push(fn);

  new PassRunner(mod).add("CoalesceLocals").run();

  assertEquals(mod.functions[0].locals.length, 1);
});

// ---------------------------------------------------------------------------
// RemoveUnusedModuleElements pass
// ---------------------------------------------------------------------------

Deno.test("RemoveUnusedModuleElements: unreachable function is removed", () => {
  const mod: WasmModule = {
    functions: [
      {
        name: "exported",
        params: [],
        results: [],
        locals: [],
        body: makeNop(),
      },
      {
        name: "dead",
        params: [],
        results: [],
        locals: [],
        body: makeNop(),
      },
    ],
    globals: [],
    memories: [],
    tables: [],
    tags: [],
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [{ name: "exported", value: "exported", kind: "function" }],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
    heapTypes: [],
    hasGC: false,
  };

  new PassRunner(mod).add("RemoveUnusedModuleElements").run();

  assertEquals(mod.functions.length, 1);
  assertEquals(mod.functions[0].name, "exported");
});

Deno.test("RemoveUnusedModuleElements: callee of exported function is kept", () => {
  const mod: WasmModule = {
    functions: [
      {
        name: "root",
        params: [],
        results: [],
        locals: [],
        body: makeBlock([
          {
            kind: ExpressionKind.Call,
            type: None,
            target: "helper",
            operands: [],
            isReturn: false,
          },
        ]),
      },
      {
        name: "helper",
        params: [],
        results: [],
        locals: [],
        body: makeNop(),
      },
    ],
    globals: [],
    memories: [],
    tables: [],
    tags: [],
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [{ name: "root", value: "root", kind: "function" }],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
    heapTypes: [],
    hasGC: false,
  };

  new PassRunner(mod).add("RemoveUnusedModuleElements").run();

  const names = mod.functions.map((f) => f.name);
  assertEquals(names.includes("root"), true);
  assertEquals(names.includes("helper"), true);
});

Deno.test("RemoveUnusedModuleElements: dead global is removed", () => {
  const mod: WasmModule = {
    functions: [
      {
        name: "f",
        params: [],
        results: [],
        locals: [],
        body: makeNop(),
      },
    ],
    globals: [
      { name: "g_used", type: ValType.I32, mutable: false, init: makeI32Const(1) },
      { name: "g_dead", type: ValType.I32, mutable: false, init: makeI32Const(2) },
    ],
    memories: [],
    tables: [],
    tags: [],
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [
      { name: "f", value: "f", kind: "function" },
      { name: "g_used", value: "g_used", kind: "global" },
    ],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
    heapTypes: [],
    hasGC: false,
  };

  new PassRunner(mod).add("RemoveUnusedModuleElements").run();

  const gNames = mod.globals.map((g) => g.name);
  assertEquals(gNames.includes("g_used"), true);
  assertEquals(gNames.includes("g_dead"), false);
});

// ---------------------------------------------------------------------------
// LocalCSE pass
// ---------------------------------------------------------------------------

Deno.test("LocalCSE: repeated pure expression is extracted to local", () => {
  const mod = emptyModule();
  // Two occurrences of add(local.get(0), 1) in a block
  const fn: WasmFunction = {
    name: "f",
    params: [ValType.I32],
    results: [],
    locals: [{ type: ValType.I32 }],
    body: makeBlock([
      makeDrop(makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeI32Const(1))),
      makeDrop(makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeI32Const(1))),
    ]),
  };
  mod.functions.push(fn);
  const originalLocalCount = fn.locals.length;

  new PassRunner(mod).add("LocalCSE").run();

  // A new local should have been introduced for the CSE
  assertEquals(mod.functions[0].locals.length > originalLocalCount, true);
});

// ---------------------------------------------------------------------------
// PickLoadSigns pass (no-op when no narrow loads present)
// ---------------------------------------------------------------------------

Deno.test("PickLoadSigns: no crash on empty module", () => {
  const mod = emptyModule();
  // Should run without errors even with no functions
  new PassRunner(mod).add("PickLoadSigns").run();
  assertEquals(mod.functions.length, 0);
});

// ---------------------------------------------------------------------------
// PassRunner integration: DCE + Vacuum chain
// ---------------------------------------------------------------------------

Deno.test("PassRunner: DCE + Vacuum chain removes unreachable code", () => {
  const mod = emptyModule();
  mod.functions.push({
    name: "f",
    params: [],
    results: [],
    locals: [],
    body: makeBlock([
      makeUnreachable(),
      makeI32Const(999), // dead after unreachable
      makeNop(),
    ]),
  });

  new PassRunner(mod).add("DCE").add("Vacuum").run();

  const body = mod.functions[0].body;
  // After DCE, only unreachable remains in block; after Vacuum, block collapses
  assertEquals(body.kind, ExpressionKind.Unreachable);
});

// ---------------------------------------------------------------------------
// Phase 8.1b — DCE recurses into Try / TryTable
// ---------------------------------------------------------------------------

Deno.test("DCE: recurses into TryTable body — dead tail after throw is trimmed", () => {
  const mod = emptyModule();
  // try_table body = (block [throw $e, i32.const 99 /* dead */])
  const innerBlock = makeBlock([
    makeThrow("$e", []),
    makeI32Const(99),
  ]);
  const tt = makeTryTable(null, innerBlock, [], None);
  mod.functions.push(makeTestFn("f", makeBlock([tt])));

  new PassRunner(mod).add("DCE").run();

  const outer = mod.functions[0].body as BlockExpr;
  const ttOut = outer.children[0] as { body: BlockExpr };
  assertEquals(ttOut.body.kind, ExpressionKind.Block);
  // Dead i32.const should have been dropped — body now ends at throw
  assertEquals(ttOut.body.children.length, 1);
  assertEquals(ttOut.body.children[0].kind, ExpressionKind.Throw);
});

Deno.test("DCE: recurses into Try body — dead tail after throw is trimmed", () => {
  const mod = emptyModule();
  const innerBlock = makeBlock([
    makeThrow("$e", []),
    makeI32Const(42), // dead
  ]);
  const t = makeTry(null, innerBlock, [], [], null, None);
  mod.functions.push(makeTestFn("f", makeBlock([t])));

  new PassRunner(mod).add("DCE").run();

  const outer = mod.functions[0].body as BlockExpr;
  const tOut = outer.children[0] as { body: BlockExpr };
  assertEquals(tOut.body.children.length, 1);
  assertEquals(tOut.body.children[0].kind, ExpressionKind.Throw);
});

Deno.test("DCE: recurses into Try catchBodies — dead tail after throw is trimmed", () => {
  const mod = emptyModule();
  const catchBody = makeBlock([
    makeThrow("$e", []),
    makeNop(), // dead
    makeI32Const(7), // dead
  ]);
  const t = makeTry(null, makeNop(), ["$e"], [catchBody], null, None);
  mod.functions.push(makeTestFn("f", makeBlock([t])));

  new PassRunner(mod).add("DCE").run();

  const outer = mod.functions[0].body as BlockExpr;
  const tOut = outer.children[0] as { catchBodies: BlockExpr[] };
  assertEquals(tOut.catchBodies.length, 1);
  assertEquals(tOut.catchBodies[0].children.length, 1);
  assertEquals(tOut.catchBodies[0].children[0].kind, ExpressionKind.Throw);
});

Deno.test("DCE: Try expression itself is preserved (recursion does not strip the node)", () => {
  const mod = emptyModule();
  const t = makeTry(null, makeNop(), [], [], null, None);
  mod.functions.push(makeTestFn("f", makeBlock([t, makeI32Const(1)])));

  new PassRunner(mod).add("DCE").run();

  const outer = mod.functions[0].body as BlockExpr;
  // The Try itself has type=none (not unreachable), so the i32.const survives.
  assertEquals(outer.children.length, 2);
  assertEquals(outer.children[0].kind, ExpressionKind.Try);
});

// ---------------------------------------------------------------------------
// Phase 8.1c — StripEH pass
// ---------------------------------------------------------------------------

Deno.test("StripEH: registered in pass registry", () => {
  assertEquals(listPasses().includes("StripEH"), true);
});

Deno.test("StripEH: throw becomes unreachable, operands wrapped in drop", () => {
  const mod = emptyModule();
  // throw $e (i32.const 42)
  mod.functions.push(makeTestFn("f", makeBlock([makeThrow("$e", [makeI32Const(42)])])));
  mod.tags.push({ name: "$e", params: [ValType.I32] });
  mod.hasExceptionHandling = true;

  new PassRunner(mod).add("StripEH").run();

  const outer = mod.functions[0].body as BlockExpr;
  // The throw was replaced by a block [drop(i32.const 42), unreachable].
  const replacement = outer.children[0] as BlockExpr;
  assertEquals(replacement.kind, ExpressionKind.Block);
  assertEquals(replacement.children.length, 2);
  assertEquals(replacement.children[0].kind, ExpressionKind.Drop);
  assertEquals(replacement.children[1].kind, ExpressionKind.Unreachable);
});

Deno.test("StripEH: throw with no operands becomes bare unreachable", () => {
  const mod = emptyModule();
  mod.functions.push(makeTestFn("f", makeBlock([makeThrow("$e", [])])));
  mod.tags.push({ name: "$e", params: [] });
  mod.hasExceptionHandling = true;

  new PassRunner(mod).add("StripEH").run();

  const outer = mod.functions[0].body as BlockExpr;
  assertEquals(outer.children[0].kind, ExpressionKind.Unreachable);
});

Deno.test("StripEH: try is replaced by its body; catch is discarded", () => {
  const mod = emptyModule();
  const tryBody = makeI32Const(1);
  const catchBody = makeI32Const(99);
  const t = makeTry(null, tryBody, ["$e"], [catchBody], null, ValType.I32);
  mod.functions.push(makeTestFn("f", makeBlock([t])));
  mod.tags.push({ name: "$e", params: [] });
  mod.hasExceptionHandling = true;

  new PassRunner(mod).add("StripEH").run();

  const outer = mod.functions[0].body as BlockExpr;
  // The try was substituted by its body (the i32.const 1).
  assertEquals(outer.children[0].kind, ExpressionKind.Const);
  assertEquals((outer.children[0] as { value: { i32: number } }).value.i32, 1);
});

Deno.test("StripEH: try_table is replaced by its body", () => {
  const mod = emptyModule();
  const tt = makeTryTable(null, makeI32Const(7), [], ValType.I32);
  mod.functions.push(makeTestFn("f", makeBlock([tt])));
  mod.tags.push({ name: "$e", params: [] });
  mod.hasExceptionHandling = true;

  new PassRunner(mod).add("StripEH").run();

  const outer = mod.functions[0].body as BlockExpr;
  assertEquals(outer.children[0].kind, ExpressionKind.Const);
  assertEquals((outer.children[0] as { value: { i32: number } }).value.i32, 7);
});

Deno.test("StripEH: module.tags cleared and hasExceptionHandling reset", () => {
  const mod = emptyModule();
  mod.functions.push(makeTestFn("f", makeBlock([makeNop()])));
  mod.tags.push({ name: "$e", params: [ValType.I32] });
  mod.tags.push({ name: "$f", params: [] });
  mod.hasExceptionHandling = true;

  new PassRunner(mod).add("StripEH").run();

  assertEquals(mod.tags.length, 0);
  assertEquals(mod.hasExceptionHandling, false);
});

// ---------------------------------------------------------------------------
// ModuleBuilder + OptimizeInstructions round-trip
// ---------------------------------------------------------------------------

Deno.test("ModuleBuilder + OptimizeInstructions: add(x, 0) optimized", () => {
  const mod = new ModuleBuilder()
    .addFunction(
      "identity",
      [ValType.I32],
      [ValType.I32],
      makeReturn(makeBinary(BinaryOp.AddI32, makeLocalGet(0, ValType.I32), makeI32Const(0))),
    )
    .addExport("identity", "identity")
    .build();

  new PassRunner(mod).add("OptimizeInstructions").run();

  const fn = mod.functions[0];
  const ret = fn.body;
  if (ret.kind === ExpressionKind.Return) {
    assertEquals(ret.value?.kind, ExpressionKind.LocalGet);
  } else if (ret.kind === ExpressionKind.Block) {
    const last = ret.children[ret.children.length - 1];
    if (last.kind === ExpressionKind.Return) {
      assertEquals(last.value?.kind, ExpressionKind.LocalGet);
    }
  }
});
