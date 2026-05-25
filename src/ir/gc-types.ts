/**
 * @module binaryen-ts/ir/gc-types
 *
 * GC proposal type definitions for the binaryen-ts IR.
 *
 * This module defines the heap type hierarchy, reference types, and user-defined
 * struct/array/func type definitions introduced by the WebAssembly GC proposal.
 *
 * **Heap types** can be either abstract (built-in) or user-defined (type index).
 * **Reference types** are `(ref $T)` (non-nullable) or `(ref null $T)` (nullable).
 * **Type definitions** are the entries in the module's type section: func, struct, or array.
 *
 * @example
 * ```ts
 * import { AbstractHeapType, type RefType } from "@jrmarcum/binaryen-ts/ir";
 *
 * const i31ref: RefType = { heap: AbstractHeapType.I31, nullable: true };
 * const ref0: RefType  = { heap: 0, nullable: false }; // (ref $0)
 * ```
 *
 * @license MIT OR Apache-2.0
 */

import { type ValType } from "./types.ts";

// ---------------------------------------------------------------------------
// Heap types
// ---------------------------------------------------------------------------

/**
 * Abstract (built-in) heap types from the GC proposal.
 * Mirrors `HeapType::BasicHeapType` in upstream Binaryen.
 */
export enum AbstractHeapType {
  /** Top of the function reference hierarchy. */
  Func   = "func",
  /** Bottom of the function reference hierarchy (null func). */
  NoFunc = "nofunc",
  /** External (host) reference. */
  Ext    = "ext",
  /** Bottom of the external reference hierarchy. */
  NoExt  = "noext",
  /** Top of the GC reference hierarchy. */
  Any    = "any",
  /** Equatable references (structs, arrays, i31). */
  Eq     = "eq",
  /** 31-bit integers as references. */
  I31    = "i31",
  /** Abstract struct type. */
  Struct = "struct",
  /** Abstract array type. */
  Array  = "array",
  /** Bottom of the GC reference hierarchy (null ref). */
  None   = "none",
  /** Exception reference. */
  Exn    = "exn",
  /** Bottom of the exception reference hierarchy. */
  NoExn  = "noexn",
}

/**
 * A heap type: either an abstract built-in or a user-defined type index.
 *
 * - `AbstractHeapType` → one of the built-in GC heap types.
 * - `number` → a 0-based index into {@link WasmModule.heapTypes}.
 */
export type HeapType = AbstractHeapType | number;

// ---------------------------------------------------------------------------
// Reference types
// ---------------------------------------------------------------------------

/**
 * A WebAssembly reference type: `(ref $T)` or `(ref null $T)`.
 *
 * Used anywhere a value type is expected when the value is a GC reference.
 *
 * @example
 * ```ts
 * const anyref: RefType = { heap: AbstractHeapType.Any, nullable: true };
 * const nonNullI31: RefType = { heap: AbstractHeapType.I31, nullable: false };
 * const userStruct: RefType = { heap: 0, nullable: false }; // (ref $0)
 * ```
 */
export interface RefType {
  /** The target heap type. */
  heap: HeapType;
  /** Whether a null value is allowed. */
  nullable: boolean;
}

// ---------------------------------------------------------------------------
// Struct / array field types
// ---------------------------------------------------------------------------

/**
 * Packed integer storage types for struct and array fields.
 * These are not valid value types — they are only valid inside field declarations.
 */
export type PackedType = "i8" | "i16";

/**
 * The storage type of a struct or array field: a value type, a packed integer,
 * or a reference type.
 */
export type StorageType = ValType | PackedType | RefType;

/**
 * A struct or array field declaration.
 */
export interface FieldType {
  /** The storage type of this field. */
  type: StorageType;
  /** Whether the field can be mutated after construction. */
  mutable: boolean;
}

// ---------------------------------------------------------------------------
// User-defined type definitions
// ---------------------------------------------------------------------------

/**
 * A user-defined struct type.
 *
 * @example
 * ```ts
 * const pointType: StructTypeDef = {
 *   kind: "struct",
 *   fields: [
 *     { type: ValType.I32, mutable: false }, // x
 *     { type: ValType.I32, mutable: false }, // y
 *   ],
 * };
 * ```
 */
