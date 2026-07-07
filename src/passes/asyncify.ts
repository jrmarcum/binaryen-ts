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
  type DropExpr,
  type Expression,
  ExpressionKind,
  type GlobalGetExpr,
  type GlobalSetExpr,
  makeBinary,
  makeBlock,
  makeBreak,
  makeCall,
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
  makeReturn,
  makeStore,
  makeUnary,
  makeUnreachable,
  type LocalSetExpr,
  UnaryOp,
} from "../ir/expressions.ts";
import type { Local, WasmFunction, WasmImport, WasmModule } from "../ir/module.ts";
import { None, type Type, ValType } from "../ir/types.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";
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
// AsyncifyFlow (Stage 3b) — mirror Asyncify.cpp lines 878-1258.
//
// Instruments an already-FLATTENED instrumented function so it can pause and
// resume: it "linearizes" control flow (always skipping forward while
// rewinding) and wraps each state-changing call with a call-index check + a
// possible-unwind. Runs on flat IR (Stage 3a), which guarantees calls are
// standalone statements and control-flow conditions are trivial.
//
// The three helpers below are emitted as calls to TEMPORARY intrinsics that
// Stage 4 (AsyncifyLocals) implements against the asyncify stack; until then a
// flow-instrumented module references undefined functions and cannot run. This
// is why the flow is exposed as its own function and NOT yet wired into
// `AsyncifyPass.run` (the pass stays at Stage 2 output — analyze + runtime
// support — so its Stage-1/2 tests still round-trip).
// ---------------------------------------------------------------------------

/** Temporary intrinsic: pop the next call index off the stack (start of a rewind). */
const ASYNCIFY_GET_CALL_INDEX = "$__asyncify_get_call_index";
/** Temporary intrinsic: is `index` the call to resume into? → i32. */
const ASYNCIFY_CHECK_CALL_INDEX = "$__asyncify_check_call_index";
/** Temporary intrinsic: note an unwind through call `index`. */
const ASYNCIFY_UNWIND = "$__asyncify_unwind";

/** Per-function flow context. */
export interface FlowCtx {
  func: WasmFunction;
  /** `canChangeState` per function name, from {@link analyzeModule}. */
  canChangeState: Map<string, boolean>;
  /** Whether indirect calls are assumed to change state. */
  canIndirect: boolean;
  /** Functions whose indirect calls are instrumented even under ignore-indirect. */
  addedFromList: Set<string>;
  /** Mutable running call index. */
  callIndex: { n: number };
  /** Fake globals created per call-result type (name keyed by type). */
  fakeGlobals: Map<Type, string>;
}

/** `i32.eq($__asyncify_state, value)`. */
function makeStateCheck(state: State): Expression {
  return makeBinary(
    BinaryOp.EqI32,
    makeGlobalGet(ASYNCIFY_STATE, ValType.I32),
    makeI32Const(state),
  );
}

/** `if (state == Normal) curr` — run `curr` only in normal execution (skip while rewinding). */
function makeMaybeSkip(curr: Expression): Expression {
  return makeIf(makeStateCheck(State.Normal), curr);
}

/** True if `expr` may start an unwind/rewind (contains a call to a state-changer). */
function exprCanChangeState(expr: Expression, ctx: FlowCtx): boolean {
  let changes = false;
  let indirect = false;
  walkExpression(expr, (e) => {
    if (e.kind === ExpressionKind.Call) {
      if (ctx.canChangeState.get((e as CallExpr).target)) changes = true;
    } else if (e.kind === ExpressionKind.CallIndirect) {
      indirect = true;
    }
  });
  if (indirect && (ctx.canIndirect || ctx.addedFromList.has(ctx.func.name))) changes = true;
  return changes;
}

/** Does `curr` perform a call (possibly under a `local.set` or `drop`)? */
function doesCall(curr: Expression): boolean {
  let inner = curr;
  if (curr.kind === ExpressionKind.LocalSet) inner = (curr as LocalSetExpr).value;
  else if (curr.kind === ExpressionKind.Drop) inner = (curr as DropExpr).value;
  return inner.kind === ExpressionKind.Call || inner.kind === ExpressionKind.CallIndirect;
}

