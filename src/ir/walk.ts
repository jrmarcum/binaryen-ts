/**
 * @module binaryen-ts/ir/walk
 *
 * Tree walking utilities for the binaryen-ts IR.
 *
 * Two operations are provided:
 *
 * - {@link mapExpression} — transform a tree bottom-up (children first, then
 *   the parent). Used by optimisation passes that rewrite nodes.
 * - {@link walkExpression} — visit every node pre-order (parent before
 *   children). Used by analysis passes that only read the tree.
 *
 * @license MIT
 */

import {
  type Expression,
  ExpressionKind,
  type SIMDExtractExpr,
  type SIMDLoadExpr,
  type SIMDLoadStoreLaneExpr,
  type SIMDReplaceExpr,
  type SIMDShiftExpr,
  type SIMDShuffleExpr,
  type SIMDTernaryExpr,
} from "./expressions.ts";

// ---------------------------------------------------------------------------
// mapExpression — bottom-up tree transform
// ---------------------------------------------------------------------------

/**
 * Maps an expression tree bottom-up.
 *
 * Children are transformed recursively first, then `fn` is called on the
 * resulting node and may return a replacement. Passes that return the same
 * object from `fn` share unchanged subtrees with the original tree.
 *
 * @param expr - Root of the subtree to transform.
 * @param fn   - Called on each node after its children have been transformed.
 * @returns The transformed tree (may share structure with the original).
 */
export function mapExpression(
  expr: Expression,
  fn: (e: Expression) => Expression,
): Expression {
  const mapped = _mapChildren(expr, (c) => mapExpression(c, fn));
  return fn(mapped);
}

// ---------------------------------------------------------------------------
// walkExpression — pre-order visitor
// ---------------------------------------------------------------------------

/**
 * Visits every node in an expression tree in pre-order (parent before children).
 * Used by analysis passes that collect information without rewriting the tree.
 *
 * @param expr    - Root of the subtree to visit.
 * @param visitor - Called on each node. Return value is ignored.
 */
export function walkExpression(
  expr: Expression,
  visitor: (e: Expression) => void,
): void {
  visitor(expr);
  _visitChildren(expr, (child) => walkExpression(child, visitor));
}

/**
 * Visits the immediate children of an expression in their evaluation order
 * (matching the order the binary encoder emits them in). Unlike
 * {@link walkExpression}, the parent itself is not visited and the recursion
 * does not continue past the direct children — callers control whether to
 * recurse. CFG construction uses this to walk non-control nodes generically.
 *
 * @param expr  - The parent expression whose children to visit.
 * @param visit - Called on each direct child. Return value is ignored.
 */
export function visitChildren(
  expr: Expression,
  visit: (child: Expression) => void,
): void {
  _visitChildren(expr, visit);
}

/**
 * Rebuilds `expr` with each of its **direct** children replaced by `fn(child)`,
 * visiting children in evaluation order. Unlike {@link mapExpression}, `fn` is
 * NOT applied to `expr` itself and the recursion does NOT descend past the
 * direct children — the caller controls whether to recurse. This is the
 * one-level structural rebuild primitive used by passes (e.g. Flatten) that
 * need per-child control while collecting side information in `fn`.
 *
 * @param expr - The parent whose children to rebuild.
 * @param fn   - Maps each direct child to its replacement (called in eval order).
 * @returns A new parent node of the same kind with replaced children.
 */
export function mapChildrenShallow(
  expr: Expression,
  fn: (e: Expression) => Expression,
): Expression {
  return _mapChildren(expr, fn);
}

// ---------------------------------------------------------------------------
// Internal: map children. `fn` is applied to each DIRECT child (shallow);
// `mapExpression` passes a callback that recurses, so it maps the whole tree.
// ---------------------------------------------------------------------------

