/**
 * @module binaryen-ts/ir/module
 *
 * WebAssembly module structure and builder API.
 *
 * A {@link WasmModule} is the root container for all WASM definitions.
 * The {@link ModuleBuilder} class provides a fluent API for constructing
 * modules, mirroring the `BinaryenModule*` family of functions in the upstream
 * Binaryen C API (`src/binaryen-c.h`).
 *
 * @example
 * ```ts
 * import { ModuleBuilder, ValType } from "@jrmarcum/binaryen-ts/ir";
 *
 * const mod = new ModuleBuilder()
 *   .addFunction("add", [ValType.I32, ValType.I32], [ValType.I32], (b) =>
 *     b.binary(BinaryOp.AddI32, b.localGet(0), b.localGet(1))
 *   )
 *   .addExport("add", "add")
 *   .build();
 * ```
 *
 * @license MIT
 */

import { Expression } from "./expressions.ts";
import { None, Type, ValType } from "./types.ts";
import { type TypeDef } from "./gc-types.ts";
export type { TypeDef } from "./gc-types.ts";

// ---------------------------------------------------------------------------
// Module-level definition types
// ---------------------------------------------------------------------------

/**
 * A single local variable declaration inside a function.
 * Params are also represented as locals (indices 0..params.length-1).
 */
export interface Local {
  /** Type of the local. */
  type: ValType;
  /** Optional name (for WAT output readability). */
  name?: string;
}

/**
 * A WASM function definition.
 * Mirrors `Function` in `src/wasm.h`.
 */
export interface WasmFunction {
  /** Internal name (used for calls and exports). */
  name: string;
  /** Parameter types (subset of locals at indices 0..params.length-1). */
  params: ValType[];
  /** Result types (empty = void). */
  results: ValType[];
  /** All locals including params. Additional locals start at params.length. */
  locals: Local[];
  /** The function body (a single expression, typically a Block). */
  body: Expression;
}

/**
 * Import descriptor.
 * Mirrors `Import` in `src/wasm.h`.
 */
export interface WasmImport {
  /** Internal module name (`"env"`, `"wasi_snapshot_preview1"`, etc.). */
  module: string;
  /** The base name within that module. */
  base: string;
  /** Internal name used to reference this import within the module. */
  name: string;
  /** Which kind of entity is being imported. */
  kind: "function" | "global" | "table" | "memory";
  /** For function imports: parameter types. */
  params?: ValType[];
  /** For function imports: result types. */
  results?: ValType[];
  /** For global imports: value type. For table imports: element type (FuncRef | ExternRef). */
  type?: ValType;
  /** For global imports: whether the global is mutable. */
  mutable?: boolean;
  /** For table/memory imports: minimum size (elements or pages). */
  initial?: number;
  /** For table/memory imports: maximum size, or null for unbounded. */
  max?: number | null;
  /** For memory imports: whether the memory is shared (threads proposal). */
  shared?: boolean;
  /** For memory imports: whether the memory uses 64-bit addressing. */
  is64?: boolean;
}

/**
 * Export descriptor.
 * Mirrors `Export` in `src/wasm.h`.
 */
export interface WasmExport {
  /** The name visible to the host. */
  name: string;
  /** The internal name of the exported entity. */
  value: string;
  /** Which kind of entity is being exported. */
  kind: "function" | "global" | "table" | "memory";
}

/**
 * A WASM global variable.
 */
export interface WasmGlobal {
  /** Internal name used to reference this global from instructions. */
  name: string;
  /** Value type of the global. */
  type: ValType;
  /** Whether the global is writable via `global.set`. */
  mutable: boolean;
  /** Constant initializer expression. */
  init: Expression;
}

/**
 * A data segment (initializes a region of linear memory).
 */
export interface DataSegment {
  /** Segment name (for WAT output). */
  name: string;
  /** `true` for passive segments (not auto-applied at instantiation). */
  passive: boolean;
  /** Offset expression (for active segments). */
  offset: Expression | null;
  /** Raw bytes copied into linear memory. */
  data: Uint8Array;
}

/**
 * A linear memory definition.
 */
