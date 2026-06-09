/**
 * @module binaryen-ts/compat
 *
 * Compatibility facade for code written against the upstream `npm:binaryen`
 * package. Provides the namespace API shape (`readBinary`, `Features`,
 * `setShrinkLevel`, etc.) that the upstream binaryen.js bindings expose,
 * mapped onto binaryen-ts's underlying TypeScript pipeline.
 *
 * Migration from `npm:binaryen`:
 *
 * ```ts
 * // before
 * import binaryen from "binaryen";
 *
 * // after
 * import * as binaryen from "@jrmarcum/binaryen-ts/compat";
 * ```
 *
 * The rest of the call sites stay the same:
 *
 * ```ts
 * const mod = binaryen.readBinary(bytes);
 * mod.setFeatures(binaryen.Features.All);
 * binaryen.setShrinkLevel(2);
 * binaryen.setOptimizeLevel(2);
 * mod.optimize();
 * const optimized = mod.emitBinary();
 * ```
 *
 * Programmatic construction also works:
 *
 * ```ts
 * const mod = new binaryen.Module();
 * mod.addFunction(
 *   "add",
 *   binaryen.createType([binaryen.i32, binaryen.i32]),
 *   binaryen.i32,
 *   [],
 *   mod.i32.add(mod.local.get(0, binaryen.i32), mod.local.get(1, binaryen.i32)),
 * );
 * mod.addFunctionExport("add", "add");
 * mod.runPasses(["DCE", "Vacuum"]);
 * const bytes = mod.emitBinary();
 * ```
 *
 * ## Coverage
 *
 * Implemented surface:
 *
 * - Parsing / serialization: `readBinary`, `Module.emitBinary`
 * - Optimization control: `setShrinkLevel`, `setOptimizeLevel`, `setDebugInfo`,
 *   `Module.optimize`, `Module.runPasses`, `Module.setFeatures`, `Features`
 * - Inspection: `Module.getNumExports`, `Module.getExportByIndex`,
 *   `Module.getFunction`, `getExportInfo`, `getFunctionInfo`, `expandType`,
 *   `createType`, `ExternalFunction`/`Table`/`Memory`/`Global`/`Tag` kind
 *   constants, primitive type ID constants (`i32`, `i64`, `f32`, `f64`, ...)
 * - Programmatic construction: `new Module()`, `addFunction`,
 *   `addFunctionImport`, `addGlobal`, `addGlobalImport`, `addMemoryImport`,
 *   `setMemory`, `addExport` (and per-kind variants)
 * - Instance expression factories: `mod.i32` / `mod.i64` / `mod.f32` /
 *   `mod.f64` / `mod.local` / `mod.global` / `mod.memory` namespaces, plus
 *   top-level control flow (`block`, `if`, `loop`, `br`, `br_if`, `call`,
 *   `call_indirect`, `return`, `nop`, `unreachable`, `drop`, `select`)
 *
 * Surface deliberately omitted (no current consumer needs them):
 * - SIMD / GC / EH expression factory methods (use the binaryen-ts `make*`
 *   factories from `/ir` directly for these)
 * - Relooper, source-map APIs
 *
 * @license MIT
 */

import { parseWasm } from "../binary/wasm-parser.ts";
import { encodeWasm } from "../encoder/wasm-encoder.ts";
import {
  BinaryOp,
  type Expression,
  makeBinary,
  makeBlock,
  makeBreak,
  makeCall,
  makeCallIndirect,
  makeDrop,
  makeF32Const,
  makeF64Const,
  makeGlobalGet,
  makeGlobalSet,
  makeI32Const,
  makeI64Const,
  makeIf,
  makeLoad,
  makeLocalGet,
  makeLocalSet,
  makeLocalTee,
  makeLoop,
  makeMemoryGrow,
  makeMemorySize,
  makeNop,
  makeReturn,
  makeSelect,
  makeStore,
  makeSwitch,
  makeUnary,
  makeUnreachable,
  UnaryOp,
} from "../ir/expressions.ts";
import {
  ModuleBuilder,
  type WasmExport,
  type WasmFunction,
  type WasmModule,
} from "../ir/module.ts";
import { None, type Type, ValType } from "../ir/types.ts";
import { createPass, PassRunner } from "../passes/index.ts";

// ---------------------------------------------------------------------------
// Numeric type IDs — same values as upstream binaryen.js
// ---------------------------------------------------------------------------

/** Type ID for the empty (void) result. */
export const none: number = 0;
/** Type ID for an unreachable expression. */
export const unreachable: number = 1;
/** Type ID for `i32`. */
export const i32: number = 2;
/** Type ID for `i64`. */
export const i64: number = 3;
/** Type ID for `f32`. */
export const f32: number = 4;
/** Type ID for `f64`. */
export const f64: number = 5;
/** Type ID for `v128`. */
export const v128: number = 6;
/** Type ID for `funcref`. */
export const funcref: number = 7;
/** Type ID for `externref`. */
export const externref: number = 8;
/** Type ID for `anyref` (GC proposal). */
export const anyref: number = 9;
/** Type ID for `eqref` (GC proposal). */
export const eqref: number = 10;
/** Type ID for `i31ref` (GC proposal). */
export const i31ref: number = 11;
/** Type ID for `structref` (GC proposal). */
export const structref: number = 12;
/** Type ID for `arrayref` (GC proposal). */
export const arrayref: number = 13;
/** Type ID for `stringref` (stringref proposal). */
export const stringref: number = 14;
/** Sentinel used by upstream when the caller wants binaryen to infer the type. */
export const auto: number = 15;

