/**
 * @module binaryen-ts/passes/optimize-instructions
 *
 * OptimizeInstructions pass — peephole rewrites and algebraic simplifications.
 *
 * Two categories of transformations:
 *
 * **Algebraic identities** (applied when one operand is a constant):
 *   - `add(x, 0)` / `add(0, x)` → `x`
 *   - `sub(x, 0)` → `x`
 *   - `mul(x, 1)` / `mul(1, x)` → `x`
 *   - `mul(x, 0)` / `mul(0, x)` → `0` (only when the other operand is pure)
 *   - `and(x, -1)` / `and(-1, x)` → `x`
 *   - `and(x, 0)` / `and(0, x)` → `0` (pure operand only)
 *   - `or(x, 0)` / `or(0, x)` → `x`
 *   - `or(x, -1)` / `or(-1, x)` → `-1` (pure operand only)
 *   - `xor(x, 0)` / `xor(0, x)` → `x`
 *   - `shl/shr/rot(x, 0)` → `x`
 *   - `div(x, 1)` → `x`
 *   - `eq(x, 0)` → `eqz(x)` (i32 only)
 *
 * **Constant folding** (both operands are compile-time constants):
 *   - Integer binary ops: add, sub, mul, and, or, xor, shl, shr, rotl, rotr,
 *     eq, ne, lt, le, gt, ge (signed and unsigned variants).
 *   - Integer unary ops: clz, eqz, extend, wrap, sign-extend.
 *   - Division is excluded from constant folding (can trap on zero).
 *
 * Reference: `upstream/src/passes/OptimizeInstructions.cpp`
 *
 * @license MIT
 */

import {
  BinaryOp,
  Expression,
  ExpressionKind,
  Literal,
  UnaryOp,
  makeI32Const,
  makeI64Const,
} from "../ir/expressions.ts";
import { WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";
import { mapExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Peephole rewrites: algebraic identities and integer constant folding. */
export class OptimizeInstructionsPass implements Pass {
  readonly name = "OptimizeInstructions";
  readonly description =
    "Algebraic identities (identity element removal, strength reduction) and integer constant folding.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = mapExpression(fn.body, _optimizeNode);
    }
    for (const global of module.globals) {
      global.init = mapExpression(global.init, _optimizeNode);
    }
  }
}

registerPass(OptimizeInstructionsPass);

// ---------------------------------------------------------------------------
// Node-level optimizer (called bottom-up by mapExpression)
// ---------------------------------------------------------------------------

function _optimizeNode(expr: Expression): Expression {
  if (expr.kind === ExpressionKind.Binary) return _optimizeBinary(expr);
  if (expr.kind === ExpressionKind.Unary) return _optimizeUnary(expr);
  return expr;
}

// ---------------------------------------------------------------------------
// Binary optimizations
// ---------------------------------------------------------------------------

function _optimizeBinary(
  expr: Extract<Expression, { kind: ExpressionKind.Binary }>,
): Expression {
  const { op, left, right } = expr;

  // Constant folding: both operands are literal constants
  if (left.kind === ExpressionKind.Const && right.kind === ExpressionKind.Const) {
    const folded = _foldBinary(op, left.value, right.value);
    if (folded !== null) return folded;
  }

  // Algebraic identities with a constant on the right
  if (right.kind === ExpressionKind.Const) {
    const r = _simplifyRHS(op, left, right.value);
    if (r !== null) return r;
  }

  // Algebraic identities with a constant on the left (commutative ops)
  if (left.kind === ExpressionKind.Const) {
    const r = _simplifyLHS(op, left.value, right);
    if (r !== null) return r;
  }

  return expr;
}

/** True if `expr` has no observable side effects and can be dropped safely. */
function _isPure(expr: Expression): boolean {
  switch (expr.kind) {
    case ExpressionKind.Const:
    case ExpressionKind.Nop:
    case ExpressionKind.LocalGet:
    case ExpressionKind.GlobalGet:
      return true;
    case ExpressionKind.Binary: {
      const op = expr.op;
      // Integer division and remainder can trap on zero
      if (
        op === BinaryOp.DivSI32 || op === BinaryOp.DivUI32 ||
        op === BinaryOp.RemSI32 || op === BinaryOp.RemUI32 ||
        op === BinaryOp.DivSI64 || op === BinaryOp.DivUI64 ||
        op === BinaryOp.RemSI64 || op === BinaryOp.RemUI64
      ) return false;
      return _isPure(expr.left) && _isPure(expr.right);
    }
    case ExpressionKind.Unary: {
      // Non-saturating float-to-int truncations can trap
      const op = expr.op as string;
      if (op.includes("trunc") && !op.includes("sat")) return false;
      return _isPure(expr.value);
    }
    default:
      return false;
  }
}

