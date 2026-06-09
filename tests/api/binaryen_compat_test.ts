/**
 * @module binaryen-ts/tests/api/binaryen_compat_test
 *
 * Tests for the npm:binaryen compatibility facade. Verifies the namespace
 * surface (readBinary, Features, setShrinkLevel, ...) and Module instance
 * methods (optimize, emitBinary, getExportByIndex, ...) behave like the
 * upstream binaryen.js bindings.
 *
 * @license MIT
 */

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import * as binaryen from "../../src/api/binaryen-compat.ts";
import { ValType } from "../../src/ir/types.ts";
import { type CallIndirectExpr, ExpressionKind } from "../../src/ir/expressions.ts";

// ---------------------------------------------------------------------------
// Fixture: same ADD_MODULE used by encoder tests — a tiny module with one
// exported `add(i32, i32) -> i32` function: `(local.get 0) (local.get 1) i32.add`.
// ---------------------------------------------------------------------------

const ADD_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // wasm header
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f, // type section
  0x03,
  0x02,
  0x01,
  0x00, // function section
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00, // export "add"
  0x0a,
  0x09,
  0x01,
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b, // code
]);

// ---------------------------------------------------------------------------
// Type ID constants
// ---------------------------------------------------------------------------

Deno.test("type ID constants match upstream binaryen.js values", () => {
  assertEquals(binaryen.none, 0);
  assertEquals(binaryen.i32, 2);
  assertEquals(binaryen.i64, 3);
  assertEquals(binaryen.f32, 4);
  assertEquals(binaryen.f64, 5);
  assertEquals(binaryen.v128, 6);
  assertEquals(binaryen.funcref, 7);
  assertEquals(binaryen.externref, 8);
});

Deno.test("external kind constants match upstream binaryen.js values", () => {
  assertEquals(binaryen.ExternalFunction, 0);
  assertEquals(binaryen.ExternalTable, 1);
  assertEquals(binaryen.ExternalMemory, 2);
  assertEquals(binaryen.ExternalGlobal, 3);
  assertEquals(binaryen.ExternalTag, 4);
});

Deno.test("Features.All is a non-zero bitmask", () => {
  assertEquals(binaryen.Features.All, 0x7fffffff);
  assertEquals(binaryen.Features.MVP, 0);
});

// ---------------------------------------------------------------------------
// Global setters / getters
// ---------------------------------------------------------------------------

Deno.test("setShrinkLevel / setOptimizeLevel / setDebugInfo round-trip", () => {
  binaryen.setShrinkLevel(2);
  assertEquals(binaryen.getShrinkLevel(), 2);
  binaryen.setOptimizeLevel(3);
  assertEquals(binaryen.getOptimizeLevel(), 3);
  binaryen.setDebugInfo(true);
  assertEquals(binaryen.getDebugInfo(), true);

  // reset for other tests
  binaryen.setShrinkLevel(0);
  binaryen.setOptimizeLevel(2);
  binaryen.setDebugInfo(false);
});

// ---------------------------------------------------------------------------
// readBinary + emitBinary round-trip
// ---------------------------------------------------------------------------

Deno.test("readBinary -> emitBinary preserves a parseable module", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  const out = mod.emitBinary();

  // Re-parse the output to confirm it's a valid wasm module.
  const reparsed = binaryen.readBinary(out);
  assertEquals(reparsed.getNumExports(), 1);
  const exp = binaryen.getExportInfo(reparsed.getExportByIndex(0));
  assertEquals(exp.kind, binaryen.ExternalFunction);
  assertEquals(exp.name, "add");
});

// ---------------------------------------------------------------------------
// Inspection: getNumExports / getExportByIndex / getExportInfo
// ---------------------------------------------------------------------------

Deno.test("getNumExports + getExportByIndex + getExportInfo", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  assertEquals(mod.getNumExports(), 1);

  const exp = binaryen.getExportInfo(mod.getExportByIndex(0));
  assertEquals(exp.kind, binaryen.ExternalFunction);
  assertEquals(exp.name, "add");

  assertThrows(
    () => mod.getExportByIndex(99),
    RangeError,
    "out of range",
  );
});

// ---------------------------------------------------------------------------
// Inspection: getFunction / getFunctionInfo / expandType
// ---------------------------------------------------------------------------

Deno.test("getFunction + getFunctionInfo + expandType for `add(i32,i32)->i32`", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  const exp = binaryen.getExportInfo(mod.getExportByIndex(0));
  const func = mod.getFunction(exp.value);
  if (!func) throw new Error(`function ${exp.value} not found`);

  const info = binaryen.getFunctionInfo(func);
  assertEquals(binaryen.expandType(info.params), [binaryen.i32, binaryen.i32]);
  assertEquals(binaryen.expandType(info.results), [binaryen.i32]);
  // No extra vars beyond the two parameters.
  assertEquals(info.vars.length, 0);
});

