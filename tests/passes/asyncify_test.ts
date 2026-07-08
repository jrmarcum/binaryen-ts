/**
 * @module binaryen-ts/tests/passes/asyncify_test
 *
 * Stage 1 tests for the Asyncify pass: option parsing and the runtime-support
 * synthesis (the 2 globals + 5 exported control functions). These pin the ABI
 * shape that TinyGo depends on, cross-checked against `wasm-opt --asyncify`
 * (Binaryen v130): the globals `__asyncify_state` / `__asyncify_data`, the
 * State values 0/1/2, the data-struct offsets 0/4, the `gt_u` stack-overflow
 * check, and the export names/order.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";

import {
  BinaryOp,
  type BlockExpr,
  ExpressionKind,
  type GlobalSetExpr,
  type IfExpr,
} from "../../src/ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../../src/ir/module.ts";
import { ValType } from "../../src/ir/types.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { parseWasm } from "../../src/binary/index.ts";
import {
  ASYNCIFY_DATA,
  ASYNCIFY_GET_STATE,
  ASYNCIFY_START_REWIND,
  ASYNCIFY_START_UNWIND,
  ASYNCIFY_STATE,
  ASYNCIFY_STOP_REWIND,
  ASYNCIFY_STOP_UNWIND,
  AsyncifyPass,
  parseAsyncifyOptions,
  State,
} from "../../src/passes/asyncify.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal module: memory + an import + one exported function that calls it. */
function moduleWithImport(): WasmModule {
  return {
    functions: [{
      name: "$foo",
      params: [ValType.I32],
      results: [ValType.I32],
      locals: [{ type: ValType.I32 }],
      body: {
        kind: ExpressionKind.Block,
        type: ValType.I32,
        name: null,
        children: [
          { kind: ExpressionKind.Call, type: "none", target: "$sleep", operands: [] },
          { kind: ExpressionKind.LocalGet, type: ValType.I32, index: 0 },
        ],
        // deno-lint-ignore no-explicit-any
      } as any,
    }],
    globals: [],
    memories: [{ name: "$mem", initial: 1, max: null, shared: false, is64: false }],
    tables: [],
    tags: [],
    elements: [],
    dataSegments: [],
    imports: [{
      module: "env",
      base: "sleep",
      name: "$sleep",
      kind: "function",
      params: [],
      results: [],
    }],
    exports: [{ name: "foo", value: "$foo", kind: "function" }],
    hasExceptionHandling: false,
    hasMemory64: false,
    hasMultiMemory: false,
    heapTypes: [],
    hasGC: false,
  };
}