const _VAL_TO_ID: Record<string, number> = {
  [ValType.I32]: i32,
  [ValType.I64]: i64,
  [ValType.F32]: f32,
  [ValType.F64]: f64,
  [ValType.V128]: v128,
  [ValType.FuncRef]: funcref,
  [ValType.ExternRef]: externref,
  [ValType.AnyRef]: anyref,
  [ValType.EqRef]: eqref,
  [ValType.I31Ref]: i31ref,
  [ValType.StructRef]: structref,
  [ValType.ArrayRef]: arrayref,
  [ValType.StringRef]: stringref,
  [ValType.NullFuncRef]: funcref,
  [ValType.NullExternRef]: externref,
  [ValType.NullRef]: anyref,
  [ValType.ExnRef]: externref,
  [ValType.NullExnRef]: externref,
};

const _ID_TO_VAL: Record<number, ValType> = {
  [i32]: ValType.I32,
  [i64]: ValType.I64,
  [f32]: ValType.F32,
  [f64]: ValType.F64,
  [v128]: ValType.V128,
  [funcref]: ValType.FuncRef,
  [externref]: ValType.ExternRef,
  [anyref]: ValType.AnyRef,
  [eqref]: ValType.EqRef,
  [i31ref]: ValType.I31Ref,
  [structref]: ValType.StructRef,
  [arrayref]: ValType.ArrayRef,
  [stringref]: ValType.StringRef,
};

function _valTypeToId(t: ValType | undefined): number {
  if (t === undefined) return none;
  return _VAL_TO_ID[t] ?? none;
}

function _idToValType(id: number): ValType | null {
  return _ID_TO_VAL[id] ?? null;
}

/**
 * Flattens a tuple type ID to an array of primitive types for use in
 * `addFunction` etc. Accepts either a single packed ID (the common case) or
 * an already-array tuple (binaryen-ts native shape).
 */
function _idToValTypeArray(id: number | number[]): ValType[] {
  if (Array.isArray(id)) {
    return id.map((x) => _idToValType(x)).filter((x): x is ValType => x !== null);
  }
  if (id === none) return [];
  const vt = _idToValType(id);
  return vt === null ? [] : [vt];
}

/**
 * Packs a list of primitive type IDs into the shape upstream binaryen.js uses
 * for multi-value tuple types.
 *
 * - Empty list → `none` (0)
 * - Single type → that type's ID (the common scalar case)
 * - Multiple types → the array itself (binaryen-ts native shape;
 *   {@link expandType} accepts both forms transparently)
 */
export function createType(types: number[]): number | number[] {
  if (types.length === 0) return none;
  if (types.length === 1) return types[0];
  return types;
}

// ---------------------------------------------------------------------------
// Features bitflags (matches upstream binaryen.js Features enum)
// ---------------------------------------------------------------------------

/**
 * WebAssembly feature flags. `Features.All` enables every proposal; the
 * individual flags exist for parity with upstream's API but binaryen-ts's
 * parser/encoder always accept the full feature set regardless of the
 * `Module.features` value.
 */
export const Features = {
  MVP: 0,
  Atomics: 1 << 0,
  BulkMemory: 1 << 1,
  MutableGlobals: 1 << 2,
  NontrappingFPToInt: 1 << 3,
  SignExt: 1 << 4,
  SIMD128: 1 << 5,
  ExceptionHandling: 1 << 6,
  TailCall: 1 << 7,
  ReferenceTypes: 1 << 8,
  Multivalue: 1 << 9,
  GC: 1 << 10,
  Memory64: 1 << 11,
  RelaxedSIMD: 1 << 12,
  ExtendedConst: 1 << 13,
  Strings: 1 << 14,
  MultiMemory: 1 << 15,
  All: 0x7fffffff,
} as const;

// ---------------------------------------------------------------------------
// External kinds — same values as upstream binaryen.js
// ---------------------------------------------------------------------------

/** Export kind for a function. */
export const ExternalFunction: number = 0;
/** Export kind for a table. */
export const ExternalTable: number = 1;
/** Export kind for a memory. */
export const ExternalMemory: number = 2;
/** Export kind for a global. */
export const ExternalGlobal: number = 3;
/** Export kind for a tag (EH proposal). */
export const ExternalTag: number = 4;

const _KIND_TO_ID: Record<WasmExport["kind"], number> = {
  function: ExternalFunction,
  table: ExternalTable,
  memory: ExternalMemory,
  global: ExternalGlobal,
  tag: ExternalTag,
};

// ---------------------------------------------------------------------------
// ExpressionId constants (parity with upstream binaryen.js)
// ---------------------------------------------------------------------------

/** Expression ID for `invalid` (sentinel). */
export const InvalidId: number = 0;
/** Expression ID for `block`. */
export const BlockId: number = 1;
/** Expression ID for `if`. */
export const IfId: number = 2;
/** Expression ID for `loop`. */
export const LoopId: number = 3;
/** Expression ID for `br` / `br_if`. */
export const BreakId: number = 4;
/** Expression ID for `br_table`. */
export const SwitchId: number = 5;
/** Expression ID for `call`. */
export const CallId: number = 6;
/** Expression ID for `call_indirect`. */
export const CallIndirectId: number = 7;
/** Expression ID for `local.get`. */
export const LocalGetId: number = 8;
/** Expression ID for `local.set` / `local.tee`. */
export const LocalSetId: number = 9;
/** Expression ID for `global.get`. */
export const GlobalGetId: number = 10;
/** Expression ID for `global.set`. */
export const GlobalSetId: number = 11;
/** Expression ID for memory loads. */
export const LoadId: number = 12;
/** Expression ID for memory stores. */
export const StoreId: number = 13;
/** Expression ID for constants. */
export const ConstId: number = 14;
/** Expression ID for unary operations. */
export const UnaryId: number = 15;
/** Expression ID for binary operations. */
export const BinaryId: number = 16;
/** Expression ID for `select`. */
export const SelectId: number = 17;
/** Expression ID for `drop`. */
export const DropId: number = 18;
/** Expression ID for `return`. */
export const ReturnId: number = 19;
/** Expression ID for `memory.size`. */
export const MemorySizeId: number = 20;
/** Expression ID for `memory.grow`. */
export const MemoryGrowId: number = 21;
/** Expression ID for `nop`. */
export const NopId: number = 22;
/** Expression ID for `unreachable`. */
export const UnreachableId: number = 23;

