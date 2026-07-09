/**
 * @module binaryen-ts/tests/passes/asyncify_e2e_test
 *
 * Stage 4 end-to-end tests: the FULL asyncify pipeline (flatten → flow → locals
 * → runtime support) is now runnable. Each test builds a module, asyncifies it
 * with our passes, instantiates it, and drives a real unwind/rewind cycle
 * through the exported control functions — the canonical asyncify usage:
 *
 *   1. call the export; an "async" import triggers `asyncify_start_unwind`, so
 *      the call unwinds the wasm stack and returns a dummy value;
 *   2. `asyncify_stop_unwind`; do the async work; `asyncify_start_rewind`;
 *   3. call the export again — it rewinds to the paused call, which now returns
 *      the real value, and the function runs to completion with its locals
 *      restored.
 *
 * Where `wasm-opt` (Binaryen v130) is on PATH, the SAME driver is run against
 * `wasm-opt --asyncify` output as a differential oracle — both must agree.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";

import { encodeWasm } from "../../src/encoder/index.ts";
import { parseWat } from "../../src/parser/wat-parser.ts";
import { buildCallResultTypes, flattenFunction } from "../../src/passes/flatten.ts";
import {
  analyzeModule,
  type FlowCtx,
  flowInstrumentFunction,
  computeRelevantLocals,
  localsInstrumentFunction,
  parseAsyncifyOptions,
  synthesizeRuntimeSupport,
} from "../../src/passes/asyncify.ts";
import { listPasses, PassRunner } from "../../src/passes/index.ts";
import type { WasmModule } from "../../src/ir/module.ts";

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

/** Run the complete asyncify transformation over `mod` (in place). */
function asyncify(mod: WasmModule, passArgs: Record<string, string> = {}): WasmModule {
  const opts = parseAsyncifyOptions(passArgs);
  const analysis = analyzeModule(mod, opts);
  const callResultTypes = buildCallResultTypes(mod);
  for (const func of mod.functions) {
    if (!analysis.instrumentedFuncs.has(func.name)) continue;
    flattenFunction(func, callResultTypes);
    const relevant = computeRelevantLocals(
      func,
      analysis.canChangeState,
      !opts.ignoreIndirect,
      analysis.addedFromList,
    );
    const flowCtx: FlowCtx = {
      func,
      canChangeState: analysis.canChangeState,
      canIndirect: !opts.ignoreIndirect,
      addedFromList: analysis.addedFromList,
      callIndex: { n: 0 },
      fakeGlobals: new Map(),
      savedCondTemps: new Set(),
    };
    flowInstrumentFunction(func, flowCtx);
    localsInstrumentFunction(func, flowCtx.fakeGlobals, [...relevant, ...flowCtx.savedCondTemps]);
  }
  synthesizeRuntimeSupport(mod, opts);
  return mod;
}

// ---------------------------------------------------------------------------
// Unwind/rewind driver
// ---------------------------------------------------------------------------

interface Exports {
  memory: WebAssembly.Memory;
  asyncify_start_unwind: (data: number) => void;
  asyncify_stop_unwind: () => void;
  asyncify_start_rewind: (data: number) => void;
  asyncify_stop_rewind: () => void;
  asyncify_get_state: () => number;
  [k: string]: unknown;
}

const DATA_PTR = 16;
const STACK_BASE = 24;
const STACK_END = 1024;

/**
 * Drive one export through a single suspend/resume, where the "async" import
 * `asyncImport` unwinds on the first hit and yields `asyncResult` on rewind.
 * Returns the export's final result.
 */
