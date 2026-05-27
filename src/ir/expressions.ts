/**
 * @module binaryen-ts/ir/expressions
 *
 * WebAssembly expression (instruction) node types for the binaryen-ts IR.
 *
 * Every node in the IR tree is one of the discriminated-union variants below,
 * each with a unique `kind` field. This mirrors the `ExpressionId` enum and
 * per-expression structs in the upstream Binaryen C++ source (`src/wasm.h`).
 *
 * **Tree invariant** (inherited from Binaryen): each node must have exactly
 * one parent. Never share expression nodes between positions in the tree.
 *
 * @example
 * ```ts
 * import { makeBinary, makeI32Const, makeLocalGet } from "@jrmarcum/binaryen-ts/ir";
 *
 * const expr = makeBinary(
 *   BinaryOp.AddI32,
 *   makeLocalGet(0, ValType.I32),
 *   makeI32Const(1),
 * );
 * ```
 *
 * @license MIT
 */

import { None, type Type, Unreachable, ValType } from "./types.ts";
import type { HeapType } from "./gc-types.ts";
export type { HeapType, RefType } from "./gc-types.ts";

// ---------------------------------------------------------------------------
// Expression kind discriminant
// ---------------------------------------------------------------------------

/**
 * Discriminant tag for every expression variant.
 * Mirrors `BinaryenExpressionId` / `ExpressionId` in Binaryen.
 */
export enum ExpressionKind {
  // Control flow
  Nop = "nop",
  Block = "block",
  If = "if",
  Loop = "loop",
  Break = "br",
  Switch = "br_table",
  Return = "return",
  Unreachable = "unreachable",
  // Locals / globals
  LocalGet = "local.get",
  LocalSet = "local.set",
  LocalTee = "local.tee",
  GlobalGet = "global.get",
  GlobalSet = "global.set",
  // Constants
  Const = "const",
  // Arithmetic / logic
  Unary = "unary",
  Binary = "binary",
  Select = "select",
  Drop = "drop",
  // Memory
  Load = "load",
  Store = "store",
  MemorySize = "memory.size",
  MemoryGrow = "memory.grow",
  MemoryCopy = "memory.copy",
  MemoryFill = "memory.fill",
  MemoryInit = "memory.init",
  DataDrop = "data.drop",
  // Calls
  Call = "call",
  CallIndirect = "call_indirect",
  CallRef = "call_ref",
  // Tables
  TableGet = "table.get",
  TableSet = "table.set",
  TableSize = "table.size",
  TableGrow = "table.grow",
  TableFill = "table.fill",
  TableCopy = "table.copy",
  // Atomics
  AtomicRMW = "atomic.rmw",
  AtomicCmpxchg = "atomic.cmpxchg",
  AtomicWait = "atomic.wait",
  AtomicNotify = "atomic.notify",
  AtomicFence = "atomic.fence",
  // SIMD
  SIMDExtract = "simd.extract",
  SIMDReplace = "simd.replace",
  SIMDShuffle = "simd.shuffle",
  SIMDTernary = "simd.ternary",
  SIMDShift = "simd.shift",
  SIMDLoad = "simd.load",
  SIMDLoadStoreLane = "simd.load_store_lane",
  // References (GC + reference-types proposals)
  RefNull = "ref.null",
  RefIsNull = "ref.is_null",
  RefAs = "ref.as",
  RefFunc = "ref.func",
  RefEq = "ref.eq",
  RefI31 = "ref.i31",
  I31Get = "i31.get",
  RefTest = "ref.test",
  RefCast = "ref.cast",
  BrOn = "br_on",
  // GC structs
  StructNew = "struct.new",
  StructGet = "struct.get",
  StructSet = "struct.set",
  // GC arrays
  ArrayNew = "array.new",
  ArrayNewFixed = "array.new_fixed",
  ArrayNewData = "array.new_data",
  ArrayNewElem = "array.new_elem",
  ArrayGet = "array.get",
  ArraySet = "array.set",
  ArrayLen = "array.len",
  ArrayCopy = "array.copy",
  ArrayFill = "array.fill",
  ArrayInitData = "array.init_data",
  ArrayInitElem = "array.init_elem",
  // Exception handling
  Try = "try",
  TryTable = "try_table",
  Throw = "throw",
  ThrowRef = "throw_ref",
  Rethrow = "rethrow",
  Pop = "pop",
  // Multi-value
  TupleMake = "tuple.make",
  TupleExtract = "tuple.extract",
}

// ---------------------------------------------------------------------------
// Constant value union
// ---------------------------------------------------------------------------

/**
 * A WASM literal constant value.
 * Exactly one field is present, corresponding to the value type.
 */
export type Literal =
  | { i32: number }
  | { i64: bigint }
  | { f32: number }
  | { f64: number }
  | { v128: Uint8Array };

// ---------------------------------------------------------------------------
// Operator enums
// ---------------------------------------------------------------------------

