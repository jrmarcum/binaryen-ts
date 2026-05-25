/**
 * @module binaryen-ts/api
 *
 * High-level public API for `binaryen-ts`.
 *
 * This module exposes a unified, ergonomic interface for building, analyzing,
 * and optimizing WebAssembly modules. It is the recommended entry point for
 * application code — prefer this over importing from sub-modules directly.
 *
 * The API surface is intentionally modeled after `binaryen.js` to ease
 * migration from the upstream JavaScript bindings, but takes advantage of
 * TypeScript discriminated unions and const enums for compile-time safety.
 *
 * @example
 * ```ts
 * import { createModule, BinaryOp, ValType } from "@jrmarcum/binaryen-ts/api";
 * import { writeFile } from "node:fs/promises";
 *
 * const mod = createModule((b) => {
 *   b.addFunction("add", [ValType.I32, ValType.I32], [ValType.I32], (e) =>
 *     e.return(e.binary(BinaryOp.AddI32, e.localGet(0), e.localGet(1)))
 *   );
 *   b.addExport("add", "add");
 * });
 *
 * const wasm = await mod.optimize("-Oz");
 * await writeFile("add.wasm", wasm);
 * ```
 *
 * ## Runtime support
 *
 * Pure-TypeScript paths (IR construction, encoder, pass pipeline) run on Deno,
 * Node 18+, Bun, and any modern browser. The `optimize()` shorthand uses the
 * subprocess bridge when `hybridMode: true`, which is Node/Deno/Bun only.
 *
 * @license MIT OR Apache-2.0
 */

import {
  BinaryOp,
  Expression,
  ExpressionKind,
  makeBlock,
  makeBinary,
  makeDrop,
  makeF32Const,
  makeF64Const,
  makeI32Const,
  makeI64Const,
  makeIf,
  makeLocalGet,
  makeLocalSet,
  makeLocalTee,
  makeNop,
  makeReturn,
  makeUnary,
  makeUnreachable,
  UnaryOp,
} from "../ir/expressions.ts";
import {
  Local,
  ModuleBuilder,
  WasmFunction,
  WasmModule,
} from "../ir/module.ts";
import { None, Type, ValType } from "../ir/types.ts";
import { BinaryenInterop } from "../interop/binaryen-js.ts";
import { PassRunner } from "../passes/index.ts";

// ---------------------------------------------------------------------------
// Expression builder (fluent helper passed to function body closures)
// ---------------------------------------------------------------------------

/**
 * Fluent expression builder.
 * An instance is passed to the callback in {@link FunctionBodyBuilder}
 * so function bodies can be written in a readable, composable style.
 */
export class ExprBuilder {
  /** `i32` constant. */
  i32(v: number): Expression { return makeI32Const(v); }
  /** `i64` constant. */
  i64(v: bigint): Expression { return makeI64Const(v); }
  /** `f32` constant. */
  f32(v: number): Expression { return makeF32Const(v); }
  /** `f64` constant. */
  f64(v: number): Expression { return makeF64Const(v); }
  /** `local.get` — reads local at `index`. */
  localGet(index: number, type: ValType = ValType.I32): Expression { return makeLocalGet(index, type); }
  /** `local.set` — writes `value` to local at `index`. */
  localSet(index: number, value: Expression): Expression { return makeLocalSet(index, value); }
  /** `local.tee` — writes `value` to local at `index` and forwards the value. */
  localTee(index: number, value: Expression, type: ValType): Expression { return makeLocalTee(index, value, type); }
  /** Binary operation. */
  binary(op: BinaryOp, left: Expression, right: Expression): Expression { return makeBinary(op, left, right); }
  /** Unary operation. */
  unary(op: UnaryOp, value: Expression): Expression { return makeUnary(op, value); }
  /** `if` expression. */
  if(cond: Expression, then: Expression, else_?: Expression): Expression { return makeIf(cond, then, else_ ?? null); }
  /** `block` expression. */
  block(children: Expression[], name?: string): Expression { return makeBlock(children, name ?? null); }
  /** `return` expression. */
  return(value?: Expression): Expression { return makeReturn(value ?? null); }
  /** `drop` — discard a value. */
  drop(value: Expression): Expression { return makeDrop(value); }
  /** `nop` — no-operation. */
  nop(): Expression { return makeNop(); }
  /** `unreachable` — marks a point as never reached. */
  unreachable(): Expression { return makeUnreachable(); }
}