/** The fake global name for a call-result `type` (created lazily). */
function fakeGlobalFor(ctx: FlowCtx, type: Type): string {
  let name = ctx.fakeGlobals.get(type);
  if (!name) {
    name = `$asyncify_fake_call_global_${type}`;
    ctx.fakeGlobals.set(type, name);
  }
  return name;
}

/** A zero constant of `type` (for fake-global initializers). */
function makeZero(type: Type): Expression {
  switch (type) {
    case ValType.I32:
      return makeI32Const(0);
    case ValType.I64:
      return makeI64Const(0n);
    case ValType.F32:
      return makeF32Const(0);
    case ValType.F64:
      return makeF64Const(0);
    default:
      throw new Error(`asyncify: unsupported call-result type for fake global: ${type}`);
  }
}

/** `if (state == Unwinding) __asyncify_unwind(index) else ifNotUnwinding`. */
function makePossibleUnwind(index: number, ifNotUnwinding: Expression | null): Expression {
  return makeIf(
    makeStateCheck(State.Unwinding),
    makeCall(ASYNCIFY_UNWIND, [makeI32Const(index)], None),
    ifNotUnwinding,
  );
}

/**
 * Wrap a state-changing call statement so it runs only when normal OR when
 * rewinding into exactly this call, and notes an unwind afterwards. The
 * `local.set` case defers the set via a fake global so an unwinding call's fake
 * return value never lands in a real local.
 */
function makeCallSupport(curr: Expression, ctx: FlowCtx): Expression {
  const index = ctx.callIndex.n++;
  let executed = curr; // run in the if-then
  let setBack: Expression | null = null; // the deferred local.set, if any

  if (curr.kind === ExpressionKind.LocalSet) {
    const set = curr as LocalSetExpr;
    const fake = fakeGlobalFor(ctx, set.value.type);
    executed = makeGlobalSet(fake, set.value);
    setBack = makeLocalSet(set.index, makeGlobalGet(fake, set.value.type as ValType));
  }

  const thenSeq = makeBlock([executed, makePossibleUnwind(index, setBack)], null);
  return makeIf(
    makeBinary(
      BinaryOp.OrI32,
      makeStateCheck(State.Normal),
      makeCall(ASYNCIFY_CHECK_CALL_INDEX, [makeI32Const(index)], ValType.I32),
    ),
    thenSeq,
  );
}

/** Recursively instrument a flat expression tree for unwind/rewind. */
function processFlow(curr: Expression, ctx: FlowCtx): Expression {
  // A subtree that can't change state is simply skipped while rewinding.
  if (!exprCanChangeState(curr, ctx)) return makeMaybeSkip(curr);

  switch (curr.kind) {
    case ExpressionKind.Block: {
      const children = curr.children;
      const newList: Expression[] = [];
      let i = 0;
      while (i < children.length) {
        if (exprCanChangeState(children[i], ctx)) {
          newList.push(processFlow(children[i], ctx));
          i++;
        } else {
          // Clump a run of non-state-changing statements under one skip.
          let j = i;
          while (j < children.length && !exprCanChangeState(children[j], ctx)) j++;
          const run = children.slice(i, j);
          newList.push(run.length === 1 ? makeMaybeSkip(run[0]) : makeMaybeSkip(makeBlock(run, null)));
          i = j;
        }
      }
      return makeBlock(newList, curr.name);
    }

    case ExpressionKind.If: {
      // In flat form the state change is in an arm, never the condition.
      if (!curr.ifFalse) {
        const newIfTrue = processFlow(curr.ifTrue, ctx);
        return makeIf(makeBinary(BinaryOp.OrI32, curr.condition, makeStateCheck(State.Rewinding)), newIfTrue);
      }
      // Two arms: pass through both while rewinding, gated on a saved condition.
      const newIfTrue = processFlow(curr.ifTrue, ctx);
      const newIfFalse = processFlow(curr.ifFalse, ctx);
      const condTemp = ctx.func.locals.length;
      ctx.func.locals.push({ type: ValType.I32 });
      const pre = makeMaybeSkip(makeLocalSet(condTemp, curr.condition));
      const if1 = makeIf(
        makeBinary(BinaryOp.OrI32, makeLocalGet(condTemp, ValType.I32), makeStateCheck(State.Rewinding)),
        newIfTrue,
      );
      const if2 = makeIf(
        makeBinary(
          BinaryOp.OrI32,
          makeUnary(UnaryOp.EqzI32, makeLocalGet(condTemp, ValType.I32)),
          makeStateCheck(State.Rewinding),
        ),
        newIfFalse,
      );
      return makeBlock([pre, if1, if2], null);
    }

    case ExpressionKind.Loop:
      return { ...curr, type: None, body: processFlow(curr.body, ctx) };

    default:
      if (doesCall(curr)) return makeCallSupport(curr, ctx);
      throw new Error(`asyncify flow: unexpected state-changing expression ${curr.kind}`);
  }
}

