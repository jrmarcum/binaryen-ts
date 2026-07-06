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
  type CallExpr,
  type CallIndirectExpr,
  type Expression,
  ExpressionKind,
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
import type { Local, WasmImport, WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import { walkExpression } from "../ir/walk.ts";
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
// ModuleAnalyzer (Stage 2) — mirror Asyncify.cpp lines 538-808.
//
// Whole-program analysis of which functions "can change the state" — i.e. may
// start an unwind/rewind, directly or transitively — and therefore must be
// instrumented. The safe default (upstream): every import and every indirect
// call is assumed to be able to unwind; `asyncify-imports` / `-ignore-imports`
// / `-ignore-indirect` and the add/remove/only lists refine that.
// ---------------------------------------------------------------------------

/** Result of the whole-program analysis. */
export interface AnalysisResult {
  /** Internal names of the DEFINED functions that need instrumentation. */
  instrumentedFuncs: Set<string>;
  /**
   * `canChangeState` per function name (defined AND imported). Consumed by the
   * Stage-3 flow transform to decide which call sites to instrument.
   */
  canChangeState: Map<string, boolean>;
  /**
   * Functions forced in via the add-list / only-list. Per the upstream docs
   * these also get their indirect calls instrumented even under
   * `ignore-indirect`.
   */
  addedFromList: Set<string>;
}

/** The `asyncify` import module namespace (the in-wasm-runtime control API). */
const ASYNCIFY_IMPORT_MODULE = "asyncify";

/**
 * Translate a wildcard pattern (`*` matches any run of characters, as in the
 * upstream `String::wildcardMatch`) into an anchored RegExp and test it.
 */
function wildcardMatch(pattern: string, str: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(str);
}

/**
 * Analyze `module` and compute the set of functions to instrument.
 *
 * Faithful to the common-path logic of upstream `ModuleAnalyzer`
 * (Asyncify.cpp 538-808): initial per-function scan (imports + indirect calls),
 * remove-list, add-list (pre- or post-propagation per `propagate-addlist`),
 * backward call-graph propagation, and the only-list override.
 *
 * **Not yet supported:** the "manage everything inside wasm" mode where the
 * module imports `asyncify.start_unwind` / `.stop_unwind` / `.start_rewind` /
 * `.stop_rewind` (top-most / bottom-most runtime handling). Such a module
 * throws here rather than being silently mis-analyzed — the driving use cases
 * (TinyGo goroutines, JS-driven Emscripten-style pausing) do not use it.
 */
export function analyzeModule(
  module: WasmModule,
  options: AsyncifyOptions,
): AnalysisResult {
  // Unsupported advanced mode: in-wasm asyncify.* runtime imports.
  const asyncifyImport = module.imports.find(
    (i) => i.kind === "function" && i.module === ASYNCIFY_IMPORT_MODULE,
  );
  if (asyncifyImport) {
    throw new Error(
      `asyncify: importing from the "${ASYNCIFY_IMPORT_MODULE}" module ` +
        `(in-wasm unwind/rewind runtime) is not yet supported by this port; ` +
        `drive unwind/rewind from the host via the exported control functions.`,
    );
  }

  if (options.onlyList.length > 0 && (options.removeList.length > 0 || options.addList.length > 0)) {
    throw new Error(
      "asyncify: an only-list cannot be combined with an add-list or remove-list.",
    );
  }

  const canIndirect = !options.ignoreIndirect;
  // Default (no imports-list and no ignore-imports): every import can unwind.
  const allImportsCanChange = options.imports.length === 0 && !options.ignoreImports;
  const canImportChangeState = (imp: WasmImport): boolean => {
    if (allImportsCanChange) return true;
    const full = `${imp.module}.${imp.base}`;
    return options.imports.some((p) => wildcardMatch(p, full));
  };

  const matchesAny = (patterns: string[], name: string): boolean =>
    patterns.some((p) => (p.includes("*") ? wildcardMatch(p, name) : p === name));

  // Reverse call-graph edges: callee name -> set of (defined) caller names.
  const calledBy = new Map<string, Set<string>>();
  const canChangeState = new Map<string, boolean>();
  const hasIndirectCall = new Map<string, boolean>();
  const inRemoveList = new Set<string>();
  const addedFromList = new Set<string>();

  const addEdge = (callee: string, caller: string): void => {
    let s = calledBy.get(callee);
    if (!s) calledBy.set(callee, s = new Set());
    s.add(caller);
  };

  // Seed imports.
  for (const imp of module.imports) {
    if (imp.kind === "function") {
      canChangeState.set(imp.name, canImportChangeState(imp));
    }
  }

  // Initial scan of defined functions: build the call graph + seed from
  // indirect calls (direct-call-driven state change is added by propagation).
  for (const func of module.functions) {
    let indirect = false;
    walkExpression(func.body, (e: Expression) => {
      if (e.kind === ExpressionKind.Call) {
        const call = e as CallExpr;
        if (call.isReturn) {
          throw new Error("asyncify: tail calls (return_call) are not yet supported.");
        }
        addEdge(call.target, func.name);
      } else if (e.kind === ExpressionKind.CallIndirect) {
        if ((e as CallIndirectExpr).isReturn) {
          throw new Error("asyncify: tail calls (return_call_indirect) are not yet supported.");
        }
        indirect = true;
      }
    });
    hasIndirectCall.set(func.name, indirect);
    canChangeState.set(func.name, indirect && canIndirect);
  }

  // remove-list: assumed not to change state (and a barrier to propagation).
  for (const func of module.functions) {
    if (matchesAny(options.removeList, func.name)) {
      inRemoveList.add(func.name);
      canChangeState.set(func.name, false);
    }
  }

  const applyAddList = (): void => {
    if (options.addList.length === 0) return;
    for (const func of module.functions) {
      const inAdd = matchesAny(options.addList, func.name);
      if (inAdd && matchesAny(options.removeList, func.name)) {
        throw new Error(`asyncify: "${func.name}" is in both the add-list and the remove-list.`);
      }
      if (inAdd) {
        canChangeState.set(func.name, true);
        addedFromList.add(func.name);
      }
    }
  };

  // With propagate-addlist, seed add-list BEFORE propagation so callers of
  // add-listed functions are instrumented too.
  if (options.propagateAddList) applyAddList();

  // Backward propagation: any function that (transitively) calls a
  // state-changing function also changes state. remove-list funcs never receive
  // the property and so do not propagate it further.
  const worklist: string[] = [];
  for (const [name, changes] of canChangeState) {
    if (changes && !inRemoveList.has(name)) worklist.push(name);
  }
  while (worklist.length > 0) {
    const callee = worklist.pop()!;
    for (const caller of calledBy.get(callee) ?? []) {
      if (!inRemoveList.has(caller) && !canChangeState.get(caller)) {
        canChangeState.set(caller, true);
        worklist.push(caller);
      }
    }
  }

  // only-list: exactly these defined functions change state, nothing else.
  if (options.onlyList.length > 0) {
    for (const func of module.functions) {
      const matched = matchesAny(options.onlyList, func.name);
      canChangeState.set(func.name, matched);
      if (matched) addedFromList.add(func.name);
    }
  }

  // Default add-list behaviour (no propagate): add AFTER propagation, so the
  // added functions are instrumented but do not pull in their callers.
  if (!options.propagateAddList) applyAddList();

  // needsInstrumentation(func) = canChangeState && !isTopMostRuntime. We reject
  // the asyncify.* import mode above, so isTopMostRuntime is never set.
  const instrumentedFuncs = new Set<string>();
  for (const func of module.functions) {
    if (canChangeState.get(func.name)) instrumentedFuncs.add(func.name);
  }

  return { instrumentedFuncs, canChangeState, addedFromList };
}

// ---------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------

/**
 * The Asyncify transformation pass.
 *
 * **Incomplete (Stages 1-2 done):** computes the instrument set (Stage 2) and
 * synthesizes the runtime-support globals + control functions (Stage 1). Body
 * instrumentation (Stages 3-4: AsyncifyFlow + AsyncifyLocals) is not yet
 * applied, so a module run through this pass is not yet functionally
 * suspendable. The pass is deliberately left unregistered until instrumentation
 * is complete.
 */
export class AsyncifyPass implements Pass {
  readonly name = "Asyncify";
  readonly description =
    "Transforms a module to support pausing and resuming (unwind/rewind the " +
    "call stack). Port of Binaryen's --asyncify.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, options: PassOptions): void {
    const opts = parseAsyncifyOptions(options.passArgs);
    // Stage 2: analyze BEFORE synthesizing runtime support, so the newly-added
    // control functions are never themselves considered for instrumentation.
    analyzeModule(module, opts);
    // TODO(stage 3): AsyncifyFlow — control-flow skip/unwind body transform,
    //   applied only to `analysis.instrumentedFuncs`.
    // TODO(stage 4): AsyncifyLocals — liveness-driven local save/restore.
    synthesizeRuntimeSupport(module, opts);
  }
}