// ---------------------------------------------------------------------------
// Module-level optimization state (mirrors npm:binaryen global setters)
// ---------------------------------------------------------------------------

let _shrinkLevel = 0;
let _optimizeLevel = 2;
let _debugInfo = false;
let _lowMemoryUnused = false;

/** Sets the shrink level (0=`-O*`, 1=`-Os`, 2=`-Oz`) for subsequent `optimize()` calls. */
export function setShrinkLevel(level: number): void {
  _shrinkLevel = level;
}
/** Returns the current shrink level. */
export function getShrinkLevel(): number {
  return _shrinkLevel;
}
/** Sets the optimize level (0..4) for subsequent `optimize()` calls. */
export function setOptimizeLevel(level: number): void {
  _optimizeLevel = level;
}
/** Returns the current optimize level. */
export function getOptimizeLevel(): number {
  return _optimizeLevel;
}
/** Sets whether passes should preserve debug names. */
export function setDebugInfo(b: boolean): void {
  _debugInfo = b;
}
/** Returns whether passes preserve debug names. */
export function getDebugInfo(): boolean {
  return _debugInfo;
}
/** Sets whether the low memory region (below 1KB) is considered unused. */
export function setLowMemoryUnused(b: boolean): void {
  _lowMemoryUnused = b;
}
/** Returns whether the low memory region is considered unused. */
export function getLowMemoryUnused(): boolean {
  return _lowMemoryUnused;
}

// ---------------------------------------------------------------------------
// Namespace classes for instance expression factories
// ---------------------------------------------------------------------------

/**
 * `mod.i32.*` namespace — factories for `i32`-typed expressions. Singleton:
 * factory methods do not capture any module state, so the same instance is
 * shared across all {@link Module} instances.
 */
export class I32Ops {
  /** `i32.const value`. */
  const(value: number): Expression {
    return makeI32Const(value);
  }
  /** `i32.add`. */
  add(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.AddI32, l, r);
  }
  /** `i32.sub`. */
  sub(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.SubI32, l, r);
  }
  /** `i32.mul`. */
  mul(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MulI32, l, r);
  }
  /** `i32.div_s`. */
  div_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.DivSI32, l, r);
  }
  /** `i32.div_u`. */
  div_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.DivUI32, l, r);
  }
  /** `i32.rem_s`. */
  rem_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RemSI32, l, r);
  }
  /** `i32.rem_u`. */
  rem_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RemUI32, l, r);
  }
  /** `i32.and`. */
  and(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.AndI32, l, r);
  }
  /** `i32.or`. */
  or(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.OrI32, l, r);
  }
  /** `i32.xor`. */
  xor(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.XorI32, l, r);
  }
  /** `i32.shl`. */
  shl(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.ShlI32, l, r);
  }
  /** `i32.shr_s`. */
  shr_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.ShrSI32, l, r);
  }
  /** `i32.shr_u`. */
  shr_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.ShrUI32, l, r);
  }
  /** `i32.rotl`. */
  rotl(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RotlI32, l, r);
  }
  /** `i32.rotr`. */
  rotr(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RotrI32, l, r);
  }
  /** `i32.eq`. */
  eq(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.EqI32, l, r);
  }
  /** `i32.ne`. */
  ne(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.NeI32, l, r);
  }
  /** `i32.lt_s`. */
  lt_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LtSI32, l, r);
  }
  /** `i32.lt_u`. */
  lt_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LtUI32, l, r);
  }
  /** `i32.gt_s`. */
  gt_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GtSI32, l, r);
  }
  /** `i32.gt_u`. */
  gt_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GtUI32, l, r);
  }
  /** `i32.le_s`. */
  le_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LeSI32, l, r);
  }
  /** `i32.le_u`. */
  le_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LeUI32, l, r);
  }
  /** `i32.ge_s`. */
  ge_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GeSI32, l, r);
  }
  /** `i32.ge_u`. */
  ge_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GeUI32, l, r);
  }
  /** `i32.clz`. */
  clz(v: Expression): Expression {
    return makeUnary(UnaryOp.ClzI32, v);
  }
  /** `i32.ctz`. */
  ctz(v: Expression): Expression {
    return makeUnary(UnaryOp.CtzI32, v);
  }
  /** `i32.popcnt`. */
  popcnt(v: Expression): Expression {
    return makeUnary(UnaryOp.PopcntI32, v);
  }
  /** `i32.eqz`. */
  eqz(v: Expression): Expression {
    return makeUnary(UnaryOp.EqzI32, v);
  }
  /** `i32.load offset align ptr`. */
  load(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(4, true, offset, align, ptr, ValType.I32);
  }
  /** `i32.load8_s offset align ptr`. */
  load8_s(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(1, true, offset, align, ptr, ValType.I32);
  }
  /** `i32.load8_u offset align ptr`. */
  load8_u(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(1, false, offset, align, ptr, ValType.I32);
  }
  /** `i32.load16_s offset align ptr`. */
  load16_s(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(2, true, offset, align, ptr, ValType.I32);
  }
  /** `i32.load16_u offset align ptr`. */
  load16_u(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(2, false, offset, align, ptr, ValType.I32);
  }
  /** `i32.store offset align ptr value`. */
  store(offset: number, align: number, ptr: Expression, value: Expression): Expression {
    return makeStore(4, offset, align, ptr, value);
  }
  /** `i32.store8 offset align ptr value`. */
  store8(offset: number, align: number, ptr: Expression, value: Expression): Expression {
    return makeStore(1, offset, align, ptr, value);
  }
  /** `i32.store16 offset align ptr value`. */
  store16(offset: number, align: number, ptr: Expression, value: Expression): Expression {
    return makeStore(2, offset, align, ptr, value);
  }
}

