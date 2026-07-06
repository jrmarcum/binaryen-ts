/**
 * @module binaryen-ts/passes/asyncify
 *
 * Asyncify: async/await-style transformation that lets a module pause and
 * resume — unwinding the wasm call stack at a "blocking" call and rewinding it
 * later, so synchronous-looking code can suspend. Use cases: coroutines,
 * generators, and (the driving one here) **TinyGo goroutines** compiled to
 * wasm, for which wasm-opt's `--asyncify` is a required post-processing step.
 *
 * This is a faithful port of upstream Binaryen's `src/passes/Asyncify.cpp`
 * (vendored at `upstream/src/passes/Asyncify.cpp`). The exact ABI it produces
 * is depended on by TinyGo's runtime, so the transformation and the generated
 * runtime-support functions must match upstream bit-for-bit in shape.
 *
 * ## ABI produced (see the upstream header comment for the full contract)
 *
 * A new i32 global `__asyncify_state` is added: 0 = normal, 1 = unwinding,
 * 2 = rewinding. A second i32 global `__asyncify_data` points, while
 * unwinding/rewinding, to a `{ i32 stackPos; i32 stackEnd; }` structure (i64
 * fields for wasm64). Five control functions are created and exported:
 * `asyncify_start_unwind(data)`, `asyncify_stop_unwind()`,
 * `asyncify_start_rewind(data)`, `asyncify_stop_rewind()`, `asyncify_get_state()`.
 *
 * ## Incremental status
 *
 * This pass is being ported in stages:
 *  - **Stage 1 (this file, current):** ABI constants, option parsing, and the
 *    runtime-support synthesis (the 2 globals + 5 exported control functions),
 *    reproducing wasm-opt's output for those surfaces exactly. Function-body
 *    instrumentation is NOT yet applied.
 *  - Stage 2: `ModuleAnalyzer` — whole-program analysis of which functions can
 *    be on the stack during a pause and therefore need instrumenting.
 *  - Stage 3: `AsyncifyFlow` — the control-flow "skip/unwind" body transform.
 *  - Stage 4: `AsyncifyLocals` — liveness-driven local save/restore.
 *  - Stage 5: register the pass, wire `--asyncify` into the CLI, and validate
 *    end-to-end against `wasm-opt --asyncify` + a real TinyGo goroutine module.
 *
 * Until Stage 4 lands the pass is intentionally NOT registered with the pass
 * registry (so nothing can invoke a half-instrumented transform); it is used
 * directly by its own tests via {@link AsyncifyPass} / {@link synthesizeRuntimeSupport}.
 *
 * @license MIT
 */

