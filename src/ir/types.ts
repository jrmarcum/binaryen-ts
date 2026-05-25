/**
 * @module binaryen-ts/ir/types
 *
 * WebAssembly type system definitions for the binaryen-ts IR.
 *
 * This module mirrors the type hierarchy in the upstream Binaryen C++ library
 * (`src/wasm-type.h`) and represents it as TypeScript discriminated unions and
 * const enums for zero-cost type safety.
 *
 * **Value types** are the primitive types that WASM values carry at runtime.
 * **Heap types** support the GC (garbage collection) proposal.
 * **Type** is the top-level alias — either a single value type, a tuple (for
 * multi-value), the special `unreachable` / `none` sentinels, or a GC
 * reference type (`RefType`).
 *
 * @example
 * ```ts
 * import { ValType, Type, typeToString } from "@jrmarcum/binaryen-ts/ir";
 *
 * const t: Type = ValType.I32;
 * console.log(typeToString(t)); // "i32"
 *
 * const tuple: Type = [ValType.I32, ValType.F64];
 * console.log(typeToString(tuple)); // "(i32 f64)"
 * ```
 *
 * @license MIT
 */

import { isRefType, refTypeToString, type RefType } from "./gc-types.ts";
export type { RefType } from "./gc-types.ts";

// ---------------------------------------------------------------------------
// Value types (MVP + SIMD + reference types)
// ---------------------------------------------------------------------------

/**
 * Primitive WebAssembly value types.
 *
 * These are the value types that WASM values carry at runtime. The set covers
 * the MVP types plus the SIMD and reference-types proposals.
 */
export enum ValType {
  /** 32-bit integer */
  I32 = "i32",
  /** 64-bit integer */
  I64 = "i64",
  /** 32-bit float */
  F32 = "f32",
  /** 64-bit float */
  F64 = "f64",
  /** 128-bit SIMD vector */
  V128 = "v128",
  /** Nullable function reference */
  FuncRef = "funcref",
  /** Nullable external (host) reference */
  ExternRef = "externref",
  /** Nullable any reference (GC proposal) */
  AnyRef = "anyref",
  /** Nullable eq reference (GC proposal) */
  EqRef = "eqref",
  /** Nullable i31 reference (GC proposal) */
  I31Ref = "i31ref",
  /** Nullable struct reference (GC proposal) */
  StructRef = "structref",
  /** Nullable array reference (GC proposal) */
  ArrayRef = "arrayref",
  /** String reference (stringref proposal) */
  StringRef = "stringref",
  /** Null function reference (bottom type) */
  NullFuncRef = "nullfuncref",
  /** Null external reference (bottom type) */
  NullExternRef = "nullexternref",
  /** Null any reference (bottom type) */
  NullRef = "nullref",
  /** Exception reference (EH proposal) */
  ExnRef = "exnref",
  /** Null exception reference (bottom type, EH proposal) */
  NullExnRef = "nullexnref",
}

// ---------------------------------------------------------------------------
// Special sentinel types (not value types but appear in type positions)
// ---------------------------------------------------------------------------

/** Signals a diverging / bottom computation. Used as the type of `unreachable`. */
export const Unreachable = "unreachable" as const;
export type Unreachable = typeof Unreachable;

/** The empty type — represents a void return or the empty tuple. */
export const None = "none" as const;
export type None = typeof None;

// ---------------------------------------------------------------------------
// Compound / multi-value types
// ---------------------------------------------------------------------------

/**
 * A tuple type (multi-value return).
 * Represented as an ordered array of {@link ValType} values.
 * An empty array is equivalent to {@link None}.
 */
export type TupleType = (ValType | RefType)[];

// ---------------------------------------------------------------------------
// Top-level Type alias
// ---------------------------------------------------------------------------

/**
 * The union of all types that can appear in a binaryen-ts IR node's `type` field.
 *
 * - A single {@link ValType} for most expressions.
 * - A {@link TupleType} (array) for multi-value blocks and calls.
 * - {@link None} (`"none"`) for void / empty returns.
 * - {@link Unreachable} (`"unreachable"`) for diverging expressions.
 * - A {@link RefType} for GC reference-typed expressions (`ref.cast`, `struct.new`, etc.).
 */
export type Type = ValType | TupleType | None | Unreachable | RefType;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Returns the WAT textual representation of a {@link Type}.
 *
 * @example
 * ```ts
 * typeToString(ValType.I32)              // → "i32"
 * typeToString([ValType.I32, ValType.F64]) // → "(i32 f64)"
 * typeToString(None)                     // → ""
 * typeToString(Unreachable)              // → "unreachable"
 * ```
 */
export function typeToString(t: Type): string {
  if (t === None) return "";
  if (t === Unreachable) return "unreachable";
  if (Array.isArray(t)) {
    if (t.length === 0) return "";
    const strs = t.map((e) => isRefType(e) ? refTypeToString(e) : e as string);
    if (strs.length === 1) return strs[0];
    return `(${strs.join(" ")})`;
  }
  if (isRefType(t)) return refTypeToString(t);
  return t as string;
}

/**
 * Returns `true` if the type is concrete (not `none` or `unreachable`).
 */
export function isConcrete(t: Type): t is ValType | TupleType {
  return t !== None && t !== Unreachable;
}

/**
 * Returns `true` if the type is an integer type (`i32` or `i64`).
 */
export function isInteger(t: Type): boolean {
  return t === ValType.I32 || t === ValType.I64;
}

/**
 * Returns `true` if the type is a floating-point type (`f32` or `f64`).
 */
export function isFloat(t: Type): boolean {
  return t === ValType.F32 || t === ValType.F64;
}

/**
 * Returns `true` if the type is a reference type (abstract ValType ref or GC RefType).
 */
export function isRef(t: Type): boolean {
  if (isRefType(t)) return true;
  if (Array.isArray(t) || t === None || t === Unreachable) return false;
  return (
    t === ValType.FuncRef ||
    t === ValType.ExternRef ||
    t === ValType.AnyRef ||
    t === ValType.EqRef ||
    t === ValType.I31Ref ||
    t === ValType.StructRef ||
    t === ValType.ArrayRef ||
    t === ValType.StringRef ||
    t === ValType.NullFuncRef ||
    t === ValType.NullExternRef ||
    t === ValType.NullRef ||
    t === ValType.ExnRef ||
    t === ValType.NullExnRef
  );
}

/**
 * Returns the byte size of a value type, or `null` for non-concrete types.
 */
export function byteSize(t: ValType): number {
  switch (t) {
    case ValType.I32:
    case ValType.F32:
      return 4;
    case ValType.I64:
    case ValType.F64:
      return 8;
    case ValType.V128:
      return 16;
    default:
      return 4; // references are pointer-sized (4 bytes in wasm32)
  }
}
