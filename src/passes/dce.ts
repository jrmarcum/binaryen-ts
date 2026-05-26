/**
 * @module binaryen-ts/passes/dce
 *
 * Dead Code Elimination (DCE) pass.
 *
 * Removes expressions that provably cannot be reached at runtime.
 * Specifically, any expression that follows an `unreachable`, `return`,
 * `throw`, `throw_ref`, or `rethrow` within a block is dead and can be
 * dropped. The pass recurses into the bodies of `if`, `loop`, `try`, and
 * `try_table` so dead code buried in nested control flow is reached too.
 *
 * This mirrors the `DeadCodeElimination` pass in `src/passes/DeadCodeElimination.cpp`
 * in the upstream Binaryen C++ library (the simplified post-order tail-trim
 * variant — full liveness-based DCE is deferred).
 *
 * @license MIT
 */

import { type Expression, ExpressionKind } from "../ir/expressions.ts";
import type { WasmModule } from "../ir/module.ts";
import { Unreachable } from "../ir/types.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";

/**
 * Dead Code Elimination pass.
 *
 * After a child expression has type `unreachable`, any sibling expressions
 * later in the same block are unreachable and may be removed. `throw`,
 * `throw_ref`, and `rethrow` are typed `unreachable` so they trim the block
 * tail the same way `unreachable` and `return` do.
 */
export class DCEPass implements Pass {
  readonly name = "DCE";
  readonly description =
    "Removes dead code — expressions that follow unreachable instructions in a block.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = eliminateDeadCode(fn.body);
    }
  }
}

registerPass(DCEPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function eliminateDeadCode(expr: Expression): Expression {
  switch (expr.kind) {
    case ExpressionKind.Block:
      return eliminateDeadBlock(expr);

    case ExpressionKind.If:
      return {
        ...expr,
        condition: eliminateDeadCode(expr.condition),
        ifTrue: eliminateDeadCode(expr.ifTrue),
        ifFalse: expr.ifFalse ? eliminateDeadCode(expr.ifFalse) : null,
      };

    case ExpressionKind.Loop:
      return { ...expr, body: eliminateDeadCode(expr.body) };

    case ExpressionKind.Try:
      return {
        ...expr,
        body: eliminateDeadCode(expr.body),
        catchBodies: expr.catchBodies.map(eliminateDeadCode),
      };

    case ExpressionKind.TryTable:
      return { ...expr, body: eliminateDeadCode(expr.body) };

    default:
      return expr;
  }
}

function eliminateDeadBlock(
  block: Extract<Expression, { kind: ExpressionKind.Block }>,
): Expression {
  const newChildren: Expression[] = [];
  let trimmed = false;
  for (let i = 0; i < block.children.length; i++) {
    // Recurse before deciding the tail — a child may contain inner dead code
    // (e.g. unreachable buried in a Try body) without itself being typed
    // unreachable, but we still want to clean inside it.
    const processed = eliminateDeadCode(block.children[i]);
    newChildren.push(processed);
    if (processed.type === Unreachable && i < block.children.length - 1) {
      trimmed = true;
      // Everything after this point is dead — stop collecting.
      break;
    }
  }
  // Reference-equality short-circuit: only rebuild when something changed.
  if (
    !trimmed &&
    newChildren.length === block.children.length &&
    newChildren.every((c, i) => c === block.children[i])
  ) {
    return block;
  }
  return { ...block, children: newChildren };
}
