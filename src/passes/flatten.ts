/**
 * @module binaryen-ts/passes/flatten
 *
 * Flatten pass — rewrites each function into **Flat IR**, the form in which:
 *
 *  - every side-effecting or value-producing subexpression is hoisted into its
 *    own `local.set $tmp (...)` statement, and used via `local.get $tmp`;
 *  - operands are therefore always *trivial* (a `local.get` or a constant);
 *  - control-flow structures (`block` / `if` / `loop`) are statements whose
 *    value, if any, flows out through a temp local; their conditions are
 *    trivial.
 *
 * This mirrors upstream Binaryen's `src/passes/Flatten.cpp`. It is a
 * prerequisite for the Asyncify flow transform (`asyncify.ts` Stage 3), which
 * relies on calls being standalone statements and on control-flow conditions
 * being trivial so it can wrap each call and "skip forward" while rewinding.
 *
 * ## Formulation
 *
 * Upstream uses an in-place `ExpressionStackWalker` with a pointer-identity
 * "preludes" map. This port uses the equivalent, and cleaner-in-TS, recursive
 * formulation: `flattenExpr(e)` returns `{ pre, value }` where `pre` is the list
 * of statements to run before `e`'s value is available and `value` is a trivial
 * expression (or `nop` for a void `e`). Preludes bubble up to the nearest
 * enclosing statement position exactly as they do upstream.
 *
 * Because Flat IR intentionally introduces many temp locals (later cleaned up
 * by `simplify-locals` / `coalesce-locals`), this pass does not attempt to
 * match upstream's exact temp numbering; it produces behaviorally-equivalent,
 * invariant-satisfying Flat IR.
 *
 * ## Not yet supported
 *
 * Exception handling (`try` / `try_table` / `pop`), the legacy `br_on`,
 * multivalue/tuple results, and value-carrying branches (`br`/`br_if`/`br_table`
 * with a value) throw rather than being silently mishandled. The driving use
 * case — TinyGo goroutine code (loops / ifs / calls / locals, no EH/tuples) —
 * is fully covered.
 *
 * @license MIT
 */

import {
  type BlockExpr,
  type BreakExpr,
  type CallExpr,
  type CallIndirectExpr,
  type Expression,
  ExpressionKind,
  type IfExpr,
  type LoopExpr,
  makeBlock,
  makeLocalGet,
  makeLocalSet,
  makeNop,
  makeReturn,
  makeUnreachable,
  type SwitchExpr,
} from "../ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../ir/module.ts";
import { None, type Type, Unreachable, type ValType } from "../ir/types.ts";
import { mapChildrenShallow } from "../ir/walk.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** A concrete (single-value) type — produces a value that can be stored in a local. */
function isConcrete(t: Type): boolean {
  return t !== None && t !== Unreachable;
}

/** Expressions that are trivial operands: keep them inline, no preludes. */
function isTrivial(e: Expression): boolean {
  switch (e.kind) {
    case ExpressionKind.Const:
    case ExpressionKind.RefNull:
    case ExpressionKind.RefFunc:
    case ExpressionKind.Nop:
    case ExpressionKind.Unreachable:
      return true;
    default:
      return false;
  }
}

/** Control-flow structures handled explicitly (children may have side effects). */
function isControlFlow(e: Expression): boolean {
  return e.kind === ExpressionKind.Block ||
    e.kind === ExpressionKind.If ||
    e.kind === ExpressionKind.Loop;
}

/** Kinds this port does not yet flatten — fail loud rather than mishandle. */
function rejectUnsupported(e: Expression): void {
  switch (e.kind) {
    case ExpressionKind.Try:
    case ExpressionKind.TryTable:
    case ExpressionKind.Pop:
    case ExpressionKind.BrOn:
      throw new Error(`flatten: ${e.kind} is not yet supported by this port.`);
  }
}

// ---------------------------------------------------------------------------
// Flatten context (per function)
// ---------------------------------------------------------------------------

interface Ctx {
  func: WasmFunction;
  /**
   * Maps a direct-call target name to its result type. The WAT/binary parser
   * leaves `Call.type === none` (the callee's result is implicit in wasm), so
   * flatten must resolve it here to know whether a call produces a value that
   * needs hoisting into a local.
   */
  callResultTypes: Map<string, Type>;
}

/** The effective result type of a (possibly type-`none`) call node. */
function callEffectiveType(e: Expression, ctx: Ctx): Type {
  if (e.kind === ExpressionKind.Call) {
    return ctx.callResultTypes.get((e as CallExpr).target) ?? None;
  }
  if (e.kind === ExpressionKind.CallIndirect) {
    const r = (e as CallIndirectExpr).results;
    return r.length > 0 ? r[0] : None;
  }
  return e.type;
}