/** Unary operators. Mirrors `UnaryOp` in Binaryen. */
export enum UnaryOp {
  // i32
  ClzI32 = "i32.clz",
  CtzI32 = "i32.ctz",
  PopcntI32 = "i32.popcnt",
  EqzI32 = "i32.eqz",
  // i64
  ClzI64 = "i64.clz",
  CtzI64 = "i64.ctz",
  PopcntI64 = "i64.popcnt",
  EqzI64 = "i64.eqz",
  // f32
  AbsF32 = "f32.abs",
  NegF32 = "f32.neg",
  CeilF32 = "f32.ceil",
  FloorF32 = "f32.floor",
  TruncF32 = "f32.trunc",
  NearestF32 = "f32.nearest",
  SqrtF32 = "f32.sqrt",
  // f64
  AbsF64 = "f64.abs",
  NegF64 = "f64.neg",
  CeilF64 = "f64.ceil",
  FloorF64 = "f64.floor",
  TruncF64 = "f64.trunc",
  NearestF64 = "f64.nearest",
  SqrtF64 = "f64.sqrt",
  // Conversions
  ExtendSI32 = "i64.extend_i32_s",
  ExtendUI32 = "i64.extend_i32_u",
  WrapI64 = "i32.wrap_i64",
  TruncSF32ToI32 = "i32.trunc_f32_s",
  TruncUF32ToI32 = "i32.trunc_f32_u",
  TruncSF64ToI32 = "i32.trunc_f64_s",
  TruncUF64ToI32 = "i32.trunc_f64_u",
  TruncSF32ToI64 = "i64.trunc_f32_s",
  TruncUF32ToI64 = "i64.trunc_f32_u",
  TruncSF64ToI64 = "i64.trunc_f64_s",
  TruncUF64ToI64 = "i64.trunc_f64_u",
  PromoteF32 = "f64.promote_f32",
  DemoteF64 = "f32.demote_f64",
  ConvertSI32ToF32 = "f32.convert_i32_s",
  ConvertUI32ToF32 = "f32.convert_i32_u",
  ConvertSI64ToF32 = "f32.convert_i64_s",
  ConvertUI64ToF32 = "f32.convert_i64_u",
  ConvertSI32ToF64 = "f64.convert_i32_s",
  ConvertUI32ToF64 = "f64.convert_i32_u",
  ConvertSI64ToF64 = "f64.convert_i64_s",
  ConvertUI64ToF64 = "f64.convert_i64_u",
  ReinterpretI32 = "f32.reinterpret_i32",
  ReinterpretI64 = "f64.reinterpret_i64",
  ReinterpretF32 = "i32.reinterpret_f32",
  ReinterpretF64 = "i64.reinterpret_f64",
  ExtendS8I32 = "i32.extend8_s",
  ExtendS16I32 = "i32.extend16_s",
  ExtendS8I64 = "i64.extend8_s",
  ExtendS16I64 = "i64.extend16_s",
  ExtendS32I64 = "i64.extend32_s",
  // SIMD splats
  SplatVecI8x16 = "i8x16.splat",
  SplatVecI16x8 = "i16x8.splat",
  SplatVecI32x4 = "i32x4.splat",
  SplatVecI64x2 = "i64x2.splat",
  SplatVecF32x4 = "f32x4.splat",
  SplatVecF64x2 = "f64x2.splat",
  // v128 unary
  NotVec128 = "v128.not",
  AnyTrueVec128 = "v128.any_true",
  // i8x16 unary
  AbsVecI8x16 = "i8x16.abs",
  NegVecI8x16 = "i8x16.neg",
  PopcntVecI8x16 = "i8x16.popcnt",
  AllTrueVecI8x16 = "i8x16.all_true",
  BitmaskVecI8x16 = "i8x16.bitmask",
  // i16x8 unary
  AbsVecI16x8 = "i16x8.abs",
  NegVecI16x8 = "i16x8.neg",
  AllTrueVecI16x8 = "i16x8.all_true",
  BitmaskVecI16x8 = "i16x8.bitmask",
  ExtendLowSVecI8x16ToI16x8 = "i16x8.extend_low_i8x16_s",
  ExtendHighSVecI8x16ToI16x8 = "i16x8.extend_high_i8x16_s",
  ExtendLowUVecI8x16ToI16x8 = "i16x8.extend_low_i8x16_u",
  ExtendHighUVecI8x16ToI16x8 = "i16x8.extend_high_i8x16_u",
  ExtaddPairwiseSVecI8x16ToI16x8 = "i16x8.extadd_pairwise_i8x16_s",
  ExtaddPairwiseUVecI8x16ToI16x8 = "i16x8.extadd_pairwise_i8x16_u",
  // i32x4 unary
  AbsVecI32x4 = "i32x4.abs",
  NegVecI32x4 = "i32x4.neg",
  AllTrueVecI32x4 = "i32x4.all_true",
  BitmaskVecI32x4 = "i32x4.bitmask",
  ExtendLowSVecI16x8ToI32x4 = "i32x4.extend_low_i16x8_s",
  ExtendHighSVecI16x8ToI32x4 = "i32x4.extend_high_i16x8_s",
  ExtendLowUVecI16x8ToI32x4 = "i32x4.extend_low_i16x8_u",
  ExtendHighUVecI16x8ToI32x4 = "i32x4.extend_high_i16x8_u",
  ExtaddPairwiseSVecI16x8ToI32x4 = "i32x4.extadd_pairwise_i16x8_s",
  ExtaddPairwiseUVecI16x8ToI32x4 = "i32x4.extadd_pairwise_i16x8_u",
  TruncSatSVecF32x4ToI32x4 = "i32x4.trunc_sat_f32x4_s",
  TruncSatUVecF32x4ToI32x4 = "i32x4.trunc_sat_f32x4_u",
  TruncSatSVecF64x2ToI32x4Zero = "i32x4.trunc_sat_f64x2_s_zero",
  TruncSatUVecF64x2ToI32x4Zero = "i32x4.trunc_sat_f64x2_u_zero",
  // i64x2 unary
  AbsVecI64x2 = "i64x2.abs",
  NegVecI64x2 = "i64x2.neg",
  AllTrueVecI64x2 = "i64x2.all_true",
  BitmaskVecI64x2 = "i64x2.bitmask",
  ExtendLowSVecI32x4ToI64x2 = "i64x2.extend_low_i32x4_s",
  ExtendHighSVecI32x4ToI64x2 = "i64x2.extend_high_i32x4_s",
  ExtendLowUVecI32x4ToI64x2 = "i64x2.extend_low_i32x4_u",
  ExtendHighUVecI32x4ToI64x2 = "i64x2.extend_high_i32x4_u",
  // f32x4 unary
  AbsVecF32x4 = "f32x4.abs",
  NegVecF32x4 = "f32x4.neg",
  SqrtVecF32x4 = "f32x4.sqrt",
  CeilVecF32x4 = "f32x4.ceil",
  FloorVecF32x4 = "f32x4.floor",
  TruncVecF32x4 = "f32x4.trunc",
  NearestVecF32x4 = "f32x4.nearest",
  DemoteZeroVecF64x2ToF32x4 = "f32x4.demote_f64x2_zero",
  ConvertSVecI32x4ToF32x4 = "f32x4.convert_i32x4_s",
  ConvertUVecI32x4ToF32x4 = "f32x4.convert_i32x4_u",
  // f64x2 unary
  AbsVecF64x2 = "f64x2.abs",
  NegVecF64x2 = "f64x2.neg",
  SqrtVecF64x2 = "f64x2.sqrt",
  CeilVecF64x2 = "f64x2.ceil",
  FloorVecF64x2 = "f64x2.floor",
  TruncVecF64x2 = "f64x2.trunc",
  NearestVecF64x2 = "f64x2.nearest",
  PromoteLowVecF32x4ToF64x2 = "f64x2.promote_low_f32x4",
  ConvertLowSVecI32x4ToF64x2 = "f64x2.convert_low_i32x4_s",
  ConvertLowUVecI32x4ToF64x2 = "f64x2.convert_low_i32x4_u",
}

