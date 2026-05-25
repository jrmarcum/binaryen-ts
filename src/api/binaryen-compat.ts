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
 * ## Coverage
 *
 * Implemented surface (enough for `wasmtk`'s optimization + inspection paths):
 *
 * - Parsing / serialization: `readBinary`, `Module.emitBinary`
 * - Optimization control: `setShrinkLevel`, `setOptimizeLevel`, `setDebugInfo`,
 *   `Module.optimize`, `Module.setFeatures`, `Features`
 * - Inspection: `Module.getNumExports`, `Module.getExportByIndex`,
 *   `Module.getFunction`, `getExportInfo`, `getFunctionInfo`, `expandType`,
 *   `ExternalFunction`/`Table`/`Memory`/`Global`/`Tag` kind constants,
 *   primitive type ID constants (`i32`, `i64`, `f32`, `f64`, ...).
 *
 * Surface that `npm:binaryen` exposes but this facade does NOT yet implement:
 * - Programmatic module construction via `new binaryen.Module()` + low-level
 *   instruction factories (`Const`, `Add`, `Call`, ...). Use the binaryen-ts
 *   high-level API instead (`createModule`, `ExprBuilder`).
 * - Pass-name strings as `mod.runPasses([...])`. Use the binaryen-ts
 *   `PassRunner` directly if you need per-pass control.
 *
 * @license MIT
 */

import { parseWasm } from "../binary/wasm-parser.ts";
import { encodeWasm } from "../encoder/wasm-encoder.ts";
import type { Expression } from "../ir/expressions.ts";
import type { WasmExport, WasmFunction, WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import { PassRunner } from "../passes/index.ts";

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

function _valTypeToId(t: ValType | undefined): number {
  if (t === undefined) return none;
  return _VAL_TO_ID[t] ?? none;
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
};

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
// Module wrapper
// ---------------------------------------------------------------------------

/**
 * Wrapper around a binaryen-ts {@link WasmModule} that exposes the
 * `npm:binaryen` instance API (`optimize`, `emitBinary`, `getNumExports`, etc).
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

  /** @internal */
  constructor(inner: WasmModule) {
    this._inner = inner;
  }

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

  /** Sets the feature bitflags (informational — see class docs). */
  setFeatures(flags: number): void {
    this.features = flags;
  }

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
