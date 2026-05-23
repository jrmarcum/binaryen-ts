/**
 * @module binaryen-ts/passes/local-cse
 *
 * LocalCSE pass — common subexpression elimination within function bodies.
 *
 * Within each basic block (flat sequence of instructions) the pass identifies
 * pure sub-expressions that appear more than once. The first occurrence is
 * wrapped in a `local.tee(fresh, expr)` so the computed value is stored in a
 * new local; subsequent occurrences are replaced with `local.get(fresh)`,
 * avoiding redundant recomputation.
 *
 * **What counts as a CSE candidate (pure expression)**:
 * - Integer / float constants (`i32.const`, `i64.const`, `f32.const`, `f64.const`)
 * - `local.get(i)` (a read has no side effects)
 * - `global.get(name)` (immutable global reads have no side effects)
 * - Binary ops on two pure sub-expressions (excluding division/remainder,
 *   which can trap)
 * - Unary ops on a pure sub-expression (excluding non-saturating float
 *   truncations, which can trap)
 *
 * **Scope**: only direct children of a `block` are considered. Expressions
 * nested inside `if`, `loop`, or other control-flow are handled by the
 * recursive `mapExpression` walk.
 *
 * **Invalidation**: when a `local.set(i, ...)` or `local.tee(i, ...)` is
 * encountered, all cached CSE entries that reference `local.get(i)` are
 * evicted. Global-writes and calls evict all cached entries.
 *
 * Reference: `upstream/src/passes/LocalCSE.cpp`
 *
 * @license MIT OR Apache-2.0
 */

import {
  BinaryOp,
  Expression,
  ExpressionKind,
  LocalTeeExpr,
  makeLocalGet,
} from "../ir/expressions.ts";
import { Local, WasmFunction, WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";
import { mapExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Extracts repeated pure sub-expressions into fresh locals within blocks. */
export class LocalCSEPass implements Pass {
  readonly name = "LocalCSE";
  readonly description =
    "Common subexpression elimination: repeated pure expressions are computed once and cached in a local.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = _cseFunction(fn);
    }
  }
}

