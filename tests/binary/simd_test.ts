/**
 * @module binaryen-ts/tests/binary/simd_test
 *
 * Tests for Phase 9 SIMD support in the binary parser and encoder.
 *
 * @license MIT
 */

import { assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import {
  type BinaryExpr,
  BinaryOp,
  type ConstExpr,
  ExpressionKind,
  type SIMDExtractExpr,
  SIMDExtractOp,
  type SIMDLoadExpr,
  SIMDLoadOp,
  type SIMDLoadStoreLaneExpr,
  SIMDLoadStoreLaneOp,
  type SIMDReplaceExpr,
  SIMDReplaceOp,
  type SIMDShiftExpr,
  SIMDShiftOp,
  type SIMDShuffleExpr,
  type SIMDTernaryExpr,
  SIMDTernaryOp,
  type UnaryExpr,
  UnaryOp,
} from "../../src/ir/expressions.ts";
import { ValType } from "../../src/ir/types.ts";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function module(...sections: number[][]): Uint8Array {
  const bytes: number[] = [...WASM_HEADER];
  for (const s of sections) bytes.push(...s);
  return new Uint8Array(bytes);
}

// section(id, ...contentBytes) — inserts section id + content byte count
function section(id: number, ...content: number[]): number[] {
  return [id, content.length, ...content];
}

// ---------------------------------------------------------------------------
// Test binary 1: v128.const
//
// (module
//   (func (result v128)
//     v128.const i8x16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
//   )
// )
// body bytes: 0x00(locals) 0xfd 0x0c [16 bytes] 0x0b = 20 bytes
// ---------------------------------------------------------------------------

const V128CONST_MODULE = module(
  section(0x01, 0x01, 0x60, 0x00, 0x01, 0x7b), // type: () -> v128
  section(0x03, 0x01, 0x00), // func: type 0
  section(
    0x0a,
    0x01,
    20, // body size = 1+2+16+1
    0x00, // 0 locals
    0xfd,
    0x0c, // v128.const sub-opcode
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b,
    0x0c,
    0x0d,
    0x0e,
    0x0f,
    0x0b, // end
  ),
);

Deno.test("SIMD: v128.const parsed correctly", () => {
  const mod = parseWasm(V128CONST_MODULE);
  const expr = mod.functions[0].body as ConstExpr;
  assertEquals(expr.kind, ExpressionKind.Const);
  assertEquals(expr.type, ValType.V128);
  const v128 = (expr.value as { v128: Uint8Array }).v128;
  assertEquals(v128.length, 16);
  for (let i = 0; i < 16; i++) assertEquals(v128[i], i);
});

// ---------------------------------------------------------------------------
// Test binary 2: i32x4.splat
//
// (module
//   (func (param i32) (result v128)
//     local.get 0
//     i32x4.splat  ; 0xFD 0x11
//   )
// )
// body: 0x00 0x20 0x00 0xfd 0x11 0x0b = 6 bytes
// ---------------------------------------------------------------------------

const SPLAT_MODULE = module(
  section(0x01, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7b), // (i32) -> v128
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    6, // body size
    0x00, // 0 locals
    0x20,
    0x00, // local.get 0
    0xfd,
    0x11, // i32x4.splat
    0x0b, // end
  ),
);

Deno.test("SIMD: i32x4.splat parsed correctly", () => {
  const mod = parseWasm(SPLAT_MODULE);
  const expr = mod.functions[0].body as UnaryExpr;
  assertEquals(expr.kind, ExpressionKind.Unary);
  assertEquals(expr.op, UnaryOp.SplatVecI32x4);
  assertEquals(expr.type, ValType.V128);
});

// ---------------------------------------------------------------------------
// Test binary 3: i32x4.add
//
// (module
//   (func (param v128 v128) (result v128)
//     local.get 0
//     local.get 1
//     i32x4.add   ; 0xFD 0xAE 0x01  (sub-opcode 174, LEB128 2 bytes)
//   )
// )
// body: 0x00 0x20 0x00 0x20 0x01 0xfd 0xae 0x01 0x0b = 9 bytes
// ---------------------------------------------------------------------------

const ADD_MODULE = module(
  section(0x01, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b),
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    9,
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0xfd,
    0xae,
    0x01, // i32x4.add (sub=174=0xAE, LEB128: 0xAE 0x01)
    0x0b,
  ),
);

Deno.test("SIMD: i32x4.add parsed correctly", () => {
  const mod = parseWasm(ADD_MODULE);
  const expr = mod.functions[0].body as BinaryExpr;
  assertEquals(expr.kind, ExpressionKind.Binary);
  assertEquals(expr.op, BinaryOp.AddVecI32x4);
  assertEquals(expr.type, ValType.V128);
});