/**
 * Flow-instrument one already-flattened instrumented function in place. The
 * body is wrapped so a rewind first pops its call index, then re-executes,
 * skipping forward to the paused call. Emits the temporary intrinsics that
 * Stage 4 implements.
 */
export function flowInstrumentFunction(func: WasmFunction, ctx: FlowCtx): void {
  const processed = processFlow(func.body, ctx);
  const list: Expression[] = [
    makeIf(makeStateCheck(State.Rewinding), makeCall(ASYNCIFY_GET_CALL_INDEX, [], None)),
    processed,
  ];
  // Rewriting control flow may leave the value-producing tail conditional; a
  // trailing unreachable keeps a value-returning function well-formed (the
  // optimizer removes it later).
  if (func.results.length > 0) list.push(makeUnreachable());
  func.body = makeBlock(list, null);
}

/**
 * Materialize the fake call-result globals collected during flow instrumentation
 * (one mutable global per call-result type), adding them to `module`.
 */
export function materializeFakeGlobals(module: WasmModule, fakeGlobals: Map<Type, string>): void {
  for (const [type, name] of fakeGlobals) {
    module.globals.push({ name, type: type as ValType, mutable: true, init: makeZero(type) });
  }
}

// ---------------------------------------------------------------------------
// AsyncifyLocals (Stage 4) — mirror Asyncify.cpp lines 1446-1730.
//
// Lowers the temporary intrinsics from Stage 3b into real stack operations,
// converts the fake globals to locals, and wraps the flowed body so that on an
// unwind the call index is pushed and the live locals are saved to the asyncify
// stack, and on a rewind they are restored. After this the module is runnable.
//
// Stack layout: `$__asyncify_data` points to `{ i32 stackPos@0; i32 stackEnd@4 }`
// (wasm32). The stack grows UP from stackPos; each save pushes the used locals
// then the call index; STACK_ALIGN = 4 bytes.
//
// Simplification vs upstream: rather than a liveness pass, this saves/restores
// ALL of a function's *original* locals (params + user + flatten/flow temps —
// everything present before this stage adds its own temps). That is correct
// (a dead local is restored then overwritten) at the cost of a little extra
// stack per frame; the fake-call scratch locals and this stage's own index
// temps are excluded. Liveness-minimized saving is a future optimization.
// ---------------------------------------------------------------------------

/** Byte offset within `$__asyncify_data` of the current stack position. */
const STACK_POS_OFFSET = DataOffset.StackPos;
/** log2 alignment for i32 stack accesses (STACK_ALIGN = 4 bytes). */
const STACK_ALIGN_LOG2 = 2;
/** Branch label of the unwind block (breaks here to unwind out of the body). */
const ASYNCIFY_UNWIND_LABEL = "$__asyncify_unwind";

/** `load i32 from $__asyncify_data[stackPos]` — the current asyncify stack pointer. */
function makeGetStackPos(): Expression {
  return makeLoad(
    4,
    false,
    STACK_POS_OFFSET,
    STACK_ALIGN_LOG2,
    makeGlobalGet(ASYNCIFY_DATA, ValType.I32),
    ValType.I32,
  );
}