// ---------------------------------------------------------------------------
// Module wrapper with optimization methods
// ---------------------------------------------------------------------------

/**
 * A compiled {@link WasmModule} with optimization and serialization methods.
 */
export class Module {
  private readonly _inner: WasmModule;

  /** @internal */
  constructor(inner: WasmModule) {
    this._inner = inner;
  }

  /** The underlying raw IR module. */
  get ir(): WasmModule { return this._inner; }

  /**
   * Optimizes the module and returns the WASM binary bytes.
   *
   * @param flags - Optimization preset (e.g. `"-Oz"`, `"-O3"`).
   *   When `hybridMode` is true, this is passed directly to the upstream
   *   `wasm-opt` subprocess.
   * @param hybridMode - Use upstream binaryen.js / wasm-opt subprocess.
   *   Default: `false` (TypeScript pass infrastructure).
   */
  async optimize(flags = "-Oz", hybridMode = false): Promise<Uint8Array> {
    if (hybridMode) {
      const wat = this.toWat();
      return BinaryenInterop.optimizeViaSubprocess(wat, [flags]);
    }
    const runner = new PassRunner(this._inner, {
      optimizeLevel: 2,
      shrinkLevel: flags.includes("z") ? 2 : flags.includes("s") ? 1 : 0,
    });
    runner.addDefaultOptimizationPasses().run();
    return this.toBinary();
  }

  /**
   * Serializes the module to WAT text format.
   * @returns WAT text as a string.
   */
  toWat(): string {
    return serializeToWat(this._inner);
  }

  /**
   * Serializes the module to binary WASM.
   * @returns Binary WASM bytes.
   */
  toBinary(): Uint8Array {
    // TODO(phase 2): implement native WAT→WASM assembler.
    // For now, serialize to WAT and call wabt's wat2wasm as subprocess.
    throw new Error(
      "Module.toBinary() is not yet implemented in native mode.\n" +
        "Call Module.optimize(..., hybridMode=true) to use the upstream wasm-opt subprocess,\n" +
        "or use BinaryenInterop.optimizeViaSubprocess() directly.",
    );
  }
}

// ---------------------------------------------------------------------------
// createModule — primary factory
// ---------------------------------------------------------------------------

/**
 * Callback type for the {@link createModule} body builder.
 * Receives a {@link ModuleBuilder} for defining functions, globals, etc.
 */
export type ModuleBodyBuilder = (builder: ModuleBuilder, expr: ExprBuilder) => void;

/**
 * Creates a {@link Module} using a fluent builder callback.
 *
 * This is the primary factory function for application code.
 *
 * @param body - Callback that populates the module via the provided {@link ModuleBuilder}.
 * @returns A {@link Module} ready for optimization or serialization.
 *
 * @example
 * ```ts
 * import { createModule, BinaryOp, ValType } from "@jrmarcum/binaryen-ts/api";
 *
 * const mod = createModule((b, e) => {
 *   b.addFunction("square", [ValType.I32], [ValType.I32],
 *     e.return(e.binary(BinaryOp.MulI32, e.localGet(0), e.localGet(0)))
 *   );
 *   b.addExport("square", "square");
 * });
 * ```
 */