/** Binary operators. Mirrors `BinaryOp` in Binaryen. */
export enum BinaryOp {
  // i32
  AddI32 = "i32.add",
  SubI32 = "i32.sub",
  MulI32 = "i32.mul",
  DivSI32 = "i32.div_s",
  DivUI32 = "i32.div_u",
  RemSI32 = "i32.rem_s",
  RemUI32 = "i32.rem_u",
  AndI32 = "i32.and",
  OrI32 = "i32.or",
  XorI32 = "i32.xor",
  ShlI32 = "i32.shl",
  ShrSI32 = "i32.shr_s",
  ShrUI32 = "i32.shr_u",
  RotlI32 = "i32.rotl",
  RotrI32 = "i32.rotr",
  EqI32 = "i32.eq",
  NeI32 = "i32.ne",
  LtSI32 = "i32.lt_s",
  LtUI32 = "i32.lt_u",
  LeSI32 = "i32.le_s",
  LeUI32 = "i32.le_u",
  GtSI32 = "i32.gt_s",
  GtUI32 = "i32.gt_u",
  GeSI32 = "i32.ge_s",
  GeUI32 = "i32.ge_u",
  // i64
  AddI64 = "i64.add",
  SubI64 = "i64.sub",
  MulI64 = "i64.mul",
  DivSI64 = "i64.div_s",
  DivUI64 = "i64.div_u",
  RemSI64 = "i64.rem_s",
  RemUI64 = "i64.rem_u",
  AndI64 = "i64.and",
  OrI64 = "i64.or",
  XorI64 = "i64.xor",
  ShlI64 = "i64.shl",
  ShrSI64 = "i64.shr_s",
  ShrUI64 = "i64.shr_u",
  RotlI64 = "i64.rotl",
  RotrI64 = "i64.rotr",
  EqI64 = "i64.eq",
  NeI64 = "i64.ne",
  LtSI64 = "i64.lt_s",
  LtUI64 = "i64.lt_u",
  LeSI64 = "i64.le_s",
  LeUI64 = "i64.le_u",
  GtSI64 = "i64.gt_s",
  GtUI64 = "i64.gt_u",
  GeSI64 = "i64.ge_s",
  GeUI64 = "i64.ge_u",
  // f32
  AddF32 = "f32.add",
  SubF32 = "f32.sub",
  MulF32 = "f32.mul",
  DivF32 = "f32.div",
  CopySignF32 = "f32.copysign",
  MinF32 = "f32.min",
  MaxF32 = "f32.max",
  EqF32 = "f32.eq",
  NeF32 = "f32.ne",
  LtF32 = "f32.lt",
  LeF32 = "f32.le",
  GtF32 = "f32.gt",
  GeF32 = "f32.ge",
  // f64
  AddF64 = "f64.add",
  SubF64 = "f64.sub",
  MulF64 = "f64.mul",
  DivF64 = "f64.div",
  CopySignF64 = "f64.copysign",
  MinF64 = "f64.min",
  MaxF64 = "f64.max",
  EqF64 = "f64.eq",
  NeF64 = "f64.ne",
  LtF64 = "f64.lt",
  LeF64 = "f64.le",
  GtF64 = "f64.gt",
  GeF64 = "f64.ge",
  // SIMD binary
  SwizzleVecI8x16 = "i8x16.swizzle",
  // i8x16 comparisons (return v128)
  EqVecI8x16 = "i8x16.eq",
  NeVecI8x16 = "i8x16.ne",
  LtSVecI8x16 = "i8x16.lt_s",
  LtUVecI8x16 = "i8x16.lt_u",
  GtSVecI8x16 = "i8x16.gt_s",
  GtUVecI8x16 = "i8x16.gt_u",
  LeSVecI8x16 = "i8x16.le_s",
  LeUVecI8x16 = "i8x16.le_u",
  GeSVecI8x16 = "i8x16.ge_s",
  GeUVecI8x16 = "i8x16.ge_u",
  // i16x8 comparisons
  EqVecI16x8 = "i16x8.eq",
  NeVecI16x8 = "i16x8.ne",
  LtSVecI16x8 = "i16x8.lt_s",
  LtUVecI16x8 = "i16x8.lt_u",
  GtSVecI16x8 = "i16x8.gt_s",
  GtUVecI16x8 = "i16x8.gt_u",
  LeSVecI16x8 = "i16x8.le_s",
  LeUVecI16x8 = "i16x8.le_u",
  GeSVecI16x8 = "i16x8.ge_s",
  GeUVecI16x8 = "i16x8.ge_u",
  // i32x4 comparisons
  EqVecI32x4 = "i32x4.eq",
  NeVecI32x4 = "i32x4.ne",
  LtSVecI32x4 = "i32x4.lt_s",
  LtUVecI32x4 = "i32x4.lt_u",
  GtSVecI32x4 = "i32x4.gt_s",
  GtUVecI32x4 = "i32x4.gt_u",
  LeSVecI32x4 = "i32x4.le_s",
  LeUVecI32x4 = "i32x4.le_u",
  GeSVecI32x4 = "i32x4.ge_s",
  GeUVecI32x4 = "i32x4.ge_u",
  // f32x4 comparisons
  EqVecF32x4 = "f32x4.eq",
  NeVecF32x4 = "f32x4.ne",
  LtVecF32x4 = "f32x4.lt",
  GtVecF32x4 = "f32x4.gt",
  LeVecF32x4 = "f32x4.le",
  GeVecF32x4 = "f32x4.ge",
  // f64x2 comparisons
  EqVecF64x2 = "f64x2.eq",
  NeVecF64x2 = "f64x2.ne",
  LtVecF64x2 = "f64x2.lt",
  GtVecF64x2 = "f64x2.gt",
  LeVecF64x2 = "f64x2.le",
  GeVecF64x2 = "f64x2.ge",
  // i64x2 comparisons
  EqVecI64x2 = "i64x2.eq",
  NeVecI64x2 = "i64x2.ne",
  LtSVecI64x2 = "i64x2.lt_s",
  GtSVecI64x2 = "i64x2.gt_s",
  LeSVecI64x2 = "i64x2.le_s",
  GeSVecI64x2 = "i64x2.ge_s",
  // v128 bitwise
  AndVec128 = "v128.and",
  OrVec128 = "v128.or",
  XorVec128 = "v128.xor",
  AndNotVec128 = "v128.andnot",
  // i8x16 arithmetic
  AddVecI8x16 = "i8x16.add",
  AddSatSVecI8x16 = "i8x16.add_sat_s",
  AddSatUVecI8x16 = "i8x16.add_sat_u",
  SubVecI8x16 = "i8x16.sub",
  SubSatSVecI8x16 = "i8x16.sub_sat_s",
  SubSatUVecI8x16 = "i8x16.sub_sat_u",
  MinSVecI8x16 = "i8x16.min_s",
  MinUVecI8x16 = "i8x16.min_u",
  MaxSVecI8x16 = "i8x16.max_s",
  MaxUVecI8x16 = "i8x16.max_u",
  AvgrUVecI8x16 = "i8x16.avgr_u",
  NarrowSVecI16x8ToI8x16 = "i8x16.narrow_i16x8_s",
  NarrowUVecI16x8ToI8x16 = "i8x16.narrow_i16x8_u",
  // i16x8 arithmetic
  AddVecI16x8 = "i16x8.add",
  AddSatSVecI16x8 = "i16x8.add_sat_s",
  AddSatUVecI16x8 = "i16x8.add_sat_u",
  SubVecI16x8 = "i16x8.sub",
  SubSatSVecI16x8 = "i16x8.sub_sat_s",
  SubSatUVecI16x8 = "i16x8.sub_sat_u",
  MulVecI16x8 = "i16x8.mul",
  MinSVecI16x8 = "i16x8.min_s",
  MinUVecI16x8 = "i16x8.min_u",
  MaxSVecI16x8 = "i16x8.max_s",
  MaxUVecI16x8 = "i16x8.max_u",
  AvgrUVecI16x8 = "i16x8.avgr_u",
  Q15MulrSatSVecI16x8 = "i16x8.q15mulr_sat_s",
  NarrowSVecI32x4ToI16x8 = "i16x8.narrow_i32x4_s",
  NarrowUVecI32x4ToI16x8 = "i16x8.narrow_i32x4_u",
  ExtmulLowSVecI8x16ToI16x8 = "i16x8.extmul_low_i8x16_s",
  ExtmulHighSVecI8x16ToI16x8 = "i16x8.extmul_high_i8x16_s",
  ExtmulLowUVecI8x16ToI16x8 = "i16x8.extmul_low_i8x16_u",
  ExtmulHighUVecI8x16ToI16x8 = "i16x8.extmul_high_i8x16_u",
  // i32x4 arithmetic
  AddVecI32x4 = "i32x4.add",
  SubVecI32x4 = "i32x4.sub",
  MulVecI32x4 = "i32x4.mul",
  MinSVecI32x4 = "i32x4.min_s",
  MinUVecI32x4 = "i32x4.min_u",
  MaxSVecI32x4 = "i32x4.max_s",
  MaxUVecI32x4 = "i32x4.max_u",
  DotSVecI16x8ToI32x4 = "i32x4.dot_i16x8_s",
  ExtmulLowSVecI16x8ToI32x4 = "i32x4.extmul_low_i16x8_s",
  ExtmulHighSVecI16x8ToI32x4 = "i32x4.extmul_high_i16x8_s",
  ExtmulLowUVecI16x8ToI32x4 = "i32x4.extmul_low_i16x8_u",
  ExtmulHighUVecI16x8ToI32x4 = "i32x4.extmul_high_i16x8_u",
  // i64x2 arithmetic
  AddVecI64x2 = "i64x2.add",
  SubVecI64x2 = "i64x2.sub",
  MulVecI64x2 = "i64x2.mul",
  ExtmulLowSVecI32x4ToI64x2 = "i64x2.extmul_low_i32x4_s",
  ExtmulHighSVecI32x4ToI64x2 = "i64x2.extmul_high_i32x4_s",
  ExtmulLowUVecI32x4ToI64x2 = "i64x2.extmul_low_i32x4_u",
  ExtmulHighUVecI32x4ToI64x2 = "i64x2.extmul_high_i32x4_u",
  // f32x4 arithmetic
  AddVecF32x4 = "f32x4.add",
  SubVecF32x4 = "f32x4.sub",
  MulVecF32x4 = "f32x4.mul",
  DivVecF32x4 = "f32x4.div",
  MinVecF32x4 = "f32x4.min",
  MaxVecF32x4 = "f32x4.max",
  PminVecF32x4 = "f32x4.pmin",
  PmaxVecF32x4 = "f32x4.pmax",
  // f64x2 arithmetic
  AddVecF64x2 = "f64x2.add",
  SubVecF64x2 = "f64x2.sub",
  MulVecF64x2 = "f64x2.mul",
  DivVecF64x2 = "f64x2.div",
  MinVecF64x2 = "f64x2.min",
  MaxVecF64x2 = "f64x2.max",
  PminVecF64x2 = "f64x2.pmin",
  PmaxVecF64x2 = "f64x2.pmax",
}

// ---------------------------------------------------------------------------
// SIMD-specific operator enums
// ---------------------------------------------------------------------------

/** Lane extract operators. Mirrors `SIMDExtractOp` in Binaryen. */
export enum SIMDExtractOp {
  ExtractLaneSVecI8x16 = "i8x16.extract_lane_s",
  ExtractLaneUVecI8x16 = "i8x16.extract_lane_u",
  ExtractLaneSVecI16x8 = "i16x8.extract_lane_s",
  ExtractLaneUVecI16x8 = "i16x8.extract_lane_u",
  ExtractLaneVecI32x4 = "i32x4.extract_lane",
  ExtractLaneVecI64x2 = "i64x2.extract_lane",
  ExtractLaneVecF32x4 = "f32x4.extract_lane",
  ExtractLaneVecF64x2 = "f64x2.extract_lane",
}

/** Lane replace operators. Mirrors `SIMDReplaceOp` in Binaryen. */
export enum SIMDReplaceOp {
  ReplaceLaneVecI8x16 = "i8x16.replace_lane",
  ReplaceLaneVecI16x8 = "i16x8.replace_lane",
  ReplaceLaneVecI32x4 = "i32x4.replace_lane",
  ReplaceLaneVecI64x2 = "i64x2.replace_lane",
  ReplaceLaneVecF32x4 = "f32x4.replace_lane",
  ReplaceLaneVecF64x2 = "f64x2.replace_lane",
}

/** SIMD lane shift operators. Mirrors `SIMDShiftOp` in Binaryen. */
export enum SIMDShiftOp {
  ShlVecI8x16 = "i8x16.shl",
  ShrSVecI8x16 = "i8x16.shr_s",
  ShrUVecI8x16 = "i8x16.shr_u",
  ShlVecI16x8 = "i16x8.shl",
  ShrSVecI16x8 = "i16x8.shr_s",
  ShrUVecI16x8 = "i16x8.shr_u",
  ShlVecI32x4 = "i32x4.shl",
  ShrSVecI32x4 = "i32x4.shr_s",
  ShrUVecI32x4 = "i32x4.shr_u",
  ShlVecI64x2 = "i64x2.shl",
  ShrSVecI64x2 = "i64x2.shr_s",
  ShrUVecI64x2 = "i64x2.shr_u",
}

