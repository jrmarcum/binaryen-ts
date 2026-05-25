/**
 * @module binaryen-ts/tests/binary/gc_parser_test
 *
 * Tests for Phase 7 GC proposal support in the binary parser and encoder.
 *
 * @license MIT
 */

import { assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { ExpressionKind } from "../../src/ir/expressions.ts";
import { ValType } from "../../src/ir/types.ts";
import { ModuleBuilder } from "../../src/ir/module.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function module(...sections: number[][]): Uint8Array {
  const bytes: number[] = [...WASM_HEADER];
  for (const s of sections) bytes.push(...s);
  return new Uint8Array(bytes);
}

/** Build a section: [id, content_length, ...content] */
function section(id: number, ...content: number[]): number[] {
  return [id, content.length, ...content];
}

// ---------------------------------------------------------------------------
// GC WASM binaries
// ---------------------------------------------------------------------------

/**
 * Module with a struct type (type 0) and a func type (type 1):
 *   type 0 = struct { i32 (immutable), i32 (immutable) }
 *   type 1 = func () -> (ref $0)          [non-nullable ref to type 0]
 *   func 0 (type 1):
 *     i32.const 1
 *     i32.const 2
 *     struct.new $0
 */
const STRUCT_MODULE = module(
  // type section: 2 types
  section(
    0x01,
    0x02, // count
    // type 0: struct { i32 immutable, i32 immutable }
    0x5f,
    0x02,
    0x7f,
    0x00,
    0x7f,
    0x00,
    // type 1: func () -> (ref $0)
    0x60,
    0x00,
    0x01,
    0x64,
    0x00,
  ),
  section(0x03, 0x01, 0x01), // function section: 1 function, type 1
  // code section
  section(
    0x0a,
    0x01, // 1 function
    0x09, // body size = 9 bytes
    0x00, // 0 local groups
    0x41,
    0x01, // i32.const 1
    0x41,
    0x02, // i32.const 2
    0xfb,
    0x00,
    0x00, // struct.new $0  (0xfb prefix, sub=0x00, typeIdx=0)
    0x0b, // end
  ),
);

/**
 * Module with an array type (type 0) and a func type (type 1):
 *   type 0 = array { i32 (mutable) }
 *   type 1 = func (i32) -> (ref $0)
 *   func 0:
 *     local.get 0
 *     array.new_default $0
 */
const ARRAY_MODULE = module(
  section(
    0x01,
    0x02, // count
    // type 0: array { i32, mutable }
    0x5e,
    0x7f,
    0x01,
    // type 1: func (i32) -> (ref $0)
    0x60,
    0x01,
    0x7f,
    0x01,
    0x64,
    0x00,
  ),
  section(0x03, 0x01, 0x01),
  section(
    0x0a,
    0x01, // 1 function
    0x07, // body size = 7 bytes
    0x00, // 0 local groups
    0x20,
    0x00, // local.get 0
    0xfb,
    0x07,
    0x00, // array.new_default $0  (sub=0x07)
    0x0b,
  ),
);

/**
 * Module with ref.test:
 *   type 0 = struct {}
 *   type 1 = func (anyref) -> i32
 *   func 0:
 *     local.get 0
 *     ref.test $0      -> i32
 */
const REF_TEST_MODULE = module(
  section(
    0x01,
    0x02,
    // type 0: empty struct
    0x5f,
    0x00,
    // type 1: func (anyref) -> i32   [anyref = 0x6e]
    0x60,
    0x01,
    0x6e,
    0x01,
    0x7f,
  ),
  section(0x03, 0x01, 0x01),
  section(
    0x0a,
    0x01,
    0x07, // body size = 7 bytes: 0x00 + local.get(2) + ref.test(3) + end(1)
    0x00, // 0 local groups
    0x20,
    0x00, // local.get 0
    0xfb,
    0x14,
    0x00, // ref.test $0  (sub=0x14, heapType=typeIdx 0)
    0x0b,
  ),
);

// ---------------------------------------------------------------------------
// Tests — binary parser
// ---------------------------------------------------------------------------

Deno.test("GC parser: struct type definition is decoded", () => {
  const mod = parseWasm(STRUCT_MODULE);
  assertEquals(mod.heapTypes.length, 2);

  const structDef = mod.heapTypes[0];
  assertEquals(structDef.kind, "struct");
  if (structDef.kind !== "struct") return;
  assertEquals(structDef.fields.length, 2);
  assertEquals(structDef.fields[0].type, ValType.I32);
  assertEquals(structDef.fields[0].mutable, false);
  assertEquals(structDef.fields[1].type, ValType.I32);
  assertEquals(structDef.fields[1].mutable, false);
});

Deno.test("GC parser: func type in heapTypes has RefType result", () => {
  const mod = parseWasm(STRUCT_MODULE);
  const funcDef = mod.heapTypes[1];
  assertEquals(funcDef.kind, "func");
  if (funcDef.kind !== "func") return;
  assertEquals(funcDef.params.length, 0);
  assertEquals(funcDef.results.length, 1);
  const result = funcDef.results[0];
  assertEquals(typeof result, "object");
  if (typeof result !== "object") return;
  const ref = result as { heap: number; nullable: boolean };
  assertEquals(ref.nullable, false);
  assertEquals(ref.heap, 0); // non-nullable ref to type 0
});