/** `$__asyncify_data[stackPos] += by` (nop when `by === 0`). */
function makeIncStackPos(by: number): Expression {
  if (by === 0) return makeBlock([], null); // effect-free placeholder
  return makeStore(
    4,
    STACK_POS_OFFSET,
    STACK_ALIGN_LOG2,
    makeGlobalGet(ASYNCIFY_DATA, ValType.I32),
    makeBinary(BinaryOp.AddI32, makeGetStackPos(), makeI32Const(by)),
  );
}

/** The byte size of a (numeric) value type. */
function byteSize(type: Type): number {
  switch (type) {
    case ValType.I32:
    case ValType.F32:
      return 4;
    case ValType.I64:
    case ValType.F64:
      return 8;
    default:
      throw new Error(`asyncify: cannot save/restore non-numeric local of type ${type}`);
  }
}

/** log2 store size of a numeric type (for the memarg align). */
function loadOpBytes(type: Type): 1 | 2 | 4 | 8 | 16 {
  return byteSize(type) as 1 | 2 | 4 | 8 | 16;
}

/** Per-function locals context. */
interface LocalsCtx {
  func: WasmFunction;
  /** Reverse of the flow's fake-global map: fake global name → value type. */
  fakeNameToType: Map<string, Type>;
  /** Fake-call scratch locals, allocated per type on demand. */
  fakeCallLocals: Map<Type, number>;
  /** Local holding the popped call index during a rewind. */
  rewindIndex: number;
}

function allocLocal(func: WasmFunction, type: Type): number {
  const idx = func.locals.length;
  func.locals.push({ type: type as ValType });
  return idx;
}

function fakeCallLocal(ctx: LocalsCtx, type: Type): number {
  let idx = ctx.fakeCallLocals.get(type);
  if (idx === undefined) {
    idx = allocLocal(ctx.func, type);
    ctx.fakeCallLocals.set(type, idx);
  }
  return idx;
}

/** Replace the temporary intrinsics and fake globals with real ops (bottom-up). */
function lowerIntrinsics(body: Expression, ctx: LocalsCtx): Expression {
  return mapExpression(body, (e) => {
    if (e.kind === ExpressionKind.Call) {
      const c = e as CallExpr;
      if (c.target === ASYNCIFY_UNWIND) {
        // Break out of the body to the unwind block, carrying the call index.
        return makeBreak(ASYNCIFY_UNWIND_LABEL, null, c.operands[0]);
      }
      if (c.target === ASYNCIFY_GET_CALL_INDEX) {
        // Pop the next index off the stack into $rewindIndex.
        return makeBlock([
          makeIncStackPos(-4),
          makeLocalSet(
            ctx.rewindIndex,
            makeLoad(4, false, 0, STACK_ALIGN_LOG2, makeGetStackPos(), ValType.I32),
          ),
        ], null);
      }
      if (c.target === ASYNCIFY_CHECK_CALL_INDEX) {
        // Is this the call to resume into?  rewindIndex == index
        return makeBinary(BinaryOp.EqI32, makeLocalGet(ctx.rewindIndex, ValType.I32), c.operands[0]);
      }
    } else if (e.kind === ExpressionKind.GlobalSet) {
      const g = e as GlobalSetExpr;
      const type = ctx.fakeNameToType.get(g.name);
      if (type !== undefined) return makeLocalSet(fakeCallLocal(ctx, type), g.value);
    } else if (e.kind === ExpressionKind.GlobalGet) {
      const g = e as GlobalGetExpr;
      const type = ctx.fakeNameToType.get(g.name);
      if (type !== undefined) return makeLocalGet(fakeCallLocal(ctx, type), type as ValType);
    }
    return e;
  });
}

