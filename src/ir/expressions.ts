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
 * import { makeConst, makeLocalGet, makeBinary } from "@jrmarcum/binaryen-ts/ir";
 *
 * const expr = makeBinary(
 *   BinaryOp.AddI32,
 *   makeLocalGet(0, ValType.I32),
 *   makeConst({ i32: 1 }),
 * );
 * ```
 *
 * @license Apache-2.0
 */

import { None, Type, Unreachable, ValType } from "./types.ts";

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
}

// ---------------------------------------------------------------------------
// Expression node types (discriminated union)
// ---------------------------------------------------------------------------

/** Common base for all expression nodes. */
interface ExprBase {
  /** The WAT instruction name (discriminant). */
  kind: ExpressionKind;
  /** The result type of this expression. */
  type: Type;
}

export interface NopExpr extends ExprBase {
  kind: ExpressionKind.Nop;
  type: None;
}

export interface UnreachableExpr extends ExprBase {
  kind: ExpressionKind.Unreachable;
  type: Unreachable;
}

export interface BlockExpr extends ExprBase {
  kind: ExpressionKind.Block;
  /** Optional label for branch targets. */
  name: string | null;
  children: Expression[];
}

export interface IfExpr extends ExprBase {
  kind: ExpressionKind.If;
  condition: Expression;
  ifTrue: Expression;
  ifFalse: Expression | null;
}

export interface LoopExpr extends ExprBase {
  kind: ExpressionKind.Loop;
  /** Branch label for `br` back-edges. */
  name: string;
  body: Expression;
}

export interface BreakExpr extends ExprBase {
  kind: ExpressionKind.Break;
  /** Target label. */
  name: string;
  /** Optional condition — when present this is a `br_if`. */
  condition: Expression | null;
  /** Optional forwarded value. */
  value: Expression | null;
}

export interface SwitchExpr extends ExprBase {
  kind: ExpressionKind.Switch;
  /** Branch table targets. */
  targets: string[];
  defaultTarget: string;
  condition: Expression;
  value: Expression | null;
}

export interface ReturnExpr extends ExprBase {
  kind: ExpressionKind.Return;
  value: Expression | null;
}

export interface ConstExpr extends ExprBase {
  kind: ExpressionKind.Const;
  value: Literal;
}

export interface LocalGetExpr extends ExprBase {
  kind: ExpressionKind.LocalGet;
  /** Local index. */
  index: number;
}

export interface LocalSetExpr extends ExprBase {
  kind: ExpressionKind.LocalSet;
  index: number;
  value: Expression;
}

export interface LocalTeeExpr extends ExprBase {
  kind: ExpressionKind.LocalTee;
  index: number;
  value: Expression;
}

export interface GlobalGetExpr extends ExprBase {
  kind: ExpressionKind.GlobalGet;
  name: string;
}

export interface GlobalSetExpr extends ExprBase {
  kind: ExpressionKind.GlobalSet;
  name: string;
  value: Expression;
}

export interface UnaryExpr extends ExprBase {
  kind: ExpressionKind.Unary;
  op: UnaryOp;
  value: Expression;
}

export interface BinaryExpr extends ExprBase {
  kind: ExpressionKind.Binary;
  op: BinaryOp;
  left: Expression;
  right: Expression;
}

export interface SelectExpr extends ExprBase {
  kind: ExpressionKind.Select;
  ifTrue: Expression;
  ifFalse: Expression;
  condition: Expression;
}

export interface DropExpr extends ExprBase {
  kind: ExpressionKind.Drop;
  type: None;
  value: Expression;
}

/** Memory load node. */
export interface LoadExpr extends ExprBase {
  kind: ExpressionKind.Load;
  /** Byte width of the memory access (1, 2, 4, 8, 16). */
  bytes: 1 | 2 | 4 | 8 | 16;
  /** Whether the loaded integer is sign-extended. */
  signed: boolean;
  offset: number;
  align: number;
  ptr: Expression;
}

/** Memory store node. */
export interface StoreExpr extends ExprBase {
  kind: ExpressionKind.Store;
  bytes: 1 | 2 | 4 | 8 | 16;
  offset: number;
  align: number;
  ptr: Expression;
  value: Expression;
}

export interface MemoryGrowExpr extends ExprBase {
  kind: ExpressionKind.MemoryGrow;
  type: ValType.I32;
  delta: Expression;
}

export interface MemorySizeExpr extends ExprBase {
  kind: ExpressionKind.MemorySize;
  type: ValType.I32;
}

export interface MemoryCopyExpr extends ExprBase {
  kind: ExpressionKind.MemoryCopy;
  type: None;
  dest: Expression;
  source: Expression;
  size: Expression;
}

export interface MemoryFillExpr extends ExprBase {
  kind: ExpressionKind.MemoryFill;
  type: None;
  dest: Expression;
  value: Expression;
  size: Expression;
}

export interface CallExpr extends ExprBase {
  kind: ExpressionKind.Call;
  target: string;
  operands: Expression[];
  isReturn: boolean;
}

export interface CallIndirectExpr extends ExprBase {
  kind: ExpressionKind.CallIndirect;
  table: string;
  target: Expression;
  operands: Expression[];
  params: ValType[];
  results: ValType[];
  isReturn: boolean;
}

export interface RefNullExpr extends ExprBase {
  kind: ExpressionKind.RefNull;
}

export interface RefIsNullExpr extends ExprBase {
  kind: ExpressionKind.RefIsNull;
  type: ValType.I32;
  value: Expression;
}

export interface RefFuncExpr extends ExprBase {
  kind: ExpressionKind.RefFunc;
  func: string;
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
  | RefFuncExpr;

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
  const type: Type = value ? value.type : None;
  return { kind: ExpressionKind.Return, type, value };
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

// ---------------------------------------------------------------------------
// Internal type inference helpers
// ---------------------------------------------------------------------------

function inferBinaryType(op: BinaryOp): ValType {
  if (op.startsWith("i32")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  return ValType.F64;
}

function inferUnaryType(op: UnaryOp): ValType {
  if (op.startsWith("i32")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  return ValType.F64;
}