Deno.test("GC parser: struct.new decoded as StructNewExpr (body is the expr directly)", () => {
  const mod = parseWasm(STRUCT_MODULE);
  assertEquals(mod.functions.length, 1);
  // Single-result function body: the body IS the struct.new (no wrapper block)
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.StructNew);
  const sn = body as { typeIndex: number; operands: unknown[]; defaultInit: boolean };
  assertEquals(sn.typeIndex, 0);
  assertEquals(sn.operands.length, 2);
  assertEquals(sn.defaultInit, false);
});

Deno.test("GC parser: array type definition is decoded", () => {
  const mod = parseWasm(ARRAY_MODULE);
  assertEquals(mod.heapTypes.length, 2);

  const arrayDef = mod.heapTypes[0];
  assertEquals(arrayDef.kind, "array");
  if (arrayDef.kind !== "array") return;
  assertEquals(arrayDef.element.type, ValType.I32);
  assertEquals(arrayDef.element.mutable, true);
});

Deno.test("GC parser: array.new_default decoded as ArrayNewExpr with null init", () => {
  const mod = parseWasm(ARRAY_MODULE);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.ArrayNew);
  const an = body as { typeIndex: number; init: unknown };
  assertEquals(an.typeIndex, 0);
  assertEquals(an.init, null);
});

Deno.test("GC parser: ref.test decoded as RefTestExpr", () => {
  const mod = parseWasm(REF_TEST_MODULE);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.RefTest);
  const rt = body as { castType: unknown; nullable: boolean };
  assertEquals(rt.castType, 0);
  assertEquals(rt.nullable, false);
});

Deno.test("GC parser: hasGC flag is set for GC modules", () => {
  const mod = parseWasm(STRUCT_MODULE);
  assertEquals(mod.hasGC, true);
});

// ---------------------------------------------------------------------------
// Tests — binary encoder round-trip
// ---------------------------------------------------------------------------

Deno.test("GC encoder: struct module round-trips through encode+parse", () => {
  const mod = parseWasm(STRUCT_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));

  assertEquals(mod2.heapTypes.length, mod.heapTypes.length);
  assertEquals(mod2.heapTypes[0].kind, "struct");
  assertEquals(mod2.heapTypes[1].kind, "func");
  assertEquals(mod2.functions.length, 1);
});

Deno.test("GC encoder: struct fields preserved after round-trip", () => {
  const mod = parseWasm(STRUCT_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));

  const s0 = mod2.heapTypes[0];
  if (s0.kind !== "struct") throw new Error("expected struct");
  assertEquals(s0.fields.length, 2);
  assertEquals(s0.fields[0].type, ValType.I32);
  assertEquals(s0.fields[0].mutable, false);
  assertEquals(s0.fields[1].type, ValType.I32);
  assertEquals(s0.fields[1].mutable, false);
});

Deno.test("GC encoder: struct.new preserved after round-trip", () => {
  const mod = parseWasm(STRUCT_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  const body = mod2.functions[0].body;
  assertEquals(body.kind, ExpressionKind.StructNew);
  const sn = body as { typeIndex: number; operands: unknown[] };
  assertEquals(sn.typeIndex, 0);
  assertEquals(sn.operands.length, 2);
});

Deno.test("GC encoder: array module round-trips through encode+parse", () => {
  const mod = parseWasm(ARRAY_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));

  assertEquals(mod2.heapTypes.length, 2);
  const a0 = mod2.heapTypes[0];
  if (a0.kind !== "array") throw new Error("expected array");
  assertEquals(a0.element.type, ValType.I32);
  assertEquals(a0.element.mutable, true);
});

Deno.test("GC encoder: array.new_default preserved after round-trip", () => {
  const mod = parseWasm(ARRAY_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  const body = mod2.functions[0].body;
  assertEquals(body.kind, ExpressionKind.ArrayNew);
  const an = body as { init: unknown };
  assertEquals(an.init, null);
});

Deno.test("GC encoder: ref.test round-trips through encode+parse", () => {
  const mod = parseWasm(REF_TEST_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  const body = mod2.functions[0].body;
  assertEquals(body.kind, ExpressionKind.RefTest);
  const rt = body as { castType: unknown; nullable: boolean };
  assertEquals(rt.castType, 0);
  assertEquals(rt.nullable, false);
});

Deno.test("GC encoder: IR-built struct type encodes and parses", () => {
  const builder = new ModuleBuilder();
  builder.addHeapType({
    kind: "struct",
    fields: [
      { type: ValType.I32, mutable: false },
      { type: ValType.F64, mutable: true },
    ],
  });
  const mod = builder.build();
  assertEquals(mod.heapTypes.length, 1);

  const mod2 = parseWasm(encodeWasm(mod));
  assertEquals(mod2.heapTypes.length, 1);
  const s = mod2.heapTypes[0];
  if (s.kind !== "struct") throw new Error("expected struct");
  assertEquals(s.fields.length, 2);
  assertEquals(s.fields[0].type, ValType.I32);
  assertEquals(s.fields[0].mutable, false);
  assertEquals(s.fields[1].type, ValType.F64);
  assertEquals(s.fields[1].mutable, true);
});

Deno.test("GC encoder: IR-built array type encodes and parses", () => {
  const builder = new ModuleBuilder();
  builder.addHeapType({
    kind: "array",
    element: { type: ValType.I64, mutable: true },
  });
  const mod = builder.build();

  const mod2 = parseWasm(encodeWasm(mod));
  assertEquals(mod2.heapTypes.length, 1);
  const a = mod2.heapTypes[0];
  if (a.kind !== "array") throw new Error("expected array");
  assertEquals(a.element.type, ValType.I64);
  assertEquals(a.element.mutable, true);
});