export interface StructTypeDef {
  kind: "struct";
  /** The ordered list of field declarations. */
  fields: FieldType[];
}

/**
 * A user-defined array type.
 *
 * @example
 * ```ts
 * const intArrayType: ArrayTypeDef = {
 *   kind: "array",
 *   element: { type: ValType.I32, mutable: true },
 * };
 * ```
 */
export interface ArrayTypeDef {
  kind: "array";
  /** The element field declaration. */
  element: FieldType;
}

/**
 * A function type stored explicitly in the module's type section.
 * Used when GC types are present (so all type indices are stable).
 */
export interface FuncTypeDef {
  kind: "func";
  params: (ValType | RefType)[];
  results: (ValType | RefType)[];
}

/**
 * A user-defined type entry in the module's type section.
 */
export type TypeDef = StructTypeDef | ArrayTypeDef | FuncTypeDef;

// ---------------------------------------------------------------------------
// Type guard utilities
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the value is a {@link RefType} object.
 *
 * Useful to narrow `ValType | RefType` unions.
 */
export function isRefType(t: unknown): t is RefType {
  return (
    typeof t === "object" &&
    t !== null &&
    !Array.isArray(t) &&
    "heap" in t &&
    "nullable" in t
  );
}

/**
 * Returns `true` if the heap type is an abstract built-in (string).
 */
export function isAbstractHeapType(h: HeapType): h is AbstractHeapType {
  return typeof h === "string";
}

/**
 * Returns `true` if the storage type is a packed integer (`i8` or `i16`).
 */
export function isPackedType(t: StorageType): t is PackedType {
  return t === "i8" || t === "i16";
}

// ---------------------------------------------------------------------------
// String conversion helpers
// ---------------------------------------------------------------------------

/**
 * Returns the WAT text representation of a {@link HeapType}.
 *
 * Abstract types use their built-in name; type indices use `$typeN`.
 */
export function heapTypeToString(h: HeapType): string {
  if (typeof h === "string") return h;
  return `$type${h}`;
}

/**
 * Returns the WAT text representation of a {@link RefType}.
 *
 * @example
 * ```ts
 * refTypeToString({ heap: AbstractHeapType.I31, nullable: true })  // → "(ref null i31)"
 * refTypeToString({ heap: 0, nullable: false })                    // → "(ref $type0)"
 * ```
 */
export function refTypeToString(rt: RefType): string {
  const inner = heapTypeToString(rt.heap);
  return rt.nullable ? `(ref null ${inner})` : `(ref ${inner})`;
}

/**
 * Returns the WAT text representation of a {@link StorageType}.
 */
export function storageTypeToString(t: StorageType): string {
  if (isRefType(t)) return refTypeToString(t);
  return t as string;
}

// ---------------------------------------------------------------------------
// Canonical abstract-type shorthands (convenience RefType values)
// ---------------------------------------------------------------------------

/** `anyref` = `(ref null any)` */
export const anyref: RefType  = { heap: AbstractHeapType.Any,    nullable: true };
/** `eqref`  = `(ref null eq)`  */
export const eqref: RefType   = { heap: AbstractHeapType.Eq,     nullable: true };
/** `i31ref` = `(ref null i31)` */
export const i31ref: RefType  = { heap: AbstractHeapType.I31,    nullable: true };
/** `structref` = `(ref null struct)` */
export const structref: RefType = { heap: AbstractHeapType.Struct, nullable: true };
/** `arrayref` = `(ref null array)` */
export const arrayref: RefType = { heap: AbstractHeapType.Array,  nullable: true };
/** `funcref` = `(ref null func)` */
export const funcref: RefType  = { heap: AbstractHeapType.Func,   nullable: true };
/** `externref` = `(ref null ext)` */
export const externref: RefType = { heap: AbstractHeapType.Ext,   nullable: true };
/** `nullref` = `(ref null none)` */
export const nullref: RefType  = { heap: AbstractHeapType.None,   nullable: true };