/** SIMD extended-load operators. Mirrors `SIMDLoadOp` in Binaryen. */
export enum SIMDLoadOp {
  Load8SplatVec128 = "v128.load8_splat",
  Load16SplatVec128 = "v128.load16_splat",
  Load32SplatVec128 = "v128.load32_splat",
  Load64SplatVec128 = "v128.load64_splat",
  Load8x8SVec128 = "v128.load8x8_s",
  Load8x8UVec128 = "v128.load8x8_u",
  Load16x4SVec128 = "v128.load16x4_s",
  Load16x4UVec128 = "v128.load16x4_u",
  Load32x2SVec128 = "v128.load32x2_s",
  Load32x2UVec128 = "v128.load32x2_u",
  Load32ZeroVec128 = "v128.load32_zero",
  Load64ZeroVec128 = "v128.load64_zero",
}

/** SIMD load/store lane operators. Mirrors `SIMDLoadStoreLaneOp` in Binaryen. */
export enum SIMDLoadStoreLaneOp {
  Load8LaneVec128 = "v128.load8_lane",
  Load16LaneVec128 = "v128.load16_lane",
  Load32LaneVec128 = "v128.load32_lane",
  Load64LaneVec128 = "v128.load64_lane",
  Store8LaneVec128 = "v128.store8_lane",
  Store16LaneVec128 = "v128.store16_lane",
  Store32LaneVec128 = "v128.store32_lane",
  Store64LaneVec128 = "v128.store64_lane",
}

/** SIMD ternary operators. Mirrors `SIMDTernaryOp` in Binaryen. */
export enum SIMDTernaryOp {
  Bitselect = "v128.bitselect",
}

// ---------------------------------------------------------------------------
// Expression node types (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Common base for all expression nodes.
 *
 * Every expression node in the IR has a `kind` discriminant (which determines
 * the specific variant of the {@link Expression} discriminated union) and a
 * `type` recording the value type that the expression yields at runtime.
 *
 * Exported so all subtype interfaces (e.g. {@link BinaryExpr}, {@link CallExpr})
 * have a public supertype reachable from JSR documentation. Construct
 * expression nodes through the typed `make*` factory functions
 * (e.g. {@link makeBinary}, {@link makeI32Const}) rather than the interfaces
 * directly.
 */
export interface ExprBase {
  /** The WAT instruction name (discriminant). */
  kind: ExpressionKind;
  /** The result type of this expression. */
  type: Type;
}

/** {@link NopExpr} — see {@link makeNop} for the factory. */
export interface NopExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Nop;
  /** Result type — the value type yielded at runtime. */
  type: None;
}

/** {@link UnreachableExpr} — see {@link makeUnreachable} for the factory. */
export interface UnreachableExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Unreachable;
  /** Result type — the value type yielded at runtime. */
  type: Unreachable;
}

/** {@link BlockExpr} — see {@link makeBlock} for the factory. */
export interface BlockExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Block;
  /** Optional label for branch targets. */
  name: string | null;
  /** Ordered list of child expressions. */
  children: Expression[];
}

/** {@link IfExpr} — see {@link makeIf} for the factory. */
export interface IfExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.If;
  /** Condition expression (typed as i32). */
  condition: Expression;
  /** Branch taken when the condition is non-zero. */
  ifTrue: Expression;
  /** Branch taken when the condition is zero (nullable). */
  ifFalse: Expression | null;
}

/** {@link LoopExpr} — see {@link makeLoop} for the factory. */
export interface LoopExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Loop;
  /** Branch label for `br` back-edges. */
  name: string;
  /** Body expression. */
  body: Expression;
}

/** {@link BreakExpr} — see {@link makeBreak} for the factory. */
export interface BreakExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Break;
  /** Target label. */
  name: string;
  /** Optional condition — when present this is a `br_if`. */
  condition: Expression | null;
  /** Optional forwarded value. */
  value: Expression | null;
}

/** {@link SwitchExpr} — see {@link makeSwitch} for the factory. */
export interface SwitchExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Switch;
  /** Branch table targets. */
  targets: string[];
  /** Default branch label when no index matches. */
  defaultTarget: string;
  /** Condition expression (typed as i32). */
  condition: Expression;
  /** Value expression. */
  value: Expression | null;
}

/** {@link ReturnExpr} — see {@link makeReturn} for the factory. */
export interface ReturnExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Return;
  /** Value expression. */
  value: Expression | null;
}

/** {@link ConstExpr} — see {@link makeI32Const}, {@link makeI64Const}, {@link makeF32Const}, {@link makeF64Const} for factories. */
export interface ConstExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Const;
  /** Value expression. */
  value: Literal;
}

/** {@link LocalGetExpr} — see {@link makeLocalGet} for the factory. */
export interface LocalGetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.LocalGet;
  /** Local index. */
  index: number;
}

/** {@link LocalSetExpr} — see {@link makeLocalSet} for the factory. */
export interface LocalSetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.LocalSet;
  /** Numeric index into the relevant table. */
  index: number;
  /** Value expression. */
  value: Expression;
}

/** {@link LocalTeeExpr} — see {@link makeLocalTee} for the factory. */
export interface LocalTeeExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.LocalTee;
  /** Numeric index into the relevant table. */
  index: number;
  /** Value expression. */
  value: Expression;
}

/** {@link TableGetExpr} — see {@link makeTableGet} for the factory.
 *  `table.get $t index` — reads the element at `index` from table `$t`. */
export interface TableGetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.TableGet;
  /** Internal name of the table being read. */
  table: string;
  /** i32 index into the table. */
  index: Expression;
}

/** {@link TableSetExpr} — see {@link makeTableSet} for the factory.
 *  `table.set $t index value` — writes `value` to `index` in table `$t`. */
export interface TableSetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.TableSet;
  /** Internal name of the table being written. */
  table: string;
  /** i32 index into the table. */
  index: Expression;
  /** New reference value to store. */
  value: Expression;
}

/** {@link GlobalGetExpr} — see {@link makeGlobalGet} for the factory. */
export interface GlobalGetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.GlobalGet;
  /** Identifier label or symbolic name. */
  name: string;
}

/** {@link GlobalSetExpr} — see {@link makeGlobalSet} for the factory. */
export interface GlobalSetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.GlobalSet;
  /** Identifier label or symbolic name. */
  name: string;
  /** Value expression. */
  value: Expression;
}

/** {@link UnaryExpr} — see {@link makeUnary} for the factory. */
export interface UnaryExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Unary;
  /** Operator code. */
  op: UnaryOp;
  /** Value expression. */
  value: Expression;
}

/** {@link BinaryExpr} — see {@link makeBinary} for the factory. */
export interface BinaryExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Binary;
  /** Operator code. */
  op: BinaryOp;
  /** Left-hand operand. */
  left: Expression;
  /** Right-hand operand. */
  right: Expression;
}

/** {@link SelectExpr} — see {@link makeSelect} for the factory. */
export interface SelectExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Select;
  /** Branch taken when the condition is non-zero. */
  ifTrue: Expression;
  /** Branch taken when the condition is zero (nullable). */
  ifFalse: Expression;
  /** Condition expression (typed as i32). */
  condition: Expression;
}

/** {@link DropExpr} — see {@link makeDrop} for the factory. */
export interface DropExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Drop;
  /** Result type — the value type yielded at runtime. */
  type: None;
  /** Value expression. */
  value: Expression;
}

/** Memory load node. */
export interface LoadExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Load;
  /** Byte width of the memory access (1, 2, 4, 8, 16). */
  bytes: 1 | 2 | 4 | 8 | 16;
  /** Whether the loaded integer is sign-extended. */
  signed: boolean;
  /** Static byte offset added to the address operand. */
  offset: number;
  /** Power-of-two alignment hint (e.g. 0=byte, 2=i32). */
  align: number;
  /** Address operand. */
  ptr: Expression;
}

/** Memory store node. */
export interface StoreExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Store;
  /** Width in bytes of the access. */
  bytes: 1 | 2 | 4 | 8 | 16;
  /** Static byte offset added to the address operand. */
  offset: number;
  /** Power-of-two alignment hint (e.g. 0=byte, 2=i32). */
  align: number;
  /** Address operand. */
  ptr: Expression;
  /** Value expression. */
  value: Expression;
}

/** {@link MemoryGrowExpr} — see {@link makeMemoryGrow} for the factory. */
export interface MemoryGrowExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.MemoryGrow;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
  /** delta — see the matching factory for semantics. */
  delta: Expression;
}

/** {@link MemorySizeExpr} — see {@link makeMemorySize} for the factory. */
export interface MemorySizeExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.MemorySize;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
}