/** Allocate a fresh local of `type` and return its index. */
function allocTemp(ctx: Ctx, type: Type): number {
  const idx = ctx.func.locals.length;
  ctx.func.locals.push({ type: type as ValType });
  return idx;
}

/** The result of flattening one expression. */
interface Flat {
  /** Statements to run, in order, before `value` is available. */
  pre: Expression[];
  /** A trivial value expression (or `nop` when the source was void). */
  value: Expression;
}

// ---------------------------------------------------------------------------
// Core recursion
// ---------------------------------------------------------------------------

function flattenExpr(e: Expression, ctx: Ctx): Flat {
  rejectUnsupported(e);

  // Constants / nop / unreachable are already trivial.
  if (isTrivial(e)) return { pre: [], value: e };

  if (isControlFlow(e)) return flattenControlFlow(e, ctx);

  // local.tee is disallowed in Flat IR: rewrite to a set (prelude) + get.
  // The result must read a FRESH temp, not `local.get tee.index`: returning the
  // original local left the value clobberable by a later sibling operand whose
  // own prelude writes the same local (e.g. two tees to the same local as
  // sibling operands) → the parent read the wrong value. Capture into a temp
  // that nothing else writes, mirroring the general-case hoist below.
  if (e.kind === ExpressionKind.LocalTee) {
    const tee = e as { index: number; value: Expression; type: Type };
    const inner = flattenExpr(tee.value, ctx);
    const temp = allocTemp(ctx, tee.type);
    return {
      pre: [
        ...inner.pre,
        makeLocalSet(temp, inner.value),
        makeLocalSet(tee.index, makeLocalGet(temp, tee.type as ValType)),
      ],
      value: makeLocalGet(temp, tee.type as ValType),
    };
  }

  // Value-carrying branches need break-target temps — not yet supported.
  if (e.kind === ExpressionKind.Break && (e as BreakExpr).value) {
    throw new Error("flatten: value-carrying br/br_if is not yet supported by this port.");
  }
  if (e.kind === ExpressionKind.Switch && (e as SwitchExpr).value) {
    throw new Error("flatten: value-carrying br_table is not yet supported by this port.");
  }

  // General case: flatten each child (eval order), collecting their preludes,
  // then reduce the rebuilt node according to its type.
  const childPre: Expression[] = [];
  const rebuilt = mapChildrenShallow(e, (child) => {
    const f = flattenExpr(child, ctx);
    childPre.push(...f.pre);
    return f.value;
  });

  if (rebuilt.type === Unreachable) {
    return { pre: [...childPre, rebuilt], value: makeUnreachable() };
  }
  // Calls carry `type === none` from the parser; resolve their true result type.
  const effType = callEffectiveType(rebuilt, ctx);
  if (isConcrete(effType)) {
    const temp = allocTemp(ctx, effType);
    return {
      pre: [...childPre, makeLocalSet(temp, rebuilt)],
      value: makeLocalGet(temp, effType as ValType),
    };
  }
  // Void statement (store, local.set, drop, void call, br/br_if without value…).
  return { pre: [...childPre, rebuilt], value: makeNop() };
}

// ---------------------------------------------------------------------------
// Control-flow structures
// ---------------------------------------------------------------------------

function flattenControlFlow(e: Expression, ctx: Ctx): Flat {
  switch (e.kind) {
    case ExpressionKind.Block:
      return flattenBlock(e as BlockExpr, ctx);
    case ExpressionKind.If:
      return flattenIf(e as IfExpr, ctx);
    case ExpressionKind.Loop:
      return flattenLoop(e as LoopExpr, ctx);
    default:
      throw new Error(`flatten: unexpected control-flow kind ${e.kind}`);
  }
}

/**
 * Flatten a block. Non-last children are statements: their preludes and (void)
 * bodies are appended in order. If the block is concrete, the last child's
 * value is routed into a result temp and the block becomes a void statement;
 * the block's value flows out via `local.get $temp`.
 */
function flattenBlock(block: BlockExpr, ctx: Ctx): Flat {
  const concrete = isConcrete(block.type);
  const resultTemp = concrete ? allocTemp(ctx, block.type) : -1;
  const list: Expression[] = [];

  block.children.forEach((child, i) => {
    const isLast = i === block.children.length - 1;
    const f = flattenExpr(child, ctx);
    list.push(...f.pre);
    if (isLast && concrete) {
      list.push(makeLocalSet(resultTemp, f.value));
    } else if (child.type === Unreachable) {
      // A non-last `unreachable` (e.g. a bare `unreachable`, or the value of a
      // call to a noreturn fn) is trivial with an empty prelude, so it would
      // otherwise vanish. Keep it as a statement — it carries the trap and
      // terminates control flow; dropping it lets execution fall through.
      list.push(f.value);
    }
    // A non-last concrete child (rare, e.g. a dropped value mid-block that
    // reduced to a local.get) has no effect — discard its trivial value.
    // Void children: their statement is already in `f.pre` (general case emits
    // the rebuilt node into pre), so nothing else to push.
  });

  const flatBlock = makeBlock(list, block.name);
  return concrete
    ? { pre: [flatBlock], value: makeLocalGet(resultTemp, block.type as ValType) }
    : { pre: [flatBlock], value: makeNop() };
}