export interface WasmMemory {
  /** Internal name used to reference the memory from instructions. */
  name: string;
  /** Initial size in pages (64 KiB each). */
  initial: number;
  /** Maximum size in pages, or `null` for unbounded. */
  max: number | null;
  /** Whether this memory is shared (atomics proposal). */
  shared: boolean;
  /** Whether this memory uses 64-bit addressing (memory64 proposal). */
  is64: boolean;
}

/**
 * A table definition (for indirect calls and reference types).
 */
export interface WasmTable {
  /** Internal name used to reference the table from instructions. */
  name: string;
  /** Element value type — typically a reference type. */
  type: ValType;
  /** Initial number of slots. */
  initial: number;
  /** Maximum number of slots, or `null` for unbounded. */
  max: number | null;
}

/**
 * A WASM exception tag (EH proposal).
 * A tag defines the type of an exception — its payload is a list of value types.
 */
export interface WasmTag {
  /** Internal name (used in `throw` and `try_table` catch clauses). */
  name: string;
  /** Exception payload parameter types. */
  params: ValType[];
}

/**
 * An element segment (populates a table).
 */
export interface ElementSegment {
  /** Segment name (for WAT output). */
  name: string;
  /** Name of the target table that this segment initializes. */
  table: string;
  /** Offset expression — index into the target table where copying begins. */
  offset: Expression | null;
  /** Names of the functions referenced by this segment, in order. */
  data: string[];
}

// ---------------------------------------------------------------------------
// Root module container
// ---------------------------------------------------------------------------

/**
 * The root container for all WASM definitions.
 * Analogous to `Module` in `src/wasm.h`.
 */
export interface WasmModule {
  /** All locally-defined functions in declaration order. */
  functions: WasmFunction[];
  /** All locally-defined globals in declaration order. */
  globals: WasmGlobal[];
  /** All linear-memory definitions (typically 0 or 1 entry pre-multi-memory). */
  memories: WasmMemory[];
  /** All table definitions in declaration order. */
  tables: WasmTable[];
  /** Element segments that initialize tables. */
  elements: ElementSegment[];
  /** Data segments that initialize linear memory. */
  dataSegments: DataSegment[];
  /** Imported entities (functions, globals, memories, tables). */
  imports: WasmImport[];
  /** Names exported to the host. */
  exports: WasmExport[];
  /** Exception tags (EH proposal). */
  tags: WasmTag[];
  /** Whether the module uses the WASM exception-handling proposal. */
  hasExceptionHandling: boolean;
  /** Whether the module uses the memory64 proposal. */
  hasMemory64: boolean;
  /** Whether the module uses the multi-memory proposal. */
  hasMultiMemory: boolean;
  /** User-defined heap types (struct, array, func) for the GC proposal. */
  heapTypes: TypeDef[];
  /** Whether the module uses the GC proposal. */
  hasGC: boolean;
}

// ---------------------------------------------------------------------------
// ModuleBuilder
// ---------------------------------------------------------------------------

/**
 * Fluent builder for constructing {@link WasmModule} instances.
 *
 * All `add*` methods mutate the builder and return `this` for chaining.
 * Call {@link ModuleBuilder.build} to produce the final immutable module.
 *
 * @example
 * ```ts
 * const mod = new ModuleBuilder()
 *   .addMemory("mem0", 1, null)
 *   .addFunction("factorial", [ValType.I32], [ValType.I32], myBody)
 *   .addExport("factorial", "factorial")
 *   .build();
 * ```
 */
export class ModuleBuilder {
  private readonly _functions: WasmFunction[] = [];
  private readonly _globals: WasmGlobal[] = [];
  private readonly _memories: WasmMemory[] = [];
  private readonly _tables: WasmTable[] = [];
  private readonly _elements: ElementSegment[] = [];
  private readonly _dataSegments: DataSegment[] = [];
  private readonly _imports: WasmImport[] = [];
  private readonly _exports: WasmExport[] = [];
  private readonly _tags: WasmTag[] = [];
  private _hasEH = false;
  private _hasMemory64 = false;
  private _hasMultiMemory = false;
  private _hasGC = false;
  private readonly _heapTypes: TypeDef[] = [];

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  /**
   * Adds a function to the module.
   *
   * @param name - Internal function name.
   * @param params - Parameter types.
   * @param results - Return types (empty = void).
   * @param body - The function body expression.
   * @param locals - Additional (non-param) local variables.
   */
  addFunction(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Expression,
    locals: Local[] = [],
  ): this {
    const paramLocals: Local[] = params.map((type) => ({ type }));
    this._functions.push({ name, params, results, locals: [...paramLocals, ...locals], body });
    return this;
  }

