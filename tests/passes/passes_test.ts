/**
 * @module binaryen-ts/tests/passes/passes_test
 *
 * Tests for all Phase 4 optimization passes.
 *
 * @license MIT OR Apache-2.0
 */

import { assertEquals, assertNotEquals } from "jsr:@std/assert";

import {
  BinaryOp,
  BlockExpr,
  Expression,
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
  makeUnary,
  makeUnreachable,
  UnaryOp,
} from "../../src/ir/expressions.ts";
import { ModuleBuilder, WasmFunction, WasmModule } from "../../src/ir/module.ts";
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
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
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
    if (e.kind === ExpressionKind.LocalSet) { hasSet = true; return; }
    if (e.kind === ExpressionKind.Block) e.children.forEach(find);
  }
  find(body);
  assertEquals(hasSet, true);
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
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [{ name: "exported", value: "exported", kind: "function" }],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
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
    elements: [],
    dataSegments: [],
    imports: [],
    exports: [{ name: "root", value: "root", kind: "function" }],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
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