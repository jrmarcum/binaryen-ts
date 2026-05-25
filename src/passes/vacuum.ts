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
  // branch targets; without a name there are no branches targeting it)
  if (filtered.length === 1 && block.name === null) return filtered[0];

  // No change
  if (filtered.length === block.children.length) return block;

  const lastType = filtered[filtered.length - 1].type;
  return { ...block, type: lastType, children: filtered };
}