function _mapChildren(
  expr: Expression,
  fn: (e: Expression) => Expression,
): Expression {
  switch (expr.kind) {
    case ExpressionKind.Block:
      return { ...expr, children: expr.children.map((c) => fn(c)) };

    case ExpressionKind.If:
      return {
        ...expr,
        condition: fn(expr.condition),
        ifTrue: fn(expr.ifTrue),
        ifFalse: expr.ifFalse ? fn(expr.ifFalse) : null,
      };

    case ExpressionKind.Loop:
      return { ...expr, body: fn(expr.body) };

    case ExpressionKind.Break:
      return {
        ...expr,
        condition: expr.condition ? fn(expr.condition) : null,
        value: expr.value ? fn(expr.value) : null,
      };

    case ExpressionKind.Switch:
      return {
        ...expr,
        condition: fn(expr.condition),
        value: expr.value ? fn(expr.value) : null,
      };

    case ExpressionKind.Return:
      return {
        ...expr,
        value: expr.value ? fn(expr.value) : null,
      };

    case ExpressionKind.LocalSet:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.LocalTee:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.TableGet:
      return { ...expr, index: fn(expr.index) };

    case ExpressionKind.TableSet:
      return {
        ...expr,
        index: fn(expr.index),
        value: fn(expr.value),
      };

    case ExpressionKind.GlobalSet:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.Unary:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.Binary:
      return {
        ...expr,
        left: fn(expr.left),
        right: fn(expr.right),
      };

    case ExpressionKind.Select:
      return {
        ...expr,
        ifTrue: fn(expr.ifTrue),
        ifFalse: fn(expr.ifFalse),
        condition: fn(expr.condition),
      };

    case ExpressionKind.Drop:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.Load:
      return { ...expr, ptr: fn(expr.ptr) };

    case ExpressionKind.Store:
      return {
        ...expr,
        ptr: fn(expr.ptr),
        value: fn(expr.value),
      };

    case ExpressionKind.MemoryGrow:
      return { ...expr, delta: fn(expr.delta) };

    case ExpressionKind.MemoryCopy:
      return {
        ...expr,
        dest: fn(expr.dest),
        source: fn(expr.source),
        size: fn(expr.size),
      };

    case ExpressionKind.MemoryFill:
      return {
        ...expr,
        dest: fn(expr.dest),
        value: fn(expr.value),
        size: fn(expr.size),
      };

    case ExpressionKind.Call:
      return {
        ...expr,
        operands: expr.operands.map((o) => fn(o)),
      };

    case ExpressionKind.CallIndirect: {
      // Evaluation order is operands first, then the table index (target) last —
      // match wasm semantics so effect/eval-order-sensitive consumers (Flatten's
      // prelude hoisting, CFG construction) see children in the real order.
      const operands = expr.operands.map((o) => fn(o));
      const target = fn(expr.target);
      return { ...expr, target, operands };
    }

    case ExpressionKind.RefIsNull:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.RefEq:
      return {
        ...expr,
        left: fn(expr.left),
        right: fn(expr.right),
      };

    case ExpressionKind.RefI31:
      return { ...expr, value: fn(expr.value) };

    case ExpressionKind.I31Get:
      return { ...expr, i31: fn(expr.i31) };

    case ExpressionKind.StructNew:
      return { ...expr, operands: expr.operands.map((o) => fn(o)) };

    case ExpressionKind.StructGet:
      return { ...expr, ref: fn(expr.ref) };

    case ExpressionKind.StructSet:
      return {
        ...expr,
        ref: fn(expr.ref),
        value: fn(expr.value),
      };

    case ExpressionKind.ArrayNew:
      return {
        ...expr,
        init: expr.init ? fn(expr.init) : null,
        length: fn(expr.length),
      };

    case ExpressionKind.ArrayNewFixed:
      return { ...expr, values: expr.values.map((v) => fn(v)) };

    case ExpressionKind.ArrayNewData:
    case ExpressionKind.ArrayNewElem:
      return {
        ...expr,
        offset: fn(expr.offset),
        length: fn(expr.length),
      };

    case ExpressionKind.ArrayGet:
      return {
        ...expr,
        ref: fn(expr.ref),
        index: fn(expr.index),
      };

    case ExpressionKind.ArraySet:
      return {
        ...expr,
        ref: fn(expr.ref),
        index: fn(expr.index),
        value: fn(expr.value),
      };

    case ExpressionKind.ArrayLen:
      return { ...expr, ref: fn(expr.ref) };

    case ExpressionKind.RefTest:
    case ExpressionKind.RefCast:
      return { ...expr, ref: fn(expr.ref) };

    case ExpressionKind.BrOn:
      return { ...expr, ref: fn(expr.ref) };

    case ExpressionKind.TryTable:
      return {
        ...expr,
        body: fn(expr.body),
      };

    case ExpressionKind.Try:
      return {
        ...expr,
        body: fn(expr.body),
        catchBodies: expr.catchBodies.map((b) => fn(b)),
      };

    case ExpressionKind.Throw:
      return { ...expr, operands: expr.operands.map((o) => fn(o)) };

    case ExpressionKind.ThrowRef:
      return { ...expr, exnref: fn(expr.exnref) };

    case ExpressionKind.SIMDExtract:
      return {
        ...(expr as SIMDExtractExpr),
        vec: fn((expr as SIMDExtractExpr).vec),
      };

    case ExpressionKind.SIMDReplace: {
      const e = expr as SIMDReplaceExpr;
      return { ...e, vec: fn(e.vec), value: fn(e.value) };
    }

    case ExpressionKind.SIMDShuffle: {
      const e = expr as SIMDShuffleExpr;
      return { ...e, left: fn(e.left), right: fn(e.right) };
    }

    case ExpressionKind.SIMDTernary: {
      const e = expr as SIMDTernaryExpr;
      return {
        ...e,
        a: fn(e.a),
        b: fn(e.b),
        c: fn(e.c),
      };
    }

    case ExpressionKind.SIMDShift: {
      const e = expr as SIMDShiftExpr;
      return { ...e, vec: fn(e.vec), shift: fn(e.shift) };
    }

    case ExpressionKind.SIMDLoad:
      return { ...(expr as SIMDLoadExpr), ptr: fn((expr as SIMDLoadExpr).ptr) };

    case ExpressionKind.SIMDLoadStoreLane: {
      const e = expr as SIMDLoadStoreLaneExpr;
      return { ...e, ptr: fn(e.ptr), vec: fn(e.vec) };
    }

    // Leaf nodes — no children to transform
    case ExpressionKind.Nop:
    case ExpressionKind.Unreachable:
    case ExpressionKind.Const:
    case ExpressionKind.LocalGet:
    case ExpressionKind.GlobalGet:
    case ExpressionKind.MemorySize:
    case ExpressionKind.RefNull:
    case ExpressionKind.RefFunc:
    case ExpressionKind.Rethrow:
    case ExpressionKind.Pop:
      return expr;

    default:
      // Every constructed ExpressionKind is handled above (an explicit case or
      // a listed leaf). Reaching here means a new/placeholder kind was wired
      // into the IR without a walk case — silently passing it through would
      // hide its children from every pass (DCE / CSE / liveness), a miscompile.
      // Fail loudly at the moment the kind is introduced instead.
      throw new Error(
        `mapExpression: unhandled expression kind "${(expr as { kind: string }).kind}" ` +
          `(add a case to _mapChildren in walk.ts)`,
      );
  }
}