  // -------------------------------------------------------------------------
  // Globals
  // -------------------------------------------------------------------------

  /**
   * Adds a global variable.
   *
   * @param name - Internal global name.
   * @param type - Value type.
   * @param mutable - Whether the global can be mutated via `global.set`.
   * @param init - Constant initializer expression.
   */
  addGlobal(name: string, type: ValType, mutable: boolean, init: Expression): this {
    this._globals.push({ name, type, mutable, init });
    return this;
  }

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  /**
   * Adds a linear memory.
   *
   * @param name - Internal memory name.
   * @param initial - Initial size in 64 KiB pages.
   * @param max - Maximum pages, or `null` for unbounded.
   * @param shared - Whether the memory is shared (threads proposal).
   * @param is64 - Whether the memory uses 64-bit addressing (memory64 proposal).
   */
  addMemory(
    name: string,
    initial: number,
    max: number | null = null,
    shared = false,
    is64 = false,
  ): this {
    this._memories.push({ name, initial, max, shared, is64 });
    if (is64) this._hasMemory64 = true;
    return this;
  }

  /**
   * Adds an active data segment that initializes a region of linear memory.
   *
   * @param name - Segment name.
   * @param offset - Constant offset expression (e.g. `makeI32Const(0)`).
   * @param data - Raw bytes.
   */
  addDataSegment(name: string, offset: Expression, data: Uint8Array): this {
    this._dataSegments.push({ name, passive: false, offset, data });
    return this;
  }

