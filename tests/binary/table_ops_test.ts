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
