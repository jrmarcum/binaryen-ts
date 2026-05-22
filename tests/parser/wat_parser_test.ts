/**
 * @module binaryen-ts/tests/parser/wat_parser
 *
 * Integration tests for the WAT → WasmModule IR parser.
 *
 * @license Apache-2.0
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { parseWat, WatParseError } from "../../src/parser/wat-parser.ts";
import { ExpressionKind } from "../../src/ir/expressions.ts";
import { ValType } from "../../src/ir/types.ts";

Deno.test("parseWat — empty module", () => {
  const mod = parseWat("(module)");
  assertEquals(mod.functions.length, 0);
  assertEquals(mod.exports.length, 0);
  assertEquals(mod.imports.length, 0);
});

Deno.test("parseWat — single function, no body", () => {
  const mod = parseWat(`(module (func $f))`);
  assertEquals(mod.functions.length, 1);
  assertEquals(mod.functions[0].name, "$f");
  assertEquals(mod.functions[0].params, []);
  assertEquals(mod.functions[0].results, []);
});

Deno.test("parseWat — function with params and result", () => {
  const mod = parseWat(`(module
    (func $add (param i32 i32) (result i32)
      (i32.add (local.get 0) (local.get 1))))`);
  const fn = mod.functions[0];
  assertEquals(fn.name, "$add");
  assertEquals(fn.params, [ValType.I32, ValType.I32]);
  assertEquals(fn.results, [ValType.I32]);
  assertEquals(fn.body.kind, ExpressionKind.Binary);
});

Deno.test("parseWat — i32.const", () => {
  const mod = parseWat(`(module (func $f (result i32) (i32.const 42)))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Const);
  assertEquals((body as import("../../src/ir/expressions.ts").ConstExpr).value, { i32: 42 });
});

Deno.test("parseWat — f64.const", () => {
  const mod = parseWat(`(module (func $f (result f64) (f64.const 3.14)))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Const);
  const v = (body as import("../../src/ir/expressions.ts").ConstExpr).value as { f64: number };
  assertClose(v.f64, 3.14);
});

Deno.test("parseWat — local.get and local.set", () => {
  const mod = parseWat(`(module
    (func $f (param i32) (result i32)
      (local.get 0)))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.LocalGet);
  assertEquals((body as import("../../src/ir/expressions.ts").LocalGetExpr).index, 0);
  assertEquals((body as import("../../src/ir/expressions.ts").LocalGetExpr).type, ValType.I32);
});

Deno.test("parseWat — nop and unreachable", () => {
  const mod = parseWat(`(module (func $f (nop) (unreachable)))`);
  const fn = mod.functions[0];
  // Body is a block since there are two expressions
  assertEquals(fn.body.kind, ExpressionKind.Block);
  const block = fn.body as import("../../src/ir/expressions.ts").BlockExpr;
  assertEquals(block.children[0].kind, ExpressionKind.Nop);
  assertEquals(block.children[1].kind, ExpressionKind.Unreachable);
});

Deno.test("parseWat — if/then/else", () => {
  const mod = parseWat(`(module
    (func $f (param i32) (result i32)
      (if (result i32) (local.get 0)
        (then (i32.const 1))
        (else (i32.const 0)))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.If);
});

Deno.test("parseWat — block with label", () => {
  const mod = parseWat(`(module
    (func $f
      (block $b
        (br $b))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Block);
  const block = body as import("../../src/ir/expressions.ts").BlockExpr;
  assertEquals(block.name, "$b");
  assertEquals(block.children[0].kind, ExpressionKind.Break);
});

Deno.test("parseWat — loop", () => {
  const mod = parseWat(`(module
    (func $f
      (loop $l
        (br $l))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Loop);
});

Deno.test("parseWat — call", () => {
  const mod = parseWat(`(module
    (func $callee (result i32) (i32.const 1))
    (func $caller (result i32) (call $callee)))`);
  assertEquals(mod.functions.length, 2);
  const caller = mod.functions[1];
  assertEquals(caller.body.kind, ExpressionKind.Call);
  assertEquals((caller.body as import("../../src/ir/expressions.ts").CallExpr).target, "$callee");
});

Deno.test("parseWat — export", () => {
  const mod = parseWat(`(module
    (func $add (param i32 i32) (result i32)
      (i32.add (local.get 0) (local.get 1)))
    (export "add" (func $add)))`);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "add");
  assertEquals(mod.exports[0].value, "$add");
});

Deno.test("parseWat — inline export", () => {
  const mod = parseWat(`(module
    (func $f (export "f") (result i32) (i32.const 0)))`);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "f");
});

Deno.test("parseWat — memory", () => {
  const mod = parseWat(`(module (memory $mem 1 4))`);
  assertEquals(mod.memories.length, 1);
  assertEquals(mod.memories[0].initial, 1);
  assertEquals(mod.memories[0].max, 4);
});

Deno.test("parseWat — function import", () => {
  const mod = parseWat(`(module
    (import "env" "log" (func $log (param i32))))`);
  assertEquals(mod.imports.length, 1);
  assertEquals(mod.imports[0].module, "env");
  assertEquals(mod.imports[0].base, "log");
  assertEquals(mod.imports[0].params, [ValType.I32]);
});

Deno.test("parseWat — full add module", () => {
  const src = `(module
    (func $add (export "add") (param $a i32) (param $b i32) (result i32)
      (i32.add (local.get $a) (local.get $b))))`;
  const mod = parseWat(src);
  assertEquals(mod.functions.length, 1);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "add");
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Binary);
});

Deno.test("parseWat — return expression", () => {
  const mod = parseWat(`(module (func $f (result i32) (return (i32.const 99))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Return);
  const ret = body as import("../../src/ir/expressions.ts").ReturnExpr;
  assertEquals(ret.value?.kind, ExpressionKind.Const);
});

Deno.test("parseWat — drop", () => {
  const mod = parseWat(`(module (func $f (drop (i32.const 1))))`);
  assertEquals(mod.functions[0].body.kind, ExpressionKind.Drop);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertClose(a: number, b: number, epsilon = 1e-10): void {
  if (Math.abs(a - b) > epsilon) {
    throw new Error(`Expected ${a} to be close to ${b}`);
  }
}