/** {@link MemoryCopyExpr} — see {@link makeMemoryCopy} for the factory. */
export interface MemoryCopyExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.MemoryCopy;
  /** Result type — the value type yielded at runtime. */
  type: None;
  /** Destination address operand. */
  dest: Expression;
  /** source — see the {@link make} factory for semantics. */
  source: Expression;
  /** Number of elements. */
  size: Expression;
}

/** {@link MemoryFillExpr} — see {@link makeMemoryFill} for the factory. */
export interface MemoryFillExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.MemoryFill;
  /** Result type — the value type yielded at runtime. */
  type: None;
  /** Destination address operand. */
  dest: Expression;
  /** Value expression. */
  value: Expression;
  /** Number of elements. */
  size: Expression;
}

/** {@link CallExpr} — see {@link makeCall} for the factory. */
export interface CallExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Call;
  /** Target label of the branch. */
  target: string;
  /** Argument expressions in declaration order. */
  operands: Expression[];
  /** isReturn — see the {@link make} factory for semantics. */
  isReturn: boolean;
}

/** {@link CallIndirectExpr} — see {@link makeCallIndirect} for the factory. */
export interface CallIndirectExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.CallIndirect;
  /** Table index (defaults to 0). */
  table: string;
  /** Target label of the branch. */
  target: Expression;
  /** Argument expressions in declaration order. */
  operands: Expression[];
  /** params — see the matching factory for semantics. */
  params: ValType[];
  /** results — see the {@link make} factory for semantics. */
  results: ValType[];
  /** isReturn — see the matching factory for semantics. */
  isReturn: boolean;
}

/** {@link RefNullExpr} — see {@link makeRefNull} for the factory. */
export interface RefNullExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefNull;
}

/** {@link RefIsNullExpr} — see {@link makeRefIsNull} for the factory. */
export interface RefIsNullExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefIsNull;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
  /** Value expression. */
  value: Expression;
}

/** {@link RefFuncExpr} — see {@link makeRefFunc} for the factory. */
export interface RefFuncExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefFunc;
  /** func — see the {@link make} factory for semantics. */
  func: string;
}

// ---------------------------------------------------------------------------
// GC proposal expression node types (Phase 7)
// ---------------------------------------------------------------------------

/** Discriminant for br_on variants. */
export enum BrOnOp {
  Null = "br_on_null",
  NonNull = "br_on_non_null",
  Cast = "br_on_cast",
  CastFail = "br_on_cast_fail",
}

/** {@link RefEqExpr} — see {@link makeRefEq} for the factory. */
export interface RefEqExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefEq;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
  /** Left-hand operand. */
  left: Expression;
  /** Right-hand operand. */
  right: Expression;
}

/** {@link RefI31Expr} — see {@link makeRefI31} for the factory. */
export interface RefI31Expr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefI31;
  /** Value expression. */
  value: Expression;
}

/** {@link I31GetExpr} — see {@link makeI31Get} for the factory. */
export interface I31GetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.I31Get;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
  /** i31 — see the matching factory for semantics. */
  i31: Expression;
  /** true = i31.get_s (sign-extend). */
  signed: boolean;
}

/** {@link StructNewExpr} — see {@link makeStructNew} for the factory. */
export interface StructNewExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.StructNew;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** Argument expressions in declaration order. */
  operands: Expression[];
  /** defaultInit — see the {@link make} factory for semantics. */
  defaultInit: boolean;
}

/** {@link StructGetExpr} — see {@link makeStructGet} for the factory. */
export interface StructGetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.StructGet;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** Index of the struct field. */
  fieldIndex: number;
  /** ref — see the {@link make} factory for semantics. */
  ref: Expression;
  /** Whether the load is sign-extended (signed=true) or zero-extended. */
  signed: boolean;
}

/** {@link StructSetExpr} — see {@link makeStructSet} for the factory. */
export interface StructSetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.StructSet;
  /** Result type — the value type yielded at runtime. */
  type: None;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** Index of the struct field. */
  fieldIndex: number;
  /** ref — see the matching factory for semantics. */
  ref: Expression;
  /** Value expression. */
  value: Expression;
}

/** {@link ArrayNewExpr} — see {@link makeArrayNew} for the factory. */
export interface ArrayNewExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArrayNew;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** init — see the matching factory for semantics. */
  init: Expression | null;
  /** Byte length to operate on. */
  length: Expression;
}

/** {@link ArrayNewFixedExpr} — see {@link makeArrayNewFixed} for the factory. */
export interface ArrayNewFixedExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArrayNewFixed;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** values — see the matching factory for semantics. */
  values: Expression[];
}

/** {@link ArrayNewDataExpr} — see {@link makeArrayNewData} for the factory. */
export interface ArrayNewDataExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArrayNewData;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** dataSegment — see the matching factory for semantics. */
  dataSegment: number;
  /** Static byte offset added to the address operand. */
  offset: Expression;
  /** Byte length to operate on. */
  length: Expression;
}

/** {@link ArrayNewElemExpr} — see {@link makeArrayNewElem} for the factory. */
export interface ArrayNewElemExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArrayNewElem;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** elemSegment — see the matching factory for semantics. */
  elemSegment: number;
  /** Static byte offset added to the address operand. */
  offset: Expression;
  /** Byte length to operate on. */
  length: Expression;
}

/** {@link ArrayGetExpr} — see {@link makeArrayGet} for the factory. */
export interface ArrayGetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArrayGet;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** ref — see the matching factory for semantics. */
  ref: Expression;
  /** Numeric index into the relevant table. */
  index: Expression;
  /** Whether the load is sign-extended (signed=true) or zero-extended. */
  signed: boolean;
}

/** {@link ArraySetExpr} — see {@link makeArraySet} for the factory. */
export interface ArraySetExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArraySet;
  /** Result type — the value type yielded at runtime. */
  type: None;
  /** Index into the module heap-type table. */
  typeIndex: number;
  /** ref — see the {@link make} factory for semantics. */
  ref: Expression;
  /** Numeric index into the relevant table. */
  index: Expression;
  /** Value expression. */
  value: Expression;
}

/** {@link ArrayLenExpr} — see {@link makeArrayLen} for the factory. */
export interface ArrayLenExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ArrayLen;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
  /** ref — see the matching factory for semantics. */
  ref: Expression;
}

/** {@link RefTestExpr} — see {@link makeRefTest} for the factory. */
export interface RefTestExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefTest;
  /** Result type — the value type yielded at runtime. */
  type: ValType.I32;
  /** ref — see the matching factory for semantics. */
  ref: Expression;
  /** Target reference type for the cast. */
  castType: HeapType;
  /** Whether the reference type is nullable. */
  nullable: boolean;
}

/** {@link RefCastExpr} — see {@link makeRefCast} for the factory. */
export interface RefCastExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.RefCast;
  /** ref — see the {@link make} factory for semantics. */
  ref: Expression;
  /** Target reference type for the cast. */
  castType: HeapType;
  /** Whether the reference type is nullable. */
  nullable: boolean;
}

/** {@link BrOnExpr} — see {@link makeBrOn} for the factory. */
export interface BrOnExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.BrOn;
  /** Operator code. */
  op: BrOnOp;
  /** label — see the matching factory for semantics. */
  label: string;
  /** ref — see the {@link make} factory for semantics. */
  ref: Expression;
  /** Target reference type for the cast. */
  castType?: HeapType;
  /** castNullable — see the {@link make} factory for semantics. */
  castNullable?: boolean;
}

// ---------------------------------------------------------------------------
// Exception handling (EH proposal)
// ---------------------------------------------------------------------------

/**
 * A catch clause in a `try_table` expression.
 * Mirrors the four catch opcode variants (0x00–0x03) from the EH proposal.
 */
export interface CatchClause {
  /** Tag name, or `null` for `catch_all` / `catch_all_ref`. */
  tag: string | null;
  /** Branch label to jump to when this clause matches. */
  dest: string;
  /** `true` for `catch_ref` and `catch_all_ref` (sends an exnref). */
  isRef: boolean;
}

/** `try_table` expression (new EH proposal). */
export interface TryTableExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.TryTable;
  /** Optional label for the try_table block itself. */
  name: string | null;
  /** The protected body. */
  body: Expression;
  /** catches — see the matching factory for semantics. */
  catches: CatchClause[];
}

/** `try` expression (old/legacy EH). */
export interface TryExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Try;
  /** Label (targetable by `delegate`). */
  name: string | null;
  /** Body expression. */
  body: Expression;
  /** Parallel arrays: catchTags[i] is the tag for catchBodies[i].
   *  An empty string tag signals `catch_all`. */
  catchTags: string[];
  /** catchBodies — see the matching factory for semantics. */
  catchBodies: Expression[];
  /** Set for the `delegate` variant; depth to delegate to. */
  delegateTarget: string | null;
}

