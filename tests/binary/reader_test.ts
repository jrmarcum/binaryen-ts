/**
 * @module binaryen-ts/tests/binary/reader_test
 *
 * Tests for {@link BinaryReader}, focused on LEB128 boundary cases.
 *
 * The 5-byte signed-i32 / 10-byte signed-i64 boundary is the regression
 * surface that previously rejected legal-but-large encodings — e.g. the
 * `i32.const` initializers emitted by DWARF-aware C++ toolchains for
 * data-segment offsets near `2^31`. Real-world wasm files (zlib,
 * cubescript, fannkuch_dwarf) routinely contain these encodings.
 *
 * @license MIT
 */

import { assertEquals, assertThrows } from "@std/assert";
import { BinaryReader, WasmBinaryError } from "../../src/binary/reader.ts";

// ---------------------------------------------------------------------------
// readI32 — signed LEB128 i32
// ---------------------------------------------------------------------------

Deno.test("readI32 — 1-byte positive (max 1-byte SLEB is 63; 0x40 is the sign bit)", () => {
  // 0x3f = 63 — max single-byte positive SLEB128 i32
  const r = new BinaryReader(new Uint8Array([0x3f]));
  assertEquals(r.readI32(), 63);
});

Deno.test("readI32 — 1-byte negative (sign-extended)", () => {
  // 0x7f = -1 in signed LEB128 (sign bit set in 1-byte form)
  const r = new BinaryReader(new Uint8Array([0x7f]));
  assertEquals(r.readI32(), -1);
});

Deno.test("readI32 — 5-byte INT32_MAX (boundary case the bug rejected)", () => {
  // 0x7fffffff = INT32_MAX. SLEB128 encoding: ff ff ff ff 07
  // Bytes: 0x7f | (0x7f<<7) | (0x7f<<14) | (0x7f<<21) | (0x07<<28) = 0x7FFFFFFF
  const r = new BinaryReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x07]));
  assertEquals(r.readI32(), 0x7fffffff | 0);
});

Deno.test("readI32 — 5-byte INT32_MIN (boundary case, negative)", () => {
  // -2^31 = INT32_MIN. SLEB128 encoding: 80 80 80 80 78
  // Last byte 0x78: bit 0x40 set → sign-extend bit 31 high → result = 0x80000000
  const r = new BinaryReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x78]));
  assertEquals(r.readI32(), -0x80000000 | 0);
});

Deno.test("readI32 — 5-byte arbitrary large positive (typical DWARF data offset)", () => {
  // i32.const 0x40000000 (1 << 30): SLEB128 = 80 80 80 80 04
  const r = new BinaryReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x04]));
  assertEquals(r.readI32(), 0x40000000);
});

Deno.test("readI32 — 6 bytes is overflow (would-be 6th byte rejected)", () => {
  // 6 bytes worth of continuation: ff ff ff ff ff 00 — invalid, exceeds i32
  const r = new BinaryReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x00]));
  assertThrows(() => r.readI32(), WasmBinaryError, "LEB128 i32 overflow");
});

// ---------------------------------------------------------------------------
// readI64 — signed LEB128 i64 (parallel boundary)
// ---------------------------------------------------------------------------

Deno.test("readI64 — 1-byte negative", () => {
  // -1 in SLEB128 is 0x7f
  const r = new BinaryReader(new Uint8Array([0x7f]));
  assertEquals(r.readI64(), -1n);
});

Deno.test("readI64 — 10-byte INT64_MAX (boundary case the parallel bug rejected)", () => {
  // INT64_MAX = 2^63 - 1. SLEB128: 10 bytes, last = 0x00 (after 9× 0xff)
  // Bytes 0-8: 0xff each → contributes 0x7f at shift 0,7,14,...,56
  // Byte 9 (last): 0x00, no continuation, no sign bit
  // Result: (1<<63) - 1
  const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
  const r = new BinaryReader(bytes);
  assertEquals(r.readI64(), (1n << 63n) - 1n);
});

Deno.test("readI64 — 11 bytes is overflow", () => {
  const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
  const r = new BinaryReader(bytes);
  assertThrows(() => r.readI64(), WasmBinaryError, "LEB128 i64 overflow");
});

// ---------------------------------------------------------------------------
// readU32 — unsigned LEB128 u32 (was already correct; pinning behavior)
// ---------------------------------------------------------------------------

Deno.test("readU32 — 5-byte UINT32_MAX", () => {
  // 0xffffffff = UINT32_MAX. ULEB128: ff ff ff ff 0f
  const r = new BinaryReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]));
  assertEquals(r.readU32(), 0xffffffff);
});

Deno.test("readU32 — 6 bytes is overflow", () => {
  const r = new BinaryReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]));
  assertThrows(() => r.readU32(), WasmBinaryError, "LEB128 u32 overflow");
});
