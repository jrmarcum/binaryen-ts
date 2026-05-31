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
 * @license MIT
 */

import {
  BinaryOp,
  type Expression,
  ExpressionKind,
  type LocalTeeExpr,
  makeLocalGet,
} from "../ir/expressions.ts";
import type { Local, WasmFunction, WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";

const _VAL_TYPES = new Set<string>(Object.values(ValType) as string[]);

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
  // We may need to add fresh locals; track the next available index.
  // `fn.locals` is the full local vector INCLUDING params (the encoder slices
  // `fn.locals.slice(fn.params.length)` to recover the declared-locals tail),
  // so `fn.locals.length` is already the next free absolute index.
  const state: CSEState = {
    nextLocal: fn.locals.length,
    newLocals: [],
  };

  const body = mapExpression(fn.body, (expr) => {
    if (expr.kind !== ExpressionKind.Block) return expr;
    return _cseBlock(expr, state);
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
  state: CSEState,
): Expression {
  // --- Pass 1: count occurrences of each keyed expression ---
  const counts = new Map<string, number>();
  for (const child of block.children) {
    _countKeys(child, counts);
  }

  // Only proceed if any expression appears more than once
  const candidates = new Set<string>();
  for (const [k, n] of counts) {
    if (n > 1) candidates.add(k);
  }
  if (candidates.size === 0) return block;

  // --- Pass 2: rewrite first occurrence → tee, subsequent → get ---
  const cache = new Map<string, number>(); // key → local index
  const newChildren: Expression[] = [];
  let changed = false;

  for (const child of block.children) {
    // Pre-invalidate: clear entries this child's writes will clobber. Pre is
    // necessary so the FIRST occurrence of a key inside this child (a tee that
    // captures the OLD value) isn't a stale hit on a prior entry.
    _invalidate(child, cache);

    const rewritten = _rewriteExpr(child, candidates, cache, state);
    if (rewritten !== child) changed = true;
    newChildren.push(rewritten);

    // Post-invalidate: any entry CREATED inside this child (via a tee in the
    // child's value sub-expression) captures the pre-side-effect value. The
    // child's surrounding write then clobbers the underlying slot, so the
    // entry is stale for subsequent block children. Without this, e.g. a
    // `set K (... tee N (lg K) ...)` would leave `lg:K → N` in the cache, and
    // a later child's `lg K` would be substituted with `lg N` — reading the
    // PRE-set value instead of the POST-set value. Was: `_fib(7)` came out as
    // `fib(8) = 34` after the loop's `$9 == $0` test silently read the old
    // `$8` instead of the freshly-stored `$9`, running one extra iteration.
    _invalidate(child, cache);
  }

  if (!changed) return block;

  // Preserve the block's declared result type. CSE rewriting only ever wraps a
  // value in `local.tee` or replaces it with `local.get` — both keep the
  // expression's type — so the block's result type is unchanged. Recomputing it
  // from the last child is wrong when the block exits via `br`/`return`: the
  // last child is then typed `unreachable`, and overwriting the declared type
  // (e.g. `i32`) with that makes the encoder emit a void blocktype, tripping
  // "expected N elements for fallthru, found 0" in any enclosing result-typed
  // construct. (Same trap the binary parser's block handler guards against.)
  return { ...block, children: newChildren };
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
  // Walk the WHOLE child subtree, not just its top-level node: a block child
  // such as `(if cond (then (local.set 1 ...)))` writes local 1 from inside a
  // nested control node, and that write must still evict any cached
  // `local.get 1` entry — otherwise a later sibling `local.set 3 (local.get 1)`
  // is wrongly rewritten to read the entry's stale (pre-write) tee. (This is
  // what mis-formatted negative integers in wasic's itoa: the `-` sign's buffer
  // advance happened inside an `if`, so the post-`if` pointer read was
  // substituted with the entry-time pointer and the sign was overwritten.)
  walkExpression(expr, (e) => {
    switch (e.kind) {
      case ExpressionKind.LocalSet:
      case ExpressionKind.LocalTee:
        // Evict all entries that depend on this local.
        for (const key of [...cache.keys()]) {
          if (key.includes(`lg:${e.index}`)) cache.delete(key);
        }
        break;
      case ExpressionKind.GlobalSet:
      case ExpressionKind.Call:
      case ExpressionKind.CallIndirect:
      case ExpressionKind.Store:
      case ExpressionKind.MemoryGrow:
      case ExpressionKind.MemoryCopy:
      case ExpressionKind.MemoryFill:
        // Conservative: evict everything.
        cache.clear();
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Rewrite: wrap first occurrence in tee, replace subsequent with get
// ---------------------------------------------------------------------------

function _rewriteExpr(
  expr: Expression,
  candidates: Set<string>,
  cache: Map<string, number>,
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
    case ExpressionKind.Binary: {
      // A binary evaluates `left` then `right`. If `left` writes a local
      // (e.g. a nested `local.tee K`), any cached `local.get K` entry is stale
      // for `right` — invalidate between the operands so a `local.get K` in
      // `right` is NOT rewritten to read the entry-time value. `_invalidate`
      // walks the ORIGINAL `left` (which still carries the real writes; the
      // CSE-introduced tee only writes a fresh local). This is the
      // within-expression analogue of the cross-sibling write the block-level
      // invalidation already handles — without it, `monthFromDays`/`dayFromDays`
      // in a `wasmmerge`-spliced module read a pre-mutation `era`/`yoe` value.
      const left = _rewriteExpr(expr.left, candidates, cache, state);
      _invalidate(expr.left, cache);
      const right = _rewriteExpr(expr.right, candidates, cache, state);
      return { ...expr, left, right };
    }
    case ExpressionKind.Unary:
    case ExpressionKind.Drop:
    case ExpressionKind.LocalSet:
    case ExpressionKind.LocalTee:
    case ExpressionKind.GlobalSet:
      return {
        ...expr,
        value: _rewriteExpr(expr.value, candidates, cache, state),
      };
    case ExpressionKind.Return:
      if (expr.value) {
        const v = _rewriteExpr(expr.value, candidates, cache, state);
        return v === expr.value ? expr : { ...expr, value: v };
      }
      return expr;
    default:
      return expr;
  }
}

function _exprType(expr: Expression): ValType {
  const t = expr.type;
  if (typeof t === "string" && _VAL_TYPES.has(t)) {
    return t as ValType;
  }
  return ValType.I32; // fallback
}