Deno.test("getFunction returns null for missing name", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  assertEquals(mod.getFunction("nope"), null);
});

Deno.test("expandType accepts both packed and array inputs", () => {
  assertEquals(binaryen.expandType(binaryen.i32), [binaryen.i32]);
  assertEquals(
    binaryen.expandType([binaryen.i32, binaryen.i64]),
    [binaryen.i32, binaryen.i64],
  );
});

// ---------------------------------------------------------------------------
// setFeatures (informational)
// ---------------------------------------------------------------------------

Deno.test("setFeatures updates the features field", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  // Default is All.
  assertEquals(mod.features, binaryen.Features.All);
  mod.setFeatures(binaryen.Features.MVP);
  assertEquals(mod.features, binaryen.Features.MVP);
});

// ---------------------------------------------------------------------------
// optimize() actually runs the pipeline
// ---------------------------------------------------------------------------

Deno.test("optimize() at -Oz produces a valid, possibly smaller wasm", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  binaryen.setShrinkLevel(2);
  binaryen.setOptimizeLevel(2);
  mod.optimize();
  binaryen.setShrinkLevel(0); // reset

  const out = mod.emitBinary();
  // Re-parse to verify validity.
  const reparsed = binaryen.readBinary(out);
  assertEquals(reparsed.getNumExports(), 1);
  // For this tiny module size shouldn't grow.
  if (out.length > ADD_MODULE.length) {
    throw new Error(
      `optimized output (${out.length} B) larger than input (${ADD_MODULE.length} B)`,
    );
  }
});

Deno.test("optimize() does not throw on a module with no functions", () => {
  // Minimal empty module — wasm header only.
  const EMPTY = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const mod = binaryen.readBinary(EMPTY);
  mod.optimize();
  const out = mod.emitBinary();
  assertNotEquals(out.length, 0);
});

// ---------------------------------------------------------------------------
// Programmatic construction — new binaryen.Module() + low-level factories
// ---------------------------------------------------------------------------

Deno.test("new Module() returns an empty, emittable module", () => {
  const mod = new binaryen.Module();
  assertEquals(mod.getNumExports(), 0);
  const bytes = mod.emitBinary();
  // Wasm header at minimum.
  assertEquals(bytes[0], 0x00);
  assertEquals(bytes[1], 0x61);
  assertEquals(bytes[2], 0x73);
  assertEquals(bytes[3], 0x6d);
});

Deno.test("createType packs as upstream binaryen.js does", () => {
  assertEquals(binaryen.createType([]), binaryen.none);
  assertEquals(binaryen.createType([binaryen.i32]), binaryen.i32);
  assertEquals(binaryen.createType([binaryen.i32, binaryen.i64]), [binaryen.i32, binaryen.i64]);
});

Deno.test("ExpressionId constants match upstream binaryen.js values", () => {
  assertEquals(binaryen.BlockId, 1);
  assertEquals(binaryen.IfId, 2);
  assertEquals(binaryen.LoopId, 3);
  assertEquals(binaryen.CallId, 6);
  assertEquals(binaryen.LocalGetId, 8);
  assertEquals(binaryen.ConstId, 14);
  assertEquals(binaryen.NopId, 22);
  assertEquals(binaryen.UnreachableId, 23);
});

Deno.test("programmatic add(i32,i32)->i32 builds, emits, re-parses", () => {
  const mod = new binaryen.Module();
  mod.addFunction(
    "add",
    binaryen.createType([binaryen.i32, binaryen.i32]),
    binaryen.i32,
    [],
    mod.i32.add(
      mod.local.get(0, binaryen.i32),
      mod.local.get(1, binaryen.i32),
    ),
  );
  mod.addFunctionExport("add", "add");

  const bytes = mod.emitBinary();
  const reparsed = binaryen.readBinary(bytes);
  assertEquals(reparsed.getNumExports(), 1);

  const exp = binaryen.getExportInfo(reparsed.getExportByIndex(0));
  assertEquals(exp.kind, binaryen.ExternalFunction);
  assertEquals(exp.name, "add");

  const fn = reparsed.getFunction(exp.value);
  if (!fn) throw new Error("missing function after round-trip");
  const info = binaryen.getFunctionInfo(fn);
  assertEquals(binaryen.expandType(info.params), [binaryen.i32, binaryen.i32]);
  assertEquals(binaryen.expandType(info.results), [binaryen.i32]);
});