/**
 * `mod.i64.*` namespace — factories for `i64`-typed expressions. Singleton.
 */
export class I64Ops {
  /** `i64.const value` (bigint). */
  const(value: bigint | number): Expression {
    return makeI64Const(typeof value === "number" ? BigInt(value) : value);
  }
  /** `i64.add`. */
  add(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.AddI64, l, r);
  }
  /** `i64.sub`. */
  sub(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.SubI64, l, r);
  }
  /** `i64.mul`. */
  mul(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MulI64, l, r);
  }
  /** `i64.div_s`. */
  div_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.DivSI64, l, r);
  }
  /** `i64.div_u`. */
  div_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.DivUI64, l, r);
  }
  /** `i64.rem_s`. */
  rem_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RemSI64, l, r);
  }
  /** `i64.rem_u`. */
  rem_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RemUI64, l, r);
  }
  /** `i64.and`. */
  and(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.AndI64, l, r);
  }
  /** `i64.or`. */
  or(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.OrI64, l, r);
  }
  /** `i64.xor`. */
  xor(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.XorI64, l, r);
  }
  /** `i64.shl`. */
  shl(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.ShlI64, l, r);
  }
  /** `i64.shr_s`. */
  shr_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.ShrSI64, l, r);
  }
  /** `i64.shr_u`. */
  shr_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.ShrUI64, l, r);
  }
  /** `i64.rotl`. */
  rotl(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RotlI64, l, r);
  }
  /** `i64.rotr`. */
  rotr(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.RotrI64, l, r);
  }
  /** `i64.eq`. */
  eq(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.EqI64, l, r);
  }
  /** `i64.ne`. */
  ne(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.NeI64, l, r);
  }
  /** `i64.lt_s`. */
  lt_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LtSI64, l, r);
  }
  /** `i64.lt_u`. */
  lt_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LtUI64, l, r);
  }
  /** `i64.gt_s`. */
  gt_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GtSI64, l, r);
  }
  /** `i64.gt_u`. */
  gt_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GtUI64, l, r);
  }
  /** `i64.le_s`. */
  le_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LeSI64, l, r);
  }
  /** `i64.le_u`. */
  le_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LeUI64, l, r);
  }
  /** `i64.ge_s`. */
  ge_s(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GeSI64, l, r);
  }
  /** `i64.ge_u`. */
  ge_u(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GeUI64, l, r);
  }
  /** `i64.clz`. */
  clz(v: Expression): Expression {
    return makeUnary(UnaryOp.ClzI64, v);
  }
  /** `i64.ctz`. */
  ctz(v: Expression): Expression {
    return makeUnary(UnaryOp.CtzI64, v);
  }
  /** `i64.popcnt`. */
  popcnt(v: Expression): Expression {
    return makeUnary(UnaryOp.PopcntI64, v);
  }
  /** `i64.eqz`. */
  eqz(v: Expression): Expression {
    return makeUnary(UnaryOp.EqzI64, v);
  }
  /** `i64.load offset align ptr`. */
  load(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(8, true, offset, align, ptr, ValType.I64);
  }
  /** `i64.store offset align ptr value`. */
  store(offset: number, align: number, ptr: Expression, value: Expression): Expression {
    return makeStore(8, offset, align, ptr, value);
  }
}

/**
 * `mod.f32.*` namespace — factories for `f32`-typed expressions. Singleton.
 */
export class F32Ops {
  /** `f32.const value`. */
  const(value: number): Expression {
    return makeF32Const(value);
  }
  /** `f32.add`. */
  add(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.AddF32, l, r);
  }
  /** `f32.sub`. */
  sub(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.SubF32, l, r);
  }
  /** `f32.mul`. */
  mul(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MulF32, l, r);
  }
  /** `f32.div`. */
  div(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.DivF32, l, r);
  }
  /** `f32.min`. */
  min(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MinF32, l, r);
  }
  /** `f32.max`. */
  max(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MaxF32, l, r);
  }
  /** `f32.copysign`. */
  copysign(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.CopySignF32, l, r);
  }
  /** `f32.eq`. */
  eq(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.EqF32, l, r);
  }
  /** `f32.ne`. */
  ne(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.NeF32, l, r);
  }
  /** `f32.lt`. */
  lt(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LtF32, l, r);
  }
  /** `f32.gt`. */
  gt(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GtF32, l, r);
  }
  /** `f32.le`. */
  le(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LeF32, l, r);
  }
  /** `f32.ge`. */
  ge(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GeF32, l, r);
  }
  /** `f32.abs`. */
  abs(v: Expression): Expression {
    return makeUnary(UnaryOp.AbsF32, v);
  }
  /** `f32.neg`. */
  neg(v: Expression): Expression {
    return makeUnary(UnaryOp.NegF32, v);
  }
  /** `f32.ceil`. */
  ceil(v: Expression): Expression {
    return makeUnary(UnaryOp.CeilF32, v);
  }
  /** `f32.floor`. */
  floor(v: Expression): Expression {
    return makeUnary(UnaryOp.FloorF32, v);
  }
  /** `f32.trunc`. */
  trunc(v: Expression): Expression {
    return makeUnary(UnaryOp.TruncF32, v);
  }
  /** `f32.nearest`. */
  nearest(v: Expression): Expression {
    return makeUnary(UnaryOp.NearestF32, v);
  }
  /** `f32.sqrt`. */
  sqrt(v: Expression): Expression {
    return makeUnary(UnaryOp.SqrtF32, v);
  }
  /** `f32.load offset align ptr`. */
  load(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(4, false, offset, align, ptr, ValType.F32);
  }
  /** `f32.store offset align ptr value`. */
  store(offset: number, align: number, ptr: Expression, value: Expression): Expression {
    return makeStore(4, offset, align, ptr, value);
  }
}