function _simplifyRHS(
  op: BinaryOp,
  left: Expression,
  rhs: Literal,
): Expression | null {
  if ("i32" in rhs) {
    const v = rhs.i32 as number;
    switch (op) {
      case BinaryOp.AddI32: if (v === 0) return left; break;
      case BinaryOp.SubI32: if (v === 0) return left; break;
      case BinaryOp.MulI32:
        if (v === 1) return left;
        if (v === 0 && _isPure(left)) return makeI32Const(0);
        break;
      case BinaryOp.DivSI32:
      case BinaryOp.DivUI32:
        if (v === 1) return left;
        break;
      case BinaryOp.AndI32:
        if (v === -1) return left;
        if (v === 0 && _isPure(left)) return makeI32Const(0);
        break;
      case BinaryOp.OrI32:
        if (v === 0) return left;
        if (v === -1 && _isPure(left)) return makeI32Const(-1);
        break;
      case BinaryOp.XorI32: if (v === 0) return left; break;
      case BinaryOp.ShlI32:
      case BinaryOp.ShrSI32:
      case BinaryOp.ShrUI32:
      case BinaryOp.RotlI32:
      case BinaryOp.RotrI32:
        if ((v & 31) === 0) return left;
        break;
      case BinaryOp.EqI32:
        if (v === 0) {
          return {
            kind: ExpressionKind.Unary,
            type: ValType.I32,
            op: UnaryOp.EqzI32,
            value: left,
          };
        }
        break;
    }
  }

  if ("i64" in rhs) {
    const v = rhs.i64 as bigint;
    switch (op) {
      case BinaryOp.AddI64: if (v === 0n) return left; break;
      case BinaryOp.SubI64: if (v === 0n) return left; break;
      case BinaryOp.MulI64:
        if (v === 1n) return left;
        if (v === 0n && _isPure(left)) return makeI64Const(0n);
        break;
      case BinaryOp.DivSI64:
      case BinaryOp.DivUI64:
        if (v === 1n) return left;
        break;
      case BinaryOp.AndI64:
        if (v === -1n) return left;
        if (v === 0n && _isPure(left)) return makeI64Const(0n);
        break;
      case BinaryOp.OrI64:
        if (v === 0n) return left;
        if (v === -1n && _isPure(left)) return makeI64Const(-1n);
        break;
      case BinaryOp.XorI64: if (v === 0n) return left; break;
      case BinaryOp.ShlI64:
      case BinaryOp.ShrSI64:
      case BinaryOp.ShrUI64:
      case BinaryOp.RotlI64:
      case BinaryOp.RotrI64:
        if ((v & 63n) === 0n) return left;
        break;
      case BinaryOp.EqI64:
        if (v === 0n) {
          return {
            kind: ExpressionKind.Unary,
            type: ValType.I32,
            op: UnaryOp.EqzI64,
            value: left,
          };
        }
        break;
    }
  }

  return null;
}