  /**
   * Adds a passive data segment (not auto-applied; used with `memory.init`).
   */
  addPassiveDataSegment(name: string, data: Uint8Array): this {
    this._dataSegments.push({ name, passive: true, offset: null, data });
    return this;
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  /**
   * Adds a table definition.
   *
   * @param name - Internal table name.
   * @param type - Element reference type (default `funcref`).
   * @param initial - Initial element count.
   * @param max - Maximum element count, or `null` for unbounded.
   */
  addTable(
    name: string,
    type: ValType = ValType.FuncRef,
    initial = 0,
    max: number | null = null,
  ): this {
    this._tables.push({ name, type, initial, max });
    return this;
  }

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  /**
   * Adds a function import.
   *
   * @param internalName - Name used inside the module to call this function.
   * @param module - External module name (e.g. `"env"`).
   * @param base - External function name.
   * @param params - Parameter types.
   * @param results - Return types.
   */
  addFunctionImport(
    internalName: string,
    module: string,
    base: string,
    params: ValType[],
    results: ValType[],
  ): this {
    this._imports.push({ kind: "function", name: internalName, module, base, params, results });
    return this;
  }

  /**
   * Adds a global import.
   *
   * @param internalName - Name used inside the module to reference this global.
   * @param module - External module name.
   * @param base - External global name.
   * @param type - Value type of the global.
   * @param mutable - Whether the global is mutable.
   */
  addGlobalImport(
    internalName: string,
    module: string,
    base: string,
    type: ValType,
    mutable = false,
  ): this {
    this._imports.push({ kind: "global", name: internalName, module, base, type, mutable });
    return this;
  }

  /**
   * Adds a table import.
   *
   * @param internalName - Name used inside the module to reference this table.
   * @param module - External module name.
   * @param base - External table name.
   * @param type - Element type (`FuncRef` or `ExternRef`).
   * @param initial - Minimum element count.
   * @param max - Maximum element count, or `null` for unbounded.
   */
  addTableImport(
    internalName: string,
    module: string,
    base: string,
    type: ValType = ValType.FuncRef,
    initial = 0,
    max: number | null = null,
  ): this {
    this._imports.push({ kind: "table", name: internalName, module, base, type, initial, max });
    return this;
  }

  /**
   * Adds a memory import.
   *
   * @param internalName - Name used inside the module to reference this memory.
   * @param module - External module name.
   * @param base - External memory name.
   * @param initial - Minimum size in 64 KiB pages.
   * @param max - Maximum pages, or `null` for unbounded.
   * @param shared - Whether the memory is shared (threads proposal).
   * @param is64 - Whether the memory uses 64-bit addressing (memory64 proposal).
   */
  addMemoryImport(
    internalName: string,
    module: string,
    base: string,
    initial: number,
    max: number | null = null,
    shared = false,
    is64 = false,
  ): this {
    this._imports.push({ kind: "memory", name: internalName, module, base, initial, max, shared, is64 });
    return this;
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  /**
   * Adds an export that exposes an internal entity to the host.
   *
   * @param externalName - The name the host will use.
   * @param internalName - The name of the internal function / global / etc.
   * @param kind - The kind of the exported entity.
   */
  addExport(
    externalName: string,
    internalName: string,
    kind: WasmExport["kind"] = "function",
  ): this {
    this._exports.push({ name: externalName, value: internalName, kind });
    return this;
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Tags (EH proposal)
  // -------------------------------------------------------------------------

  /**
   * Adds an exception tag.
   *
   * @param name - Internal tag name (e.g. `"$MyError"`).
   * @param params - The exception payload types.
   */
  addTag(name: string, params: ValType[]): this {
    this._tags.push({ name, params });
    this._hasEH = true;
    return this;
  }

  /** Enables the exception-handling proposal. */
  enableExceptionHandling(): this {
    this._hasEH = true;
    return this;
  }

  /**
   * Adds a user-defined heap type (struct, array, or func) to the type section.
   * Returns the 0-based index for use in GC instructions.
   */
  addHeapType(def: TypeDef): number {
    const idx = this._heapTypes.length;
    this._heapTypes.push(def);
    this._hasGC = true;
    return idx;
  }

  /** Enables the GC proposal. */
  enableGC(): this {
    this._hasGC = true;
    return this;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /**
   * Produces the final {@link WasmModule}.
   * The builder may be reused after calling this method.
   */
  build(): WasmModule {
    return {
      functions: [...this._functions],
      globals: [...this._globals],
      memories: [...this._memories],
      tables: [...this._tables],
      elements: [...this._elements],
      dataSegments: [...this._dataSegments],
      imports: [...this._imports],
      exports: [...this._exports],
      tags: [...this._tags],
      heapTypes: [...this._heapTypes],
      hasExceptionHandling: this._hasEH,
      hasMemory64: this._hasMemory64,
      hasMultiMemory: this._hasMultiMemory,
      hasGC: this._hasGC,
    };
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Returns the function with the given name, or `undefined` if not found. */
  getFunction(name: string): WasmFunction | undefined {
    return this._functions.find((f) => f.name === name);
  }

  /** Returns the global with the given name, or `undefined` if not found. */
  getGlobal(name: string): WasmGlobal | undefined {
    return this._globals.find((g) => g.name === name);
  }

  /** Returns `true` if a function with the given name has been added. */
  hasFunction(name: string): boolean {
    return this._functions.some((f) => f.name === name);
  }

  /** Returns the number of functions currently defined. */
  get functionCount(): number {
    return this._functions.length;
  }

  /** The result type of a local reference, resolving params from a function. */
  static localType(fn: WasmFunction, index: number): ValType | undefined {
    return fn.locals[index]?.type;
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  /**
   * Creates an empty module (convenience alias for `new ModuleBuilder().build()`).
   */
  static empty(): WasmModule {
    return new ModuleBuilder().build();
  }

  /**
   * Returns a new module with the `void` (`none`) return type sentinel for convenience.
   * @deprecated Prefer using `None` from `@jrmarcum/binaryen-ts/ir` directly.
   */
  static readonly Void: Type = None;
}
