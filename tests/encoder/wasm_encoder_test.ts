/**
 * @module binaryen-ts/tests/encoder/wasm_encoder_test
 *
 * Tests for the Phase 3 WASM binary encoder.
 * Round-trip tests parse a known binary, encode the resulting IR, then re-parse
 * and verify structural equivalence.
 *
 * @license MIT
 */

import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm, WasmEncodeError } from "../../src/encoder/index.ts";
import { ExpressionKind } from "../../src/ir/expressions.ts";
import { None, ValType } from "../../src/ir/types.ts";
import {
  BinaryOp,
  type Expression,
  makeBinary,
  makeCall,
  makeI32Const,
  makeLocalGet,
} from "../../src/ir/expressions.ts";
import { ModuleBuilder } from "../../src/ir/module.ts";

// ---------------------------------------------------------------------------
// Shared binary fixtures (same as parser tests)
// ---------------------------------------------------------------------------

const EMPTY_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
]);

const ADD_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x07,
  0x01,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f,
  0x03,
  0x02,
  0x01,
  0x00,
  0x07,
  0x07,
  0x01,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00,
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
  0x0b,
]);

const GLOBAL_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x05,
  0x01,
  0x60,
  0x00,
  0x01,
  0x7f,
  0x03,
  0x02,
  0x01,
  0x00,
  0x06,
  0x06,
  0x01,
  0x7f,
  0x01,
  0x41,
  0x2a,
  0x0b,
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
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(bytes: Uint8Array): ReturnType<typeof parseWasm> {
  const mod = parseWasm(bytes);
  const encoded = encodeWasm(mod);
  return parseWasm(encoded);
}

function walkFind(
  expr: {
    kind: string;
    children?: unknown[];
    left?: unknown;
    right?: unknown;
    value?: unknown;
    body?: unknown;
    condition?: unknown;
    ifTrue?: unknown;
    ifFalse?: unknown;
    delta?: unknown;
    dest?: unknown;
    source?: unknown;
    size?: unknown;
    operands?: unknown[];
    target?: unknown;
  },
  pred: (e: typeof expr) => boolean,
): boolean {
  if (pred(expr)) return true;
  const sub = [
    ...(expr.children ?? []),
    expr.left,
    expr.right,
    expr.value,
    expr.body,
    expr.condition,
    expr.ifTrue,
    expr.ifFalse,
    expr.delta,
    expr.dest,
    expr.source,
    expr.size,
    expr.target,
    ...(expr.operands ?? []),
  ].filter(Boolean) as typeof expr[];
  return sub.some((c) => walkFind(c, pred));
}

// ---------------------------------------------------------------------------
// Encoder output shape tests
// ---------------------------------------------------------------------------

Deno.test("encodeWasm: empty module produces valid WASM header", () => {
  const mod = parseWasm(EMPTY_MODULE);
  const bytes = encodeWasm(mod);
  assertEquals(bytes[0], 0x00);
  assertEquals(bytes[1], 0x61);
  assertEquals(bytes[2], 0x73);
  assertEquals(bytes[3], 0x6d);
  assertEquals(bytes[4], 0x01);
  assertEquals(bytes[5], 0x00);
  assertEquals(bytes[6], 0x00);
  assertEquals(bytes[7], 0x00);
});