function _simplifyLHS(
  op: BinaryOp,
  lhs: Literal,
  right: Expression,
): Expression | null {
  if ("i32" in lhs) {
    const v = lhs.i32 as number;
    switch (op) {
      case BinaryOp.AddI32: if (v === 0) return right; break;
      case BinaryOp.MulI32:
        if (v === 1) return right;
        if (v === 0 && _isPure(right)) return makeI32Const(0);
        break;
      case BinaryOp.AndI32:
        if (v === -1) return right;
        if (v === 0 && _isPure(right)) return makeI32Const(0);
        break;
      case BinaryOp.OrI32:
        if (v === 0) return right;
        if (v === -1 && _isPure(right)) return makeI32Const(-1);
        break;
      case BinaryOp.XorI32: if (v === 0) return right; break;
    }
  }

  if ("i64" in lhs) {
    const v = lhs.i64 as bigint;
    switch (op) {
      case BinaryOp.AddI64: if (v === 0n) return right; break;
      case BinaryOp.MulI64:
        if (v === 1n) return right;
        if (v === 0n && _isPure(right)) return makeI64Const(0n);
        break;
      case BinaryOp.AndI64:
        if (v === -1n) return right;
        if (v === 0n && _isPure(right)) return makeI64Const(0n);
        break;
      case BinaryOp.OrI64:
        if (v === 0n) return right;
        if (v === -1n && _isPure(right)) return makeI64Const(-1n);
        break;
      case BinaryOp.XorI64: if (v === 0n) return right; break;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Unary optimizations
// ---------------------------------------------------------------------------

function _optimizeUnary(
  expr: Extract<Expression, { kind: ExpressionKind.Unary }>,
): Expression {
  if (expr.value.kind === ExpressionKind.Const) {
    const folded = _foldUnary(expr.op, expr.value.value);
    if (folded !== null) return folded;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Constant folding — binary
// ---------------------------------------------------------------------------

function _foldBinary(
  op: BinaryOp,
  lhs: Literal,
  rhs: Literal,
): Expression | null {
  // i32 × i32
  if ("i32" in lhs && "i32" in rhs) {
    const a = lhs.i32 as number;
    const b = rhs.i32 as number;
    switch (op) {
      case BinaryOp.AddI32:  return makeI32Const((a + b) | 0);
      case BinaryOp.SubI32:  return makeI32Const((a - b) | 0);
      case BinaryOp.MulI32:  return makeI32Const(Math.imul(a, b));
      case BinaryOp.AndI32:  return makeI32Const(a & b);
      case BinaryOp.OrI32:   return makeI32Const(a | b);
      case BinaryOp.XorI32:  return makeI32Const(a ^ b);
      case BinaryOp.ShlI32:  return makeI32Const((a << (b & 31)) | 0);
      case BinaryOp.ShrSI32: return makeI32Const(a >> (b & 31));
      case BinaryOp.ShrUI32: return makeI32Const((a >>> (b & 31)) | 0);
      case BinaryOp.RotlI32: {
        const s = b & 31;
        return makeI32Const(s === 0 ? a : ((a << s) | (a >>> (32 - s))) | 0);
      }
      case BinaryOp.RotrI32: {
        const s = b & 31;
        return makeI32Const(s === 0 ? a : ((a >>> s) | (a << (32 - s))) | 0);
      }
      case BinaryOp.EqI32:   return makeI32Const(a === b ? 1 : 0);
      case BinaryOp.NeI32:   return makeI32Const(a !== b ? 1 : 0);
      case BinaryOp.LtSI32:  return makeI32Const(a < b ? 1 : 0);
      case BinaryOp.LeSI32:  return makeI32Const(a <= b ? 1 : 0);
      case BinaryOp.GtSI32:  return makeI32Const(a > b ? 1 : 0);
      case BinaryOp.GeSI32:  return makeI32Const(a >= b ? 1 : 0);
      case BinaryOp.LtUI32:  return makeI32Const((a >>> 0) < (b >>> 0) ? 1 : 0);
      case BinaryOp.LeUI32:  return makeI32Const((a >>> 0) <= (b >>> 0) ? 1 : 0);
      case BinaryOp.GtUI32:  return makeI32Const((a >>> 0) > (b >>> 0) ? 1 : 0);
      case BinaryOp.GeUI32:  return makeI32Const((a >>> 0) >= (b >>> 0) ? 1 : 0);
    }
  }

  // i64 × i64
  if ("i64" in lhs && "i64" in rhs) {
    const a = lhs.i64 as bigint;
    const b = rhs.i64 as bigint;
    switch (op) {
      case BinaryOp.AddI64:  return makeI64Const(BigInt.asIntN(64, a + b));
      case BinaryOp.SubI64:  return makeI64Const(BigInt.asIntN(64, a - b));
      case BinaryOp.MulI64:  return makeI64Const(BigInt.asIntN(64, a * b));
      case BinaryOp.AndI64:  return makeI64Const(BigInt.asIntN(64, a & b));
      case BinaryOp.OrI64:   return makeI64Const(BigInt.asIntN(64, a | b));
      case BinaryOp.XorI64:  return makeI64Const(BigInt.asIntN(64, a ^ b));
      case BinaryOp.ShlI64:  return makeI64Const(BigInt.asIntN(64, a << (b & 63n)));
      case BinaryOp.ShrSI64: return makeI64Const(a >> (b & 63n));
      case BinaryOp.ShrUI64: return makeI64Const(
        BigInt.asIntN(64, BigInt.asUintN(64, a) >> (b & 63n)),
      );
      case BinaryOp.RotlI64: {
        const s = b & 63n;
        if (s === 0n) return makeI64Const(a);
        const u = BigInt.asUintN(64, a);
        return makeI64Const(BigInt.asIntN(64, (u << s) | (u >> (64n - s))));
      }
      case BinaryOp.RotrI64: {
        const s = b & 63n;
        if (s === 0n) return makeI64Const(a);
        const u = BigInt.asUintN(64, a);
        return makeI64Const(BigInt.asIntN(64, (u >> s) | (u << (64n - s))));
      }
      // i64 comparisons return i32
      case BinaryOp.EqI64:   return makeI32Const(a === b ? 1 : 0);
      case BinaryOp.NeI64:   return makeI32Const(a !== b ? 1 : 0);
      case BinaryOp.LtSI64:  return makeI32Const(a < b ? 1 : 0);
      case BinaryOp.LeSI64:  return makeI32Const(a <= b ? 1 : 0);
      case BinaryOp.GtSI64:  return makeI32Const(a > b ? 1 : 0);
      case BinaryOp.GeSI64:  return makeI32Const(a >= b ? 1 : 0);
      case BinaryOp.LtUI64: return makeI32Const(BigInt.asUintN(64, a) < BigInt.asUintN(64, b) ? 1 : 0);
      case BinaryOp.LeUI64: return makeI32Const(BigInt.asUintN(64, a) <= BigInt.asUintN(64, b) ? 1 : 0);
      case BinaryOp.GtUI64: return makeI32Const(BigInt.asUintN(64, a) > BigInt.asUintN(64, b) ? 1 : 0);
      case BinaryOp.GeUI64: return makeI32Const(BigInt.asUintN(64, a) >= BigInt.asUintN(64, b) ? 1 : 0);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Constant folding — unary
// ---------------------------------------------------------------------------

function _foldUnary(op: UnaryOp, val: Literal): Expression | null {
  if ("i32" in val) {
    const v = val.i32 as number;
    switch (op) {
      case UnaryOp.ClzI32:      return makeI32Const(Math.clz32(v));
      case UnaryOp.EqzI32:      return makeI32Const(v === 0 ? 1 : 0);
      case UnaryOp.ExtendSI32:  return makeI64Const(BigInt(v));
      case UnaryOp.ExtendUI32:  return makeI64Const(BigInt(v >>> 0));
      case UnaryOp.ExtendS8I32: return makeI32Const((v << 24) >> 24);
      case UnaryOp.ExtendS16I32: return makeI32Const((v << 16) >> 16);
      case UnaryOp.ReinterpretI32: {
        const buf = new ArrayBuffer(4);
        new Int32Array(buf)[0] = v;
        return makeI32Const(new Float32Array(buf)[0]);
      }
    }
  }

  if ("i64" in val) {
    const v = val.i64 as bigint;
    switch (op) {
      case UnaryOp.WrapI64:      return makeI32Const(Number(BigInt.asIntN(32, v)));
      case UnaryOp.EqzI64:       return makeI32Const(v === 0n ? 1 : 0);
      case UnaryOp.ExtendS8I64:  return makeI64Const(BigInt.asIntN(64, BigInt((Number(v) << 56) >> 56)));
      case UnaryOp.ExtendS16I64: return makeI64Const(BigInt.asIntN(64, BigInt((Number(v) << 48) >> 48)));
      case UnaryOp.ExtendS32I64: return makeI64Const(BigInt.asIntN(64, BigInt(Number(BigInt.asIntN(32, v)))));
    }
  }

  if ("f32" in val) {
    const v = val.f32 as number;
    if (op === UnaryOp.ReinterpretF32) {
      const buf = new ArrayBuffer(4);
      new Float32Array(buf)[0] = v;
      return makeI32Const(new Int32Array(buf)[0]);
    }
  }

  if ("f64" in val) {
    const v = val.f64 as number;
    if (op === UnaryOp.ReinterpretF64) {
      const buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v;
      const lo = new Int32Array(buf)[0];
      const hi = new Int32Array(buf)[1];
      return makeI64Const(BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo >>> 0)));
    }
  }

  return null;
}