// ---------------------------------------------------------------------------
// Test binary 4: i8x16.shuffle
//
// body: 0x00 0x20 0x00 0x20 0x01 0xfd 0x0d [16 bytes] 0x0b = 24 bytes
// ---------------------------------------------------------------------------

const SHUFFLE_MODULE = module(
  section(0x01, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b),
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    24,
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0xfd,
    0x0d, // i8x16.shuffle
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b,
    0x0c,
    0x0d,
    0x0e,
    0x0f,
    0x0b,
  ),
);

Deno.test("SIMD: i8x16.shuffle parsed correctly", () => {
  const mod = parseWasm(SHUFFLE_MODULE);
  const expr = mod.functions[0].body as SIMDShuffleExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDShuffle);
  assertEquals(expr.type, ValType.V128);
  assertEquals(expr.mask.length, 16);
  for (let i = 0; i < 16; i++) assertEquals(expr.mask[i], i);
});

// ---------------------------------------------------------------------------
// Test binary 5: i8x16.extract_lane_s lane=3
//
// body: 0x00 0x20 0x00 0xfd 0x15 0x03 0x0b = 7 bytes
// ---------------------------------------------------------------------------

const EXTRACT_MODULE = module(
  section(0x01, 0x01, 0x60, 0x01, 0x7b, 0x01, 0x7f), // (v128) -> i32
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    7,
    0x00,
    0x20,
    0x00,
    0xfd,
    0x15,
    0x03, // i8x16.extract_lane_s, lane=3
    0x0b,
  ),
);

Deno.test("SIMD: i8x16.extract_lane_s parsed correctly", () => {
  const mod = parseWasm(EXTRACT_MODULE);
  const expr = mod.functions[0].body as SIMDExtractExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDExtract);
  assertEquals(expr.op, SIMDExtractOp.ExtractLaneSVecI8x16);
  assertEquals(expr.lane, 3);
  assertEquals(expr.type, ValType.I32);
});

// ---------------------------------------------------------------------------
// Test binary 6: i32x4.replace_lane lane=2
//
// body: 0x00 0x20 0x00 0x20 0x01 0xfd 0x1c 0x02 0x0b = 9 bytes
// ---------------------------------------------------------------------------

const REPLACE_MODULE = module(
  section(0x01, 0x01, 0x60, 0x02, 0x7b, 0x7f, 0x01, 0x7b), // (v128,i32)->v128
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    9, // 1+2+2+3+1
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0xfd,
    0x1c,
    0x02, // i32x4.replace_lane, lane=2
    0x0b,
  ),
);

Deno.test("SIMD: i32x4.replace_lane parsed correctly", () => {
  const mod = parseWasm(REPLACE_MODULE);
  const expr = mod.functions[0].body as SIMDReplaceExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDReplace);
  assertEquals(expr.op, SIMDReplaceOp.ReplaceLaneVecI32x4);
  assertEquals(expr.lane, 2);
  assertEquals(expr.type, ValType.V128);
});

// ---------------------------------------------------------------------------
// Test binary 7: i32x4.shl (SIMDShift)
//
// sub-opcode 0xAB=171, LEB128: 0xAB 0x01
// body: 0x00 0x20 0x00 0x20 0x01 0xfd 0xab 0x01 0x0b = 9 bytes
// ---------------------------------------------------------------------------

const SHIFT_MODULE = module(
  section(0x01, 0x01, 0x60, 0x02, 0x7b, 0x7f, 0x01, 0x7b), // (v128,i32)->v128
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    9,
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0xfd,
    0xab,
    0x01, // i32x4.shl (sub=171)
    0x0b,
  ),
);

Deno.test("SIMD: i32x4.shl (SIMDShift) parsed correctly", () => {
  const mod = parseWasm(SHIFT_MODULE);
  const expr = mod.functions[0].body as SIMDShiftExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDShift);
  assertEquals(expr.op, SIMDShiftOp.ShlVecI32x4);
  assertEquals(expr.type, ValType.V128);
});

// ---------------------------------------------------------------------------
// Test binary 8: v128.bitselect (SIMDTernary)
//
// body: 0x00 0x20 0x00 0x20 0x01 0x20 0x02 0xfd 0x52 0x0b = 10 bytes
// ---------------------------------------------------------------------------

const BITSELECT_MODULE = module(
  section(0x01, 0x01, 0x60, 0x03, 0x7b, 0x7b, 0x7b, 0x01, 0x7b),
  section(0x03, 0x01, 0x00),
  section(
    0x0a,
    0x01,
    10,
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0x20,
    0x02,
    0xfd,
    0x52, // v128.bitselect (sub=0x52)
    0x0b,
  ),
);

Deno.test("SIMD: v128.bitselect (SIMDTernary) parsed correctly", () => {
  const mod = parseWasm(BITSELECT_MODULE);
  const expr = mod.functions[0].body as SIMDTernaryExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDTernary);
  assertEquals(expr.op, SIMDTernaryOp.Bitselect);
  assertEquals(expr.type, ValType.V128);
});