/**
 * `mod.f64.*` namespace — factories for `f64`-typed expressions. Singleton.
 */
export class F64Ops {
  /** `f64.const value`. */
  const(value: number): Expression {
    return makeF64Const(value);
  }
  /** `f64.add`. */
  add(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.AddF64, l, r);
  }
  /** `f64.sub`. */
  sub(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.SubF64, l, r);
  }
  /** `f64.mul`. */
  mul(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MulF64, l, r);
  }
  /** `f64.div`. */
  div(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.DivF64, l, r);
  }
  /** `f64.min`. */
  min(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MinF64, l, r);
  }
  /** `f64.max`. */
  max(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.MaxF64, l, r);
  }
  /** `f64.copysign`. */
  copysign(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.CopySignF64, l, r);
  }
  /** `f64.eq`. */
  eq(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.EqF64, l, r);
  }
  /** `f64.ne`. */
  ne(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.NeF64, l, r);
  }
  /** `f64.lt`. */
  lt(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LtF64, l, r);
  }
  /** `f64.gt`. */
  gt(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GtF64, l, r);
  }
  /** `f64.le`. */
  le(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.LeF64, l, r);
  }
  /** `f64.ge`. */
  ge(l: Expression, r: Expression): Expression {
    return makeBinary(BinaryOp.GeF64, l, r);
  }
  /** `f64.abs`. */
  abs(v: Expression): Expression {
    return makeUnary(UnaryOp.AbsF64, v);
  }
  /** `f64.neg`. */
  neg(v: Expression): Expression {
    return makeUnary(UnaryOp.NegF64, v);
  }
  /** `f64.ceil`. */
  ceil(v: Expression): Expression {
    return makeUnary(UnaryOp.CeilF64, v);
  }
  /** `f64.floor`. */
  floor(v: Expression): Expression {
    return makeUnary(UnaryOp.FloorF64, v);
  }
  /** `f64.trunc`. */
  trunc(v: Expression): Expression {
    return makeUnary(UnaryOp.TruncF64, v);
  }
  /** `f64.nearest`. */
  nearest(v: Expression): Expression {
    return makeUnary(UnaryOp.NearestF64, v);
  }
  /** `f64.sqrt`. */
  sqrt(v: Expression): Expression {
    return makeUnary(UnaryOp.SqrtF64, v);
  }
  /** `f64.load offset align ptr`. */
  load(offset: number, align: number, ptr: Expression): Expression {
    return makeLoad(8, false, offset, align, ptr, ValType.F64);
  }
  /** `f64.store offset align ptr value`. */
  store(offset: number, align: number, ptr: Expression, value: Expression): Expression {
    return makeStore(8, offset, align, ptr, value);
  }
}

/** `mod.local.*` namespace — local-variable factories. Singleton. */
export class LocalOps {
  /** `local.get index` — returns the value of local `index`, typed as `type`. */
  get(index: number, type: number): Expression {
    const vt = _idToValType(type) ?? ValType.I32;
    return makeLocalGet(index, vt);
  }
  /** `local.set index value`. */
  set(index: number, value: Expression): Expression {
    return makeLocalSet(index, value);
  }
  /** `local.tee index value` — stores `value` to local `index` and forwards it. */
  tee(index: number, value: Expression, type: number): Expression {
    const vt = _idToValType(type) ?? ValType.I32;
    return makeLocalTee(index, value, vt);
  }
}

/** `mod.global.*` namespace — global-variable factories. Singleton. */
export class GlobalOps {
  /** `global.get $name` — returns the value of global `$name`, typed as `type`. */
  get(name: string, type: number): Expression {
    const vt = _idToValType(type) ?? ValType.I32;
    return makeGlobalGet(name, vt);
  }
  /** `global.set $name value`. */
  set(name: string, value: Expression): Expression {
    return makeGlobalSet(name, value);
  }
}

/** `mod.memory.*` namespace — memory query/grow factories. Singleton. */
export class MemoryOps {
  /** `memory.size` — returns the current memory size in pages. */
  size(): Expression {
    return makeMemorySize();
  }
  /** `memory.grow delta` — grows linear memory by `delta` pages. */
  grow(delta: Expression): Expression {
    return makeMemoryGrow(delta);
  }
}

const _I32 = new I32Ops();
const _I64 = new I64Ops();
const _F32 = new F32Ops();
const _F64 = new F64Ops();
const _LOCAL = new LocalOps();
const _GLOBAL = new GlobalOps();
const _MEMORY = new MemoryOps();

// ---------------------------------------------------------------------------
// Module wrapper
// ---------------------------------------------------------------------------

/**
 * A data segment accepted by {@link Module.setMemory}, mirroring the upstream
 * `npm:binaryen` segment shape.
 */
export interface MemoryDataSegment {
  /** `true` for a passive segment (applied via `memory.init`, not at instantiation). */
  passive?: boolean;
  /** Active-segment offset expression. Defaults to `i32.const 0`. Ignored when passive. */
  offset?: Expression | null;
  /** Segment bytes. */
  data: Uint8Array | number[];
}