import {
  BinaryOp,
  type Expression,
  makeBinary,
  makeBlock,
  makeGlobalGet,
  makeGlobalSet,
  makeI32Const,
  makeIf,
  makeLoad,
  makeLocalGet,
  makeUnreachable,
} from "../ir/expressions.ts";
import type { Local, WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import type { Pass, PassOptions } from "./pass.ts";

// ---------------------------------------------------------------------------
// ABI constants (mirror Asyncify.cpp lines 366-386)
// ---------------------------------------------------------------------------

/** Internal name of the i32 state global (0 normal / 1 unwind / 2 rewind). */
export const ASYNCIFY_STATE = "$__asyncify_state";
/** Internal name of the i32 data-pointer global. */
export const ASYNCIFY_DATA = "$__asyncify_data";

/** Host-visible export names of the five control functions (upstream order). */
export const ASYNCIFY_START_UNWIND = "asyncify_start_unwind";
export const ASYNCIFY_STOP_UNWIND = "asyncify_stop_unwind";
export const ASYNCIFY_START_REWIND = "asyncify_start_rewind";
export const ASYNCIFY_STOP_REWIND = "asyncify_stop_rewind";
export const ASYNCIFY_GET_STATE = "asyncify_get_state";

/** The `__asyncify_state` values. */
export const enum State {
  Normal = 0,
  Unwinding = 1,
  Rewinding = 2,
}

/** Byte offsets within the `__asyncify_data` structure (wasm32). */
export const enum DataOffset {
  StackPos = 0,
  StackEnd = 4,
  StackEnd64 = 8,
}

// ---------------------------------------------------------------------------
// Options (mirror the `--pass-arg=asyncify-*` surface documented upstream)
// ---------------------------------------------------------------------------

/**
 * Parsed Asyncify options. Populated from {@link PassOptions.passArgs} using
 * the upstream `asyncify-<name>` keys. Fields not consumed until later stages
 * are parsed now so the option surface is stable.
 */
export interface AsyncifyOptions {
  /** `asyncify-imports@a.b,c.d` — imports assumed to unwind/rewind (prefix `*` allowed). */
  imports: string[];
  /** `asyncify-ignore-imports` — assume no import (except `asyncify.*`) unwinds. */
  ignoreImports: boolean;
  /** `asyncify-ignore-indirect` — assume indirect calls never unwind. */
  ignoreIndirect: boolean;
  /** `asyncify-asserts` — emit extra placement asserts. */
  asserts: boolean;
  /** `asyncify-ignore-unwind-from-catch` — silently skip unwinds from EH catch blocks. */
  ignoreUnwindFromCatch: boolean;
  /** `asyncify-verbose` — log instrumentation decisions. */
  verbose: boolean;
  /** `asyncify-memory@name` — which exported memory to use (empty = the first). */
  memory: string;
  /** `asyncify-removelist@…` — functions to force-exclude from instrumentation. */
  removeList: string[];
  /** `asyncify-addlist@…` — functions to force-include. */
  addList: string[];
  /** `asyncify-propagate-addlist` — propagate add-list instrumentation to callers. */
  propagateAddList: boolean;
  /** `asyncify-onlylist@…` — instrument ONLY these functions. */
  onlyList: string[];
  /** `import-globals` — import the internal globals instead of defining them. */
  importGlobals: boolean;
  /** `export-globals` — export the internal globals. */
  exportGlobals: boolean;
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse Asyncify options out of a runner's `passArgs`. Keys follow the upstream
 * convention: bare flags are present when the key exists (any value), list/value
 * flags carry their payload as the value. Both the `Asyncify@name` prefixed form
 * and the bare `asyncify-name` form are accepted.
 */
export function parseAsyncifyOptions(passArgs: Record<string, string>): AsyncifyOptions {
  const get = (name: string): string | undefined => {
    // Accept "asyncify-<name>", "Asyncify@asyncify-<name>", and "Asyncify@<name>".
    return (
      passArgs[`asyncify-${name}`] ??
        passArgs[`Asyncify@asyncify-${name}`] ??
        passArgs[`Asyncify@${name}`]
    );
  };
  const has = (name: string): boolean =>
    get(name) !== undefined ||
    // response-file / bare flags may arrive with an empty value
    Object.prototype.hasOwnProperty.call(passArgs, `asyncify-${name}`);

  return {
    imports: splitList(get("imports")),
    ignoreImports: has("ignore-imports"),
    ignoreIndirect: has("ignore-indirect"),
    asserts: has("asserts"),
    ignoreUnwindFromCatch: has("ignore-unwind-from-catch"),
    verbose: has("verbose"),
    memory: get("memory") ?? "",
    removeList: splitList(get("removelist")),
    addList: splitList(get("addlist")),
    propagateAddList: has("propagate-addlist"),
    onlyList: splitList(get("onlylist")),
    importGlobals: has("import-globals"),
    exportGlobals: has("export-globals"),
  };
}

// ---------------------------------------------------------------------------
// Runtime-support synthesis (mirror Asyncify::run's global + control-function
// creation). Produces output identical in shape to `wasm-opt --asyncify`.
// ---------------------------------------------------------------------------

/** i32 `global.get $__asyncify_data`. */
function dataPtr(): Expression {
  return makeGlobalGet(ASYNCIFY_DATA, ValType.I32);
}

/**
 * The stack-overflow check emitted at the tail of every control function:
 * `if (i32.gt_u (load data[0]) (load data[4])) (unreachable)`.
 */
function makeStackOverflowCheck(): Expression {
  return makeIf(
    makeBinary(
      BinaryOp.GtUI32,
      makeLoad(4, false, DataOffset.StackPos, 2, dataPtr(), ValType.I32),
      makeLoad(4, false, DataOffset.StackEnd, 2, dataPtr(), ValType.I32),
    ),
    makeUnreachable(),
  );
}

/** Body of `asyncify_start_unwind` / `asyncify_start_rewind` (sets state + data). */
function makeStartBody(state: State): Expression {
  return makeBlock([
    makeGlobalSet(ASYNCIFY_STATE, makeI32Const(state)),
    makeGlobalSet(ASYNCIFY_DATA, makeLocalGet(0, ValType.I32)),
    makeStackOverflowCheck(),
  ]);
}

/** Body of `asyncify_stop_unwind` / `asyncify_stop_rewind` (resets state). */
function makeStopBody(): Expression {
  return makeBlock([
    makeGlobalSet(ASYNCIFY_STATE, makeI32Const(State.Normal)),
    makeStackOverflowCheck(),
  ]);
}

/**
 * Add the two Asyncify globals, the five control functions, and their exports
 * to `module` in place. Mirrors the runtime-support portion of `Asyncify::run`.
 *
 * @param module - The module to augment (wasm32 only for now).
 * @param options - Parsed Asyncify options (controls global import/export).
 */
export function synthesizeRuntimeSupport(
  module: WasmModule,
  options: AsyncifyOptions,
): void {
  if (module.hasMemory64) {
    throw new Error(
      "asyncify: wasm64 (memory64) is not yet supported in this port; " +
        "the driving use case (TinyGo goroutines) is wasm32.",
    );
  }

  // Globals: `__asyncify_state` and `__asyncify_data`, both mut i32 init 0.
  // (import-globals / export-globals dynamic-linking modes are handled in a
  // later stage; the default is internal-and-neither, matching upstream.)
  module.globals.push({
    name: ASYNCIFY_STATE,
    type: ValType.I32,
    mutable: true,
    init: makeI32Const(0),
  });
  module.globals.push({
    name: ASYNCIFY_DATA,
    type: ValType.I32,
    mutable: true,
    init: makeI32Const(0),
  });
  if (options.exportGlobals) {
    module.exports.push({ name: "__asyncify_state", value: ASYNCIFY_STATE, kind: "global" });
    module.exports.push({ name: "__asyncify_data", value: ASYNCIFY_DATA, kind: "global" });
  }

  const dataParam: Local[] = [{ type: ValType.I32 }];

  // The five control functions, in upstream order.
  addExportedFunction(module, ASYNCIFY_START_UNWIND, dataParam, [], makeStartBody(State.Unwinding));
  addExportedFunction(module, ASYNCIFY_STOP_UNWIND, [], [], makeStopBody());
  addExportedFunction(module, ASYNCIFY_START_REWIND, dataParam, [], makeStartBody(State.Rewinding));
  addExportedFunction(module, ASYNCIFY_STOP_REWIND, [], [], makeStopBody());
  addExportedFunction(
    module,
    ASYNCIFY_GET_STATE,
    [],
    [ValType.I32],
    makeGlobalGet(ASYNCIFY_STATE, ValType.I32),
  );
}

/** Add one function (internal name `$<hostName>`) and export it as `hostName`. */
function addExportedFunction(
  module: WasmModule,
  hostName: string,
  params: Local[],
  results: ValType[],
  body: Expression,
): void {
  const internalName = `$${hostName}`;
  module.functions.push({
    name: internalName,
    params: params.map((l) => l.type),
    results,
    locals: [...params],
    body,
  });
  module.exports.push({ name: hostName, value: internalName, kind: "function" });
}

// ---------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------

/**
 * The Asyncify transformation pass.
 *
 * **Incomplete (Stage 1):** currently only synthesizes the runtime-support
 * globals + control functions. Whole-program analysis and body instrumentation
 * (Stages 2-4) are not yet applied, so a module run through this pass is not
 * yet functionally suspendable. The pass is deliberately left unregistered
 * until instrumentation is complete.
 */
export class AsyncifyPass implements Pass {
  readonly name = "Asyncify";
  readonly description =
    "Transforms a module to support pausing and resuming (unwind/rewind the " +
    "call stack). Port of Binaryen's --asyncify.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, options: PassOptions): void {
    const opts = parseAsyncifyOptions(options.passArgs);
    // TODO(stage 2): ModuleAnalyzer — determine the instrument set.
    // TODO(stage 3): AsyncifyFlow — control-flow skip/unwind body transform.
    // TODO(stage 4): AsyncifyLocals — liveness-driven local save/restore.
    synthesizeRuntimeSupport(module, opts);
  }
}