/** `throw $tag operands*` expression. Always has type `unreachable`. */
export interface ThrowExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Throw;
  /** tag — see the {@link make} factory for semantics. */
  tag: string;
  /** Argument expressions in declaration order. */
  operands: Expression[];
}

/** `throw_ref $exnref` expression (new EH). Always has type `unreachable`. */
export interface ThrowRefExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.ThrowRef;
  /** exnref — see the {@link make} factory for semantics. */
  exnref: Expression;
}

/** `rethrow $depth` expression (old EH). Always has type `unreachable`. */
export interface RethrowExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Rethrow;
  /** Label of the enclosing try whose caught exception to rethrow. */
  target: string;
}

/** `pop` pseudo-instruction — implicit value producer at start of catch handlers. */
export interface PopExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.Pop;
}

// ---------------------------------------------------------------------------
// SIMD expression node types
// ---------------------------------------------------------------------------

/** `*.extract_lane` — extract a scalar lane from a v128. */
export interface SIMDExtractExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDExtract;
  /** Operator code. */
  op: SIMDExtractOp;
  /** vec — see the matching factory for semantics. */
  vec: Expression;
  /** Lane index for the SIMD operation. */
  lane: number;
}

/** `*.replace_lane` — replace a scalar lane in a v128. */
export interface SIMDReplaceExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDReplace;
  /** Operator code. */
  op: SIMDReplaceOp;
  /** vec — see the matching factory for semantics. */
  vec: Expression;
  /** Lane index for the SIMD operation. */
  lane: number;
  /** Value expression. */
  value: Expression;
}

/** `i8x16.shuffle` — byte-level permute of two v128 operands. */
export interface SIMDShuffleExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDShuffle;
  /** Left-hand operand. */
  left: Expression;
  /** Right-hand operand. */
  right: Expression;
  /** 16-byte immediate lane-select mask. */
  mask: Uint8Array;
}

/** `v128.bitselect` and relaxed ternary SIMD ops. */
export interface SIMDTernaryExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDTernary;
  /** Operator code. */
  op: SIMDTernaryOp;
  /** First operand. */
  a: Expression;
  /** Second operand. */
  b: Expression;
  /** Third operand. */
  c: Expression;
}

/** `*.shl` / `*.shr_s` / `*.shr_u` — SIMD lane shift (vec: v128, shift: i32). */
export interface SIMDShiftExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDShift;
  /** Operator code. */
  op: SIMDShiftOp;
  /** vec — see the matching factory for semantics. */
  vec: Expression;
  /** Shift amount operand. */
  shift: Expression;
}

/** Extended SIMD loads: splat, extend (8x8/16x4/32x2), and zero-extend. */
export interface SIMDLoadExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDLoad;
  /** Operator code. */
  op: SIMDLoadOp;
  /** Address operand. */
  ptr: Expression;
  /** Static byte offset added to the address operand. */
  offset: number;
  /** Power-of-two alignment hint (e.g. 0=byte, 2=i32). */
  align: number;
}

/** `v128.loadN_lane` / `v128.storeN_lane`. */
export interface SIMDLoadStoreLaneExpr extends ExprBase {
  /** Discriminant — identifies which expression variant this is. */
  kind: ExpressionKind.SIMDLoadStoreLane;
  /** Operator code. */
  op: SIMDLoadStoreLaneOp;
  /** Address operand. */
  ptr: Expression;
  /** vec — see the {@link make} factory for semantics. */
  vec: Expression;
  /** Static byte offset added to the address operand. */
  offset: number;
  /** Power-of-two alignment hint (e.g. 0=byte, 2=i32). */
  align: number;
  /** Lane index for the SIMD operation. */
  lane: number;
}

// ---------------------------------------------------------------------------
// Top-level Expression union
// ---------------------------------------------------------------------------

/**
 * The union of all IR expression node types.
 * Use the `kind` discriminant to narrow to a specific variant.
 */
export type Expression =
  | NopExpr
  | UnreachableExpr
  | BlockExpr
  | IfExpr
  | LoopExpr
  | BreakExpr
  | SwitchExpr
  | ReturnExpr
  | ConstExpr
  | LocalGetExpr
  | LocalSetExpr
  | LocalTeeExpr
  | TableGetExpr
  | TableSetExpr
  | GlobalGetExpr
  | GlobalSetExpr
  | UnaryExpr
  | BinaryExpr
  | SelectExpr
  | DropExpr
  | LoadExpr
  | StoreExpr
  | MemoryGrowExpr
  | MemorySizeExpr
  | MemoryCopyExpr
  | MemoryFillExpr
  | CallExpr
  | CallIndirectExpr
  | RefNullExpr
  | RefIsNullExpr
  | RefFuncExpr
  | RefEqExpr
  | RefI31Expr
  | I31GetExpr
  | StructNewExpr
  | StructGetExpr
  | StructSetExpr
  | ArrayNewExpr
  | ArrayNewFixedExpr
  | ArrayNewDataExpr
  | ArrayNewElemExpr
  | ArrayGetExpr
  | ArraySetExpr
  | ArrayLenExpr
  | RefTestExpr
  | RefCastExpr
  | BrOnExpr
  | TryTableExpr
  | TryExpr
  | ThrowExpr
  | ThrowRefExpr
  | RethrowExpr
  | PopExpr
  | SIMDExtractExpr
  | SIMDReplaceExpr
  | SIMDShuffleExpr
  | SIMDTernaryExpr
  | SIMDShiftExpr
  | SIMDLoadExpr
  | SIMDLoadStoreLaneExpr;

// ---------------------------------------------------------------------------
// Builder helpers (factory functions)
// ---------------------------------------------------------------------------

/** Creates an `i32` constant expression. */
export function makeI32Const(value: number): ConstExpr {
  return { kind: ExpressionKind.Const, type: ValType.I32, value: { i32: value } };
}

/** Creates an `i64` constant expression. */
export function makeI64Const(value: bigint): ConstExpr {
  return { kind: ExpressionKind.Const, type: ValType.I64, value: { i64: value } };
}

/** Creates an `f32` constant expression. */
export function makeF32Const(value: number): ConstExpr {
  return { kind: ExpressionKind.Const, type: ValType.F32, value: { f32: value } };
}

/** Creates an `f64` constant expression. */
export function makeF64Const(value: number): ConstExpr {
  return { kind: ExpressionKind.Const, type: ValType.F64, value: { f64: value } };
}

/** Creates a `global.get` expression. */
export function makeGlobalGet(name: string, type: ValType): GlobalGetExpr {
  return { kind: ExpressionKind.GlobalGet, type, name };
}

/** Creates a `global.set` expression (result type is `none`). */
export function makeGlobalSet(name: string, value: Expression): GlobalSetExpr {
  return { kind: ExpressionKind.GlobalSet, type: None, name, value };
}

/** Creates a `local.get` expression. */
export function makeLocalGet(index: number, type: ValType): LocalGetExpr {
  return { kind: ExpressionKind.LocalGet, type, index };
}

/** Creates a `local.set` expression (result type is `none`). */
export function makeLocalSet(index: number, value: Expression): LocalSetExpr {
  return { kind: ExpressionKind.LocalSet, type: None, index, value };
}

/** Creates a `local.tee` expression (result type matches the value). */
export function makeLocalTee(index: number, value: Expression, type: ValType): LocalTeeExpr {
  return { kind: ExpressionKind.LocalTee, type, index, value };
}

/** Creates a `table.get` expression. Default element type is `funcref` (the
 *  most common reference table); pass `externref` for tables holding host
 *  references. */
export function makeTableGet(
  table: string,
  index: Expression,
  type: ValType = ValType.FuncRef,
): TableGetExpr {
  return { kind: ExpressionKind.TableGet, type, table, index };
}

/** Creates a `table.set` expression (result type is `none`). */
export function makeTableSet(
  table: string,
  index: Expression,
  value: Expression,
): TableSetExpr {
  return { kind: ExpressionKind.TableSet, type: None, table, index, value };
}

/** Creates a binary expression. */
export function makeBinary(op: BinaryOp, left: Expression, right: Expression): BinaryExpr {
  const type = inferBinaryType(op);
  return { kind: ExpressionKind.Binary, type, op, left, right };
}

/** Creates a unary expression. */
export function makeUnary(op: UnaryOp, value: Expression): UnaryExpr {
  const type = inferUnaryType(op);
  return { kind: ExpressionKind.Unary, type, op, value };
}