/** `store $__asyncify_data[stackPos] = index; stackPos += 4`. */
function makeCallIndexPush(unwindIndex: number): Expression {
  return makeBlock([
    makeStore(4, 0, STACK_ALIGN_LOG2, makeGetStackPos(), makeLocalGet(unwindIndex, ValType.I32)),
    makeIncStackPos(4),
  ], null);
}

/** Restore the saved locals from the stack (run in the rewind prelude). */
function makeLocalLoading(func: WasmFunction, saved: number[]): Expression {
  if (saved.length === 0) return makeBlock([], null);
  const total = saved.reduce((s, i) => s + byteSize(func.locals[i].type), 0);
  const temp = allocLocal(func, ValType.I32);
  const list: Expression[] = [
    makeIncStackPos(-total),
    makeLocalSet(temp, makeGetStackPos()),
  ];
  let offset = 0;
  for (const i of saved) {
    const t = func.locals[i].type;
    list.push(makeLocalSet(
      i,
      makeLoad(loadOpBytes(t), true, offset, STACK_ALIGN_LOG2, makeLocalGet(temp, ValType.I32), t as ValType),
    ));
    offset += byteSize(t);
  }
  return makeBlock(list, null);
}

/** Save the live locals to the stack (run after an unwind). */
function makeLocalSaving(func: WasmFunction, saved: number[]): Expression {
  if (saved.length === 0) return makeBlock([], null);
  const temp = allocLocal(func, ValType.I32);
  const list: Expression[] = [makeLocalSet(temp, makeGetStackPos())];
  let offset = 0;
  for (const i of saved) {
    const t = func.locals[i].type;
    list.push(makeStore(
      loadOpBytes(t),
      offset,
      STACK_ALIGN_LOG2,
      makeLocalGet(temp, ValType.I32),
      makeLocalGet(i, t as ValType),
    ));
    offset += byteSize(t);
  }
  list.push(makeIncStackPos(offset));
  return makeBlock(list, null);
}

/**
 * Locals-instrument one flowed instrumented function in place: lower the
 * intrinsics + fake globals, then wrap the body with the unwind block and the
 * save/restore prelude+postamble. After this the function is runnable.
 *
 * @param func - The function, already flattened (3a) and flow-instrumented (3b).
 * @param fakeGlobals - The flow context's fake-global map (type → global name).
 */
export function localsInstrumentFunction(func: WasmFunction, fakeGlobals: Map<Type, string>): void {
  // Locals to save/restore = everything present before this stage adds temps.
  const numOriginalLocals = func.locals.length;
  const saved: number[] = [];
  for (let i = 0; i < numOriginalLocals; i++) saved.push(i);

  const fakeNameToType = new Map<string, Type>();
  for (const [type, name] of fakeGlobals) fakeNameToType.set(name, type);

  const rewindIndex = allocLocal(func, ValType.I32);
  const unwindIndex = allocLocal(func, ValType.I32);
  const ctx: LocalsCtx = { func, fakeNameToType, fakeCallLocals: new Map(), rewindIndex };

  // Lower intrinsics + fake globals inside the (flowed) body.
  const loweredBody = lowerIntrinsics(func.body, ctx);

  // On normal completion the body returns directly; on unwind it breaks to the
  // unwind block with the call index. Barrier after the body must be reached
  // only in the (impossible) fallthrough case.
  const barrier = func.results.length === 0 ? makeReturn() : makeUnreachable();
  const unwindBlock: Expression = {
    kind: ExpressionKind.Block,
    type: ValType.I32, // breaks carry the i32 call index
    name: ASYNCIFY_UNWIND_LABEL,
    children: [loweredBody, barrier],
  };

  const newList: Expression[] = [
    makeIf(makeStateCheck(State.Rewinding), makeLocalLoading(func, saved)),
    makeLocalSet(unwindIndex, unwindBlock),
    makeCallIndexPush(unwindIndex),
    makeLocalSaving(func, saved),
  ];
  // On the unwind path the function must still "return" a value (ignored by the
  // host); provide a zero of the result type.
  if (func.results.length > 0) newList.push(makeZero(func.results[0]));

  func.body = makeBlock(newList, null);
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