function funcByName(m: WasmModule, name: string): WasmFunction | undefined {
  return m.functions.find((f) => f.name === name);
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

Deno.test("parseAsyncifyOptions — reads the upstream flag surface", () => {
  const opts = parseAsyncifyOptions({
    "asyncify-imports": "env.sleep,wasi_snapshot_preview1.*",
    "asyncify-ignore-indirect": "",
    "asyncify-onlylist": "a,b, c",
    "asyncify-memory": "mymem",
  });
  assertEquals(opts.imports, ["env.sleep", "wasi_snapshot_preview1.*"]);
  assert(opts.ignoreIndirect);
  assert(!opts.ignoreImports);
  assertEquals(opts.onlyList, ["a", "b", "c"]);
  assertEquals(opts.memory, "mymem");
});

Deno.test("parseAsyncifyOptions — accepts the Asyncify@ prefixed form", () => {
  const opts = parseAsyncifyOptions({ "Asyncify@asyncify-ignore-imports": "" });
  assert(opts.ignoreImports);
});

// ---------------------------------------------------------------------------
// Runtime-support synthesis (ABI shape)
// ---------------------------------------------------------------------------

Deno.test("Asyncify Stage 1 — adds the 2 globals with the ABI shape", () => {
  const m = moduleWithImport();
  new AsyncifyPass().run(m, {
    optimizeLevel: 2,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });

  for (const name of [ASYNCIFY_STATE, ASYNCIFY_DATA]) {
    const g = m.globals.find((x) => x.name === name);
    assert(g, `missing global ${name}`);
    assertEquals(g!.type, ValType.I32);
    assertEquals(g!.mutable, true);
    assertEquals(g!.init.kind, ExpressionKind.Const);
  }
});

Deno.test("Asyncify Stage 1 — adds & exports the 5 control functions in order", () => {
  const m = moduleWithImport();
  new AsyncifyPass().run(m, {
    optimizeLevel: 2,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });

  // Exports: original `foo` preserved + the 5 control functions, in upstream order.
  const exportNames = m.exports.filter((e) => e.kind === "function").map((e) => e.name);
  assertEquals(exportNames, [
    "foo",
    ASYNCIFY_START_UNWIND,
    ASYNCIFY_STOP_UNWIND,
    ASYNCIFY_START_REWIND,
    ASYNCIFY_STOP_REWIND,
    ASYNCIFY_GET_STATE,
  ]);

  // Signatures.
  assertEquals(funcByName(m, `$${ASYNCIFY_START_UNWIND}`)!.params, [ValType.I32]);
  assertEquals(funcByName(m, `$${ASYNCIFY_START_UNWIND}`)!.results, []);
  assertEquals(funcByName(m, `$${ASYNCIFY_START_REWIND}`)!.params, [ValType.I32]);
  assertEquals(funcByName(m, `$${ASYNCIFY_STOP_UNWIND}`)!.params, []);
  assertEquals(funcByName(m, `$${ASYNCIFY_GET_STATE}`)!.results, [ValType.I32]);
});

Deno.test("Asyncify Stage 1 — synthesizes a memory for a memoryless module (result validates)", () => {
  // The control functions (and instrumented code) load/store the coroutine stack
  // from linear memory. A module reaching the pass without one must still produce
  // valid wasm — asyncify ensures a memory exists (matching MemoryUtils::ensureExists).
  const m = moduleWithImport();
  m.memories = [];
  new AsyncifyPass().run(m, {
    optimizeLevel: 2,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });
  assertEquals(m.memories.length, 1, "asyncify must add a memory when none exists");
  const bytes = encodeWasm(m);
  assert(
    WebAssembly.validate(bytes as BufferSource),
    "asyncified memoryless module must validate (loads/stores need a memory)",
  );
});

Deno.test("Asyncify Stage 1 — start_unwind body matches the ABI (state=1, data set, gt_u check)", () => {
  const m = moduleWithImport();
  new AsyncifyPass().run(m, {
    optimizeLevel: 2,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });

  const body = funcByName(m, `$${ASYNCIFY_START_UNWIND}`)!.body as BlockExpr;
  assertEquals(body.kind, ExpressionKind.Block);
  assertEquals(body.children.length, 3);

  // child 0: global.set $__asyncify_state (i32.const 1)
  const setState = body.children[0] as GlobalSetExpr;
  assertEquals(setState.kind, ExpressionKind.GlobalSet);
  assertEquals(setState.name, ASYNCIFY_STATE);
  assertEquals((setState.value as { value: { i32: number } }).value.i32, State.Unwinding);

  // child 1: global.set $__asyncify_data (local.get 0)
  const setData = body.children[1] as GlobalSetExpr;
  assertEquals(setData.name, ASYNCIFY_DATA);
  assertEquals(setData.value.kind, ExpressionKind.LocalGet);

  // child 2: if (i32.gt_u (load off 0) (load off 4)) (unreachable)
  const check = body.children[2] as IfExpr;
  assertEquals(check.kind, ExpressionKind.If);
  assertEquals(check.condition.kind, ExpressionKind.Binary);
  assertEquals((check.condition as { op: BinaryOp }).op, BinaryOp.GtUI32);
  const lhs = (check.condition as { left: { offset: number } }).left;
  const rhs = (check.condition as { right: { offset: number } }).right;
  assertEquals(lhs.offset, 0);
  assertEquals(rhs.offset, 4);
  assertEquals(check.ifTrue.kind, ExpressionKind.Unreachable);
  assertEquals(check.ifFalse, null);
});

Deno.test("Asyncify Stage 1 — get_state returns the state global; stop_* reset to 0", () => {
  const m = moduleWithImport();
  new AsyncifyPass().run(m, {
    optimizeLevel: 2,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });

  const getState = funcByName(m, `$${ASYNCIFY_GET_STATE}`)!.body;
  assertEquals(getState.kind, ExpressionKind.GlobalGet);
  assertEquals((getState as { name: string }).name, ASYNCIFY_STATE);

  const stop = funcByName(m, `$${ASYNCIFY_STOP_UNWIND}`)!.body as BlockExpr;
  const setState = stop.children[0] as GlobalSetExpr;
  assertEquals((setState.value as { value: { i32: number } }).value.i32, State.Normal);
});

// ---------------------------------------------------------------------------
// Encode → decode round-trip (validity)
// ---------------------------------------------------------------------------

Deno.test("Asyncify Stage 1 — runtime support encodes to valid wasm & round-trips", () => {
  const m = moduleWithImport();
  new AsyncifyPass().run(m, {
    optimizeLevel: 2,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });

  const bytes = encodeWasm(m);
  assert(bytes.length > 8);
  assertEquals([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d]); // \0asm

  const decoded = parseWasm(bytes);
  // The 2 globals survive (internal names are re-synthesized as $globalN since
  // we emit no name section — assert on count, which was 0 before the pass).
  assertEquals(decoded.globals.length, 2);
  // The 5 control functions survive as host exports (export names ARE preserved).
  const decodedFnExports = decoded.exports.filter((e) => e.kind === "function").map((e) => e.name);
  for (
    const n of [
      ASYNCIFY_START_UNWIND,
      ASYNCIFY_STOP_UNWIND,
      ASYNCIFY_START_REWIND,
      ASYNCIFY_STOP_REWIND,
      ASYNCIFY_GET_STATE,
    ]
  ) {
    assert(decodedFnExports.includes(n), `export ${n} missing after round-trip`);
  }
});