// ---------------------------------------------------------------------------
// Internal: visit children (pre-order helper)
// ---------------------------------------------------------------------------

function _visitChildren(
  expr: Expression,
  visit: (child: Expression) => void,
): void {
  switch (expr.kind) {
    case ExpressionKind.Block:
      expr.children.forEach(visit);
      break;
    case ExpressionKind.If:
      visit(expr.condition);
      visit(expr.ifTrue);
      if (expr.ifFalse) visit(expr.ifFalse);
      break;
    case ExpressionKind.Loop:
      visit(expr.body);
      break;
    case ExpressionKind.Break:
      if (expr.condition) visit(expr.condition);
      if (expr.value) visit(expr.value);
      break;
    case ExpressionKind.Switch:
      visit(expr.condition);
      if (expr.value) visit(expr.value);
      break;
    case ExpressionKind.Return:
      if (expr.value) visit(expr.value);
      break;
    case ExpressionKind.LocalSet:
    case ExpressionKind.LocalTee:
      visit(expr.value);
      break;
    case ExpressionKind.TableGet:
      visit(expr.index);
      break;
    case ExpressionKind.TableSet:
      visit(expr.index);
      visit(expr.value);
      break;
    case ExpressionKind.GlobalSet:
      visit(expr.value);
      break;
    case ExpressionKind.Unary:
      visit(expr.value);
      break;
    case ExpressionKind.Binary:
      visit(expr.left);
      visit(expr.right);
      break;
    case ExpressionKind.Select:
      visit(expr.ifTrue);
      visit(expr.ifFalse);
      visit(expr.condition);
      break;
    case ExpressionKind.Drop:
      visit(expr.value);
      break;
    case ExpressionKind.Load:
      visit(expr.ptr);
      break;
    case ExpressionKind.Store:
      visit(expr.ptr);
      visit(expr.value);
      break;
    case ExpressionKind.MemoryGrow:
      visit(expr.delta);
      break;
    case ExpressionKind.MemoryCopy:
      visit(expr.dest);
      visit(expr.source);
      visit(expr.size);
      break;
    case ExpressionKind.MemoryFill:
      visit(expr.dest);
      visit(expr.value);
      visit(expr.size);
      break;
    case ExpressionKind.Call:
      expr.operands.forEach(visit);
      break;
    case ExpressionKind.CallIndirect:
      // Operands evaluate before the table index (target) — visit in that order.
      expr.operands.forEach(visit);
      visit(expr.target);
      break;
    case ExpressionKind.RefIsNull:
      visit(expr.value);
      break;

    case ExpressionKind.RefEq:
      visit(expr.left);
      visit(expr.right);
      break;
    case ExpressionKind.RefI31:
      visit(expr.value);
      break;
    case ExpressionKind.I31Get:
      visit(expr.i31);
      break;
    case ExpressionKind.StructNew:
      expr.operands.forEach(visit);
      break;
    case ExpressionKind.StructGet:
      visit(expr.ref);
      break;
    case ExpressionKind.StructSet:
      visit(expr.ref);
      visit(expr.value);
      break;
    case ExpressionKind.ArrayNew:
      if (expr.init) visit(expr.init);
      visit(expr.length);
      break;
    case ExpressionKind.ArrayNewFixed:
      expr.values.forEach(visit);
      break;
    case ExpressionKind.ArrayNewData:
    case ExpressionKind.ArrayNewElem:
      visit(expr.offset);
      visit(expr.length);
      break;
    case ExpressionKind.ArrayGet:
      visit(expr.ref);
      visit(expr.index);
      break;
    case ExpressionKind.ArraySet:
      visit(expr.ref);
      visit(expr.index);
      visit(expr.value);
      break;
    case ExpressionKind.ArrayLen:
    case ExpressionKind.RefTest:
    case ExpressionKind.RefCast:
    case ExpressionKind.BrOn:
      visit(expr.ref);
      break;
    case ExpressionKind.TryTable:
      visit(expr.body);
      break;
    case ExpressionKind.Try:
      visit(expr.body);
      expr.catchBodies.forEach(visit);
      break;
    case ExpressionKind.Throw:
      expr.operands.forEach(visit);
      break;
    case ExpressionKind.ThrowRef:
      visit(expr.exnref);
      break;
    case ExpressionKind.SIMDExtract:
      visit((expr as SIMDExtractExpr).vec);
      break;
    case ExpressionKind.SIMDReplace: {
      const e = expr as SIMDReplaceExpr;
      visit(e.vec);
      visit(e.value);
      break;
    }
    case ExpressionKind.SIMDShuffle: {
      const e = expr as SIMDShuffleExpr;
      visit(e.left);
      visit(e.right);
      break;
    }
    case ExpressionKind.SIMDTernary: {
      const e = expr as SIMDTernaryExpr;
      visit(e.a);
      visit(e.b);
      visit(e.c);
      break;
    }
    case ExpressionKind.SIMDShift: {
      const e = expr as SIMDShiftExpr;
      visit(e.vec);
      visit(e.shift);
      break;
    }
    case ExpressionKind.SIMDLoad:
      visit((expr as SIMDLoadExpr).ptr);
      break;
    case ExpressionKind.SIMDLoadStoreLane: {
      const e = expr as SIMDLoadStoreLaneExpr;
      visit(e.ptr);
      visit(e.vec);
      break;
    }

    // Leaf nodes — no children to visit.
    case ExpressionKind.Nop:
    case ExpressionKind.Unreachable:
    case ExpressionKind.Const:
    case ExpressionKind.LocalGet:
    case ExpressionKind.GlobalGet:
    case ExpressionKind.MemorySize:
    case ExpressionKind.RefNull:
    case ExpressionKind.RefFunc:
    case ExpressionKind.Rethrow:
    case ExpressionKind.Pop:
      break;

    default:
      // As in _mapChildren: every constructed kind is handled above, so this is
      // reached only by a new/placeholder kind with no walk case. Failing loudly
      // prevents a pass from silently skipping the subtree.
      throw new Error(
        `walkExpression: unhandled expression kind "${(expr as { kind: string }).kind}" ` +
          `(add a case to _visitChildren in walk.ts)`,
      );
  }
}