/**
 * Wrapper around a binaryen-ts {@link WasmModule} that exposes the
 * `npm:binaryen` instance API (`optimize`, `emitBinary`, `getNumExports`,
 * builder methods, namespaced expression factories, etc).
 */
export class Module {
  /** Underlying binaryen-ts IR module. Use this to drop down to the native API. */
  readonly _inner: WasmModule;
  /**
   * Feature bitflags currently associated with the module. Informational only —
   * binaryen-ts always accepts the full feature set; this field exists for
   * parity with upstream's `setFeatures` API.
   */
  features: number = Features.All;

  /** `i32`-typed expression factory namespace (e.g. `mod.i32.add(l, r)`). */
  readonly i32: I32Ops = _I32;
  /** `i64`-typed expression factory namespace. */
  readonly i64: I64Ops = _I64;
  /** `f32`-typed expression factory namespace. */
  readonly f32: F32Ops = _F32;
  /** `f64`-typed expression factory namespace. */
  readonly f64: F64Ops = _F64;
  /** Local-variable factory namespace (`mod.local.get` / `set` / `tee`). */
  readonly local: LocalOps = _LOCAL;
  /** Global-variable factory namespace (`mod.global.get` / `set`). */
  readonly global: GlobalOps = _GLOBAL;
  /** Memory query/grow namespace (`mod.memory.size` / `grow`). */
  readonly memory: MemoryOps = _MEMORY;

