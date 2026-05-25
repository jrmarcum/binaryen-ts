/**
 * @module binaryen-ts/tests/tools/wasm_opt_test
 *
 * Tests for the Phase 6 native `wasm-opt` pipeline and the RemoveUnusedNames pass.
 *
 * Coverage:
 * - RemoveUnusedNames unit tests (direct IR)
 * - wasmOpt integration: native parse → passes → encode
 * - Optimization levels and explicit pass selection
 * - listPasses registry sanity check
 *
 * @license MIT OR Apache-2.0
 */

import { assert, assertEquals, assertInstanceOf } from "jsr:@std/assert";

import {
  BinaryOp,
  BlockExpr,
  Expression,
  ExpressionKind,
  makeBinary,
  makeBlock,
  makeBreak,
  makeI32Const,
  makeLocalGet,
  makeLoop,
  makeNop,
  makeReturn,
  makeUnreachable,
} from "../../src/ir/expressions.ts";
import {
  ModuleBuilder,
  WasmFunction,
  WasmModule,
} from "../../src/ir/module.ts";
import { None, ValType } from "../../src/ir/types.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { parseWasm } from "../../src/binary/index.ts";
import { listPasses, PassRunner } from "../../src/passes/index.ts";
import { wasmOpt } from "../../src/tools/wasm-opt.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeTestFn(name: string, body: Expression): WasmFunction {
  return { name, params: [], results: [], locals: [], body };
}

/** Encode a simple add(i32,i32)->i32 module as a WASM binary. */
function buildAddWasm(): Uint8Array {
  const body = makeBlock(
    [
      makeReturn(
        makeBinary(
          BinaryOp.AddI32,
          makeLocalGet(0, ValType.I32),
          makeLocalGet(1, ValType.I32),
        ),
      ),
    ],
    null,
  );
  const mod = new ModuleBuilder()
    .addFunction("add", [ValType.I32, ValType.I32], [ValType.I32], body)
    .addExport("add", "add")
    .build();
  return encodeWasm(mod);
}

/** Encode a module whose body has dead code after unreachable. */
function buildDeadCodeWasm(): Uint8Array {
  const body = makeBlock([
    makeUnreachable(),
    makeNop(), // dead
    makeNop(), // dead
  ]);
  const mod = new ModuleBuilder()
    .addFunction("fn", [], [], body)
    .build();
  return encodeWasm(mod);
}

/** Write bytes to a temp .wasm, call fn, clean up. */
async function withTempWasm<T>(
  bytes: Uint8Array,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const path = await Deno.makeTempFile({ suffix: ".wasm" });
  try {
    await Deno.writeFile(path, bytes);
    return await fn(path);
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// listPasses / registry
// ---------------------------------------------------------------------------

Deno.test("listPasses includes RemoveUnusedNames", () => {
  const passes = listPasses();
  assert(passes.includes("RemoveUnusedNames"), "RemoveUnusedNames must be registered");
});

Deno.test("listPasses includes all Phase 4-5 passes", () => {
  const passes = listPasses();
  for (const expected of [
    "DCE",
    "Vacuum",
    "RemoveUnusedBrs",
    "RemoveUnusedNames",
    "OptimizeInstructions",
    "CoalesceLocals",
    "SimplifyLocals",
    "LocalCSE",
    "RemoveUnusedModuleElements",
    "PickLoadSigns",
    "Inlining",
    "InliningOptimizing",
  ]) {
    assert(passes.includes(expected), `Pass ${expected} must be registered`);
  }
});

// ---------------------------------------------------------------------------
// RemoveUnusedNames — unit tests
// ---------------------------------------------------------------------------

Deno.test("RemoveUnusedNames: strips unused block name", () => {
  const mod = emptyModule();
  mod.functions.push(makeTestFn("f", makeBlock([makeNop()], "unused_label")));

  new PassRunner(mod).add("RemoveUnusedNames").run();

  const body = mod.functions[0].body as BlockExpr;
  assertEquals(body.name, null, "unused block name should be stripped to null");
});

Deno.test("RemoveUnusedNames: keeps block name that is branched to", () => {
  const mod = emptyModule();
  // (block $exit (br $exit))
  const body = makeBlock([makeBreak("exit")], "exit");
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("RemoveUnusedNames").run();

  const newBody = mod.functions[0].body as BlockExpr;
  assertEquals(newBody.name, "exit", "used block name must be kept");
});

Deno.test("RemoveUnusedNames: replaces unused loop with body", () => {
  const mod = emptyModule();
  // (block (loop $lp (nop)))  — no br targeting $lp
  const nop = makeNop();
  const loop = makeLoop("lp", nop, None);
  const body = makeBlock([loop]);
  mod.functions.push(makeTestFn("f", body));

  new PassRunner(mod).add("RemoveUnusedNames").run();

  const newBody = mod.functions[0].body as BlockExpr;
  // The loop should have been replaced by its body (nop)
  assertEquals(
    newBody.children[0].kind,
    ExpressionKind.Nop,
    "unused loop should be replaced by its body",
  );
});

Deno.test("RemoveUnusedNames: keeps loop with br back-edge", () => {
  const mod = emptyModule();
  // (loop $lp (br $lp))  — has a back-edge
  const br = makeBreak("lp");
  const loop = makeLoop("lp", br, None);
  mod.functions.push(makeTestFn("f", loop));

  new PassRunner(mod).add("RemoveUnusedNames").run();

  // The body should still be a loop (not replaced)
  assertEquals(
    mod.functions[0].body.kind,
    ExpressionKind.Loop,
    "loop with back-edge must not be removed",
  );
});

Deno.test("RemoveUnusedNames: strips outer name but keeps inner used name", () => {
  // (block $outer (block $inner (br $inner)))
  const mod = emptyModule();
  const inner = makeBlock([makeBreak("inner")], "inner");
  const outer = makeBlock([inner], "outer");
  mod.functions.push(makeTestFn("f", outer));

  new PassRunner(mod).add("RemoveUnusedNames").run();

  const newOuter = mod.functions[0].body as BlockExpr;
  assertEquals(newOuter.name, null, "outer unused name should be stripped");
  const newInner = newOuter.children[0] as BlockExpr;
  assertEquals(newInner.name, "inner", "inner used name should be kept");
});

// ---------------------------------------------------------------------------
// wasmOpt integration — native path
// ---------------------------------------------------------------------------

Deno.test("wasmOpt: native path returns valid WASM magic bytes", async () => {
  const input = buildAddWasm();
  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, { optimizeLevel: 0 })
  );
  assertInstanceOf(result, Uint8Array);
  assertEquals(result[0], 0x00);
  assertEquals(result[1], 0x61);
  assertEquals(result[2], 0x73);
  assertEquals(result[3], 0x6d);
});

