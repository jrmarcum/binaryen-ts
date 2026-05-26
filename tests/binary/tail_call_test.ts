/**
 * @module binaryen-ts/tests/binary/tail_call_test
 *
 * Tests for the Phase 13 tail-call proposal binary support
 * (return_call = 0x12, return_call_indirect = 0x13).
 *
 * Coverage:
 *  - Parser decodes 0x12 → Call with isReturn=true
 *  - Parser decodes 0x13 → CallIndirect with isReturn=true
 *  - Encoder emits the right opcode based on isReturn
 *  - WAT-source → encode → parse round-trip preserves isReturn
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import {
  type CallExpr,
  type CallIndirectExpr,
  type Expression,
  ExpressionKind,
} from "../../src/ir/expressions.ts";
import { parseWat } from "../../src/parser/wat-parser.ts";

// ---------------------------------------------------------------------------
// Hand-crafted binary fixture — module with `f(): void` whose body is
// `(return_call $f)`. Tests pure binary decode without going through WAT.
//
// Layout:
//   magic + version
//   type section: 1 type, (func) -> ()
//   function section: 1 func of type 0
//   export section: "f" → func 0
//   code section: func 0 body = [0x12 0x00 0x0b] = return_call 0, end
// ---------------------------------------------------------------------------

const RETURN_CALL_MODULE = new Uint8Array([
  // magic + version
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  // type section: 1 entry, func type ()->()
  0x01,
  0x04,
  0x01,
  0x60,
  0x00,
  0x00,
  // function section: 1 func of type 0
  0x03,
  0x02,
  0x01,
  0x00,
  // export section: "f" → func 0
  0x07,
  0x05,
  0x01,
  0x01,
  0x66,
  0x00,
  0x00,
  // code section: 1 body, size 4: [0 locals; return_call 0; end]
  0x0a,
  0x06,
  0x01,
  0x04,
  0x00,
  0x12,
  0x00,
  0x0b,
]);

Deno.test("Phase 13: parser decodes 0x12 as Call with isReturn=true", () => {
  const mod = parseWasm(RETURN_CALL_MODULE);
  assertEquals(mod.functions.length, 1);
  const body = mod.functions[0].body;
  // Body is a block containing the return_call as its single child.
  const target = unwrapSingle(body);
  assertEquals(target.kind, ExpressionKind.Call);
  const call = target as CallExpr;
  assertEquals(call.isReturn, true);
  assertEquals(call.target, "$func0");
});

Deno.test("Phase 13: parser distinguishes call vs return_call", () => {
  // Same module but opcode 0x10 (plain call) instead of 0x12.
  const plainCallModule = new Uint8Array(RETURN_CALL_MODULE);
  // The opcode byte is at offset 30 in this fixture (right before func index 0x00).
  const opcodeOffset = plainCallModule.indexOf(0x12, 25);
  assert(opcodeOffset > 0, "could not locate 0x12 in fixture");
  plainCallModule[opcodeOffset] = 0x10;

  const mod = parseWasm(plainCallModule);
  const target = unwrapSingle(mod.functions[0].body);
  assertEquals(target.kind, ExpressionKind.Call);
  assertEquals((target as CallExpr).isReturn, false);
});

Deno.test("Phase 13: encoder emits 0x12 for isReturn=true Call", () => {
  const mod = parseWasm(RETURN_CALL_MODULE);
  const out = encodeWasm(mod);
  // Re-parse: isReturn must survive the round-trip.
  const reparsed = parseWasm(out);
  const target = unwrapSingle(reparsed.functions[0].body);
  assertEquals((target as CallExpr).isReturn, true);
});

Deno.test("Phase 13: WAT (return_call $f) → encode → parse round-trip preserves isReturn", () => {
  const mod = parseWat(`(module
    (func $f
      (return_call $f)))`);
  const out = encodeWasm(mod);
  const reparsed = parseWasm(out);
  const target = unwrapSingle(reparsed.functions[0].body);
  assertEquals(target.kind, ExpressionKind.Call);
  assertEquals((target as CallExpr).isReturn, true);
});

Deno.test("Phase 13: WAT (return_call_indirect ...) with explicit (param ...)/(result ...) round-trips", () => {
  const mod = parseWat(`(module
    (table $t 1 funcref)
    (func $f (param i32) (result i32)
      (return_call_indirect (param i32) (result i32) (local.get 0) (i32.const 0))))`);
  const out = encodeWasm(mod);
  const reparsed = parseWasm(out);
  const target = unwrapSingle(reparsed.functions[0].body);
  assertEquals(target.kind, ExpressionKind.CallIndirect);
  assertEquals((target as CallIndirectExpr).isReturn, true);
});

Deno.test("Phase 13 + Phase 1: WAT (return_call_indirect (type $sig) ...) resolves type ref", () => {
  // Same as the test above but using `(type $sig)` to reference a
  // module-level function-type declaration. Exercises the Phase 1 fix that
  // makes parseCallIndirect look up the signature via `funcTypeDefs`
  // instead of silently skipping the type reference (which previously left
  // params/results empty and broke encoding).
  const mod = parseWat(`(module
    (table $t 1 funcref)
    (type $sig (func (param i32) (result i32)))
    (func $f (param i32) (result i32)
      (return_call_indirect (type $sig) (local.get 0) (i32.const 0))))`);
  const out = encodeWasm(mod);
  const reparsed = parseWasm(out);
  const target = unwrapSingle(reparsed.functions[0].body);
  assertEquals(target.kind, ExpressionKind.CallIndirect);
  assertEquals((target as CallIndirectExpr).isReturn, true);
  // Params/results were populated from the type reference.
  const ci = target as CallIndirectExpr;
  assertEquals(ci.params.length, 1);
  assertEquals(ci.results.length, 1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The binary parser wraps function bodies in a block. Returns the first
 *  non-block descendant — useful when a fixture's body is a single instruction. */
function unwrapSingle(e: Expression): Expression {
  if (e.kind === ExpressionKind.Block) {
    const b = e as { children: Expression[] };
    if (b.children.length === 1) return unwrapSingle(b.children[0]);
  }
  return e;
}