registerPass(LocalCSEPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function _cseFunction(fn: WasmFunction): Expression {
  // We may need to add fresh locals; track the next available index
  const state: CSEState = {
    nextLocal: fn.locals.length,
    newLocals: [],
  };

  const body = mapExpression(fn.body, (expr) => {
    if (expr.kind !== ExpressionKind.Block) return expr;
    return _cseBlock(expr, fn, state);
  });

  // Append any newly created locals
  if (state.newLocals.length > 0) {
    fn.locals = [...fn.locals, ...state.newLocals];
  }
  return body;
}

interface CSEState {
  nextLocal: number;
  newLocals: Local[];
}

function _cseBlock(
  block: Extract<Expression, { kind: ExpressionKind.Block }>,
  fn: WasmFunction,
  state: CSEState,
): Expression {
  // --- Pass 1: count occurrences of each keyed expression ---
  const counts = new Map<string, number>();
  for (const child of block.children) {
    _countKeys(child, counts);
  }

  // Only proceed if any expression appears more than once
  const candidates = new Set<string>(
    [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k),
  );
  if (candidates.size === 0) return block;

  // --- Pass 2: rewrite first occurrence → tee, subsequent → get ---
  const cache = new Map<string, number>(); // key → local index
  const newChildren: Expression[] = [];
  let changed = false;

  for (const child of block.children) {
    // Invalidate cache entries affected by side effects in this child
    _invalidate(child, cache);

    const rewritten = _rewriteExpr(child, candidates, cache, fn, state);
    if (rewritten !== child) changed = true;
    newChildren.push(rewritten);
  }

  if (!changed) return block;

  const lastType = newChildren[newChildren.length - 1].type;
  return { ...block, type: lastType, children: newChildren };
}

// ---------------------------------------------------------------------------
// Expression keying — structural identity hash
// ---------------------------------------------------------------------------

function _exprKey(expr: Expression): string | null {
  switch (expr.kind) {
    case ExpressionKind.Const: {
      const v = expr.value;
      if ("i32" in v) return `i32:${v.i32}`;
      if ("i64" in v) return `i64:${v.i64}`;
      if ("f32" in v) return `f32:${v.f32}`;
      if ("f64" in v) return `f64:${v.f64}`;
      return null;
    }
    case ExpressionKind.LocalGet:
      return `lg:${expr.index}`;
    case ExpressionKind.GlobalGet:
      return `gg:${expr.name}`;
    case ExpressionKind.Binary: {
      const op = expr.op;
      // Exclude trapping ops
      if (
        op === BinaryOp.DivSI32 || op === BinaryOp.DivUI32 ||
        op === BinaryOp.RemSI32 || op === BinaryOp.RemUI32 ||
        op === BinaryOp.DivSI64 || op === BinaryOp.DivUI64 ||
        op === BinaryOp.RemSI64 || op === BinaryOp.RemUI64
      ) return null;
      const lk = _exprKey(expr.left);
      const rk = _exprKey(expr.right);
      if (lk === null || rk === null) return null;
      return `b:${op}(${lk},${rk})`;
    }
    case ExpressionKind.Unary: {
      const op = expr.op as string;
      // Exclude trapping truncations
      if (op.includes("trunc") && !op.includes("sat")) return null;
      const vk = _exprKey(expr.value);
      if (vk === null) return null;
      return `u:${op}(${vk})`;
    }
    default:
      return null;
  }
}

function _countKeys(expr: Expression, counts: Map<string, number>): void {
  const key = _exprKey(expr);
  if (key !== null) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Recurse into all child expressions
  switch (expr.kind) {
    case ExpressionKind.Binary:
      _countKeys(expr.left, counts);
      _countKeys(expr.right, counts);
      break;
    case ExpressionKind.Unary:
    case ExpressionKind.Drop:
    case ExpressionKind.LocalSet:
    case ExpressionKind.LocalTee:
    case ExpressionKind.GlobalSet:
      _countKeys(expr.value, counts);
      break;
    case ExpressionKind.Return:
      if (expr.value) _countKeys(expr.value, counts);
      break;
    case ExpressionKind.Call:
      expr.operands.forEach((o) => _countKeys(o, counts));
      break;
    case ExpressionKind.Load:
      _countKeys(expr.ptr, counts);
      break;
    case ExpressionKind.Store:
      _countKeys(expr.ptr, counts);
      _countKeys(expr.value, counts);
      break;
  }
}

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

function _invalidate(expr: Expression, cache: Map<string, number>): void {
  // Check if this expression writes locals or globals, or calls functions
  switch (expr.kind) {
    case ExpressionKind.LocalSet:
    case ExpressionKind.LocalTee:
      // Evict all entries that depend on this local
      for (const key of [...cache.keys()]) {
        if (key.includes(`lg:${expr.index}`)) cache.delete(key);
      }
      break;
    case ExpressionKind.GlobalSet:
    case ExpressionKind.Call:
    case ExpressionKind.CallIndirect:
    case ExpressionKind.Store:
    case ExpressionKind.MemoryGrow:
    case ExpressionKind.MemoryCopy:
    case ExpressionKind.MemoryFill:
      // Conservative: evict everything
      cache.clear();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Rewrite: wrap first occurrence in tee, replace subsequent with get
// ---------------------------------------------------------------------------

function _rewriteExpr(
  expr: Expression,
  candidates: Set<string>,
  cache: Map<string, number>,
  fn: WasmFunction,
  state: CSEState,
): Expression {
  const key = _exprKey(expr);
  if (key !== null && candidates.has(key)) {
    const existing = cache.get(key);
    if (existing !== undefined) {
      // Replace with local.get
      return makeLocalGet(existing, _exprType(expr));
    } else {
      // First occurrence: wrap in local.tee and cache the slot
      const slot = state.nextLocal++;
      const localType = _exprType(expr);
      state.newLocals.push({ type: localType as ValType });
      fn.locals; // reference to suppress unused warning
      cache.set(key, slot);
      const tee: LocalTeeExpr = {
        kind: ExpressionKind.LocalTee,
        type: localType,
        index: slot,
        value: expr,
      };
      return tee;
    }
  }

  // Not a CSE candidate at the top level; recurse into sub-expressions
  switch (expr.kind) {
    case ExpressionKind.Binary:
      return {
        ...expr,
        left: _rewriteExpr(expr.left, candidates, cache, fn, state),
        right: _rewriteExpr(expr.right, candidates, cache, fn, state),
      };
    case ExpressionKind.Unary:
    case ExpressionKind.Drop:
    case ExpressionKind.LocalSet:
    case ExpressionKind.LocalTee:
    case ExpressionKind.GlobalSet:
      return {
        ...expr,
        value: _rewriteExpr(expr.value, candidates, cache, fn, state),
      };
    case ExpressionKind.Return:
      if (expr.value) {
        const v = _rewriteExpr(expr.value, candidates, cache, fn, state);
        return v === expr.value ? expr : { ...expr, value: v };
      }
      return expr;
    default:
      return expr;
  }
}

function _exprType(expr: Expression): ValType {
  const t = expr.type;
  if (typeof t === "string" && Object.values(ValType).includes(t as ValType)) {
    return t as ValType;
  }
  return ValType.I32; // fallback
}