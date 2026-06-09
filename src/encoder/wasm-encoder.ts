/**
 * @module binaryen-ts/encoder/wasm-encoder
 *
 * WASM binary encoder: serializes a {@link WasmModule} IR tree into a `.wasm` binary.
 *
 * This is the inverse of the Phase 2 parser (`src/binary/wasm-parser.ts`).
 * The output is a valid WebAssembly 1.0 binary that can be re-parsed or executed.
 *
 * @license MIT
 */

import {
  type ArrayGetExpr,
  type ArrayLenExpr,
  type ArrayNewDataExpr,
  type ArrayNewElemExpr,
  type ArrayNewExpr,
  type ArrayNewFixedExpr,
  type ArraySetExpr,
  type BinaryExpr,
  BinaryOp,
  type BlockExpr,
  type BreakExpr,
  type BrOnExpr,
  BrOnOp,
  type CallExpr,
  type CallIndirectExpr,
  type ConstExpr,
  type DropExpr,
  type Expression,
  ExpressionKind,
  type GlobalGetExpr,
  type GlobalSetExpr,
  type I31GetExpr,
  type IfExpr,
  type LoadExpr,
  type LocalGetExpr,
  type LocalSetExpr,
  type LocalTeeExpr,
  type LoopExpr,
  type MemoryCopyExpr,
  type MemoryFillExpr,
  type MemoryGrowExpr,
  type RefCastExpr,
  type RefEqExpr,
  type RefFuncExpr,
  type RefI31Expr,
  type RefIsNullExpr,
  type RefNullExpr,
  type RefTestExpr,
  type RethrowExpr,
  type ReturnExpr,
  type SelectExpr,
  type SIMDExtractExpr,
  type SIMDLoadExpr,
  type SIMDLoadStoreLaneExpr,
  type SIMDReplaceExpr,
  type SIMDShiftExpr,
  type SIMDShuffleExpr,
  type SIMDTernaryExpr,
  type StoreExpr,
  type StructGetExpr,
  type StructNewExpr,
  type StructSetExpr,
  type SwitchExpr,
  type TableGetExpr,
  type TableSetExpr,
  type ThrowExpr,
  type ThrowRefExpr,
  type TryExpr,
  type TryTableExpr,
  type UnaryExpr,
  UnaryOp,
} from "../ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../ir/module.ts";
import { None, type Type, ValType } from "../ir/types.ts";
import {
  AbstractHeapType,
  type HeapType,
  isRefType,
  type RefType,
  type StorageType,
} from "../ir/gc-types.ts";

// ---------------------------------------------------------------------------
// BinaryWriter — growable byte buffer with WASM encoding helpers
// ---------------------------------------------------------------------------

class BinaryWriter {
  private buf: number[] = [];

  get byteLength(): number {
    return this.buf.length;
  }

  writeU8(n: number): void {
    this.buf.push(n & 0xff);
  }

  writeU32Fixed(n: number): void {
    this.buf.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }

  writeU32(n: number): void {
    n = n >>> 0;
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      this.buf.push(byte);
    } while (n !== 0);
  }

  writeI32(n: number): void {
    n = n | 0;
    let more = true;
    while (more) {
      let byte = n & 0x7f;
      n >>= 7;
      const signBit = (byte & 0x40) !== 0;
      more = !((n === 0 && !signBit) || (n === -1 && signBit));
      if (more) byte |= 0x80;
      this.buf.push(byte);
    }
  }

  writeI64(n: bigint): void {
    let more = true;
    while (more) {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      const signBit = (byte & 0x40) !== 0;
      more = !((n === 0n && !signBit) || (n === -1n && signBit));
      if (more) byte |= 0x80;
      this.buf.push(byte);
    }
  }

  writeF32(n: number): void {
    const arr = new Float32Array([n]);
    const bytes = new Uint8Array(arr.buffer);
    for (const b of bytes) this.buf.push(b);
  }

  writeF64(n: number): void {
    const arr = new Float64Array([n]);
    const bytes = new Uint8Array(arr.buffer);
    for (const b of bytes) this.buf.push(b);
  }

  writeBytes(bytes: Uint8Array): void {
    for (const b of bytes) this.buf.push(b);
  }

  writeUTF8(s: string): void {
    const encoded = new TextEncoder().encode(s);
    this.writeU32(encoded.length);
    this.writeBytes(encoded);
  }

  writeAll(other: BinaryWriter): void {
    for (const b of other.buf) this.buf.push(b);
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

// ---------------------------------------------------------------------------
// Opcode lookup tables (inverse of wasm-parser.ts tables)
// ---------------------------------------------------------------------------

const UNARY_TO_OPCODE: Partial<Record<UnaryOp, number>> = {
  [UnaryOp.EqzI32]: 0x45,
  [UnaryOp.EqzI64]: 0x50,
  [UnaryOp.ClzI32]: 0x67,
  [UnaryOp.CtzI32]: 0x68,
  [UnaryOp.PopcntI32]: 0x69,
  [UnaryOp.ClzI64]: 0x79,
  [UnaryOp.CtzI64]: 0x7a,
  [UnaryOp.PopcntI64]: 0x7b,
  [UnaryOp.AbsF32]: 0x8b,
  [UnaryOp.NegF32]: 0x8c,
  [UnaryOp.CeilF32]: 0x8d,
  [UnaryOp.FloorF32]: 0x8e,
  [UnaryOp.TruncF32]: 0x8f,
  [UnaryOp.NearestF32]: 0x90,
  [UnaryOp.SqrtF32]: 0x91,
  [UnaryOp.AbsF64]: 0x99,
  [UnaryOp.NegF64]: 0x9a,
  [UnaryOp.CeilF64]: 0x9b,
  [UnaryOp.FloorF64]: 0x9c,
  [UnaryOp.TruncF64]: 0x9d,
  [UnaryOp.NearestF64]: 0x9e,
  [UnaryOp.SqrtF64]: 0x9f,
  [UnaryOp.WrapI64]: 0xa7,
  [UnaryOp.TruncSF32ToI32]: 0xa8,
  [UnaryOp.TruncUF32ToI32]: 0xa9,
  [UnaryOp.TruncSF64ToI32]: 0xaa,
  [UnaryOp.TruncUF64ToI32]: 0xab,
  [UnaryOp.ExtendSI32]: 0xac,
  [UnaryOp.ExtendUI32]: 0xad,
  [UnaryOp.TruncSF32ToI64]: 0xae,
  [UnaryOp.TruncUF32ToI64]: 0xaf,
  [UnaryOp.TruncSF64ToI64]: 0xb0,
  [UnaryOp.TruncUF64ToI64]: 0xb1,
  [UnaryOp.ConvertSI32ToF32]: 0xb2,
  [UnaryOp.ConvertUI32ToF32]: 0xb3,
  [UnaryOp.ConvertSI64ToF32]: 0xb4,
  [UnaryOp.ConvertUI64ToF32]: 0xb5,
  [UnaryOp.DemoteF64]: 0xb6,
  [UnaryOp.ConvertSI32ToF64]: 0xb7,
  [UnaryOp.ConvertUI32ToF64]: 0xb8,
  [UnaryOp.ConvertSI64ToF64]: 0xb9,
  [UnaryOp.ConvertUI64ToF64]: 0xba,
  [UnaryOp.PromoteF32]: 0xbb,
  [UnaryOp.ReinterpretF32]: 0xbc,
  [UnaryOp.ReinterpretF64]: 0xbd,
  [UnaryOp.ReinterpretI32]: 0xbe,
  [UnaryOp.ReinterpretI64]: 0xbf,
  [UnaryOp.ExtendS8I32]: 0xc0,
  [UnaryOp.ExtendS16I32]: 0xc1,
  [UnaryOp.ExtendS8I64]: 0xc2,
  [UnaryOp.ExtendS16I64]: 0xc3,
  [UnaryOp.ExtendS32I64]: 0xc4,
};

const BINARY_TO_OPCODE: Partial<Record<BinaryOp, number>> = {
  [BinaryOp.EqI32]: 0x46,
  [BinaryOp.NeI32]: 0x47,
  [BinaryOp.LtSI32]: 0x48,
  [BinaryOp.LtUI32]: 0x49,
  [BinaryOp.GtSI32]: 0x4a,
  [BinaryOp.GtUI32]: 0x4b,
  [BinaryOp.LeSI32]: 0x4c,
  [BinaryOp.LeUI32]: 0x4d,
  [BinaryOp.GeSI32]: 0x4e,
  [BinaryOp.GeUI32]: 0x4f,
  [BinaryOp.EqI64]: 0x51,
  [BinaryOp.NeI64]: 0x52,
  [BinaryOp.LtSI64]: 0x53,
  [BinaryOp.LtUI64]: 0x54,
  [BinaryOp.GtSI64]: 0x55,
  [BinaryOp.GtUI64]: 0x56,
  [BinaryOp.LeSI64]: 0x57,
  [BinaryOp.LeUI64]: 0x58,
  [BinaryOp.GeSI64]: 0x59,
  [BinaryOp.GeUI64]: 0x5a,
  [BinaryOp.EqF32]: 0x5b,
  [BinaryOp.NeF32]: 0x5c,
  [BinaryOp.LtF32]: 0x5d,
  [BinaryOp.GtF32]: 0x5e,
  [BinaryOp.LeF32]: 0x5f,
  [BinaryOp.GeF32]: 0x60,
  [BinaryOp.EqF64]: 0x61,
  [BinaryOp.NeF64]: 0x62,
  [BinaryOp.LtF64]: 0x63,
  [BinaryOp.GtF64]: 0x64,
  [BinaryOp.LeF64]: 0x65,
  [BinaryOp.GeF64]: 0x66,
  [BinaryOp.AddI32]: 0x6a,
  [BinaryOp.SubI32]: 0x6b,
  [BinaryOp.MulI32]: 0x6c,
  [BinaryOp.DivSI32]: 0x6d,
  [BinaryOp.DivUI32]: 0x6e,
  [BinaryOp.RemSI32]: 0x6f,
  [BinaryOp.RemUI32]: 0x70,
  [BinaryOp.AndI32]: 0x71,
  [BinaryOp.OrI32]: 0x72,
  [BinaryOp.XorI32]: 0x73,
  [BinaryOp.ShlI32]: 0x74,
  [BinaryOp.ShrSI32]: 0x75,
  [BinaryOp.ShrUI32]: 0x76,
  [BinaryOp.RotlI32]: 0x77,
  [BinaryOp.RotrI32]: 0x78,
  [BinaryOp.AddI64]: 0x7c,
  [BinaryOp.SubI64]: 0x7d,
  [BinaryOp.MulI64]: 0x7e,
  [BinaryOp.DivSI64]: 0x7f,
  [BinaryOp.DivUI64]: 0x80,
  [BinaryOp.RemSI64]: 0x81,
  [BinaryOp.RemUI64]: 0x82,
  [BinaryOp.AndI64]: 0x83,
  [BinaryOp.OrI64]: 0x84,
  [BinaryOp.XorI64]: 0x85,
  [BinaryOp.ShlI64]: 0x86,
  [BinaryOp.ShrSI64]: 0x87,
  [BinaryOp.ShrUI64]: 0x88,
  [BinaryOp.RotlI64]: 0x89,
  [BinaryOp.RotrI64]: 0x8a,
  [BinaryOp.AddF32]: 0x92,
  [BinaryOp.SubF32]: 0x93,
  [BinaryOp.MulF32]: 0x94,
  [BinaryOp.DivF32]: 0x95,
  [BinaryOp.MinF32]: 0x96,
  [BinaryOp.MaxF32]: 0x97,
  [BinaryOp.CopySignF32]: 0x98,
  [BinaryOp.AddF64]: 0xa0,
  [BinaryOp.SubF64]: 0xa1,
  [BinaryOp.MulF64]: 0xa2,
  [BinaryOp.DivF64]: 0xa3,
  [BinaryOp.MinF64]: 0xa4,
  [BinaryOp.MaxF64]: 0xa5,
  [BinaryOp.CopySignF64]: 0xa6,
};

// SIMD unary ops — 0xFD prefix + U32 sub-opcode
const SIMD_UNARY_SUBOP: Partial<Record<UnaryOp, number>> = {
  [UnaryOp.SplatVecI8x16]: 0x0f,
  [UnaryOp.SplatVecI16x8]: 0x10,
  [UnaryOp.SplatVecI32x4]: 0x11,
  [UnaryOp.SplatVecI64x2]: 0x12,
  [UnaryOp.SplatVecF32x4]: 0x13,
  [UnaryOp.SplatVecF64x2]: 0x14,
  [UnaryOp.NotVec128]: 0x4d,
  [UnaryOp.AnyTrueVec128]: 0x53,
  [UnaryOp.AbsVecI8x16]: 0x60,
  [UnaryOp.NegVecI8x16]: 0x61,
  [UnaryOp.PopcntVecI8x16]: 0x62,
  [UnaryOp.AllTrueVecI8x16]: 0x63,
  [UnaryOp.BitmaskVecI8x16]: 0x64,
  [UnaryOp.CeilVecF32x4]: 0x67,
  [UnaryOp.FloorVecF32x4]: 0x68,
  [UnaryOp.TruncVecF32x4]: 0x69,
  [UnaryOp.NearestVecF32x4]: 0x6a,
  [UnaryOp.CeilVecF64x2]: 0x74,
  [UnaryOp.FloorVecF64x2]: 0x75,
  [UnaryOp.TruncVecF64x2]: 0x7a,
  [UnaryOp.NearestVecF64x2]: 0x94,
  [UnaryOp.ExtaddPairwiseSVecI8x16ToI16x8]: 0x7c,
  [UnaryOp.ExtaddPairwiseUVecI8x16ToI16x8]: 0x7d,
  [UnaryOp.ExtaddPairwiseSVecI16x8ToI32x4]: 0x7e,
  [UnaryOp.ExtaddPairwiseUVecI16x8ToI32x4]: 0x7f,
  [UnaryOp.AbsVecI16x8]: 0x80,
  [UnaryOp.NegVecI16x8]: 0x81,
  [UnaryOp.AllTrueVecI16x8]: 0x83,
  [UnaryOp.BitmaskVecI16x8]: 0x84,
  [UnaryOp.ExtendLowSVecI8x16ToI16x8]: 0x87,
  [UnaryOp.ExtendHighSVecI8x16ToI16x8]: 0x88,
  [UnaryOp.ExtendLowUVecI8x16ToI16x8]: 0x89,
  [UnaryOp.ExtendHighUVecI8x16ToI16x8]: 0x8a,
  [UnaryOp.AbsVecI32x4]: 0xa0,
  [UnaryOp.NegVecI32x4]: 0xa1,
  [UnaryOp.AllTrueVecI32x4]: 0xa3,
  [UnaryOp.BitmaskVecI32x4]: 0xa4,
  [UnaryOp.ExtendLowSVecI16x8ToI32x4]: 0xa7,
  [UnaryOp.ExtendHighSVecI16x8ToI32x4]: 0xa8,
  [UnaryOp.ExtendLowUVecI16x8ToI32x4]: 0xa9,
  [UnaryOp.ExtendHighUVecI16x8ToI32x4]: 0xaa,
  [UnaryOp.AbsVecI64x2]: 0xc0,
  [UnaryOp.NegVecI64x2]: 0xc1,
  [UnaryOp.AllTrueVecI64x2]: 0xc3,
  [UnaryOp.BitmaskVecI64x2]: 0xc4,
  [UnaryOp.ExtendLowSVecI32x4ToI64x2]: 0xc7,
  [UnaryOp.ExtendHighSVecI32x4ToI64x2]: 0xc8,
  [UnaryOp.ExtendLowUVecI32x4ToI64x2]: 0xc9,
  [UnaryOp.ExtendHighUVecI32x4ToI64x2]: 0xca,
  [UnaryOp.DemoteZeroVecF64x2ToF32x4]: 0x5e,
  [UnaryOp.PromoteLowVecF32x4ToF64x2]: 0x5f,
  [UnaryOp.AbsVecF32x4]: 0xe0,
  [UnaryOp.NegVecF32x4]: 0xe1,
  [UnaryOp.SqrtVecF32x4]: 0xe3,
  [UnaryOp.AbsVecF64x2]: 0xec,
  [UnaryOp.NegVecF64x2]: 0xed,
  [UnaryOp.SqrtVecF64x2]: 0xef,
  [UnaryOp.TruncSatSVecF32x4ToI32x4]: 0xf8,
  [UnaryOp.TruncSatUVecF32x4ToI32x4]: 0xf9,
  [UnaryOp.ConvertSVecI32x4ToF32x4]: 0xfa,
  [UnaryOp.ConvertUVecI32x4ToF32x4]: 0xfb,
  [UnaryOp.TruncSatSVecF64x2ToI32x4Zero]: 0xfc,
  [UnaryOp.TruncSatUVecF64x2ToI32x4Zero]: 0xfd,
  [UnaryOp.ConvertLowSVecI32x4ToF64x2]: 0xfe,
  [UnaryOp.ConvertLowUVecI32x4ToF64x2]: 0xff,
};

// SIMD binary ops — 0xFD prefix + U32 sub-opcode
const SIMD_BINARY_SUBOP: Partial<Record<BinaryOp, number>> = {
  [BinaryOp.SwizzleVecI8x16]: 0x0e,
  [BinaryOp.EqVecI8x16]: 0x23,
  [BinaryOp.NeVecI8x16]: 0x24,
  [BinaryOp.LtSVecI8x16]: 0x25,
  [BinaryOp.LtUVecI8x16]: 0x26,
  [BinaryOp.GtSVecI8x16]: 0x27,
  [BinaryOp.GtUVecI8x16]: 0x28,
  [BinaryOp.LeSVecI8x16]: 0x29,
  [BinaryOp.LeUVecI8x16]: 0x2a,
  [BinaryOp.GeSVecI8x16]: 0x2b,
  [BinaryOp.GeUVecI8x16]: 0x2c,
  [BinaryOp.EqVecI16x8]: 0x2d,
  [BinaryOp.NeVecI16x8]: 0x2e,
  [BinaryOp.LtSVecI16x8]: 0x2f,
  [BinaryOp.LtUVecI16x8]: 0x30,
  [BinaryOp.GtSVecI16x8]: 0x31,
  [BinaryOp.GtUVecI16x8]: 0x32,
  [BinaryOp.LeSVecI16x8]: 0x33,
  [BinaryOp.LeUVecI16x8]: 0x34,
  [BinaryOp.GeSVecI16x8]: 0x35,
  [BinaryOp.GeUVecI16x8]: 0x36,
  [BinaryOp.EqVecI32x4]: 0x37,
  [BinaryOp.NeVecI32x4]: 0x38,
  [BinaryOp.LtSVecI32x4]: 0x39,
  [BinaryOp.LtUVecI32x4]: 0x3a,
  [BinaryOp.GtSVecI32x4]: 0x3b,
  [BinaryOp.GtUVecI32x4]: 0x3c,
  [BinaryOp.LeSVecI32x4]: 0x3d,
  [BinaryOp.LeUVecI32x4]: 0x3e,
  [BinaryOp.GeSVecI32x4]: 0x3f,
  [BinaryOp.GeUVecI32x4]: 0x40,
  [BinaryOp.EqVecF32x4]: 0x41,
  [BinaryOp.NeVecF32x4]: 0x42,
  [BinaryOp.LtVecF32x4]: 0x43,
  [BinaryOp.GtVecF32x4]: 0x44,
  [BinaryOp.LeVecF32x4]: 0x45,
  [BinaryOp.GeVecF32x4]: 0x46,
  [BinaryOp.EqVecF64x2]: 0x47,
  [BinaryOp.NeVecF64x2]: 0x48,
  [BinaryOp.LtVecF64x2]: 0x49,
  [BinaryOp.GtVecF64x2]: 0x4a,
  [BinaryOp.LeVecF64x2]: 0x4b,
  [BinaryOp.GeVecF64x2]: 0x4c,
  [BinaryOp.AndVec128]: 0x4e,
  [BinaryOp.AndNotVec128]: 0x4f,
  [BinaryOp.OrVec128]: 0x50,
  [BinaryOp.XorVec128]: 0x51,
  [BinaryOp.NarrowSVecI16x8ToI8x16]: 0x65,
  [BinaryOp.NarrowUVecI16x8ToI8x16]: 0x66,
  [BinaryOp.AddVecI8x16]: 0x6e,
  [BinaryOp.AddSatSVecI8x16]: 0x6f,
  [BinaryOp.AddSatUVecI8x16]: 0x70,
  [BinaryOp.SubVecI8x16]: 0x71,
  [BinaryOp.SubSatSVecI8x16]: 0x72,
  [BinaryOp.SubSatUVecI8x16]: 0x73,
  [BinaryOp.MinSVecI8x16]: 0x76,
  [BinaryOp.MinUVecI8x16]: 0x77,
  [BinaryOp.MaxSVecI8x16]: 0x78,
  [BinaryOp.MaxUVecI8x16]: 0x79,
  [BinaryOp.AvgrUVecI8x16]: 0x7b,
  [BinaryOp.Q15MulrSatSVecI16x8]: 0x82,
  [BinaryOp.NarrowSVecI32x4ToI16x8]: 0x85,
  [BinaryOp.NarrowUVecI32x4ToI16x8]: 0x86,
  [BinaryOp.AddVecI16x8]: 0x8e,
  [BinaryOp.AddSatSVecI16x8]: 0x8f,
  [BinaryOp.AddSatUVecI16x8]: 0x90,
  [BinaryOp.SubVecI16x8]: 0x91,
  [BinaryOp.SubSatSVecI16x8]: 0x92,
  [BinaryOp.SubSatUVecI16x8]: 0x93,
  [BinaryOp.MulVecI16x8]: 0x95,
  [BinaryOp.MinSVecI16x8]: 0x96,
  [BinaryOp.MinUVecI16x8]: 0x97,
  [BinaryOp.MaxSVecI16x8]: 0x98,
  [BinaryOp.MaxUVecI16x8]: 0x99,
  [BinaryOp.AvgrUVecI16x8]: 0x9b,
  [BinaryOp.ExtmulLowSVecI8x16ToI16x8]: 0x9c,
  [BinaryOp.ExtmulHighSVecI8x16ToI16x8]: 0x9d,
  [BinaryOp.ExtmulLowUVecI8x16ToI16x8]: 0x9e,
  [BinaryOp.ExtmulHighUVecI8x16ToI16x8]: 0x9f,
  [BinaryOp.AddVecI32x4]: 0xae,
  [BinaryOp.SubVecI32x4]: 0xb1,
  [BinaryOp.MulVecI32x4]: 0xb5,
  [BinaryOp.MinSVecI32x4]: 0xb6,
  [BinaryOp.MinUVecI32x4]: 0xb7,
  [BinaryOp.MaxSVecI32x4]: 0xb8,
  [BinaryOp.MaxUVecI32x4]: 0xb9,
  [BinaryOp.DotSVecI16x8ToI32x4]: 0xba,
  [BinaryOp.ExtmulLowSVecI16x8ToI32x4]: 0xbc,
  [BinaryOp.ExtmulHighSVecI16x8ToI32x4]: 0xbd,
  [BinaryOp.ExtmulLowUVecI16x8ToI32x4]: 0xbe,
  [BinaryOp.ExtmulHighUVecI16x8ToI32x4]: 0xbf,
  [BinaryOp.AddVecI64x2]: 0xce,
  [BinaryOp.SubVecI64x2]: 0xd1,
  [BinaryOp.MulVecI64x2]: 0xd5,
  [BinaryOp.EqVecI64x2]: 0xd6,
  [BinaryOp.NeVecI64x2]: 0xd7,
  [BinaryOp.LtSVecI64x2]: 0xd8,
  [BinaryOp.GtSVecI64x2]: 0xd9,
  [BinaryOp.LeSVecI64x2]: 0xda,
  [BinaryOp.GeSVecI64x2]: 0xdb,
  [BinaryOp.ExtmulLowSVecI32x4ToI64x2]: 0xdc,
  [BinaryOp.ExtmulHighSVecI32x4ToI64x2]: 0xdd,
  [BinaryOp.ExtmulLowUVecI32x4ToI64x2]: 0xde,
  [BinaryOp.ExtmulHighUVecI32x4ToI64x2]: 0xdf,
  [BinaryOp.AddVecF32x4]: 0xe4,
  [BinaryOp.SubVecF32x4]: 0xe5,
  [BinaryOp.MulVecF32x4]: 0xe6,
  [BinaryOp.DivVecF32x4]: 0xe7,
  [BinaryOp.MinVecF32x4]: 0xe8,
  [BinaryOp.MaxVecF32x4]: 0xe9,
  [BinaryOp.PminVecF32x4]: 0xea,
  [BinaryOp.PmaxVecF32x4]: 0xeb,
  [BinaryOp.AddVecF64x2]: 0xf0,
  [BinaryOp.SubVecF64x2]: 0xf1,
  [BinaryOp.MulVecF64x2]: 0xf2,
  [BinaryOp.DivVecF64x2]: 0xf3,
  [BinaryOp.MinVecF64x2]: 0xf4,
  [BinaryOp.MaxVecF64x2]: 0xf5,
  [BinaryOp.PminVecF64x2]: 0xf6,
  [BinaryOp.PmaxVecF64x2]: 0xf7,
};

// SIMD shift op to sub-opcode
const SIMD_SHIFT_SUBOP: Record<string, number> = {
  "i8x16.shl": 0x6b,
  "i8x16.shr_s": 0x6c,
  "i8x16.shr_u": 0x6d,
  "i16x8.shl": 0x8b,
  "i16x8.shr_s": 0x8c,
  "i16x8.shr_u": 0x8d,
  "i32x4.shl": 0xab,
  "i32x4.shr_s": 0xac,
  "i32x4.shr_u": 0xad,
  "i64x2.shl": 0xcb,
  "i64x2.shr_s": 0xcc,
  "i64x2.shr_u": 0xcd,
};

// SIMD extract op to (sub-opcode) — lane immediate follows
const SIMD_EXTRACT_SUBOP: Record<string, number> = {
  "i8x16.extract_lane_s": 0x15,
  "i8x16.extract_lane_u": 0x16,
  "i16x8.extract_lane_s": 0x18,
  "i16x8.extract_lane_u": 0x19,
  "i32x4.extract_lane": 0x1b,
  "i64x2.extract_lane": 0x1d,
  "f32x4.extract_lane": 0x1f,
  "f64x2.extract_lane": 0x21,
};

// SIMD replace op to sub-opcode
const SIMD_REPLACE_SUBOP: Record<string, number> = {
  "i8x16.replace_lane": 0x17,
  "i16x8.replace_lane": 0x1a,
  "i32x4.replace_lane": 0x1c,
  "i64x2.replace_lane": 0x1e,
  "f32x4.replace_lane": 0x20,
  "f64x2.replace_lane": 0x22,
};

// SIMD load op to sub-opcode
const SIMD_LOAD_SUBOP: Record<string, number> = {
  "v128.load8x8_s": 0x01,
  "v128.load8x8_u": 0x02,
  "v128.load16x4_s": 0x03,
  "v128.load16x4_u": 0x04,
  "v128.load32x2_s": 0x05,
  "v128.load32x2_u": 0x06,
  "v128.load8_splat": 0x07,
  "v128.load16_splat": 0x08,
  "v128.load32_splat": 0x09,
  "v128.load64_splat": 0x0a,
  "v128.load32_zero": 0x5c,
  "v128.load64_zero": 0x5d,
};

// SIMD load/store lane op to sub-opcode
const SIMD_LANE_SUBOP: Record<string, number> = {
  "v128.load8_lane": 0x54,
  "v128.load16_lane": 0x55,
  "v128.load32_lane": 0x56,
  "v128.load64_lane": 0x57,
  "v128.store8_lane": 0x58,
  "v128.store16_lane": 0x59,
  "v128.store32_lane": 0x5a,
  "v128.store64_lane": 0x5b,
};

// ---------------------------------------------------------------------------
// ValType / blocktype encoding
// ---------------------------------------------------------------------------

function valTypeByte(t: ValType): number {
  switch (t) {
    case ValType.I32:
      return 0x7f;
    case ValType.I64:
      return 0x7e;
    case ValType.F32:
      return 0x7d;
    case ValType.F64:
      return 0x7c;
    case ValType.V128:
      return 0x7b;
    case ValType.FuncRef:
      return 0x70;
    case ValType.ExternRef:
      return 0x6f;
    case ValType.AnyRef:
      return 0x6e;
    case ValType.EqRef:
      return 0x6d;
    case ValType.I31Ref:
      return 0x6c;
    case ValType.StructRef:
      return 0x6b;
    case ValType.ArrayRef:
      return 0x6a;
    case ValType.NullRef:
      return 0x71;
    case ValType.NullFuncRef:
      return 0x73;
    case ValType.NullExternRef:
      return 0x72;
    case ValType.ExnRef:
      return 0x69;
    case ValType.NullExnRef:
      return 0x74;
    default:
      return 0x7f;
  }
}

function writeValType(w: BinaryWriter, t: ValType): void {
  w.writeU8(valTypeByte(t));
}

function writeBlockType(w: BinaryWriter, t: Type): void {
  if (t === None || (Array.isArray(t) && t.length === 0)) {
    w.writeU8(0x40);
  } else if (Array.isArray(t)) {
    if (t.length > 1) {
      // Multi-value (tuple) block results must encode as a SLEB128 type-section
      // index, not an inline valtype. Emitting only `t[0]` produced a
      // structurally invalid block header (the engine reads one result then
      // misparses the body). Full multi-value blocktype support is deferred —
      // the binary parser also discards multi-value blocktypes on read — so
      // fail loudly rather than emit a corrupt module.
      throw new WasmEncodeError(
        `multi-value block results are not supported by the encoder: [${t.join(", ")}]`,
      );
    }
    writeValueType(w, t[0] as ValType | RefType);
  } else if (t !== "unreachable") {
    writeValueType(w, t as ValType | RefType);
  } else {
    w.writeU8(0x40);
  }
}

function refHeapTypeByte(t: ValType): number {
  switch (t) {
    case ValType.FuncRef:
      return 0x70;
    case ValType.ExternRef:
      return 0x6f;
    case ValType.AnyRef:
      return 0x6e;
    case ValType.EqRef:
      return 0x6d;
    case ValType.I31Ref:
      return 0x6c;
    case ValType.StructRef:
      return 0x6b;
    case ValType.ArrayRef:
      return 0x6a;
    case ValType.NullRef:
      return 0x71;
    case ValType.NullFuncRef:
      return 0x73;
    case ValType.NullExternRef:
      return 0x72;
    case ValType.ExnRef:
      return 0x69;
    case ValType.NullExnRef:
      return 0x74;
    default:
      // Reached only for a non-ref ValType, which is a bug in the IR producing
      // this RefNull. Previously this silently returned `any` (0x6e),
      // mis-typing the null; fail loudly instead.
      throw new WasmEncodeError(`ref.null of non-reference type: ${t}`);
  }
}

// ---------------------------------------------------------------------------
// GC heap type / ref type encoding
// ---------------------------------------------------------------------------

const ABSTRACT_HEAP_TYPE_BYTE: Record<AbstractHeapType, number> = {
  [AbstractHeapType.Func]: 0x70,
  [AbstractHeapType.NoFunc]: 0x73,
  [AbstractHeapType.Ext]: 0x6f,
  [AbstractHeapType.NoExt]: 0x72,
  [AbstractHeapType.Any]: 0x6e,
  [AbstractHeapType.Eq]: 0x6d,
  [AbstractHeapType.I31]: 0x6c,
  [AbstractHeapType.Struct]: 0x6b,
  [AbstractHeapType.Array]: 0x6a,
  [AbstractHeapType.None]: 0x71,
  [AbstractHeapType.Exn]: 0x69,
  [AbstractHeapType.NoExn]: 0x74,
};

function writeHeapType(w: BinaryWriter, h: HeapType): void {
  if (typeof h === "number") {
    w.writeU32(h);
  } else {
    w.writeU8(ABSTRACT_HEAP_TYPE_BYTE[h] ?? 0x6e);
  }
}

function writeValueType(w: BinaryWriter, t: ValType | RefType): void {
  if (isRefType(t)) {
    w.writeU8(t.nullable ? 0x63 : 0x64);
    writeHeapType(w, t.heap);
  } else {
    writeValType(w, t);
  }
}

// ---------------------------------------------------------------------------
// Load / store opcode resolution
// ---------------------------------------------------------------------------

function loadOpcode(expr: LoadExpr): number {
  const t = expr.type as ValType;
  if (t === ValType.F32) return 0x2a;
  if (t === ValType.F64) return 0x2b;
  if (t === ValType.I32) {
    if (expr.bytes === 1) return expr.signed ? 0x2c : 0x2d;
    if (expr.bytes === 2) return expr.signed ? 0x2e : 0x2f;
    return 0x28;
  }
  if (t === ValType.I64) {
    if (expr.bytes === 1) return expr.signed ? 0x30 : 0x31;
    if (expr.bytes === 2) return expr.signed ? 0x32 : 0x33;
    if (expr.bytes === 4) return expr.signed ? 0x34 : 0x35;
    return 0x29;
  }
  // The previous code treated ANY non-f32/f64/i32 type as i64 — so a load whose
  // result type was unexpectedly `unreachable` (or anything else) silently
  // emitted an i64 opcode of the wrong width. A load result must be a numeric
  // scalar; fail loudly otherwise.
  throw new WasmEncodeError(`cannot encode load with result type: ${t}`);
}

function storeOpcode(expr: StoreExpr): number {
  const vt = expr.value.type as ValType;
  if (vt === ValType.F32) return 0x38;
  if (vt === ValType.F64) return 0x39;
  if (vt === ValType.I32) {
    if (expr.bytes === 1) return 0x3a;
    if (expr.bytes === 2) return 0x3b;
    return 0x36;
  }
  if (vt === ValType.I64) {
    if (expr.bytes === 1) return 0x3d;
    if (expr.bytes === 2) return 0x3e;
    if (expr.bytes === 4) return 0x3c;
    return 0x37;
  }
  throw new WasmEncodeError(`cannot encode store with value type: ${vt}`);
}

// ---------------------------------------------------------------------------
// FuncType key for deduplication
// ---------------------------------------------------------------------------

function funcTypeKey(params: ValType[], results: ValType[]): string {
  return params.join(",") + "->" + results.join(",");
}

// ---------------------------------------------------------------------------
// WasmEncoder
// ---------------------------------------------------------------------------

interface FuncTypeEntry {
  params: ValType[];
  results: ValType[];
}

class WasmEncoder {
  private readonly mod: WasmModule;

  private funcIndex = new Map<string, number>();
  private globalIndex = new Map<string, number>();
  private tableIndex = new Map<string, number>();
  private tagIndex = new Map<string, number>();

  private types: FuncTypeEntry[] = [];
  private typeKeyToIndex = new Map<string, number>();

  constructor(mod: WasmModule) {
    this.mod = mod;
  }

  /**
   * Resolves an entity name to its encoded index, throwing on a miss.
   *
   * A `map.get(name) ?? 0` fallback silently encodes index `0` when a reference
   * cannot be resolved — exactly the failure mode that once made every
   * imported-function call encode as `call 0` (a valid-but-wrong binary that
   * still passes `WebAssembly.compile`). A dangling reference (a pass dropped
   * the target but left the reference, a stripped tag is still exported, a
   * global/table name never made it into the index map) is an IR bug; emitting
   * index 0 hides it behind a miscompile. Fail loudly with the offending name
   * instead.
   */
  private resolveRef(map: Map<string, number>, name: string, kind: string): number {
    const idx = map.get(name);
    if (idx === undefined) {
      throw new WasmEncodeError(`unresolved ${kind} reference: "${name}"`);
    }
    return idx;
  }

  encode(): Uint8Array {
    this.checkSingleMemory();
    this.buildIndices();
    this.collectTypes();

    const out = new BinaryWriter();
    out.writeU32Fixed(0x6d736100); // magic: \0asm
    out.writeU32Fixed(0x00000001); // version: 1

    this.writeSection(out, 1, (w) => this.encodeTypeSection(w));
    if (this.hasImports()) this.writeSection(out, 2, (w) => this.encodeImportSection(w));
    if (this.mod.functions.length > 0) {
      this.writeSection(out, 3, (w) => this.encodeFunctionSection(w));
    }
    if (this.hasTables()) this.writeSection(out, 4, (w) => this.encodeTableSection(w));
    if (this.hasMemories()) this.writeSection(out, 5, (w) => this.encodeMemorySection(w));
    if (this.mod.tags.length > 0) this.writeSection(out, 13, (w) => this.encodeTagSection(w));
    if (this.mod.globals.length > 0) this.writeSection(out, 6, (w) => this.encodeGlobalSection(w));
    if (this.mod.exports.length > 0) this.writeSection(out, 7, (w) => this.encodeExportSection(w));
    if (this.mod.elements.length > 0) {
      this.writeSection(out, 9, (w) => this.encodeElementSection(w));
    }
    if (this.mod.functions.length > 0) this.writeSection(out, 10, (w) => this.encodeCodeSection(w));
    if (this.mod.dataSegments.length > 0) {
      this.writeSection(out, 11, (w) => this.encodeDataSection(w));
    }

    return out.toUint8Array();
  }

  // ---------------------------------------------------------------------------
  // Index building
  // ---------------------------------------------------------------------------

  private buildIndices(): void {
    let fi = 0;
    for (const imp of this.mod.imports) {
      if (imp.kind === "function") this.funcIndex.set(imp.name, fi++);
    }
    for (const fn of this.mod.functions) {
      this.funcIndex.set(fn.name, fi++);
    }

    let gi = 0;
    for (const imp of this.mod.imports) {
      if (imp.kind === "global") this.globalIndex.set(imp.name, gi++);
    }
    for (const g of this.mod.globals) {
      this.globalIndex.set(g.name, gi++);
    }

    let ti = 0;
    for (const imp of this.mod.imports) {
      if (imp.kind === "table") this.tableIndex.set(imp.name, ti++);
    }
    for (const t of this.mod.tables) {
      this.tableIndex.set(t.name, ti++);
    }

    let tagi = 0;
    for (const tag of this.mod.tags) {
      this.tagIndex.set(tag.name, tagi++);
    }
  }

  // ---------------------------------------------------------------------------
  // Type collection
  // ---------------------------------------------------------------------------

  private collectTypes(): void {
    const addType = (params: ValType[], results: ValType[]): void => {
      const key = funcTypeKey(params, results);
      if (!this.typeKeyToIndex.has(key)) {
        this.typeKeyToIndex.set(key, this.types.length);
        this.types.push({ params, results });
      }
    };

    for (const imp of this.mod.imports) {
      if (imp.kind === "function") addType(imp.params ?? [], imp.results ?? []);
    }
    for (const fn of this.mod.functions) {
      addType(fn.params, fn.results);
    }
    // Tags use function-type signatures (params only, no results)
    for (const tag of this.mod.tags) {
      addType(tag.params, []);
    }
    // Scan for call_indirect type references
    for (const fn of this.mod.functions) {
      this.collectCallIndirectTypes(fn.body, addType);
    }
  }

  private collectCallIndirectTypes(
    expr: Expression,
    addType: (params: ValType[], results: ValType[]) => void,
  ): void {
    if (expr.kind === ExpressionKind.CallIndirect) {
      const e = expr as CallIndirectExpr;
      addType(e.params, e.results);
    }
    walkChildren(expr, (child) => this.collectCallIndirectTypes(child, addType));
  }

  private getTypeIndex(params: ValType[], results: ValType[]): number {
    const idx = this.typeKeyToIndex.get(funcTypeKey(params, results));
    if (idx === undefined) {
      // `collectTypes` registers exactly the signatures every call site here
      // asks for (imported + defined functions, tags, and call_indirect). A
      // miss therefore means the collection and the encode walked different
      // sets — a bug that, with the old `?? 0`, silently emitted type index 0
      // and produced a function-signature mismatch in the output. Fail loudly,
      // matching `resolveRef` for entity references.
      throw new WasmEncodeError(
        `unresolved function type: (${params.join(", ")}) -> (${results.join(", ")})`,
      );
    }
    return idx;
  }

  // ---------------------------------------------------------------------------
  // Section helpers
  // ---------------------------------------------------------------------------

  private writeSection(out: BinaryWriter, id: number, encode: (w: BinaryWriter) => void): void {
    const body = new BinaryWriter();
    encode(body);
    if (body.byteLength === 0) return;
    out.writeU8(id);
    out.writeU32(body.byteLength);
    out.writeAll(body);
  }

  private hasImports(): boolean {
    return this.mod.imports.length > 0;
  }

  private hasTables(): boolean {
    return this.mod.tables.length > 0 || this.mod.imports.some((i) => i.kind === "table");
  }

  private hasMemories(): boolean {
    return this.mod.memories.length > 0 || this.mod.imports.some((i) => i.kind === "memory");
  }

  /**
   * Guards against the multi-memory proposal. The encoder hardcodes memory
   * index 0 for memory exports, data segments, and `memory.*` instructions, and
   * the parser names every memory `mem0` (so an imported + a defined memory
   * collide). Rather than silently emit everything against memory 0, fail
   * loudly when more than one memory is present.
   */
  private checkSingleMemory(): void {
    const importedMemories = this.mod.imports.filter((i) => i.kind === "memory").length;
    if (importedMemories + this.mod.memories.length > 1) {
      throw new WasmEncodeError(
        "multiple memories are not supported: memory exports, data segments, and " +
          "memory.* instructions are encoded against memory index 0",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Section encoders
  // ---------------------------------------------------------------------------

  private encodeTypeSection(w: BinaryWriter): void {
    if (this.mod.heapTypes.length > 0) {
      w.writeU32(this.mod.heapTypes.length);
      for (const def of this.mod.heapTypes) {
        if (def.kind === "func") {
          w.writeU8(0x60);
          w.writeU32(def.params.length);
          for (const p of def.params) writeValueType(w, p);
          w.writeU32(def.results.length);
          for (const r of def.results) writeValueType(w, r);
        } else if (def.kind === "struct") {
          w.writeU8(0x5f);
          w.writeU32(def.fields.length);
          for (const f of def.fields) {
            this.writeStorageType(w, f.type);
            w.writeU8(f.mutable ? 1 : 0);
          }
        } else {
          w.writeU8(0x5e);
          this.writeStorageType(w, def.element.type);
          w.writeU8(def.element.mutable ? 1 : 0);
        }
      }
    } else {
      w.writeU32(this.types.length);
      for (const { params, results } of this.types) {
        w.writeU8(0x60);
        w.writeU32(params.length);
        for (const p of params) writeValType(w, p);
        w.writeU32(results.length);
        for (const r of results) writeValType(w, r);
      }
    }
  }

  private writeStorageType(w: BinaryWriter, t: StorageType): void {
    if (t === "i8") {
      w.writeU8(0x78);
      return;
    }
    if (t === "i16") {
      w.writeU8(0x77);
      return;
    }
    writeValueType(w, t as ValType | RefType);
  }

  private gcFuncTypeIndex(params: ValType[], results: ValType[]): number {
    // NOTE: every `RefType` is collapsed to `AnyRef` before comparison, because
    // the binary parser's legacy shim stores ref-typed function params/results
    // as `AnyRef` (it does not yet thread concrete heap types into the function
    // signature). A consequence is that two func heap types differing ONLY in
    // their concrete heap types (e.g. `(param (ref $A))` vs `(param (ref $B))`)
    // are indistinguishable here. The old code silently returned the FIRST such
    // match — a wrong-type-index miscompile. We now collect ALL matches and:
    //   - exactly one  → return it (unambiguous),
    //   - zero         → throw (unresolved),
    //   - more than one → throw (ambiguous under the ref-collapse shim; the IR
    //                     cannot tell them apart, so a correct index can't be
    //                     chosen — proper support needs concrete param heap
    //                     types in the function-signature model).
    const matches: number[] = [];
    for (let i = 0; i < this.mod.heapTypes.length; i++) {
      const d = this.mod.heapTypes[i];
      if (d.kind !== "func") continue;
      if (d.params.length !== params.length || d.results.length !== results.length) continue;
      let match = true;
      for (let j = 0; j < d.params.length; j++) {
        const dpKey = isRefType(d.params[j]) ? ValType.AnyRef : (d.params[j] as string);
        if (dpKey !== params[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      for (let j = 0; j < d.results.length; j++) {
        const drKey = isRefType(d.results[j]) ? ValType.AnyRef : (d.results[j] as string);
        if (drKey !== results[j]) {
          match = false;
          break;
        }
      }
      if (match) matches.push(i);
    }
    const sig = `(${params.join(", ")}) -> (${results.join(", ")})`;
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new WasmEncodeError(`unresolved GC function type: ${sig}`);
    }
    throw new WasmEncodeError(
      `ambiguous GC function type ${sig}: ${matches.length} heap types match under the ` +
        `ref-type collapse shim, so a correct type index cannot be chosen`,
    );
  }

  private encodeImportSection(w: BinaryWriter): void {
    w.writeU32(this.mod.imports.length);
    for (const imp of this.mod.imports) {
      w.writeUTF8(imp.module);
      w.writeUTF8(imp.base);
      switch (imp.kind) {
        case "function": {
          w.writeU8(0x00);
          const idx = this.mod.heapTypes.length > 0
            ? this.gcFuncTypeIndex(imp.params ?? [], imp.results ?? [])
            : this.getTypeIndex(imp.params ?? [], imp.results ?? []);
          w.writeU32(idx);
          break;
        }
        case "table": {
          w.writeU8(0x01);
          writeValType(w, imp.type ?? ValType.FuncRef);
          const hasMax = imp.max !== null && imp.max !== undefined;
          w.writeU8(hasMax ? 1 : 0);
          w.writeU32(imp.initial ?? 0);
          if (hasMax) w.writeU32(imp.max as number);
          break;
        }
        case "memory": {
          w.writeU8(0x02);
          const flags = (imp.max !== null && imp.max !== undefined ? 0x01 : 0) |
            (imp.shared ? 0x02 : 0) |
            (imp.is64 ? 0x04 : 0);
          w.writeU8(flags);
          w.writeU32(imp.initial ?? 0);
          if (imp.max !== null && imp.max !== undefined) w.writeU32(imp.max as number);
          break;
        }
        case "global": {
          w.writeU8(0x03);
          writeValType(w, imp.type ?? ValType.I32);
          w.writeU8(imp.mutable ? 1 : 0);
          break;
        }
      }
    }
  }

  private encodeFunctionSection(w: BinaryWriter): void {
    w.writeU32(this.mod.functions.length);
    for (const fn of this.mod.functions) {
      const idx = this.mod.heapTypes.length > 0
        ? this.gcFuncTypeIndex(fn.params, fn.results)
        : this.getTypeIndex(fn.params, fn.results);
      w.writeU32(idx);
    }
  }

  private encodeTableSection(w: BinaryWriter): void {
    const localTables = this.mod.tables;
    w.writeU32(localTables.length);
    for (const t of localTables) {
      writeValType(w, t.type);
      const hasMax = t.max !== null;
      w.writeU8(hasMax ? 1 : 0);
      w.writeU32(t.initial);
      if (hasMax) w.writeU32(t.max as number);
    }
  }

  private encodeMemorySection(w: BinaryWriter): void {
    const localMems = this.mod.memories;
    w.writeU32(localMems.length);
    for (const m of localMems) {
      const hasMax = m.max !== null;
      const flags = (hasMax ? 0x01 : 0) | (m.shared ? 0x02 : 0) | (m.is64 ? 0x04 : 0);
      w.writeU8(flags);
      w.writeU32(m.initial);
      if (hasMax) w.writeU32(m.max as number);
    }
  }

  private encodeGlobalSection(w: BinaryWriter): void {
    w.writeU32(this.mod.globals.length);
    for (const g of this.mod.globals) {
      writeValType(w, g.type);
      w.writeU8(g.mutable ? 1 : 0);
      this.encodeInitExpr(w, g.init);
    }
  }

  private encodeExportSection(w: BinaryWriter): void {
    w.writeU32(this.mod.exports.length);
    for (const exp of this.mod.exports) {
      w.writeUTF8(exp.name);
      switch (exp.kind) {
        case "function": {
          w.writeU8(0x00);
          w.writeU32(this.resolveRef(this.funcIndex, exp.value, "exported function"));
          break;
        }
        case "table": {
          w.writeU8(0x01);
          w.writeU32(this.resolveRef(this.tableIndex, exp.value, "exported table"));
          break;
        }
        case "memory": {
          w.writeU8(0x02);
          w.writeU32(0); // memory index 0
          break;
        }
        case "global": {
          w.writeU8(0x03);
          w.writeU32(this.resolveRef(this.globalIndex, exp.value, "exported global"));
          break;
        }
        case "tag": {
          // EH proposal: export kind 0x04 = tag, payload is tag index.
          // Without this case the switch fell through, writing the export
          // name then NO kind/index bytes — corrupting every subsequent
          // export. (The matching `case 0x04` was also missing in the
          // parser, so tag exports never survived a round-trip.)
          w.writeU8(0x04);
          w.writeU32(this.resolveRef(this.tagIndex, exp.value, "exported tag"));
          break;
        }
      }
    }
  }

  private encodeElementSection(w: BinaryWriter): void {
    w.writeU32(this.mod.elements.length);
    for (const seg of this.mod.elements) {
      w.writeU32(0); // kind 0: active, implicit table 0, funcref
      if (seg.offset) this.encodeInitExpr(w, seg.offset);
      else {
        w.writeU8(0x41);
        w.writeI32(0);
        w.writeU8(0x0b);
      }
      w.writeU32(seg.data.length);
      for (const fname of seg.data) {
        w.writeU32(this.resolveRef(this.funcIndex, fname, "element-segment function"));
      }
    }
  }

  private encodeCodeSection(w: BinaryWriter): void {
    w.writeU32(this.mod.functions.length);
    for (const fn of this.mod.functions) {
      const body = new BinaryWriter();
      this.encodeFunctionBody(body, fn);
      w.writeU32(body.byteLength);
      w.writeAll(body);
    }
  }

  private encodeTagSection(w: BinaryWriter): void {
    w.writeU32(this.mod.tags.length);
    for (const tag of this.mod.tags) {
      w.writeU8(0); // reserved attribute byte
      // When `mod.heapTypes` is non-empty the emitted type section iterates
      // `mod.heapTypes` directly (see `encodeTypeSection`), so an index into
      // it is the only correct reference. `getTypeIndex` looks up against
      // the deduped `this.types` collection, whose ordering does NOT match
      // `mod.heapTypes` when the input had extra (unused) type entries —
      // pointing the tag at the wrong type slot. Imports and the function
      // section already switch via this same condition; the tag section was
      // the one site that didn't. (Surfaced by the wasmtk team's bug report
      // as "tag's type-index re-pointed to a different entry in the type
      // section after `RemoveUnusedModuleElements`".)
      const idx = this.mod.heapTypes.length > 0
        ? this.gcFuncTypeIndex(tag.params, [])
        : this.getTypeIndex(tag.params, []);
      w.writeU32(idx);
    }
  }

  private encodeDataSection(w: BinaryWriter): void {
    w.writeU32(this.mod.dataSegments.length);
    for (const seg of this.mod.dataSegments) {
      if (seg.passive) {
        w.writeU32(1); // passive
        w.writeU32(seg.data.length);
        w.writeBytes(seg.data);
      } else {
        w.writeU32(0); // active, memory 0
        this.encodeInitExpr(w, seg.offset!);
        w.writeU32(seg.data.length);
        w.writeBytes(seg.data);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Init expression (constant-only)
  // ---------------------------------------------------------------------------

  private encodeInitExpr(w: BinaryWriter, expr: Expression): void {
    this.encodeExpr(w, expr, []);
    w.writeU8(0x0b); // end
  }

  // ---------------------------------------------------------------------------
  // Function body
  // ---------------------------------------------------------------------------

  private encodeFunctionBody(w: BinaryWriter, fn: WasmFunction): void {
    // Locals: non-param locals only, run-length encoded
    const nonParamLocals = fn.locals.slice(fn.params.length);
    const groups: { count: number; type: ValType }[] = [];
    for (const loc of nonParamLocals) {
      if (groups.length > 0 && groups[groups.length - 1].type === loc.type) {
        groups[groups.length - 1].count++;
      } else {
        groups.push({ count: 1, type: loc.type });
      }
    }
    w.writeU32(groups.length);
    for (const g of groups) {
      w.writeU32(g.count);
      writeValType(w, g.type);
    }

    // Body: unpack a null-named block (the implicit function frame)
    const labels: string[] = [];
    const body = fn.body;
    if (body.kind === ExpressionKind.Block && (body as BlockExpr).name === null) {
      for (const child of (body as BlockExpr).children) {
        this.encodeExpr(w, child, labels);
      }
    } else {
      this.encodeExpr(w, body, labels);
    }
    w.writeU8(0x0b); // end
  }

  /**
   * Emits a `try`/`catch` handler body. The catch opcode pushes the tag's
   * parameter values onto the operand stack of the *catch region*, where the
   * handler's instructions consume them directly. The binary parser packs a
   * multi-instruction handler into an anonymous (`name === null`) `Block`
   * container — exactly like the function-body frame — so it must be UNPACKED
   * here: emitting it via the normal `encodeExpr` path would wrap it in a
   * `block ... end` whose (void) blocktype does not inherit the catch-pushed
   * values, leaving the handler's `local.set` / `store` running on an empty
   * stack ("not enough arguments on the stack"). A named block, or a
   * single-expression handler, is emitted as-is.
   */
  private encodeCatchBody(w: BinaryWriter, body: Expression, labels: string[]): void {
    if (body.kind === ExpressionKind.Block && (body as BlockExpr).name === null) {
      for (const child of (body as BlockExpr).children) {
        this.encodeExpr(w, child, labels);
      }
    } else {
      this.encodeExpr(w, body, labels);
    }
  }

  // ---------------------------------------------------------------------------
  // Expression encoder (recursive, stack-machine order)
  // ---------------------------------------------------------------------------

  private resolveLabel(labels: string[], name: string): number {
    for (let i = labels.length - 1; i >= 0; i--) {
      if (labels[i] === name) return labels.length - 1 - i;
    }
    return 0;
  }

  private encodeExpr(w: BinaryWriter, expr: Expression, labels: string[]): void {
    switch (expr.kind) {
      case ExpressionKind.Nop: {
        w.writeU8(0x01);
        break;
      }
      case ExpressionKind.Unreachable: {
        w.writeU8(0x00);
        break;
      }

      case ExpressionKind.Block: {
        const e = expr as BlockExpr;
        w.writeU8(0x02);
        writeBlockType(w, e.type);
        labels.push(e.name ?? "");
        for (const child of e.children) this.encodeExpr(w, child, labels);
        labels.pop();
        w.writeU8(0x0b);
        break;
      }

      case ExpressionKind.Loop: {
        const e = expr as LoopExpr;
        w.writeU8(0x03);
        writeBlockType(w, e.type);
        labels.push(e.name);
        this.encodeExpr(w, e.body, labels);
        labels.pop();
        w.writeU8(0x0b);
        break;
      }

      case ExpressionKind.If: {
        const e = expr as IfExpr;
        this.encodeExpr(w, e.condition, labels);
        w.writeU8(0x04);
        writeBlockType(w, e.type);
        labels.push(""); // if block has no label in IR
        this.encodeExpr(w, e.ifTrue, labels);
        if (e.ifFalse) {
          w.writeU8(0x05); // else
          this.encodeExpr(w, e.ifFalse, labels);
        }
        labels.pop();
        w.writeU8(0x0b);
        break;
      }

      case ExpressionKind.Break: {
        const e = expr as BreakExpr;
        if (e.value) this.encodeExpr(w, e.value, labels);
        if (e.condition) {
          this.encodeExpr(w, e.condition, labels);
          w.writeU8(0x0d); // br_if
        } else {
          w.writeU8(0x0c); // br
        }
        w.writeU32(this.resolveLabel(labels, e.name));
        break;
      }

      case ExpressionKind.Switch: {
        const e = expr as SwitchExpr;
        if (e.value) this.encodeExpr(w, e.value, labels);
        this.encodeExpr(w, e.condition, labels);
        w.writeU8(0x0e); // br_table
        w.writeU32(e.targets.length);
        for (const t of e.targets) w.writeU32(this.resolveLabel(labels, t));
        w.writeU32(this.resolveLabel(labels, e.defaultTarget));
        break;
      }

      case ExpressionKind.Return: {
        const e = expr as ReturnExpr;
        if (e.value) this.encodeExpr(w, e.value, labels);
        w.writeU8(0x0f);
        break;
      }

      case ExpressionKind.Const: {
        const e = expr as ConstExpr;
        const v = e.value;
        if ("i32" in v) {
          w.writeU8(0x41);
          w.writeI32(v.i32);
        } else if ("i64" in v) {
          w.writeU8(0x42);
          w.writeI64(v.i64);
        } else if ("f32" in v) {
          w.writeU8(0x43);
          w.writeF32(v.f32);
        } else if ("v128" in v) {
          w.writeU8(0xfd);
          w.writeU32(0x0c);
          w.writeBytes((v as { v128: Uint8Array }).v128);
        } else {
          w.writeU8(0x44);
          w.writeF64((v as { f64: number }).f64);
        }
        break;
      }

      case ExpressionKind.LocalGet: {
        const e = expr as LocalGetExpr;
        w.writeU8(0x20);
        w.writeU32(e.index);
        break;
      }
      case ExpressionKind.LocalSet: {
        const e = expr as LocalSetExpr;
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0x21);
        w.writeU32(e.index);
        break;
      }
      case ExpressionKind.LocalTee: {
        const e = expr as LocalTeeExpr;
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0x22);
        w.writeU32(e.index);
        break;
      }

      case ExpressionKind.GlobalGet: {
        const e = expr as GlobalGetExpr;
        w.writeU8(0x23);
        w.writeU32(this.resolveRef(this.globalIndex, e.name, "global.get"));
        break;
      }
      case ExpressionKind.GlobalSet: {
        const e = expr as GlobalSetExpr;
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0x24);
        w.writeU32(this.resolveRef(this.globalIndex, e.name, "global.set"));
        break;
      }

      case ExpressionKind.TableGet: {
        const e = expr as TableGetExpr;
        this.encodeExpr(w, e.index, labels);
        w.writeU8(0x25);
        w.writeU32(this.resolveRef(this.tableIndex, e.table, "table.get"));
        break;
      }
      case ExpressionKind.TableSet: {
        const e = expr as TableSetExpr;
        this.encodeExpr(w, e.index, labels);
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0x26);
        w.writeU32(this.resolveRef(this.tableIndex, e.table, "table.set"));
        break;
      }

      case ExpressionKind.Unary: {
        const e = expr as UnaryExpr;
        this.encodeExpr(w, e.value, labels);
        const simdSub = SIMD_UNARY_SUBOP[e.op];
        if (simdSub !== undefined) {
          w.writeU8(0xfd);
          w.writeU32(simdSub);
        } else {
          const opcode = UNARY_TO_OPCODE[e.op];
          if (opcode === undefined) {
            // The operand was already emitted (pushing a value); a bare `nop`
            // fallback would leave it dangling on the stack → invalid module.
            // Fail loudly on an unmapped op instead.
            throw new WasmEncodeError(`unknown unary opcode: ${e.op}`);
          }
          w.writeU8(opcode);
        }
        break;
      }

      case ExpressionKind.Binary: {
        const e = expr as BinaryExpr;
        this.encodeExpr(w, e.left, labels);
        this.encodeExpr(w, e.right, labels);
        const simdSub = SIMD_BINARY_SUBOP[e.op];
        if (simdSub !== undefined) {
          w.writeU8(0xfd);
          w.writeU32(simdSub);
        } else {
          const opcode = BINARY_TO_OPCODE[e.op];
          if (opcode === undefined) {
            throw new WasmEncodeError(`unknown binary opcode: ${e.op}`);
          }
          w.writeU8(opcode);
        }
        break;
      }

      case ExpressionKind.Select: {
        const e = expr as SelectExpr;
        this.encodeExpr(w, e.ifTrue, labels);
        this.encodeExpr(w, e.ifFalse, labels);
        this.encodeExpr(w, e.condition, labels);
        w.writeU8(0x1b);
        break;
      }

      case ExpressionKind.Drop: {
        const e = expr as DropExpr;
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0x1a);
        break;
      }

      case ExpressionKind.Load: {
        const e = expr as LoadExpr;
        this.encodeExpr(w, e.ptr, labels);
        if ((e.type as ValType) === ValType.V128) {
          // Plain `v128.load` is the two-byte SIMD form `0xFD 0x00`, not a
          // single-byte scalar load opcode. The decoder models it as a generic
          // 16-byte Load, so the encoder must re-emit the SIMD prefix.
          w.writeU8(0xfd);
          w.writeU32(0x00);
        } else {
          w.writeU8(loadOpcode(e));
        }
        w.writeU32(e.align);
        w.writeU32(e.offset);
        break;
      }

      case ExpressionKind.Store: {
        const e = expr as StoreExpr;
        this.encodeExpr(w, e.ptr, labels);
        this.encodeExpr(w, e.value, labels);
        if ((e.value.type as ValType) === ValType.V128) {
          // Plain `v128.store` is the two-byte SIMD form `0xFD 0x0b`.
          w.writeU8(0xfd);
          w.writeU32(0x0b);
        } else {
          w.writeU8(storeOpcode(e));
        }
        w.writeU32(e.align);
        w.writeU32(e.offset);
        break;
      }

      case ExpressionKind.MemorySize: {
        w.writeU8(0x3f);
        w.writeU8(0x00);
        break;
      }
      case ExpressionKind.MemoryGrow: {
        const e = expr as MemoryGrowExpr;
        this.encodeExpr(w, e.delta, labels);
        w.writeU8(0x40);
        w.writeU8(0x00);
        break;
      }
      case ExpressionKind.MemoryCopy: {
        const e = expr as MemoryCopyExpr;
        this.encodeExpr(w, e.dest, labels);
        this.encodeExpr(w, e.source, labels);
        this.encodeExpr(w, e.size, labels);
        w.writeU8(0xfc);
        w.writeU32(10);
        w.writeU8(0x00);
        w.writeU8(0x00);
        break;
      }
      case ExpressionKind.MemoryFill: {
        const e = expr as MemoryFillExpr;
        this.encodeExpr(w, e.dest, labels);
        this.encodeExpr(w, e.value, labels);
        this.encodeExpr(w, e.size, labels);
        w.writeU8(0xfc);
        w.writeU32(11);
        w.writeU8(0x00);
        break;
      }

      case ExpressionKind.Call: {
        const e = expr as CallExpr;
        for (const op of e.operands) this.encodeExpr(w, op, labels);
        // 0x10 = call, 0x12 = return_call (tail-call proposal).
        w.writeU8(e.isReturn ? 0x12 : 0x10);
        w.writeU32(this.resolveRef(this.funcIndex, e.target, "call target"));
        break;
      }

      case ExpressionKind.CallIndirect: {
        const e = expr as CallIndirectExpr;
        for (const op of e.operands) this.encodeExpr(w, op, labels);
        this.encodeExpr(w, e.target, labels);
        // 0x11 = call_indirect, 0x13 = return_call_indirect (tail-call proposal).
        w.writeU8(e.isReturn ? 0x13 : 0x11);
        const ciIdx = this.mod.heapTypes.length > 0
          ? this.gcFuncTypeIndex(e.params, e.results)
          : this.getTypeIndex(e.params, e.results);
        w.writeU32(ciIdx);
        w.writeU32(this.resolveRef(this.tableIndex, e.table, "call_indirect table"));
        break;
      }

      case ExpressionKind.RefNull: {
        const e = expr as RefNullExpr;
        w.writeU8(0xd0);
        w.writeU8(refHeapTypeByte(e.type as ValType));
        break;
      }
      case ExpressionKind.RefIsNull: {
        const e = expr as RefIsNullExpr;
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0xd1);
        break;
      }
      case ExpressionKind.RefFunc: {
        const e = expr as RefFuncExpr;
        w.writeU8(0xd2);
        w.writeU32(this.resolveRef(this.funcIndex, e.func, "ref.func"));
        break;
      }

      case ExpressionKind.RefEq: {
        const e = expr as RefEqExpr;
        this.encodeExpr(w, e.left, labels);
        this.encodeExpr(w, e.right, labels);
        w.writeU8(0xd3);
        break;
      }
      case ExpressionKind.RefI31: {
        const e = expr as RefI31Expr;
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0xfb);
        w.writeU32(0x1c);
        break;
      }
      case ExpressionKind.I31Get: {
        const e = expr as I31GetExpr;
        this.encodeExpr(w, e.i31, labels);
        w.writeU8(0xfb);
        w.writeU32(e.signed ? 0x1d : 0x1e);
        break;
      }
      case ExpressionKind.StructNew: {
        const e = expr as StructNewExpr;
        if (!e.defaultInit) { for (const op of e.operands) this.encodeExpr(w, op, labels); }
        w.writeU8(0xfb);
        w.writeU32(e.defaultInit ? 0x01 : 0x00);
        w.writeU32(e.typeIndex);
        break;
      }
      case ExpressionKind.StructGet: {
        const e = expr as StructGetExpr;
        this.encodeExpr(w, e.ref, labels);
        w.writeU8(0xfb);
        w.writeU32(e.signed ? 0x03 : 0x02);
        w.writeU32(e.typeIndex);
        w.writeU32(e.fieldIndex);
        break;
      }
      case ExpressionKind.StructSet: {
        const e = expr as StructSetExpr;
        this.encodeExpr(w, e.ref, labels);
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0xfb);
        w.writeU32(0x05);
        w.writeU32(e.typeIndex);
        w.writeU32(e.fieldIndex);
        break;
      }
      case ExpressionKind.ArrayNew: {
        const e = expr as ArrayNewExpr;
        if (e.init !== null) this.encodeExpr(w, e.init, labels);
        this.encodeExpr(w, e.length, labels);
        w.writeU8(0xfb);
        w.writeU32(e.init === null ? 0x07 : 0x06);
        w.writeU32(e.typeIndex);
        break;
      }
      case ExpressionKind.ArrayNewFixed: {
        const e = expr as ArrayNewFixedExpr;
        for (const v of e.values) this.encodeExpr(w, v, labels);
        w.writeU8(0xfb);
        w.writeU32(0x08);
        w.writeU32(e.typeIndex);
        w.writeU32(e.values.length);
        break;
      }
      case ExpressionKind.ArrayNewData: {
        const e = expr as ArrayNewDataExpr;
        this.encodeExpr(w, e.offset, labels);
        this.encodeExpr(w, e.length, labels);
        w.writeU8(0xfb);
        w.writeU32(0x09);
        w.writeU32(e.typeIndex);
        w.writeU32(e.dataSegment);
        break;
      }
      case ExpressionKind.ArrayNewElem: {
        const e = expr as ArrayNewElemExpr;
        this.encodeExpr(w, e.offset, labels);
        this.encodeExpr(w, e.length, labels);
        w.writeU8(0xfb);
        w.writeU32(0x0a);
        w.writeU32(e.typeIndex);
        w.writeU32(e.elemSegment);
        break;
      }
      case ExpressionKind.ArrayGet: {
        const e = expr as ArrayGetExpr;
        this.encodeExpr(w, e.ref, labels);
        this.encodeExpr(w, e.index, labels);
        w.writeU8(0xfb);
        w.writeU32(e.signed ? 0x0c : 0x0b);
        w.writeU32(e.typeIndex);
        break;
      }
      case ExpressionKind.ArraySet: {
        const e = expr as ArraySetExpr;
        this.encodeExpr(w, e.ref, labels);
        this.encodeExpr(w, e.index, labels);
        this.encodeExpr(w, e.value, labels);
        w.writeU8(0xfb);
        w.writeU32(0x0e);
        w.writeU32(e.typeIndex);
        break;
      }
      case ExpressionKind.ArrayLen: {
        const e = expr as ArrayLenExpr;
        this.encodeExpr(w, e.ref, labels);
        w.writeU8(0xfb);
        w.writeU32(0x0f);
        break;
      }
      case ExpressionKind.RefTest: {
        const e = expr as RefTestExpr;
        this.encodeExpr(w, e.ref, labels);
        w.writeU8(0xfb);
        w.writeU32(e.nullable ? 0x15 : 0x14);
        writeHeapType(w, e.castType);
        break;
      }
      case ExpressionKind.RefCast: {
        const e = expr as RefCastExpr;
        this.encodeExpr(w, e.ref, labels);
        w.writeU8(0xfb);
        w.writeU32(e.nullable ? 0x17 : 0x16);
        writeHeapType(w, e.castType);
        break;
      }
      case ExpressionKind.BrOn: {
        const e = expr as BrOnExpr;
        this.encodeExpr(w, e.ref, labels);
        const depth = this.resolveLabel(labels, e.label);
        if (e.op === BrOnOp.Null) {
          w.writeU8(0xd5);
          w.writeU32(depth);
        } else if (e.op === BrOnOp.NonNull) {
          w.writeU8(0xd6);
          w.writeU32(depth);
        } else {
          w.writeU8(0xfb);
          w.writeU32(e.op === BrOnOp.Cast ? 0x18 : 0x19);
          // flags: bit 0 = source nullable, bit 1 = cast-target nullable.
          w.writeU8((e.srcNullable ? 0x01 : 0x00) | (e.castNullable ? 0x02 : 0x00));
          w.writeU32(depth);
          // Two distinct heap-type immediates: source ($T1) then target ($T2).
          // Emitting the target twice corrupted the source immediate.
          writeHeapType(w, e.srcType ?? AbstractHeapType.Any);
          writeHeapType(w, e.castType ?? AbstractHeapType.Any);
        }
        break;
      }

      case ExpressionKind.TryTable: {
        const e = expr as TryTableExpr;
        w.writeU8(0x1f); // try_table
        writeBlockType(w, e.type);
        w.writeU32(e.catches.length);
        labels.push(e.name ?? "");
        for (const c of e.catches) {
          if (c.tag !== null) {
            w.writeU8(c.isRef ? 0x01 : 0x00); // catch / catch_ref
            w.writeU32(this.resolveRef(this.tagIndex, c.tag, "try_table catch tag"));
          } else {
            w.writeU8(c.isRef ? 0x03 : 0x02); // catch_all / catch_all_ref
          }
          w.writeU32(this.resolveLabel(labels, c.dest));
        }
        this.encodeExpr(w, e.body, labels);
        labels.pop();
        w.writeU8(0x0b);
        break;
      }

      case ExpressionKind.Try: {
        const e = expr as TryExpr;
        if (e.delegateTarget !== null) {
          // try...delegate: emitted as try body + delegate opcode (no end)
          w.writeU8(0x06); // try
          writeBlockType(w, e.type);
          labels.push(e.name ?? "");
          this.encodeExpr(w, e.body, labels);
          labels.pop();
          w.writeU8(0x18); // delegate
          w.writeU32(this.resolveLabel(labels, e.delegateTarget));
        } else {
          w.writeU8(0x06); // try
          writeBlockType(w, e.type);
          labels.push(e.name ?? "");
          this.encodeExpr(w, e.body, labels);
          for (let i = 0; i < e.catchTags.length; i++) {
            if (e.catchTags[i] === "") {
              w.writeU8(0x19); // catch_all
            } else {
              w.writeU8(0x07); // catch
              w.writeU32(this.resolveRef(this.tagIndex, e.catchTags[i], "catch tag"));
            }
            this.encodeCatchBody(w, e.catchBodies[i], labels);
          }
          labels.pop();
          w.writeU8(0x0b);
        }
        break;
      }

      case ExpressionKind.Throw: {
        const e = expr as ThrowExpr;
        for (const op of e.operands) this.encodeExpr(w, op, labels);
        w.writeU8(0x08);
        w.writeU32(this.resolveRef(this.tagIndex, e.tag, "throw tag"));
        break;
      }

      case ExpressionKind.ThrowRef: {
        const e = expr as ThrowRefExpr;
        this.encodeExpr(w, e.exnref, labels);
        w.writeU8(0x0a);
        break;
      }

      case ExpressionKind.Rethrow: {
        const e = expr as RethrowExpr;
        w.writeU8(0x09);
        w.writeU32(this.resolveLabel(labels, e.target));
        break;
      }

      case ExpressionKind.Pop: {
        // Pop is a pseudo-instruction; not emitted in the binary format
        break;
      }

      case ExpressionKind.SIMDExtract: {
        const e = expr as SIMDExtractExpr;
        this.encodeExpr(w, e.vec, labels);
        const sub = SIMD_EXTRACT_SUBOP[e.op];
        if (sub === undefined) throw new WasmEncodeError(`unknown SIMD extract opcode: ${e.op}`);
        w.writeU8(0xfd);
        w.writeU32(sub);
        w.writeU8(e.lane);
        break;
      }

      case ExpressionKind.SIMDReplace: {
        const e = expr as SIMDReplaceExpr;
        this.encodeExpr(w, e.vec, labels);
        this.encodeExpr(w, e.value, labels);
        const sub = SIMD_REPLACE_SUBOP[e.op];
        if (sub === undefined) throw new WasmEncodeError(`unknown SIMD replace opcode: ${e.op}`);
        w.writeU8(0xfd);
        w.writeU32(sub);
        w.writeU8(e.lane);
        break;
      }

      case ExpressionKind.SIMDShuffle: {
        const e = expr as SIMDShuffleExpr;
        this.encodeExpr(w, e.left, labels);
        this.encodeExpr(w, e.right, labels);
        w.writeU8(0xfd);
        w.writeU32(0x0d);
        w.writeBytes(e.mask);
        break;
      }

      case ExpressionKind.SIMDTernary: {
        const e = expr as SIMDTernaryExpr;
        // Stack order: a pushed first, b second, c on top (decoder pops c,b,a)
        this.encodeExpr(w, e.a, labels);
        this.encodeExpr(w, e.b, labels);
        this.encodeExpr(w, e.c, labels);
        w.writeU8(0xfd);
        w.writeU32(0x52);
        break;
      }

      case ExpressionKind.SIMDShift: {
        const e = expr as SIMDShiftExpr;
        this.encodeExpr(w, e.vec, labels);
        this.encodeExpr(w, e.shift, labels);
        const sub = SIMD_SHIFT_SUBOP[e.op];
        if (sub === undefined) throw new WasmEncodeError(`unknown SIMD shift opcode: ${e.op}`);
        w.writeU8(0xfd);
        w.writeU32(sub);
        break;
      }

      case ExpressionKind.SIMDLoad: {
        const e = expr as SIMDLoadExpr;
        this.encodeExpr(w, e.ptr, labels);
        const sub = SIMD_LOAD_SUBOP[e.op];
        if (sub === undefined) throw new WasmEncodeError(`unknown SIMD load opcode: ${e.op}`);
        w.writeU8(0xfd);
        w.writeU32(sub);
        w.writeU32(e.align);
        w.writeU32(e.offset);
        break;
      }

      case ExpressionKind.SIMDLoadStoreLane: {
        const e = expr as SIMDLoadStoreLaneExpr;
        this.encodeExpr(w, e.ptr, labels);
        this.encodeExpr(w, e.vec, labels);
        const sub = SIMD_LANE_SUBOP[e.op];
        if (sub === undefined) {
          throw new WasmEncodeError(`unknown SIMD load/store-lane opcode: ${e.op}`);
        }
        w.writeU8(0xfd);
        w.writeU32(sub);
        w.writeU32(e.align);
        w.writeU32(e.offset);
        w.writeU8(e.lane);
        break;
      }

      default: {
        // Unknown / unsupported expression kind. Emitting a `nop` here silently
        // dropped the subtree (and any stack values it was meant to consume or
        // produce), yielding an invalid or wrong module. Fail loudly instead.
        throw new WasmEncodeError(
          `cannot encode unsupported expression kind: ${(expr as { kind: string }).kind}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Walk helpers
// ---------------------------------------------------------------------------

function walkChildren(expr: Expression, visit: (child: Expression) => void): void {
  switch (expr.kind) {
    case ExpressionKind.Block:
      for (const c of (expr as BlockExpr).children) visit(c);
      break;
    case ExpressionKind.Loop:
      visit((expr as LoopExpr).body);
      break;
    case ExpressionKind.If: {
      const e = expr as IfExpr;
      visit(e.condition);
      visit(e.ifTrue);
      if (e.ifFalse) visit(e.ifFalse);
      break;
    }
    case ExpressionKind.Break: {
      const e = expr as BreakExpr;
      if (e.condition) visit(e.condition);
      if (e.value) visit(e.value);
      break;
    }
    case ExpressionKind.Switch: {
      const e = expr as SwitchExpr;
      visit(e.condition);
      if (e.value) visit(e.value);
      break;
    }
    case ExpressionKind.Return:
      if ((expr as ReturnExpr).value) visit((expr as ReturnExpr).value!);
      break;
    case ExpressionKind.LocalSet:
      visit((expr as LocalSetExpr).value);
      break;
    case ExpressionKind.LocalTee:
      visit((expr as LocalTeeExpr).value);
      break;
    case ExpressionKind.GlobalSet:
      visit((expr as GlobalSetExpr).value);
      break;
    case ExpressionKind.TableGet:
      visit((expr as TableGetExpr).index);
      break;
    case ExpressionKind.TableSet: {
      const e = expr as TableSetExpr;
      visit(e.index);
      visit(e.value);
      break;
    }
    case ExpressionKind.Unary:
      visit((expr as UnaryExpr).value);
      break;
    case ExpressionKind.Binary: {
      const e = expr as BinaryExpr;
      visit(e.left);
      visit(e.right);
      break;
    }
    case ExpressionKind.Select: {
      const e = expr as SelectExpr;
      visit(e.ifTrue);
      visit(e.ifFalse);
      visit(e.condition);
      break;
    }
    case ExpressionKind.Drop:
      visit((expr as DropExpr).value);
      break;
    case ExpressionKind.Load:
      visit((expr as LoadExpr).ptr);
      break;
    case ExpressionKind.Store: {
      const e = expr as StoreExpr;
      visit(e.ptr);
      visit(e.value);
      break;
    }
    case ExpressionKind.MemoryGrow:
      visit((expr as MemoryGrowExpr).delta);
      break;
    case ExpressionKind.MemoryCopy: {
      const e = expr as MemoryCopyExpr;
      visit(e.dest);
      visit(e.source);
      visit(e.size);
      break;
    }
    case ExpressionKind.MemoryFill: {
      const e = expr as MemoryFillExpr;
      visit(e.dest);
      visit(e.value);
      visit(e.size);
      break;
    }
    case ExpressionKind.Call:
      for (const op of (expr as CallExpr).operands) visit(op);
      break;
    case ExpressionKind.CallIndirect: {
      const e = expr as CallIndirectExpr;
      for (const op of e.operands) visit(op);
      visit(e.target);
      break;
    }
    case ExpressionKind.RefIsNull:
      visit((expr as RefIsNullExpr).value);
      break;
    case ExpressionKind.RefEq: {
      const e = expr as RefEqExpr;
      visit(e.left);
      visit(e.right);
      break;
    }
    case ExpressionKind.RefI31:
      visit((expr as RefI31Expr).value);
      break;
    case ExpressionKind.I31Get:
      visit((expr as I31GetExpr).i31);
      break;
    case ExpressionKind.StructNew:
      for (const op of (expr as StructNewExpr).operands) visit(op);
      break;
    case ExpressionKind.StructGet:
      visit((expr as StructGetExpr).ref);
      break;
    case ExpressionKind.StructSet: {
      const e = expr as StructSetExpr;
      visit(e.ref);
      visit(e.value);
      break;
    }
    case ExpressionKind.ArrayNew: {
      const e = expr as ArrayNewExpr;
      if (e.init) visit(e.init);
      visit(e.length);
      break;
    }
    case ExpressionKind.ArrayNewFixed:
      for (const v of (expr as ArrayNewFixedExpr).values) visit(v);
      break;
    case ExpressionKind.ArrayNewData: {
      const e = expr as ArrayNewDataExpr;
      visit(e.offset);
      visit(e.length);
      break;
    }
    case ExpressionKind.ArrayNewElem: {
      const e = expr as ArrayNewElemExpr;
      visit(e.offset);
      visit(e.length);
      break;
    }
    case ExpressionKind.ArrayGet: {
      const e = expr as ArrayGetExpr;
      visit(e.ref);
      visit(e.index);
      break;
    }
    case ExpressionKind.ArraySet: {
      const e = expr as ArraySetExpr;
      visit(e.ref);
      visit(e.index);
      visit(e.value);
      break;
    }
    case ExpressionKind.ArrayLen:
      visit((expr as ArrayLenExpr).ref);
      break;
    case ExpressionKind.RefTest:
      visit((expr as RefTestExpr).ref);
      break;
    case ExpressionKind.RefCast:
      visit((expr as RefCastExpr).ref);
      break;
    case ExpressionKind.BrOn:
      visit((expr as BrOnExpr).ref);
      break;
    case ExpressionKind.TryTable:
      visit((expr as TryTableExpr).body);
      break;
    case ExpressionKind.Try: {
      const e = expr as TryExpr;
      visit(e.body);
      for (const b of e.catchBodies) visit(b);
      break;
    }
    case ExpressionKind.Throw:
      for (const op of (expr as ThrowExpr).operands) visit(op);
      break;
    case ExpressionKind.ThrowRef:
      visit((expr as ThrowRefExpr).exnref);
      break;
    case ExpressionKind.SIMDExtract:
      visit((expr as SIMDExtractExpr).vec);
      break;
    case ExpressionKind.SIMDReplace: {
      const e = expr as SIMDReplaceExpr;
      visit(e.vec);
      visit(e.value);
      break;
    }
    case ExpressionKind.SIMDShuffle: {
      const e = expr as SIMDShuffleExpr;
      visit(e.left);
      visit(e.right);
      break;
    }
    case ExpressionKind.SIMDTernary: {
      const e = expr as SIMDTernaryExpr;
      visit(e.a);
      visit(e.b);
      visit(e.c);
      break;
    }
    case ExpressionKind.SIMDShift: {
      const e = expr as SIMDShiftExpr;
      visit(e.vec);
      visit(e.shift);
      break;
    }
    case ExpressionKind.SIMDLoad:
      visit((expr as SIMDLoadExpr).ptr);
      break;
    case ExpressionKind.SIMDLoadStoreLane: {
      const e = expr as SIMDLoadStoreLaneExpr;
      visit(e.ptr);
      visit(e.vec);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Thrown when the IR cannot be serialized (e.g. unknown expression kind).
 */
export class WasmEncodeError extends Error {
  /**
   * Creates an encode error with the given message.
   *
   * @param message - Human-readable description of what couldn't be encoded
   *   (e.g. "unknown expression kind: BrOn"). The error's `name` is always
   *   `"WasmEncodeError"` for `instanceof`-free type discrimination.
   */
  constructor(message: string) {
    super(message);
    this.name = "WasmEncodeError";
  }
}

/**
 * Serialize a {@link WasmModule} IR into a WebAssembly 1.0 binary.
 *
 * The output is a valid `.wasm` binary that can be re-parsed by {@link parseWasm}
 * or executed by any standard WebAssembly runtime.
 *
 * @param mod - The module to encode.
 * @returns A `Uint8Array` containing the WASM binary.
 *
 * @example
 * ```ts
 * import { encodeWasm } from "@jrmarcum/binaryen-ts/encoder";
 * import { parseWasm } from "@jrmarcum/binaryen-ts/binary";
 * import { readFile, writeFile } from "node:fs/promises";
 *
 * const bytes = new Uint8Array(await readFile("module.wasm"));
 * const mod = parseWasm(bytes);
 * // ... run passes ...
 * const optimized = encodeWasm(mod);
 * await writeFile("module.opt.wasm", optimized);
 * ```
 */
export function encodeWasm(mod: WasmModule): Uint8Array {
  return new WasmEncoder(mod).encode();
}
