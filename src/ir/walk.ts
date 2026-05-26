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
  const mapped = _mapChildren(expr, fn);
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

// ---------------------------------------------------------------------------
// Internal: map children
// ---------------------------------------------------------------------------

function _mapChildren(
  expr: Expression,
  fn: (e: Expression) => Expression,
): Expression {
  switch (expr.kind) {
    case ExpressionKind.Block:
      return { ...expr, children: expr.children.map((c) => mapExpression(c, fn)) };

    case ExpressionKind.If:
      return {
        ...expr,
        condition: mapExpression(expr.condition, fn),
        ifTrue: mapExpression(expr.ifTrue, fn),
        ifFalse: expr.ifFalse ? mapExpression(expr.ifFalse, fn) : null,
      };

    case ExpressionKind.Loop:
      return { ...expr, body: mapExpression(expr.body, fn) };

    case ExpressionKind.Break:
      return {
        ...expr,
        condition: expr.condition ? mapExpression(expr.condition, fn) : null,
        value: expr.value ? mapExpression(expr.value, fn) : null,
      };

    case ExpressionKind.Switch:
      return {
        ...expr,
        condition: mapExpression(expr.condition, fn),
        value: expr.value ? mapExpression(expr.value, fn) : null,
      };

    case ExpressionKind.Return:
      return {
        ...expr,
        value: expr.value ? mapExpression(expr.value, fn) : null,
      };

    case ExpressionKind.LocalSet:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.LocalTee:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.TableGet:
      return { ...expr, index: mapExpression(expr.index, fn) };

    case ExpressionKind.TableSet:
      return {
        ...expr,
        index: mapExpression(expr.index, fn),
        value: mapExpression(expr.value, fn),
      };

    case ExpressionKind.GlobalSet:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.Unary:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.Binary:
      return {
        ...expr,
        left: mapExpression(expr.left, fn),
        right: mapExpression(expr.right, fn),
      };

    case ExpressionKind.Select:
      return {
        ...expr,
        ifTrue: mapExpression(expr.ifTrue, fn),
        ifFalse: mapExpression(expr.ifFalse, fn),
        condition: mapExpression(expr.condition, fn),
      };

    case ExpressionKind.Drop:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.Load:
      return { ...expr, ptr: mapExpression(expr.ptr, fn) };

    case ExpressionKind.Store:
      return {
        ...expr,
        ptr: mapExpression(expr.ptr, fn),
        value: mapExpression(expr.value, fn),
      };

    case ExpressionKind.MemoryGrow:
      return { ...expr, delta: mapExpression(expr.delta, fn) };

    case ExpressionKind.MemoryCopy:
      return {
        ...expr,
        dest: mapExpression(expr.dest, fn),
        source: mapExpression(expr.source, fn),
        size: mapExpression(expr.size, fn),
      };

    case ExpressionKind.MemoryFill:
      return {
        ...expr,
        dest: mapExpression(expr.dest, fn),
        value: mapExpression(expr.value, fn),
        size: mapExpression(expr.size, fn),
      };

    case ExpressionKind.Call:
      return {
        ...expr,
        operands: expr.operands.map((o) => mapExpression(o, fn)),
      };

    case ExpressionKind.CallIndirect:
      return {
        ...expr,
        target: mapExpression(expr.target, fn),
        operands: expr.operands.map((o) => mapExpression(o, fn)),
      };

    case ExpressionKind.RefIsNull:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.RefEq:
      return {
        ...expr,
        left: mapExpression(expr.left, fn),
        right: mapExpression(expr.right, fn),
      };

    case ExpressionKind.RefI31:
      return { ...expr, value: mapExpression(expr.value, fn) };

    case ExpressionKind.I31Get:
      return { ...expr, i31: mapExpression(expr.i31, fn) };

    case ExpressionKind.StructNew:
      return { ...expr, operands: expr.operands.map((o) => mapExpression(o, fn)) };

    case ExpressionKind.StructGet:
      return { ...expr, ref: mapExpression(expr.ref, fn) };

    case ExpressionKind.StructSet:
      return {
        ...expr,
        ref: mapExpression(expr.ref, fn),
        value: mapExpression(expr.value, fn),
      };

    case ExpressionKind.ArrayNew:
      return {
        ...expr,
        init: expr.init ? mapExpression(expr.init, fn) : null,
        length: mapExpression(expr.length, fn),
      };

    case ExpressionKind.ArrayNewFixed:
      return { ...expr, values: expr.values.map((v) => mapExpression(v, fn)) };

    case ExpressionKind.ArrayNewData:
    case ExpressionKind.ArrayNewElem:
      return {
        ...expr,
        offset: mapExpression(expr.offset, fn),
        length: mapExpression(expr.length, fn),
      };

    case ExpressionKind.ArrayGet:
      return {
        ...expr,
        ref: mapExpression(expr.ref, fn),
        index: mapExpression(expr.index, fn),
      };

    case ExpressionKind.ArraySet:
      return {
        ...expr,
        ref: mapExpression(expr.ref, fn),
        index: mapExpression(expr.index, fn),
        value: mapExpression(expr.value, fn),
      };

    case ExpressionKind.ArrayLen:
      return { ...expr, ref: mapExpression(expr.ref, fn) };

    case ExpressionKind.RefTest:
    case ExpressionKind.RefCast:
      return { ...expr, ref: mapExpression(expr.ref, fn) };

    case ExpressionKind.BrOn:
      return { ...expr, ref: mapExpression(expr.ref, fn) };

    case ExpressionKind.TryTable:
      return {
        ...expr,
        body: mapExpression(expr.body, fn),
      };

    case ExpressionKind.Try:
      return {
        ...expr,
        body: mapExpression(expr.body, fn),
        catchBodies: expr.catchBodies.map((b) => mapExpression(b, fn)),
      };

    case ExpressionKind.Throw:
      return { ...expr, operands: expr.operands.map((o) => mapExpression(o, fn)) };

    case ExpressionKind.ThrowRef:
      return { ...expr, exnref: mapExpression(expr.exnref, fn) };

    case ExpressionKind.SIMDExtract:
      return {
        ...(expr as SIMDExtractExpr),
        vec: mapExpression((expr as SIMDExtractExpr).vec, fn),
      };

    case ExpressionKind.SIMDReplace: {
      const e = expr as SIMDReplaceExpr;
      return { ...e, vec: mapExpression(e.vec, fn), value: mapExpression(e.value, fn) };
    }

    case ExpressionKind.SIMDShuffle: {
      const e = expr as SIMDShuffleExpr;
      return { ...e, left: mapExpression(e.left, fn), right: mapExpression(e.right, fn) };
    }

    case ExpressionKind.SIMDTernary: {
      const e = expr as SIMDTernaryExpr;
      return {
        ...e,
        a: mapExpression(e.a, fn),
        b: mapExpression(e.b, fn),
        c: mapExpression(e.c, fn),
      };
    }

    case ExpressionKind.SIMDShift: {
      const e = expr as SIMDShiftExpr;
      return { ...e, vec: mapExpression(e.vec, fn), shift: mapExpression(e.shift, fn) };
    }

    case ExpressionKind.SIMDLoad:
      return { ...(expr as SIMDLoadExpr), ptr: mapExpression((expr as SIMDLoadExpr).ptr, fn) };

    case ExpressionKind.SIMDLoadStoreLane: {
      const e = expr as SIMDLoadStoreLaneExpr;
      return { ...e, ptr: mapExpression(e.ptr, fn), vec: mapExpression(e.vec, fn) };
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
      // Unknown or unhandled kind — pass through unchanged
      return expr;
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
      visit(expr.target);
      expr.operands.forEach(visit);
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
    default:
      break;
  }
}