// ---------------------------------------------------------------------------
// Test binary 9: v128.load8x8_s (SIMDLoad)
//
// body: 0x00 0x20 0x00 0xfd 0x01 0x01 0x00 0x0b = 8 bytes
// ---------------------------------------------------------------------------

const SIMD_LOAD_MODULE = module(
  section(0x01, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7b), // (i32) -> v128
  section(0x03, 0x01, 0x00),
  section(0x05, 0x01, 0x00, 0x01), // memory(1)
  section(
    0x0a,
    0x01,
    8,
    0x00,
    0x20,
    0x00,
    0xfd,
    0x01, // v128.load8x8_s
    0x01, // align=1
    0x00, // offset=0
    0x0b,
  ),
);

Deno.test("SIMD: v128.load8x8_s (SIMDLoad) parsed correctly", () => {
  const mod = parseWasm(SIMD_LOAD_MODULE);
  const expr = mod.functions[0].body as SIMDLoadExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDLoad);
  assertEquals(expr.op, SIMDLoadOp.Load8x8SVec128);
  assertEquals(expr.align, 1);
  assertEquals(expr.offset, 0);
  assertEquals(expr.type, ValType.V128);
});

// ---------------------------------------------------------------------------
// Test binary 10: v128.load8_lane lane=0 (SIMDLoadStoreLane)
//
// body: 0x00 0x20 0x00 0x20 0x01 0xfd 0x54 0x00 0x00 0x00 0x0b = 11 bytes
// ---------------------------------------------------------------------------

const SIMD_LANE_MODULE = module(
  section(0x01, 0x01, 0x60, 0x02, 0x7f, 0x7b, 0x01, 0x7b), // (i32,v128)->v128
  section(0x03, 0x01, 0x00),
  section(0x05, 0x01, 0x00, 0x01),
  section(
    0x0a,
    0x01,
    11, // 1+2+2+2+3+1
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0xfd,
    0x54, // v128.load8_lane
    0x00, // align=0
    0x00, // offset=0
    0x00, // lane=0
    0x0b,
  ),
);

Deno.test("SIMD: v128.load8_lane (SIMDLoadStoreLane) parsed correctly", () => {
  const mod = parseWasm(SIMD_LANE_MODULE);
  const expr = mod.functions[0].body as SIMDLoadStoreLaneExpr;
  assertEquals(expr.kind, ExpressionKind.SIMDLoadStoreLane);
  assertEquals(expr.op, SIMDLoadStoreLaneOp.Load8LaneVec128);
  assertEquals(expr.lane, 0);
  assertEquals(expr.type, ValType.V128);
});

// ===========================================================================
// Encoder round-trip tests
// ===========================================================================

function roundTrip(bytes: Uint8Array): Uint8Array {
  return encodeWasm(parseWasm(bytes));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

Deno.test("SIMD round-trip: v128.const", () => {
  assertEquals(bytesEqual(roundTrip(V128CONST_MODULE), V128CONST_MODULE), true);
});

Deno.test("SIMD round-trip: i32x4.splat", () => {
  assertEquals(bytesEqual(roundTrip(SPLAT_MODULE), SPLAT_MODULE), true);
});

Deno.test("SIMD round-trip: i32x4.add", () => {
  assertEquals(bytesEqual(roundTrip(ADD_MODULE), ADD_MODULE), true);
});

Deno.test("SIMD round-trip: i8x16.shuffle", () => {
  assertEquals(bytesEqual(roundTrip(SHUFFLE_MODULE), SHUFFLE_MODULE), true);
});

Deno.test("SIMD round-trip: i8x16.extract_lane_s", () => {
  assertEquals(bytesEqual(roundTrip(EXTRACT_MODULE), EXTRACT_MODULE), true);
});

Deno.test("SIMD round-trip: i32x4.replace_lane", () => {
  assertEquals(bytesEqual(roundTrip(REPLACE_MODULE), REPLACE_MODULE), true);
});

Deno.test("SIMD round-trip: i32x4.shl", () => {
  assertEquals(bytesEqual(roundTrip(SHIFT_MODULE), SHIFT_MODULE), true);
});

Deno.test("SIMD round-trip: v128.bitselect", () => {
  assertEquals(bytesEqual(roundTrip(BITSELECT_MODULE), BITSELECT_MODULE), true);
});

Deno.test("SIMD round-trip: v128.load8x8_s", () => {
  assertEquals(bytesEqual(roundTrip(SIMD_LOAD_MODULE), SIMD_LOAD_MODULE), true);
});

Deno.test("SIMD round-trip: v128.load8_lane", () => {
  assertEquals(bytesEqual(roundTrip(SIMD_LANE_MODULE), SIMD_LANE_MODULE), true);
});