Deno.test("i32 / i64 / f32 / f64 namespaces produce correct expression types", () => {
  const mod = new binaryen.Module();
  const i32Add = mod.i32.add(mod.i32.const(1), mod.i32.const(2));
  assertEquals(i32Add.kind, "binary");
  const i64Mul = mod.i64.mul(mod.i64.const(3n), mod.i64.const(4n));
  assertEquals(i64Mul.kind, "binary");
  const f32Div = mod.f32.div(mod.f32.const(1.5), mod.f32.const(0.5));
  assertEquals(f32Div.kind, "binary");
  const f64Sqrt = mod.f64.sqrt(mod.f64.const(4.0));
  assertEquals(f64Sqrt.kind, "unary");
});

Deno.test("local.get with non-i32 type respects the type ID", () => {
  const mod = new binaryen.Module();
  const lg = mod.local.get(0, binaryen.f64);
  assertEquals(lg.kind, "local.get");
  assertEquals(lg.type, ValType.F64);
});

Deno.test("control flow factories return well-formed nodes", () => {
  const mod = new binaryen.Module();
  const blk = mod.block("$L", [mod.nop(), mod.unreachable()]);
  assertEquals(blk.kind, "block");

  const cond = mod.i32.eqz(mod.i32.const(0));
  const ifExpr = mod.if(cond, mod.i32.const(1), mod.i32.const(2));
  assertEquals(ifExpr.kind, "if");

  const loop = mod.loop("$top", mod.br("$top"));
  assertEquals(loop.kind, "loop");

  const ret = mod.return(mod.i32.const(7));
  assertEquals(ret.kind, "return");

  const sel = mod.select(mod.i32.const(1), mod.i32.const(10), mod.i32.const(20));
  assertEquals(sel.kind, "select");
});

Deno.test("addGlobal + setMemory + addFunctionImport survive round-trip", () => {
  const mod = new binaryen.Module();

  mod.addFunctionImport(
    "host_log",
    "env",
    "log",
    binaryen.createType([binaryen.i32]),
    binaryen.none,
  );
  mod.addGlobal("counter", binaryen.i32, true, mod.i32.const(0));
  mod.setMemory(1, -1, "memory");

  mod.addFunction(
    "tick",
    binaryen.none,
    binaryen.i32,
    [],
    mod.block(
      null,
      [
        mod.global.set(
          "counter",
          mod.i32.add(mod.global.get("counter", binaryen.i32), mod.i32.const(1)),
        ),
        mod.global.get("counter", binaryen.i32),
      ],
      binaryen.i32,
    ),
  );
  mod.addFunctionExport("tick", "tick");

  const bytes = mod.emitBinary();
  const reparsed = binaryen.readBinary(bytes);
  // Memory export + function export = 2 exports.
  assertEquals(reparsed.getNumExports(), 2);
});

// ---------------------------------------------------------------------------
// Upstream-signature parity: call_indirect (table first) + setMemory segments
// ---------------------------------------------------------------------------

Deno.test("compat: Module.call_indirect takes table as the FIRST argument (upstream order)", () => {
  // Upstream is `call_indirect(table, target, operands, params, results)`. The
  // previous signature put `table` last, so an upstream-style call bound the
  // table string into the `target` slot and shifted everything else.
  const mod = new binaryen.Module();
  const target = mod.i32.const(0);
  const ci = mod.call_indirect(
    "0",
    target,
    [],
    binaryen.none,
    binaryen.none,
  ) as CallIndirectExpr;
  assertEquals(ci.table, "0");
  assertEquals(ci.target.kind, ExpressionKind.Const); // not the bare "0" string
});

Deno.test("compat: Module.setMemory installs data segments without binding them to `shared`", () => {
  // `segments` is the 4th positional arg (upstream order). The previous
  // signature omitted it, so a positional segments array landed on `shared`
  // (marking the memory shared) and the data was silently dropped.
  const mod = new binaryen.Module();
  mod.setMemory(1, 1, null, [
    { offset: mod.i32.const(0), data: new Uint8Array([1, 2, 3]) },
  ]);
  assertEquals(mod._inner.memories[0].shared, false);
  assertEquals(mod._inner.dataSegments.length, 1);
  assertEquals(Array.from(mod._inner.dataSegments[0].data), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// runPasses
// ---------------------------------------------------------------------------

Deno.test("Module.runPasses runs an explicit pass list", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  mod.runPasses(["DCE", "Vacuum"]);
  const out = mod.emitBinary();
  const reparsed = binaryen.readBinary(out);
  assertEquals(reparsed.getNumExports(), 1);
});

Deno.test("Module.runPasses throws on unknown pass names", () => {
  const mod = binaryen.readBinary(ADD_MODULE);
  assertThrows(
    () => mod.runPasses(["NoSuchPassExists"]),
    Error,
    "Unknown pass",
  );
});

Deno.test("validate() and dispose() exist for upstream parity", () => {
  const mod = new binaryen.Module();
  assertEquals(mod.validate(), 1);
  mod.dispose();
});