Deno.test("encodeWasm: empty module output is re-parseable", () => {
  const mod = parseWasm(EMPTY_MODULE);
  const encoded = encodeWasm(mod);
  const mod2 = parseWasm(encoded);
  assertEquals(mod2.functions.length, 0);
  assertEquals(mod2.globals.length, 0);
  assertEquals(mod2.imports.length, 0);
  assertEquals(mod2.exports.length, 0);
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

Deno.test("round-trip: add module preserves function signature", () => {
  const mod2 = roundTrip(ADD_MODULE);
  assertEquals(mod2.functions.length, 1);
  assertEquals(mod2.functions[0].params, [ValType.I32, ValType.I32]);
  assertEquals(mod2.functions[0].results, [ValType.I32]);
});

Deno.test("round-trip: add module preserves export", () => {
  const mod2 = roundTrip(ADD_MODULE);
  assertEquals(mod2.exports.length, 1);
  assertEquals(mod2.exports[0].name, "add");
  assertEquals(mod2.exports[0].kind, "function");
});

Deno.test("round-trip: add module body still contains binary op", () => {
  const mod2 = roundTrip(ADD_MODULE);
  const fn = mod2.functions[0];
  const found = walkFind(
    fn.body as Parameters<typeof walkFind>[0],
    (e) => e.kind === ExpressionKind.Binary,
  );
  assertEquals(found, true);
});

Deno.test("round-trip: global module preserves global count and type", () => {
  const mod2 = roundTrip(GLOBAL_MODULE);
  assertEquals(mod2.globals.length, 1);
  assertEquals(mod2.globals[0].type, ValType.I32);
  assertEquals(mod2.globals[0].mutable, true);
});

Deno.test("round-trip: global module init expression preserved", () => {
  const mod2 = roundTrip(GLOBAL_MODULE);
  const g = mod2.globals[0];
  assertEquals(g.init.kind, ExpressionKind.Const);
  if (g.init.kind === ExpressionKind.Const) {
    assertEquals((g.init.value as { i32: number }).i32, 42);
  }
});

Deno.test("round-trip: global module body contains global.get", () => {
  const mod2 = roundTrip(GLOBAL_MODULE);
  const fn = mod2.functions[0];
  const found = walkFind(
    fn.body as Parameters<typeof walkFind>[0],
    (e) => e.kind === ExpressionKind.GlobalGet,
  );
  assertEquals(found, true);
});

// ---------------------------------------------------------------------------
// Builder → encode → parse
// ---------------------------------------------------------------------------

Deno.test("encodeWasm: ModuleBuilder add function round-trips", () => {
  const body = makeBinary(
    BinaryOp.AddI32,
    makeLocalGet(0, ValType.I32),
    makeLocalGet(1, ValType.I32),
  );
  const mod = new ModuleBuilder()
    .addFunction("add", [ValType.I32, ValType.I32], [ValType.I32], body)
    .addExport("add", "add")
    .build();

  const bytes = encodeWasm(mod);
  const mod2 = parseWasm(bytes);

  assertEquals(mod2.functions.length, 1);
  assertEquals(mod2.functions[0].params, [ValType.I32, ValType.I32]);
  assertEquals(mod2.functions[0].results, [ValType.I32]);
  assertEquals(mod2.exports[0].name, "add");
});

Deno.test("encodeWasm: unresolved call target throws instead of silently encoding index 0", () => {
  // A name→index miss used to fall back to `?? 0`, encoding a dangling
  // reference as `call 0` — a valid-but-wrong binary that passes
  // WebAssembly.compile (this exact shape once made every imported-function
  // call encode as index 0). The encoder now fails loudly on the miss.
  const mod = new ModuleBuilder()
    .addFunction("caller", [], [], makeCall("does_not_exist", [], None))
    .build();
  assertThrows(() => encodeWasm(mod), WasmEncodeError, "unresolved call target");
});

Deno.test("encodeWasm: unknown unary opcode throws instead of emitting a silent nop", () => {
  // An op missing from the unary opcode table used to fall back to `nop` (0x01)
  // AFTER its operand was already emitted — leaving a dangling stack value and
  // an invalid module. It now fails loudly.
  const bogus = {
    kind: ExpressionKind.Unary,
    type: ValType.I32,
    op: "not.a.real.unary.op",
    value: makeI32Const(0),
  } as unknown as Expression;
  const mod = new ModuleBuilder()
    .addFunction("f", [], [ValType.I32], bogus)
    .build();
  assertThrows(() => encodeWasm(mod), WasmEncodeError, "unknown unary opcode");
});

Deno.test("encodeWasm: memory section round-trips", () => {
  const mod = new ModuleBuilder()
    .addMemory("mem0", 1, 4)
    .build();

  const bytes = encodeWasm(mod);
  const mod2 = parseWasm(bytes);

  assertEquals(mod2.memories.length, 1);
  assertEquals(mod2.memories[0].initial, 1);
  assertEquals(mod2.memories[0].max, 4);
});

Deno.test("encodeWasm: data segment round-trips", () => {
  const data = new TextEncoder().encode("hello");
  const mod = new ModuleBuilder()
    .addMemory("mem0", 1, null)
    .addDataSegment("$data0", makeI32Const(0), data)
    .build();

  const bytes = encodeWasm(mod);
  const mod2 = parseWasm(bytes);

  assertEquals(mod2.dataSegments.length, 1);
  assertEquals(mod2.dataSegments[0].passive, false);
  assertEquals(mod2.dataSegments[0].data, data);
});

Deno.test("encodeWasm: passive data segment round-trips", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const mod = new ModuleBuilder()
    .addMemory("mem0", 1, null)
    .addPassiveDataSegment("$data0", data)
    .build();

  const bytes = encodeWasm(mod);
  const mod2 = parseWasm(bytes);

  assertEquals(mod2.dataSegments.length, 1);
  assertEquals(mod2.dataSegments[0].passive, true);
  assertEquals(mod2.dataSegments[0].data, data);
});

Deno.test("encodeWasm: i32.const value preserved through encode/parse", () => {
  const body = makeI32Const(1337);
  const mod = new ModuleBuilder()
    .addFunction("getVal", [], [ValType.I32], body)
    .build();

  const bytes = encodeWasm(mod);
  const mod2 = parseWasm(bytes);

  const fn = mod2.functions[0];
  const bodyExpr = fn.body;
  const found = walkFind(
    bodyExpr as Parameters<typeof walkFind>[0],
    (e) => {
      if (e.kind !== ExpressionKind.Const) return false;
      const v = (e as { value?: { i32?: number } }).value;
      return v !== undefined && typeof v === "object" && "i32" in v && v.i32 === 1337;
    },
  );
  assertEquals(found, true);
});

Deno.test("encodeWasm: output is a Uint8Array", () => {
  const mod = parseWasm(ADD_MODULE);
  const bytes = encodeWasm(mod);
  assertInstanceOf(bytes, Uint8Array);
});
