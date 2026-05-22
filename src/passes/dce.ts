/**
 * @module binaryen-ts/passes/dce
 *
 * Dead Code Elimination (DCE) pass.
 *
 * Removes expressions that provably cannot be reached at runtime.
 * Specifically, any expression that follows an `unreachable` or `return`
 * within a block is dead and can be dropped.
 *
 * This mirrors the `DeadCodeElimination` pass in `src/passes/DeadCodeElimination.cpp`
 * in the upstream Binaryen C++ library.
 *
 * @license Apache-2.0
 */

import { Expression, ExpressionKind } from "../ir/expressions.ts";
import { WasmModule, WasmFunction } from "../ir/module.ts";
import { Unreachable } from "../ir/types.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";

/**
 * Dead Code Elimination pass.
 *
 * After a child expression has type `unreachable`, any sibling expressions
 * later in the same block are unreachable and may be removed.
 */
export class DCEPass implements Pass {
  readonly name = "DCE";
  readonly description =
    "Removes dead code — expressions that follow unreachable instructions in a block.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = eliminateDeadCode(fn.body, fn);
    }
  }
}

registerPass(DCEPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function eliminateDeadCode(expr: Expression, _fn: WasmFunction): Expression {
  switch (expr.kind) {
    case ExpressionKind.Block:
      return eliminateDeadBlock(expr);

    case ExpressionKind.If:
      return {
        ...expr,
        condition: eliminateDeadCode(expr.condition, _fn),
        ifTrue: eliminateDeadCode(expr.ifTrue, _fn),
        ifFalse: expr.ifFalse ? eliminateDeadCode(expr.ifFalse, _fn) : null,
      };

    case ExpressionKind.Loop:
      return { ...expr, body: eliminateDeadCode(expr.body, _fn) };

    default:
      return expr;
  }
}

function eliminateDeadBlock(
  block: Extract<Expression, { kind: ExpressionKind.Block }>,
): Expression {
  const newChildren: Expression[] = [];
  for (const child of block.children) {
    newChildren.push(child);
    if (child.type === Unreachable) {
      // Everything after this point is dead — stop collecting.
      break;
    }
  }
  if (newChildren.length === block.children.length) {
    return block;
  }
  return { ...block, children: newChildren };
}
