/**
 * @module binaryen-ts/tests/binary/table_ops_test
 *
 * Round-trip tests for `table.get` (0x25) and `table.set` (0x26).
 * Replaces the prior `nop` stubs in the binary parser.
 *
 * @license MIT
 */

import { assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import {
  type Expression,
  ExpressionKind,
  type TableGetExpr,
  type TableSetExpr,
} from "../../src/ir/expressions.ts";
import { parseWat } from "../../src/parser/wat-parser.ts";

Deno.test("table.get: WAT → encode → parse round-trip preserves the op + table-index slot", () => {
  // funcref table at index 0; `f` reads element 0 and returns it.
  // Note: binary form stores tables by numeric index, so the `$t` name from
  // the WAT source is recovered as the binary parser's default `$tableN`
  // convention after round-trip. The op kind and the index expression are
  // what matter for the round-trip contract.
  const mod = parseWat(`(module
    (table $t 1 funcref)
    (func $f (result funcref)
      (table.get $t (i32.const 0))))`);
  const out = encodeWasm(mod);
  const reparsed = parseWasm(out);
  const top = unwrap(reparsed.functions[0].body);
  assertEquals(top.kind, ExpressionKind.TableGet);
  const g = top as TableGetExpr;
  assertEquals(g.table, "$table0");
  assertEquals(g.index.kind, ExpressionKind.Const);
});

Deno.test("table.set: WAT → encode → parse round-trip preserves the op", () => {
  // externref table; `f` writes a null ref at index 0.
  const mod = parseWat(`(module
    (table $t 1 externref)
    (func $f
      (table.set $t (i32.const 0) (ref.null extern))))`);
  const out = encodeWasm(mod);
  const reparsed = parseWasm(out);
  const top = unwrap(reparsed.functions[0].body);
  assertEquals(top.kind, ExpressionKind.TableSet);
  const s = top as TableSetExpr;
  assertEquals(s.table, "$table0");
  assertEquals(s.index.kind, ExpressionKind.Const);
});

Deno.test("table.get with default table reference (no $name prefix)", () => {
  // Bare `(table.get index)` — default to the first table.
  const mod = parseWat(`(module
    (table $only 2 funcref)
    (func $f (result funcref)
      (table.get (i32.const 1))))`);
  const out = encodeWasm(mod);
  const reparsed = parseWasm(out);
  const top = unwrap(reparsed.functions[0].body);
  assertEquals(top.kind, ExpressionKind.TableGet);
  const g = top as TableGetExpr;
  assertEquals(g.table, "$table0");
});

Deno.test("element segment: flag-4 (expression-form) active funcref segment round-trips and dispatches", async () => {
  // Hand-crafted module equivalent to:
  //   (table 4 funcref)
  //   (elem (i32.const 0) func $a $b)
  //   (func $a (param i32)(result i32) (i32.add (local.get 0)(i32.const 1)))
  //   (func $b (param i32)(result i32) (i32.mul (local.get 0)(i32.const 2)))
  //   (func (export "callA")(param i32)(result i32)
  //     (call_indirect (type 0)(local.get 0)(i32.const 0)))
  //
  // The bytes are exactly what `wabt` (reference-types enabled) emits: the
  // element section uses the FLAG-4 encoding — `0x04` flags, an `i32.const 0`
  // offset expr, then a vec of `ref.func` EXPRESSIONS (`0xd2 idx 0x0b`) rather
  // than the legacy flag-0 vec(funcidx). The old parser only handled flag 0 and
  // silently dropped this segment, leaving the table empty so `call_indirect`
  // trapped with "null function". Regression guard for that bug.
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x86,
    0x80,
    0x80,
    0x80,
    0x00,
    0x01,
    0x60,
    0x01,
    0x7f,
    0x01,
    0x7f,
    0x03,
    0x84,
    0x80,
    0x80,
    0x80,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x04,
    0x84,
    0x80,
    0x80,
    0x80,
    0x00,
    0x01,
    0x70,
    0x00,
    0x04,
    0x07,
    0x89,
    0x80,
    0x80,
    0x80,
    0x00,
    0x01,
    0x05,
    0x63,
    0x61,
    0x6c,
    0x6c,
    0x41,
    0x00,
    0x02,
    0x09,
    0x8c,
    0x80,
    0x80,
    0x80,
    0x00,
    0x01,
    0x04,
    0x41,
    0x00,
    0x0b,
    0x02,
    0xd2,
    0x00,
    0x0b,
    0xd2,
    0x01,
    0x0b,
    0x0a,
    0xa7,
    0x80,
    0x80,
    0x80,
    0x00,
    0x03,
    0x87,
    0x80,
    0x80,
    0x80,
    0x00,
    0x00,
    0x20,
    0x00,
    0x41,
    0x01,
    0x6a,
    0x0b,
    0x87,
    0x80,
    0x80,
    0x80,
    0x00,
    0x00,
    0x20,
    0x00,
    0x41,
    0x02,
    0x6c,
    0x0b,
    0x89,
    0x80,
    0x80,
    0x80,
    0x00,
    0x00,
    0x20,
    0x00,
    0x41,
    0x00,
    0x11,
    0x00,
    0x00,
    0x0b,
  ]);

  const mod = parseWasm(bytes);
  // The segment must survive parsing with both function references intact.
  assertEquals(mod.elements.length, 1);
  assertEquals(mod.elements[0].data, ["$func0", "$func1"]);

  // And re-encoding must produce a binary whose table is actually populated,
  // so the `call_indirect` resolves at runtime instead of trapping.
  const out = encodeWasm(mod);
  const compiled = await WebAssembly.compile(out as BufferSource);
  const instance = new WebAssembly.Instance(compiled);
  const callA = instance.exports.callA as (x: number) => number;
  assertEquals(callA(10), 11); // dispatches to $a: 10 + 1
});

/** Unwrap the binary parser's outer body block to get at the single
 *  instruction inside. Used here because all fixtures have one-instruction
 *  bodies. */
function unwrap(e: Expression): Expression {
  if (e.kind === ExpressionKind.Block) {
    const b = e as { children: Expression[] };
    if (b.children.length === 1) return unwrap(b.children[0]);
  }
  return e;
}