function driveOnce(
  bytes: Uint8Array,
  exportName: string,
  args: number[],
  asyncImportName: string,
  asyncResult: number,
): number {
  // Holder lets the import closure reach the instance's exports, which only
  // exist after instantiation (which itself needs the closure).
  const box = { exp: undefined as unknown as Exports };
  let suspended = false;
  const asyncImport = (): number => {
    const e = box.exp;
    if (e.asyncify_get_state() === 2) { // rewinding — resuming the suspended call
      e.asyncify_stop_rewind();
      return asyncResult;
    }
    if (!suspended) { // first (normal) hit — begin the unwind
      suspended = true;
      e.asyncify_start_unwind(DATA_PTR);
      return 0; // ignored while unwinding
    }
    return asyncResult; // later normal calls (e.g. loop iterations) return directly
  };
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(bytes as BufferSource),
    { env: { [asyncImportName]: asyncImport } },
  );
  const exp = instance.exports as unknown as Exports;
  box.exp = exp;

  // Init the asyncify data struct: { stackPos, stackEnd }.
  const dv = new DataView(exp.memory.buffer);
  dv.setInt32(DATA_PTR, STACK_BASE, true);
  dv.setInt32(DATA_PTR + 4, STACK_END, true);

  const fn = exp[exportName] as (...a: number[]) => number;
  fn(...args); // first call — unwinds, returns a dummy
  assertEquals(exp.asyncify_get_state(), 1, "expected Unwinding state after first call");
  exp.asyncify_stop_unwind();
  exp.asyncify_start_rewind(DATA_PTR);
  const result = fn(...args); // second call — rewinds + completes
  assertEquals(exp.asyncify_get_state(), 0, "expected Normal state after completion");
  return result;
}

function wasmOptAsyncify(wat: string): Uint8Array | null {
  try {
    const inFile = Deno.makeTempFileSync({ suffix: ".wat" });
    const outFile = Deno.makeTempFileSync({ suffix: ".wasm" });
    Deno.writeTextFileSync(inFile, wat);
    const out = new Deno.Command("wasm-opt", {
      args: [inFile, "--asyncify", "-o", outFile],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    if (!out.success) return null;
    const bytes = Deno.readFileSync(outFile);
    Deno.removeSync(inFile);
    Deno.removeSync(outFile);
    return bytes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures + tests
// ---------------------------------------------------------------------------

// compute(x) = x + get();  get() is the async import.
const ADD_GET = `(module
  (import "env" "get" (func $get (result i32)))
  (memory 1)
  (export "memory" (memory 0))
  (func $compute (export "compute") (param $x i32) (result i32)
    (i32.add (local.get $x) (call $get))))`;

// Async import inside a loop: sum get() n times (locals must survive rewind).
const LOOP_GET = `(module
  (import "env" "get" (func $get (result i32)))
  (memory 1)
  (export "memory" (memory 0))
  (func $sum (export "sum") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $done
      (loop $lp
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $acc (i32.add (local.get $acc) (call $get)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp)))
    (local.get $acc)))`;

Deno.test("asyncify e2e — suspend/resume across an async call (x + get())", () => {
  const bytes = encodeWasm(asyncify(parseWat(ADD_GET)));
  // compute(10) with get() → 42 must yield 52 across the unwind/rewind.
  assertEquals(driveOnce(bytes, "compute", [10], "get", 42), 52);
});

Deno.test("asyncify e2e — differential vs wasm-opt --asyncify (x + get())", () => {
  const ref = wasmOptAsyncify(ADD_GET);
  if (!ref) {
    console.warn("  (skipped — wasm-opt not on PATH)");
    return;
  }
  assertEquals(driveOnce(ref, "compute", [10], "get", 42), 52);
});

Deno.test("asyncify e2e — locals survive a rewind (single suspend in a loop)", () => {
  // The loop suspends on the FIRST get(); on rewind, $i/$acc must be restored so
  // it continues. Our single-shot driver resumes once, so the loop runs to
  // completion after the first suspend (get() returns 7 on rewind and on every
  // subsequent normal call).
  const bytes = encodeWasm(asyncify(parseWat(LOOP_GET)));
  // After resume, get() returns 7 each of the 3 iterations → 21.
  assertEquals(driveOnce(bytes, "sum", [3], "get", 7), 21);
});

Deno.test("asyncify e2e — loop case matches wasm-opt --asyncify", () => {
  const ref = wasmOptAsyncify(LOOP_GET);
  if (!ref) {
    console.warn("  (skipped — wasm-opt not on PATH)");
    return;
  }
  assertEquals(driveOnce(ref, "sum", [3], "get", 7), 21);
});

Deno.test("asyncify — registered as a pass, runnable via PassRunner (lowercase name)", () => {
  assert(listPasses().includes("Asyncify"), "Asyncify should be a registered pass");
  const mod = parseWat(ADD_GET);
  // Resolve the upstream-style lowercase flag name case-insensitively.
  new PassRunner(mod).add("asyncify").run();
  assertEquals(driveOnce(encodeWasm(mod), "compute", [10], "get", 42), 52);
});
