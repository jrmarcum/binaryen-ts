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
