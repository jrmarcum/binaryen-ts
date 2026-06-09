/**
 * @module binaryen-ts/passes/vacuum
 *
 * Vacuum pass — removes obviously unneeded code.
 *
 * Transformations applied:
 *
 * - `nop` instructions are removed from block children (they contribute no
 *   value and have no side effects).
 * - Empty blocks (after nop removal) collapse to `nop`.
 * - Unnamed single-child blocks collapse to their sole child.
 * - `drop(nop)` → `nop`.
 * - `drop(unreachable)` → `unreachable` (propagate unreachability).
 * - `drop(const)` → `nop` (constants have no side effects).
 * - `drop(local.get)` → `nop` (local reads have no side effects).
 * - `drop(global.get)` → `nop` (global reads have no side effects).
 *
 * Reference: `upstream/src/passes/Vacuum.cpp`
 *
 * @license MIT
 */

import { type Expression, ExpressionKind, makeNop } from "../ir/expressions.ts";
import type { WasmModule } from "../ir/module.ts";
import { Unreachable } from "../ir/types.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";
import { mapExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Removes nops, empty blocks, and dropped pure expressions. */
export class VacuumPass implements Pass {
  readonly name = "Vacuum";
  readonly description =
    "Removes nop instructions, empty/redundant blocks, and dropped pure expressions.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = mapExpression(fn.body, _vacuumNode);
    }
    for (const global of module.globals) {
      global.init = mapExpression(global.init, _vacuumNode);
    }
  }
}

registerPass(VacuumPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Bottom-up vacuum transform for a single expression node.
 *
 * Exposed for callers that need to apply Vacuum semantics to a single
 * function body without running the whole module pass — e.g. the
 * `InliningOptimizing` pass cleans inlined call sites this way.
 */
export function vacuumNode(expr: Expression): Expression {
  return _vacuumNode(expr);
}

function _vacuumNode(expr: Expression): Expression {
  switch (expr.kind) {
    case ExpressionKind.Block:
      return _simplifyBlock(expr);

    case ExpressionKind.Drop: {
      const inner = expr.value;
      if (inner.kind === ExpressionKind.Nop) return makeNop();
      if (inner.type === Unreachable) return inner;
      if (
        inner.kind === ExpressionKind.Const ||
        inner.kind === ExpressionKind.LocalGet ||
        inner.kind === ExpressionKind.GlobalGet
      ) {
        return makeNop();
      }
      return expr;
    }

    default:
      return expr;
  }
}

function _simplifyBlock(
  block: Extract<Expression, { kind: ExpressionKind.Block }>,
): Expression {
  // Filter nops — they contribute nothing to a block body
  const filtered: Expression[] = [];
  for (const child of block.children) {
    if (child.kind === ExpressionKind.Nop) continue;
    filtered.push(child);
  }

  // Empty block → nop
  if (filtered.length === 0) return makeNop();

  // Unnamed single-child block → collapse (the name is only needed for
  // branch targets; without a name there are no branches targeting it). Safe
  // when the surviving child carries the block's declared result type, OR when
  // it is `unreachable` (the bottom type — valid in any type position, and the
  // block never falls through, so a bare `unreachable` stands in for it). The
  // ONE unsafe case is a child of a *different concrete* type than the block's
  // declared result (e.g. a result-typed block whose sole child is a void
  // statement): collapsing would silently change the type the block presents to
  // its parent. In that case fall through and keep the wrapper so `block.type`
  // is preserved (as the multi-child path does below).
  if (
    filtered.length === 1 && block.name === null &&
    (filtered[0].type === block.type || filtered[0].type === Unreachable)
  ) {
    return filtered[0];
  }

  // No change
  if (filtered.length === block.children.length) return block;

  // Preserve the block's declared result type. Removing nops never changes the
  // value the block yields at its tail, so recomputing the type from the last
  // child is wrong when that child is `unreachable` (a `br`/`return` tail):
  // overwriting a declared `i32` with `unreachable` makes the encoder emit a
  // void blocktype and trips "expected N for fallthru, found 0" upstream.
  return { ...block, children: filtered };
}
