/**
 * @module binaryen-ts/passes/strip-eh
 *
 * Strip Exception Handling pass.
 *
 * Removes every EH construct from a module so the result no longer requires
 * the exception-handling feature:
 *
 * - `throw`, `throw_ref`, `rethrow` are replaced by a block that evaluates and
 *   drops each operand (preserving side effects), then traps via `unreachable`.
 *   Any exception that the original program would have thrown now traps.
 * - `try` and `try_table` are replaced by their body. Catch bodies are
 *   discarded along with the surrounding construct.
 * - The module's tag list is cleared and `hasExceptionHandling` is set to
 *   `false` so downstream consumers stop emitting the EH feature.
 *
 * This mirrors `upstream/src/passes/StripEH.cpp`. The upstream pass invokes
 * `ReFinalize` to re-compute expression types after substitution; binaryen-ts
 * does not yet ship a ReFinalize utility, so callers that depend on tight
 * type recomputation should run subsequent cleanup passes (Vacuum,
 * OptimizeInstructions) which tolerate the unreachable-typed bodies this pass
 * may introduce.
 *
 * @license MIT
 */

import {
  type Expression,
  ExpressionKind,
  makeBlock,
  makeDrop,
  makeUnreachable,
} from "../ir/expressions.ts";
import type { WasmModule } from "../ir/module.ts";
import { mapExpression } from "../ir/walk.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";

/** Removes all EH instructions and tags; throws become traps. */
export class StripEHPass implements Pass {
  readonly name = "StripEH";
  readonly description =
    "Removes EH instructions and tags. Throws become unreachable; try / try_table are replaced by their body.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = mapExpression(fn.body, stripEHNode);
    }
    // Clear tags + disable the EH feature flag.
    module.tags = [];
    module.hasExceptionHandling = false;
  }
}

registerPass(StripEHPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Per-node EH stripper. Bottom-up; children have already been rewritten.
 *
 * Exported so other passes that want strip-style semantics on a single
 * function body (without running the whole module pass) can reuse it via
 * `mapExpression(fn.body, stripEHNode)`.
 */
export function stripEHNode(expr: Expression): Expression {
  switch (expr.kind) {
    case ExpressionKind.Throw:
      return trapWithDroppedOperands(expr.operands);

    case ExpressionKind.ThrowRef:
      return trapWithDroppedOperands([expr.exnref]);

    case ExpressionKind.Rethrow:
      // rethrow has no operands — just trap.
      return makeUnreachable();

    case ExpressionKind.Try:
      // Replace with the body; catch bodies and delegate target are discarded.
      return expr.body;

    case ExpressionKind.TryTable:
      // Replace with the body; catch destinations are discarded.
      return expr.body;

    default:
      return expr;
  }
}

/**
 * Wrap each operand in `drop` (preserving side effects), then append
 * `unreachable`. If there are no operands, return a bare `unreachable`.
 */
function trapWithDroppedOperands(operands: Expression[]): Expression {
  if (operands.length === 0) return makeUnreachable();
  const children: Expression[] = operands.map(makeDrop);
  children.push(makeUnreachable());
  return makeBlock(children);
}