/** Creates a `return` expression. */
export function makeReturn(value: Expression | null = null): ReturnExpr {
  // A `return` is a control-flow transfer, not a value producer: it never
  // yields a value to its enclosing block, so its type is always `unreachable`
  // (matches upstream `Return() { type = Type::unreachable; }` in wasm.h). The
  // returned *value's* type lives on `value.type`; the node's own type must not
  // leak into block type-inference, or a block ending in `(return x)` would be
  // mistyped as `x`'s type instead of `unreachable`.
  return { kind: ExpressionKind.Return, type: Unreachable, value };
}

/** Creates a `call` expression. */
export function makeCall(
  target: string,
  operands: Expression[],
  resultType: Type,
  isReturn = false,
): CallExpr {
  return { kind: ExpressionKind.Call, type: resultType, target, operands, isReturn };
}

/** Creates an `if` expression. */
export function makeIf(
  condition: Expression,
  ifTrue: Expression,
  ifFalse: Expression | null = null,
): IfExpr {
  return {
    kind: ExpressionKind.If,
    type: ifFalse ? ifTrue.type : None,
    condition,
    ifTrue,
    ifFalse,
  };
}

/** Creates a `block` expression. */
export function makeBlock(
  children: Expression[],
  name: string | null = null,
): BlockExpr {
  const last = children[children.length - 1];
  const type: Type = last ? last.type : None;
  return { kind: ExpressionKind.Block, type, name, children };
}

/** Creates a `drop` expression (discards a value). */
export function makeDrop(value: Expression): DropExpr {
  return { kind: ExpressionKind.Drop, type: None, value };
}

/** Creates a `nop` expression. */
export function makeNop(): NopExpr {
  return { kind: ExpressionKind.Nop, type: None };
}

/** Creates an `unreachable` expression. */
export function makeUnreachable(): UnreachableExpr {
  return { kind: ExpressionKind.Unreachable, type: Unreachable };
}

/** Creates a `loop` expression. */
export function makeLoop(name: string, body: Expression, resultType: Type = None): LoopExpr {
  return { kind: ExpressionKind.Loop, type: resultType, name, body };
}

/** Creates a `br` or `br_if` expression. */
export function makeBreak(
  name: string,
  condition: Expression | null = null,
  value: Expression | null = null,
): BreakExpr {
  // Mirrors upstream `Break::finalize`: an UNCONDITIONAL `br` always transfers
  // control, so its type is `unreachable` — a block ending in `(br $l)` is
  // therefore unreachable at its end, which is exactly what lets a result-typed
  // loop/block whose body exits via a back-edge validate (the implicit end is
  // unreachable, so no fallthrough value is required). A conditional `br_if`
  // falls through when the condition is false, so it takes the value's type
  // (or `none` when value-less).
  const type: Type = condition === null ? Unreachable : value ? value.type : None;
  return { kind: ExpressionKind.Break, type, name, condition, value };
}

/** Creates a `br_table` expression. */
export function makeSwitch(
  targets: string[],
  defaultTarget: string,
  condition: Expression,
  value: Expression | null = null,
): SwitchExpr {
  // `br_table` always branches (it is unconditional — the operand only selects
  // WHICH target), so it is `unreachable`, matching upstream `Switch() { type =
  // Type::unreachable; }`. As with `br`, this keeps a block ending in a
  // `br_table` correctly unreachable for type-inference purposes.
  return {
    kind: ExpressionKind.Switch,
    type: Unreachable,
    targets,
    defaultTarget,
    condition,
    value,
  };
}

/** Creates a `select` expression. */
export function makeSelect(
  ifTrue: Expression,
  ifFalse: Expression,
  condition: Expression,
): SelectExpr {
  return { kind: ExpressionKind.Select, type: ifTrue.type, ifTrue, ifFalse, condition };
}

/** Creates a `call_indirect` expression. */
export function makeCallIndirect(
  table: string,
  target: Expression,
  operands: Expression[],
  params: ValType[],
  results: ValType[],
  isReturn = false,
): CallIndirectExpr {
  const type: Type = results.length > 0 ? results[0] : None;
  return {
    kind: ExpressionKind.CallIndirect,
    type,
    table,
    target,
    operands,
    params,
    results,
    isReturn,
  };
}

/** Creates a memory load expression. */
export function makeLoad(
  bytes: 1 | 2 | 4 | 8 | 16,
  signed: boolean,
  offset: number,
  align: number,
  ptr: Expression,
  resultType: ValType,
): LoadExpr {
  return { kind: ExpressionKind.Load, type: resultType, bytes, signed, offset, align, ptr };
}

/** Creates a memory store expression. */
export function makeStore(
  bytes: 1 | 2 | 4 | 8 | 16,
  offset: number,
  align: number,
  ptr: Expression,
  value: Expression,
): StoreExpr {
  return { kind: ExpressionKind.Store, type: None, bytes, offset, align, ptr, value };
}

/** Creates a `memory.size` expression. */
export function makeMemorySize(): MemorySizeExpr {
  return { kind: ExpressionKind.MemorySize, type: ValType.I32 };
}

/** Creates a `memory.grow` expression. */
export function makeMemoryGrow(delta: Expression): MemoryGrowExpr {
  return { kind: ExpressionKind.MemoryGrow, type: ValType.I32, delta };
}

/** Creates a `memory.copy` expression. */
export function makeMemoryCopy(
  dest: Expression,
  source: Expression,
  size: Expression,
): MemoryCopyExpr {
  return { kind: ExpressionKind.MemoryCopy, type: None, dest, source, size };
}

/** Creates a `memory.fill` expression. */
export function makeMemoryFill(
  dest: Expression,
  value: Expression,
  size: Expression,
): MemoryFillExpr {
  return { kind: ExpressionKind.MemoryFill, type: None, dest, value, size };
}

/** Creates a `ref.null` expression. */
export function makeRefNull(type: ValType): RefNullExpr {
  return { kind: ExpressionKind.RefNull, type };
}

/** Creates a `ref.func` expression. */
export function makeRefFunc(func: string, type: ValType = ValType.FuncRef): RefFuncExpr {
  return { kind: ExpressionKind.RefFunc, type, func };
}

/** Creates a `ref.is_null` expression. */
export function makeRefIsNull(value: Expression): RefIsNullExpr {
  return { kind: ExpressionKind.RefIsNull, type: ValType.I32, value };
}

/** Creates a ref.eq expression. */
export function makeRefEq(left: Expression, right: Expression): RefEqExpr {
  return { kind: ExpressionKind.RefEq, type: ValType.I32, left, right };
}

/** Creates a ref.i31 expression. */
export function makeRefI31(value: Expression, resultType: Type): RefI31Expr {
  return { kind: ExpressionKind.RefI31, type: resultType, value };
}

/** Creates an i31.get_s or i31.get_u expression. */
export function makeI31Get(i31: Expression, signed: boolean): I31GetExpr {
  return { kind: ExpressionKind.I31Get, type: ValType.I32, i31, signed };
}

/** Creates a struct.new expression. */
export function makeStructNew(
  typeIndex: number,
  operands: Expression[],
  resultType: Type,
): StructNewExpr {
  return {
    kind: ExpressionKind.StructNew,
    type: resultType,
    typeIndex,
    operands,
    defaultInit: false,
  };
}

/** Creates a struct.new_default expression. */
export function makeStructNewDefault(typeIndex: number, resultType: Type): StructNewExpr {
  return {
    kind: ExpressionKind.StructNew,
    type: resultType,
    typeIndex,
    operands: [],
    defaultInit: true,
  };
}

/** Creates a struct.get expression. */
export function makeStructGet(
  typeIndex: number,
  fieldIndex: number,
  ref: Expression,
  resultType: Type,
  signed = false,
): StructGetExpr {
  return { kind: ExpressionKind.StructGet, type: resultType, typeIndex, fieldIndex, ref, signed };
}

/** Creates a struct.set expression. */
export function makeStructSet(
  typeIndex: number,
  fieldIndex: number,
  ref: Expression,
  value: Expression,
): StructSetExpr {
  return { kind: ExpressionKind.StructSet, type: None, typeIndex, fieldIndex, ref, value };
}

/** Creates an array.new expression. */
export function makeArrayNew(
  typeIndex: number,
  init: Expression,
  length: Expression,
  resultType: Type,
): ArrayNewExpr {
  return { kind: ExpressionKind.ArrayNew, type: resultType, typeIndex, init, length };
}

/** Creates an array.new_default expression. */
export function makeArrayNewDefault(
  typeIndex: number,
  length: Expression,
  resultType: Type,
): ArrayNewExpr {
  return { kind: ExpressionKind.ArrayNew, type: resultType, typeIndex, init: null, length };
}

/** Creates an array.new_fixed expression. */
export function makeArrayNewFixed(
  typeIndex: number,
  values: Expression[],
  resultType: Type,
): ArrayNewFixedExpr {
  return { kind: ExpressionKind.ArrayNewFixed, type: resultType, typeIndex, values };
}