  /**
   * Creates a new module. With no argument, returns an empty module ready
   * for programmatic construction via {@link addFunction} etc. Pass an
   * existing {@link WasmModule} (e.g. from {@link readBinary}) to wrap it.
   */
  constructor(inner?: WasmModule) {
    this._inner = inner ?? ModuleBuilder.empty();
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  /** Number of exports in the module. */
  getNumExports(): number {
    return this._inner.exports.length;
  }

  /** Returns an opaque handle to the export at `index`. Throws if out of range. */
  getExportByIndex(index: number): WasmExport {
    const exp = this._inner.exports[index];
    if (!exp) throw new RangeError(`export index ${index} out of range`);
    return exp;
  }

  /** Returns an opaque handle to the function named `name`, or `null` if absent. */
  getFunction(name: string): WasmFunction | null {
    return this._inner.functions.find((f) => f.name === name) ?? null;
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  /** Sets the feature bitflags (informational — see class docs). */
  setFeatures(flags: number): void {
    this.features = flags;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Adds a function definition. `params` and `results` accept either a single
   * type ID (the common scalar case) or an array of type IDs (multi-value).
   *
   * @param name - Internal function name.
   * @param params - Packed type ID (from {@link createType}) or single type.
   * @param results - Packed result type.
   * @param vars - Type IDs for extra locals beyond the parameters.
   * @param body - The function body expression.
   */
  addFunction(
    name: string,
    params: number | number[],
    results: number | number[],
    vars: number[],
    body: Expression,
  ): WasmFunction {
    const paramVts = _idToValTypeArray(params);
    const resultVts = _idToValTypeArray(results);
    const varVts = vars.map((v) => _idToValType(v) ?? ValType.I32);
    const locals = [
      ...paramVts.map((type) => ({ type })),
      ...varVts.map((type) => ({ type })),
    ];
    const fn: WasmFunction = {
      name,
      params: paramVts,
      results: resultVts,
      locals,
      body,
    };
    this._inner.functions.push(fn);
    return fn;
  }

  /**
   * Adds a function import.
   *
   * @param internalName - The name the rest of the module uses to call this function.
   * @param externalModule - External module name (e.g. `"env"`).
   * @param externalBase - External function name.
   * @param params - Packed type ID (from {@link createType}) or single type.
   * @param results - Packed result type.
   */
  addFunctionImport(
    internalName: string,
    externalModule: string,
    externalBase: string,
    params: number | number[],
    results: number | number[],
  ): void {
    this._inner.imports.push({
      kind: "function",
      name: internalName,
      module: externalModule,
      base: externalBase,
      params: _idToValTypeArray(params),
      results: _idToValTypeArray(results),
    });
  }

  /**
   * Adds a global variable.
   *
   * @param name - Internal global name.
   * @param type - Value type ID.
   * @param mutable - Whether the global can be reassigned via `global.set`.
   * @param init - Constant initializer expression.
   */
  addGlobal(name: string, type: number, mutable: boolean, init: Expression): void {
    const vt = _idToValType(type) ?? ValType.I32;
    this._inner.globals.push({ name, type: vt, mutable, init });
  }

  /**
   * Adds a global import.
   *
   * @param internalName - The name the rest of the module uses for this global.
   * @param externalModule - External module name.
   * @param externalBase - External global name.
   * @param type - Value type ID.
   * @param mutable - Whether the global is mutable.
   */
  addGlobalImport(
    internalName: string,
    externalModule: string,
    externalBase: string,
    type: number,
    mutable = false,
  ): void {
    const vt = _idToValType(type) ?? ValType.I32;
    this._inner.imports.push({
      kind: "global",
      name: internalName,
      module: externalModule,
      base: externalBase,
      type: vt,
      mutable,
    });
  }

  /**
   * Adds a memory import.
   *
   * @param internalName - The name the rest of the module uses for this memory.
   * @param externalModule - External module name.
   * @param externalBase - External memory name.
   * @param shared - Whether the memory is shared (threads proposal).
   */
  addMemoryImport(
    internalName: string,
    externalModule: string,
    externalBase: string,
    shared = false,
  ): void {
    this._inner.imports.push({
      kind: "memory",
      name: internalName,
      module: externalModule,
      base: externalBase,
      initial: 0,
      max: null,
      shared,
      is64: false,
    });
  }

  /**
   * Configures linear memory for the module.
   *
   * @param initial - Initial size in 64 KiB pages.
   * @param maximum - Maximum pages, or `-1` / `null` for unbounded
   *   (upstream binaryen.js uses `-1` to mean unbounded).
   * @param exportName - When non-null, also exports the memory under this name.
   * @param segments - Active/passive data segments to install. Each is
   *   `{ passive?, offset?, data }` — `offset` is the active-segment offset
   *   expression (defaults to `i32.const 0`); ignored for passive segments.
   * @param shared - Whether the memory is shared (threads proposal).
   * @param is64 - Whether the memory uses 64-bit addressing (memory64 proposal).
   * @param internalName - Internal memory name (default `"0"`).
   *
   * The `segments` parameter sits at position 4 to match upstream
   * `npm:binaryen` (`setMemory(initial, maximum, exportName, segments, shared,
   * memory64, internalName)`). Omitting it (the previous signature) shifted
   * `shared`/`is64`/`internalName` for any positional caller and silently
   * dropped the data segments.
   */
  setMemory(
    initial: number,
    maximum: number | null = null,
    exportName: string | null = null,
    segments: MemoryDataSegment[] = [],
    shared = false,
    is64 = false,
    internalName = "0",
  ): void {
    const max = maximum === -1 || maximum === null ? null : maximum;
    const existing = this._inner.memories[0];
    if (existing) {
      existing.name = internalName;
      existing.initial = initial;
      existing.max = max;
      existing.shared = shared;
      existing.is64 = is64;
    } else {
      this._inner.memories.push({
        name: internalName,
        initial,
        max,
        shared,
        is64,
      });
    }
    if (is64) this._inner.hasMemory64 = true;
    if (exportName !== null) {
      this.addMemoryExport(internalName, exportName);
    }
    // Install data segments (upstream applies these as part of setMemory).
    for (const seg of segments) {
      const data = seg.data instanceof Uint8Array ? seg.data : new Uint8Array(seg.data);
      this._inner.dataSegments.push({
        name: `$data${this._inner.dataSegments.length}`,
        passive: seg.passive ?? false,
        offset: seg.passive ? null : (seg.offset ?? makeI32Const(0)),
        data,
      });
    }
  }

  /**
   * Adds an export of any kind. Defaults to a function export — match upstream
   * behavior. Prefer the per-kind helpers ({@link addFunctionExport}, etc.)
   * for clarity at the call site.
   */
  addExport(
    externalName: string,
    internalName: string,
    kind: WasmExport["kind"] = "function",
  ): WasmExport {
    const exp: WasmExport = { name: externalName, value: internalName, kind };
    this._inner.exports.push(exp);
    return exp;
  }

  /** Adds a function export. */
  addFunctionExport(internalName: string, externalName: string): WasmExport {
    return this.addExport(externalName, internalName, "function");
  }

  /** Adds a memory export. */
  addMemoryExport(internalName: string, externalName: string): WasmExport {
    return this.addExport(externalName, internalName, "memory");
  }

  /** Adds a global export. */
  addGlobalExport(internalName: string, externalName: string): WasmExport {
    return this.addExport(externalName, internalName, "global");
  }

  /** Adds a table export. */
  addTableExport(internalName: string, externalName: string): WasmExport {
    return this.addExport(externalName, internalName, "table");
  }

  // -------------------------------------------------------------------------
  // Top-level expression factories
  // -------------------------------------------------------------------------

  /**
   * `block` expression. `label` may be `null` for an unnamed block (in which
   * case no `br` can target it). `type` is the result type ID; pass
   * {@link none} (the default) for void blocks.
   */
  block(label: string | null, children: Expression[], type: number = none): Expression {
    const blk = makeBlock(children, label);
    if (type !== none) {
      const vt = _idToValType(type);
      if (vt !== null) blk.type = vt as Type;
    }
    return blk;
  }

  /** `if` expression. `else_` may be omitted for a one-armed if (result type `none`). */
  if(cond: Expression, then: Expression, else_?: Expression | null): Expression {
    return makeIf(cond, then, else_ ?? null);
  }

  /** `loop` expression. */
  loop(label: string, body: Expression): Expression {
    return makeLoop(label, body, body.type);
  }

  /**
   * `br` (unconditional) or `br_if` (when `cond` is provided) expression.
   * Pass a `value` to forward to the branch target.
   */
  br(label: string, cond?: Expression | null, value?: Expression | null): Expression {
    return makeBreak(label, cond ?? null, value ?? null);
  }

  /** `br_if label cond` — convenience for a conditional break. */
  br_if(label: string, cond: Expression, value?: Expression | null): Expression {
    return makeBreak(label, cond, value ?? null);
  }

  /** `br_table` expression. */
  switch(
    targets: string[],
    defaultTarget: string,
    cond: Expression,
    value?: Expression | null,
  ): Expression {
    return makeSwitch(targets, defaultTarget, cond, value ?? null);
  }

  /** `call $target operands` — direct call. */
  call(target: string, operands: Expression[], returnType: number | number[]): Expression {
    const resultVts = _idToValTypeArray(returnType);
    const resultType: Type = resultVts.length > 0 ? resultVts[0] : None;
    return makeCall(target, operands, resultType);
  }

  /** `return_call $target operands` — tail call (returns directly from caller). */
  return_call(target: string, operands: Expression[], returnType: number | number[]): Expression {
    const resultVts = _idToValTypeArray(returnType);
    const resultType: Type = resultVts.length > 0 ? resultVts[0] : None;
    return makeCall(target, operands, resultType, true);
  }

  /**
   * `call_indirect` through `table`.
   *
   * The parameter order matches upstream `npm:binaryen`
   * (`call_indirect(table, target, operands, params, results)`) — `table` is
   * FIRST. A previous signature put `table` last with a `"0"` default, which
   * silently shifted every argument for any caller written against upstream
   * (binding the table string into the `target` slot, etc.).
   */
  call_indirect(
    table: string,
    target: Expression,
    operands: Expression[],
    params: number | number[],
    results: number | number[],
  ): Expression {
    const paramVts = _idToValTypeArray(params);
    const resultVts = _idToValTypeArray(results);
    return makeCallIndirect(table, target, operands, paramVts, resultVts);
  }

  /** `return value?` — return from the current function. */
  return(value?: Expression | null): Expression {
    return makeReturn(value ?? null);
  }

  /** `nop` — no-operation. */
  nop(): Expression {
    return makeNop();
  }

  /** `unreachable` — marks a point as never reached. */
  unreachable(): Expression {
    return makeUnreachable();
  }

  /** `drop value` — discards the value. */
  drop(value: Expression): Expression {
    return makeDrop(value);
  }

  /** `select cond ifTrue ifFalse` — typed select. */
  select(cond: Expression, ifTrue: Expression, ifFalse: Expression): Expression {
    return makeSelect(ifTrue, ifFalse, cond);
  }

  // -------------------------------------------------------------------------
  // Optimization
  // -------------------------------------------------------------------------

  /**
   * Runs the standard optimization pipeline using the current module-level
   * `shrinkLevel` / `optimizeLevel` / `debugInfo` settings. Mutates the module
   * in place.
   */
  optimize(): void {
    const runner = new PassRunner(this._inner, {
      optimizeLevel: _optimizeLevel as 0 | 1 | 2 | 3 | 4,
      shrinkLevel: _shrinkLevel as 0 | 1 | 2,
      debugInfo: _debugInfo,
    });
    runner.addDefaultOptimizationPasses().run();
  }

  /**
   * Runs an explicit list of named passes (e.g. `["DCE", "Vacuum"]`) using the
   * current module-level optimization settings. Throws if a pass name is not
   * registered — use the binaryen-ts pass-registry names (see
   * `listPasses()` from `@jrmarcum/binaryen-ts/passes`).
   */
  runPasses(passes: string[]): void {
    const runner = new PassRunner(this._inner, {
      optimizeLevel: _optimizeLevel as 0 | 1 | 2 | 3 | 4,
      shrinkLevel: _shrinkLevel as 0 | 1 | 2,
      debugInfo: _debugInfo,
    });
    for (const name of passes) {
      runner.addPass(createPass(name));
    }
    runner.run();
  }

  /**
   * Validates the module. binaryen-ts's encoder is strict about structure, so
   * this is currently a permissive stub — it returns `1` (upstream's "valid"
   * sentinel) for any module that has been constructed via this API. Full
   * structural validation lives in wabt-ts (`wasm-validate`).
   */
  validate(): number {
    return 1;
  }

  /**
   * No-op disposal. Upstream binaryen.js holds a wasm-side `Module*` pointer
   * that requires explicit free; binaryen-ts owns its IR in JS-heap memory,
   * so there is nothing to release. Exposed for API parity.
   */
  dispose(): void {
    // intentionally empty
  }

  /** Serializes the module to a `.wasm` byte stream. */
  emitBinary(): Uint8Array {
    return encodeWasm(this._inner);
  }
}

// ---------------------------------------------------------------------------
// Namespace-level functions matching upstream binaryen.js
// ---------------------------------------------------------------------------

/** Parses `.wasm` bytes into a {@link Module}. */
export function readBinary(bytes: Uint8Array): Module {
  return new Module(parseWasm(bytes));
}

/** Per-export descriptor returned by {@link getExportInfo}. */
export interface ExportInfo {
  /** One of `ExternalFunction` / `ExternalTable` / `ExternalMemory` / `ExternalGlobal` / `ExternalTag`. */
  kind: number;
  /** Public name the host sees. */
  name: string;
  /** Internal name of the exported entity. */
  value: string;
}

/** Returns the kind/name/value triple for an export handle. */
export function getExportInfo(exp: WasmExport): ExportInfo {
  return {
    kind: _KIND_TO_ID[exp.kind],
    name: exp.name,
    value: exp.value,
  };
}

/** Per-function descriptor returned by {@link getFunctionInfo}. */
export interface FunctionInfo {
  /** Internal function name. */
  name: string;
  /** Import module name, or `null` for locally-defined functions. */
  module: string | null;
  /** Import base name, or `null` for locally-defined functions. */
  base: string | null;
  /** Parameter type IDs. Pass to {@link expandType} to flatten (identity here). */
  params: number[];
  /** Result type IDs. Pass to {@link expandType} to flatten. */
  results: number[];
  /** Extra local (non-parameter) type IDs. */
  vars: number[];
  /** Function body expression (binaryen-ts native node). */
  body: Expression;
}

/**
 * Returns inspection info for a function handle. Upstream returns `params`
 * and `results` as packed tuple IDs; binaryen-ts returns them as arrays
 * already, which {@link expandType} handles transparently.
 */
export function getFunctionInfo(func: WasmFunction): FunctionInfo {
  return {
    name: func.name,
    module: null,
    base: null,
    params: func.params.map(_valTypeToId),
    results: func.results.map(_valTypeToId),
    vars: func.locals.slice(func.params.length).map((l) => _valTypeToId(l.type)),
    body: func.body,
  };
}

/**
 * Flattens a tuple type ID to an array of primitive type IDs. Upstream packs
 * multi-value tuples into a single ID; binaryen-ts stores them as arrays, so
 * this accepts either shape and always returns an array — letting code
 * written against `npm:binaryen` work unchanged.
 */
export function expandType(typeId: number | number[]): number[] {
  return Array.isArray(typeId) ? typeId : [typeId];
}