Deno.test("wasmOpt: output is re-parseable as valid WASM module", async () => {
  const input = buildAddWasm();
  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, { optimizeLevel: 2 })
  );
  assertInstanceOf(result, Uint8Array);
  const mod = parseWasm(result as Uint8Array);
  assertEquals(mod.functions.length, 1);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "add");
});

Deno.test("wasmOpt: -O1 applies DCE and removes dead code", async () => {
  const input = buildDeadCodeWasm();
  // Before optimization: body is a block with 3 children (unreachable + 2 nops)
  const inputMod = parseWasm(input);
  assertEquals(inputMod.functions[0].body.kind, ExpressionKind.Block);
  assertEquals((inputMod.functions[0].body as BlockExpr).children.length, 3);

  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, { optimizeLevel: 1 })
  );
  assertInstanceOf(result, Uint8Array);

  const optimized = parseWasm(result as Uint8Array);
  // DCE removes the dead nops → Vacuum collapses the single-child unnamed block.
  // After encode + re-parse (single-expr body → no wrapping block), body is unreachable.
  assertEquals(
    optimized.functions[0].body.kind,
    ExpressionKind.Unreachable,
    "dead nops should be eliminated; body collapses to just unreachable",
  );
});

Deno.test("wasmOpt: explicit passes override default pass set", async () => {
  // With only Vacuum specified, DCE-specific logic won't run;
  // function structure should still be present and valid
  const input = buildAddWasm();
  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, { passes: ["Vacuum"] })
  );
  assertInstanceOf(result, Uint8Array);
  const mod = parseWasm(result as Uint8Array);
  assertEquals(mod.functions.length, 1, "function should still be present after Vacuum pass");
});

Deno.test("wasmOpt: empty module round-trips cleanly", async () => {
  const input = encodeWasm({
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
  });
  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, { optimizeLevel: 2 })
  );
  assertInstanceOf(result, Uint8Array);
  // Minimum valid WASM: 8-byte header
  assert((result as Uint8Array).byteLength >= 8);
});

Deno.test("wasmOpt: passArgs are accepted without error", async () => {
  const input = buildAddWasm();
  // passArgs forwarded — no pass currently uses them, but must not throw
  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, {
      optimizeLevel: 1,
      passArgs: { "inlining@maxSize": "10" },
    })
  );
  assertInstanceOf(result, Uint8Array);
});

Deno.test("wasmOpt: -O2 with RemoveUnusedNames strips block names", async () => {
  // Build a module with a named block that has no br targeting it.
  // RemoveUnusedNames will strip the name; the encoder then unpacks the
  // resulting null-named block; the parser re-wraps single-expression bodies
  // without a block node — so the final body is just i32.const(42).
  const body = makeBlock(
    [makeI32Const(42)],
    "dead_label",
  );
  const mod = new ModuleBuilder()
    .addFunction("fn", [], [ValType.I32], body)
    .build();
  const input = encodeWasm(mod);

  const result = await withTempWasm(input, (path) =>
    wasmOpt(path, { optimizeLevel: 2 })
  );
  assertInstanceOf(result, Uint8Array);

  const optimized = parseWasm(result as Uint8Array);
  const fnBody = optimized.functions[0].body;
  // If RemoveUnusedNames did NOT run, the body would still be a named block after
  // round-trip. When it does run the name is stripped, the encoder unpacks the
  // null-named wrapper, and the parser returns a bare i32.const expression.
  assertEquals(
    fnBody.kind,
    ExpressionKind.Const,
    "dead_label block should have been stripped by RemoveUnusedNames; body simplifies to i32.const",
  );
});