/**
 * @module binaryen-ts/tests/binary/wasm_parser_test
 *
 * Tests for the Phase 2 WASM binary parser.
 *
 * @license MIT
 */

import { assertEquals, assertThrows } from "@std/assert";
import { parseWasm, WasmBinaryError } from "../../src/binary/index.ts";
import { ExpressionKind } from "../../src/ir/expressions.ts";
import { ValType } from "../../src/ir/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid empty WASM module (magic + version only). */
const EMPTY_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // magic: \0asm
  0x01,
  0x00,
  0x00,
  0x00, // version: 1
]);

/**
 * Module with one function: (func $add (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
 * Exported as "add".
 */
const ADD_MODULE = new Uint8Array([
  // magic + version
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  // type section (id=1, size=7): 1 type: (i32 i32) -> i32
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f,
  // function section (id=3, size=2): 1 function, type index 0
  0x03,
  0x02,
  0x01,
  0x00,
  // export section (id=7, size=7): export "add" -> func 0
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00,
  // code section (id=10, size=9): 1 body
  0x0a,
  0x09,
  0x01,
  //   body size=7, 0 locals, local.get 0, local.get 1, i32.add, end
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b,
]);

/**
 * Module with one i32 mutable global (init=42) and a function that reads it.
 * global section: valtype=i32, mutable=1, init=i32.const 42, end
 */
const GLOBAL_MODULE = new Uint8Array([
  // magic + version
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  // type section: 1 type () -> i32
  0x01,
  0x05,
  0x01,
  0x60,
  0x00,
  0x01,
  0x7f,
  // function section: 1 func, type 0
  0x03,
  0x02,
  0x01,
  0x00,
  // global section (id=6): 1 global, i32 mutable, init=i32.const 42 end
  0x06,
  0x06,
  0x01,
  0x7f,
  0x01,
  0x41,
  0x2a,
  0x0b,
  // code section: 1 body: 0 locals, global.get 0, end
  0x0a,
  0x06,
  0x01,
  0x04,
  0x00,
  0x23,
  0x00,
  0x0b,
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("parseWasm rejects bad magic", () => {
  const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  assertThrows(() => parseWasm(bad), WasmBinaryError, "invalid WASM magic");
});

Deno.test("parseWasm rejects wrong version", () => {
  const bad = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
  assertThrows(() => parseWasm(bad), WasmBinaryError, "unsupported WASM version");
});

Deno.test("parseWasm rejects truncated input", () => {
  assertThrows(() => parseWasm(new Uint8Array([0x00, 0x61, 0x73])), WasmBinaryError);
});

Deno.test("parseWasm accepts empty module", () => {
  const mod = parseWasm(EMPTY_MODULE);
  assertEquals(mod.functions.length, 0);
  assertEquals(mod.globals.length, 0);
  assertEquals(mod.imports.length, 0);
  assertEquals(mod.exports.length, 0);
});

Deno.test("parseWasm: add function has correct signature", () => {
  const mod = parseWasm(ADD_MODULE);
  assertEquals(mod.functions.length, 1);
  const fn = mod.functions[0];
  assertEquals(fn.params, [ValType.I32, ValType.I32]);
  assertEquals(fn.results, [ValType.I32]);
});

Deno.test("parseWasm: add function is exported as 'add'", () => {
  const mod = parseWasm(ADD_MODULE);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "add");
  assertEquals(mod.exports[0].kind, "function");
});

Deno.test("parseWasm: add function body contains binary op", () => {
  const mod = parseWasm(ADD_MODULE);
  const fn = mod.functions[0];
  // Body is a block or direct binary expression
  let found = false;
  const walk = (
    e: { kind: string; left?: unknown; right?: unknown; exprs?: unknown[]; children?: unknown[] },
  ): void => {
    if (e.kind === ExpressionKind.Binary) {
      found = true;
      return;
    }
    if (e.exprs) (e.exprs as typeof e[]).forEach(walk);
    if (e.children) (e.children as typeof e[]).forEach(walk);
  };
  walk(fn.body as Parameters<typeof walk>[0]);
  assertEquals(found, true);
});

Deno.test("parseWasm: global module has one global with init i32.const 42", () => {
  const mod = parseWasm(GLOBAL_MODULE);
  assertEquals(mod.globals.length, 1);
  const g = mod.globals[0];
  assertEquals(g.type, ValType.I32);
  assertEquals(g.mutable, true);
  assertEquals(g.init.kind, ExpressionKind.Const);
  if (g.init.kind === ExpressionKind.Const) {
    assertEquals((g.init.value as { i32: number }).i32, 42);
  }
});

Deno.test("parseWasm: global.get in function body", () => {
  const mod = parseWasm(GLOBAL_MODULE);
  assertEquals(mod.functions.length, 1);
  const fn = mod.functions[0];
  let found = false;
  const walk = (e: { kind: string; children?: unknown[]; exprs?: unknown[] }): void => {
    if (e.kind === ExpressionKind.GlobalGet) {
      found = true;
      return;
    }
    if (e.children) (e.children as typeof e[]).forEach(walk);
    if (e.exprs) (e.exprs as typeof e[]).forEach(walk);
  };
  walk(fn.body as Parameters<typeof walk>[0]);
  assertEquals(found, true);
});