/** Creates an array.new_data expression. */
export function makeArrayNewData(
  typeIndex: number,
  dataSegment: number,
  offset: Expression,
  length: Expression,
  resultType: Type,
): ArrayNewDataExpr {
  return {
    kind: ExpressionKind.ArrayNewData,
    type: resultType,
    typeIndex,
    dataSegment,
    offset,
    length,
  };
}

/** Creates an array.new_elem expression. */
export function makeArrayNewElem(
  typeIndex: number,
  elemSegment: number,
  offset: Expression,
  length: Expression,
  resultType: Type,
): ArrayNewElemExpr {
  return {
    kind: ExpressionKind.ArrayNewElem,
    type: resultType,
    typeIndex,
    elemSegment,
    offset,
    length,
  };
}

/** Creates an array.get expression. */
export function makeArrayGet(
  typeIndex: number,
  ref: Expression,
  index: Expression,
  resultType: Type,
  signed = false,
): ArrayGetExpr {
  return { kind: ExpressionKind.ArrayGet, type: resultType, typeIndex, ref, index, signed };
}

/** Creates an array.set expression. */
export function makeArraySet(
  typeIndex: number,
  ref: Expression,
  index: Expression,
  value: Expression,
): ArraySetExpr {
  return { kind: ExpressionKind.ArraySet, type: None, typeIndex, ref, index, value };
}

/** Creates an array.len expression. */
export function makeArrayLen(ref: Expression): ArrayLenExpr {
  return { kind: ExpressionKind.ArrayLen, type: ValType.I32, ref };
}

/** Creates a ref.test or ref.test null expression. */
export function makeRefTest(ref: Expression, castType: HeapType, nullable: boolean): RefTestExpr {
  return { kind: ExpressionKind.RefTest, type: ValType.I32, ref, castType, nullable };
}

/** Creates a ref.cast or ref.cast null expression. */
export function makeRefCast(
  ref: Expression,
  castType: HeapType,
  nullable: boolean,
  resultType: Type,
): RefCastExpr {
  return { kind: ExpressionKind.RefCast, type: resultType, ref, castType, nullable };
}

/** Creates a br_on_null, br_on_non_null, br_on_cast, or br_on_cast_fail expression. */
export function makeBrOn(
  op: BrOnOp,
  label: string,
  ref: Expression,
  resultType: Type,
  castType?: HeapType,
  castNullable?: boolean,
): BrOnExpr {
  return { kind: ExpressionKind.BrOn, type: resultType, op, label, ref, castType, castNullable };
}

/** Creates a `try_table` expression. */
export function makeTryTable(
  name: string | null,
  body: Expression,
  catches: CatchClause[],
  resultType: Type,
): TryTableExpr {
  return { kind: ExpressionKind.TryTable, type: resultType, name, body, catches };
}

/** Creates a `try` expression (old EH). */
export function makeTry(
  name: string | null,
  body: Expression,
  catchTags: string[],
  catchBodies: Expression[],
  delegateTarget: string | null,
  resultType: Type,
): TryExpr {
  return {
    kind: ExpressionKind.Try,
    type: resultType,
    name,
    body,
    catchTags,
    catchBodies,
    delegateTarget,
  };
}

/** Creates a `throw $tag operands*` expression. */
export function makeThrow(tag: string, operands: Expression[]): ThrowExpr {
  return { kind: ExpressionKind.Throw, type: Unreachable, tag, operands };
}

/** Creates a `throw_ref` expression. */
export function makeThrowRef(exnref: Expression): ThrowRefExpr {
  return { kind: ExpressionKind.ThrowRef, type: Unreachable, exnref };
}

/** Creates a `rethrow $depth` expression (old EH). */
export function makeRethrow(target: string): RethrowExpr {
  return { kind: ExpressionKind.Rethrow, type: Unreachable, target };
}

/** Creates a `pop` pseudo-instruction. */
export function makePop(type: Type): PopExpr {
  return { kind: ExpressionKind.Pop, type };
}

/** Creates a `v128.const` expression from 16 raw bytes. */
export function makeV128Const(bytes: Uint8Array): ConstExpr {
  return { kind: ExpressionKind.Const, type: ValType.V128, value: { v128: bytes } };
}

/** Creates a `*.extract_lane` SIMD expression. */
export function makeSIMDExtract(op: SIMDExtractOp, vec: Expression, lane: number): SIMDExtractExpr {
  const type = _simdExtractResultType(op);
  return { kind: ExpressionKind.SIMDExtract, type, op, vec, lane };
}

/** Creates a `*.replace_lane` SIMD expression. */
export function makeSIMDReplace(
  op: SIMDReplaceOp,
  vec: Expression,
  lane: number,
  value: Expression,
): SIMDReplaceExpr {
  return { kind: ExpressionKind.SIMDReplace, type: ValType.V128, op, vec, lane, value };
}

/** Creates an `i8x16.shuffle` expression. */
export function makeSIMDShuffle(
  left: Expression,
  right: Expression,
  mask: Uint8Array,
): SIMDShuffleExpr {
  return { kind: ExpressionKind.SIMDShuffle, type: ValType.V128, left, right, mask };
}

/** Creates a `v128.bitselect` or relaxed ternary SIMD expression. */
export function makeSIMDTernary(
  op: SIMDTernaryOp,
  a: Expression,
  b: Expression,
  c: Expression,
): SIMDTernaryExpr {
  return { kind: ExpressionKind.SIMDTernary, type: ValType.V128, op, a, b, c };
}

/** Creates a `*.shl` / `*.shr_s` / `*.shr_u` SIMD shift expression. */
export function makeSIMDShift(op: SIMDShiftOp, vec: Expression, shift: Expression): SIMDShiftExpr {
  return { kind: ExpressionKind.SIMDShift, type: ValType.V128, op, vec, shift };
}

/** Creates a SIMD extended load expression (splat, extend, or zero-extend). */
export function makeSIMDLoad(
  op: SIMDLoadOp,
  ptr: Expression,
  offset: number,
  align: number,
): SIMDLoadExpr {
  return { kind: ExpressionKind.SIMDLoad, type: ValType.V128, op, ptr, offset, align };
}

/** Creates a `v128.loadN_lane` or `v128.storeN_lane` expression. */
export function makeSIMDLoadStoreLane(
  op: SIMDLoadStoreLaneOp,
  ptr: Expression,
  vec: Expression,
  offset: number,
  align: number,
  lane: number,
): SIMDLoadStoreLaneExpr {
  const isStore = op === SIMDLoadStoreLaneOp.Store8LaneVec128 ||
    op === SIMDLoadStoreLaneOp.Store16LaneVec128 ||
    op === SIMDLoadStoreLaneOp.Store32LaneVec128 ||
    op === SIMDLoadStoreLaneOp.Store64LaneVec128;
  return {
    kind: ExpressionKind.SIMDLoadStoreLane,
    type: isStore ? None : ValType.V128,
    op,
    ptr,
    vec,
    offset,
    align,
    lane,
  };
}

// ---------------------------------------------------------------------------
// Internal type inference helpers
// ---------------------------------------------------------------------------

function inferBinaryType(op: BinaryOp): ValType {
  // SIMD ops all return v128 (including SIMD comparisons, unlike scalar comparisons)
  if (
    op.startsWith("i8x16.") || op.startsWith("i16x8.") || op.startsWith("i32x4.") ||
    op.startsWith("i64x2.") || op.startsWith("f32x4.") || op.startsWith("f64x2.") ||
    op.startsWith("v128.")
  ) return ValType.V128;
  if (op.startsWith("i32")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  return ValType.F64;
}

function inferUnaryType(op: UnaryOp): ValType {
  // SIMD reduction ops return i32
  if (op.endsWith(".all_true") || op.endsWith(".bitmask") || op === UnaryOp.AnyTrueVec128) {
    return ValType.I32;
  }
  // All other SIMD ops return v128
  if (
    op.startsWith("i8x16.") || op.startsWith("i16x8.") || op.startsWith("i32x4.") ||
    op.startsWith("i64x2.") || op.startsWith("f32x4.") || op.startsWith("f64x2.") ||
    op.startsWith("v128.")
  ) return ValType.V128;
  if (op.startsWith("i32")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  return ValType.F64;
}

function _simdExtractResultType(op: SIMDExtractOp): ValType {
  if (op === SIMDExtractOp.ExtractLaneVecI64x2) return ValType.I64;
  if (op === SIMDExtractOp.ExtractLaneVecF32x4) return ValType.F32;
  if (op === SIMDExtractOp.ExtractLaneVecF64x2) return ValType.F64;
  return ValType.I32;
}