/** Flatten an `if`: trivial condition + statement arms; value via a temp. */
function flattenIf(iff: IfExpr, ctx: Ctx): Flat {
  const cond = flattenExpr(iff.condition, ctx);
  const concrete = isConcrete(iff.type);
  const resultTemp = concrete ? allocTemp(ctx, iff.type) : -1;

  const arm = (a: Expression): Expression => {
    const f = flattenExpr(a, ctx);
    const stmts = [...f.pre];
    if (concrete && isConcrete(a.type)) stmts.push(makeLocalSet(resultTemp, f.value));
    return makeBlock(stmts, null);
  };

  const ifTrue = arm(iff.ifTrue);
  const ifFalse = iff.ifFalse ? arm(iff.ifFalse) : null;
  const flatIf: IfExpr = {
    kind: ExpressionKind.If,
    type: None,
    condition: cond.value,
    ifTrue,
    ifFalse,
  };

  return concrete
    ? { pre: [...cond.pre, flatIf], value: makeLocalGet(resultTemp, iff.type as ValType) }
    : { pre: [...cond.pre, flatIf], value: makeNop() };
}

/** Flatten a `loop`: body becomes a statement block; value via a temp. */
function flattenLoop(loop: LoopExpr, ctx: Ctx): Flat {
  const concrete = isConcrete(loop.type);
  const resultTemp = concrete ? allocTemp(ctx, loop.type) : -1;

  const f = flattenExpr(loop.body, ctx);
  const stmts = [...f.pre];
  if (concrete && isConcrete(loop.body.type)) stmts.push(makeLocalSet(resultTemp, f.value));

  const flatLoop: LoopExpr = {
    kind: ExpressionKind.Loop,
    type: None,
    name: loop.name,
    body: makeBlock(stmts, null),
  };

  return concrete
    ? { pre: [flatLoop], value: makeLocalGet(resultTemp, loop.type as ValType) }
    : { pre: [flatLoop], value: makeNop() };
}

// ---------------------------------------------------------------------------
// Function driver + pass
// ---------------------------------------------------------------------------

/**
 * Build the direct-call result-type map (`funcName → result type`) a module
 * needs for flattening — imports and defined functions. Pass it to
 * {@link flattenFunction}; the {@link FlattenPass} builds it automatically.
 */
export function buildCallResultTypes(module: WasmModule): Map<string, Type> {
  const map = new Map<string, Type>();
  for (const imp of module.imports) {
    if (imp.kind === "function") map.set(imp.name, imp.results?.[0] ?? None);
  }
  for (const f of module.functions) {
    map.set(f.name, f.results[0] ?? None);
  }
  return map;
}

/**
 * Flatten a single function body in place. `callResultTypes` maps direct-call
 * targets to their result type (see {@link buildCallResultTypes}); when omitted
 * calls are treated as void (correct only for modules with no value-returning
 * calls).
 */
export function flattenFunction(
  func: WasmFunction,
  callResultTypes: Map<string, Type> = new Map(),
): void {
  const ctx: Ctx = { func, callResultTypes };
  // A value-returning function body yields the return value; route it through a
  // `return` (matching upstream) so the body block ends up void. Guard on the
  // result signature, not `body.type`, since a call-bodied function has
  // `body.type === none` from the parser.
  const bodyIsValue = func.results.length > 0 && func.body.type !== Unreachable;
  const source = bodyIsValue ? makeReturn(func.body) : func.body;

  const f = flattenExpr(source, ctx);
  const list = [...f.pre];
  // If the source was void and produced a trailing non-nop value, keep it.
  if (!bodyIsValue && f.value.kind !== ExpressionKind.Nop) list.push(f.value);
  func.body = makeBlock(list, null);
}

/** Rewrites every function in the module into Flat IR. */
export class FlattenPass implements Pass {
  readonly name = "Flatten";
  readonly description =
    "Rewrites functions into Flat IR: every value-producing subexpression is " +
    "hoisted into its own local, operands become trivial, and control flow " +
    "routes values through temp locals. Port of Binaryen's --flatten.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    const callResultTypes = buildCallResultTypes(module);
    for (const func of module.functions) {
      flattenFunction(func, callResultTypes);
    }
  }
}

registerPass(FlattenPass);