export function createModule(body: ModuleBodyBuilder): Module {
  const builder = new ModuleBuilder();
  const expr = new ExprBuilder();
  body(builder, expr);
  return new Module(builder.build());
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { BinaryOp, UnaryOp } from "../ir/expressions.ts";
export { ExpressionKind } from "../ir/expressions.ts";
export { ModuleBuilder } from "../ir/module.ts";
export { ValType, None, Unreachable, typeToString, isInteger, isFloat, isRef } from "../ir/types.ts";
export type { Expression, Literal } from "../ir/expressions.ts";
export type { WasmModule, WasmFunction, WasmGlobal, Local, WasmExport, WasmImport } from "../ir/module.ts";
export type { Type } from "../ir/types.ts";

// ---------------------------------------------------------------------------
// WAT serialization (stub — full impl is phase 2)
// ---------------------------------------------------------------------------

/**
 * Serializes a {@link WasmModule} to WAT text.
 *
 * @internal Stub — full implementation is planned for Phase 2.
 */
function serializeToWat(mod: WasmModule): string {
  const lines: string[] = ["(module"];

  for (const imp of mod.imports) {
    if (imp.kind === "function") {
      const params = (imp.params ?? []).map((t) => `(param ${t})`).join(" ");
      const results = (imp.results ?? []).map((t) => `(result ${t})`).join(" ");
      const sig = [params, results].filter(Boolean).join(" ");
      lines.push(`  (import "${imp.module}" "${imp.base}" (func $${imp.name}${sig ? " " + sig : ""}))`);
    }
  }

  for (const mem of mod.memories) {
    const maxStr = mem.max !== null ? ` ${mem.max}` : "";
    lines.push(`  (memory $${mem.name} ${mem.initial}${maxStr})`);
  }

  for (const g of mod.globals) {
    const mut = g.mutable ? `(mut ${g.type})` : g.type;
    lines.push(`  (global $${g.name} ${mut} ${exprToWat(g.init, 2)})`);
  }

  for (const fn of mod.functions) {
    const params = fn.params.map((t, i) => `(param $p${i} ${t})`).join(" ");
    const results = fn.results.map((t) => `(result ${t})`).join(" ");
    const header = [params, results].filter(Boolean).join(" ");
    lines.push(`  (func $${fn.name}${header ? " " + header : ""}`);
    const extraLocals = fn.locals.slice(fn.params.length);
    for (const loc of extraLocals) {
      lines.push(`    (local ${loc.name ?? ""} ${loc.type})`);
    }
    lines.push(`    ${exprToWat(fn.body, 4)}`);
    lines.push("  )");
  }

  for (const exp of mod.exports) {
    lines.push(`  (export "${exp.name}" (${exp.kind} $${exp.value}))`);
  }

  lines.push(")");
  return lines.join("\n");
}

/**
 * Renders a single expression to WAT text (recursive, depth-first).
 * @internal
 */
function exprToWat(expr: Expression, _indent: number): string {
  switch (expr.kind) {
    case ExpressionKind.Nop:
      return "(nop)";
    case ExpressionKind.Unreachable:
      return "(unreachable)";
    case ExpressionKind.Const: {
      const v = expr.value;
      if ("i32" in v) return `(i32.const ${v.i32})`;
      if ("i64" in v) return `(i64.const ${v.i64})`;
      if ("f32" in v) return `(f32.const ${v.f32})`;
      return `(f64.const ${"f64" in v ? v.f64 : 0})`;
    }
    case ExpressionKind.LocalGet:
      return `(local.get ${expr.index})`;
    case ExpressionKind.LocalSet:
      return `(local.set ${expr.index} ${exprToWat(expr.value, _indent)})`;
    case ExpressionKind.LocalTee:
      return `(local.tee ${expr.index} ${exprToWat(expr.value, _indent)})`;
    case ExpressionKind.GlobalGet:
      return `(global.get $${expr.name})`;
    case ExpressionKind.GlobalSet:
      return `(global.set $${expr.name} ${exprToWat(expr.value, _indent)})`;
    case ExpressionKind.Binary:
      return `(${expr.op} ${exprToWat(expr.left, _indent)} ${exprToWat(expr.right, _indent)})`;
    case ExpressionKind.Unary:
      return `(${expr.op} ${exprToWat(expr.value, _indent)})`;
    case ExpressionKind.Return:
      return expr.value ? `(return ${exprToWat(expr.value, _indent)})` : "(return)";
    case ExpressionKind.Drop:
      return `(drop ${exprToWat(expr.value, _indent)})`;
    case ExpressionKind.Block: {
      const label = expr.name ? ` $${expr.name}` : "";
      const result = expr.type !== None ? ` (result ${expr.type})` : "";
      const body = expr.children.map((c) => `  ${exprToWat(c, _indent + 2)}`).join("\n");
      return `(block${label}${result}\n${body}\n)`;
    }
    case ExpressionKind.If: {
      const result = expr.type !== None ? ` (result ${expr.type})` : "";
      const then = `(then ${exprToWat(expr.ifTrue, _indent)})`;
      const else_ = expr.ifFalse ? ` (else ${exprToWat(expr.ifFalse, _indent)})` : "";
      return `(if${result} ${exprToWat(expr.condition, _indent)} ${then}${else_})`;
    }
    case ExpressionKind.Call: {
      const args = expr.operands.map((a) => exprToWat(a, _indent)).join(" ");
      return `(call $${expr.target}${args ? " " + args : ""})`;
    }
    default:
      return `(;; TODO: ${expr.kind} ;)`;
  }
}
