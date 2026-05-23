/**
 * @module binaryen-ts/passes/simplify-locals
 *
 * SimplifyLocals pass — collapses consecutive local.set / local.get pairs.
 *
 * When a `local.set(i, value)` is immediately followed by a `local.get(i)` as
 * consecutive children of the same block, the pair can be replaced by a single
 * `local.tee(i, value)`. The tee instruction both stores the value in local `i`
 * and pushes it onto the stack, replicating the effect of the set+get sequence
 * in one instruction.
 *
 * Preconditions:
 * - The set and get must be consecutive (no intervening instructions).
 * - The local index must match exactly.
 *
 * This is the core of the "tee" optimization. Blocks nested deeper in the tree
 * are handled by the recursive `mapExpression` walk.
 *
 * Reference: `upstream/src/passes/SimplifyLocals.cpp`
 *
 * @license MIT OR Apache-2.0
 */

import {
  Expression,
  ExpressionKind,
  LocalTeeExpr,
} from "../ir/expressions.ts";
import { WasmModule } from "../ir/module.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";
import { mapExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Collapses `local.set(i, v); local.get(i)` pairs into `local.tee(i, v)`. */
export class SimplifyLocalsPass implements Pass {
  readonly name = "SimplifyLocals";
  readonly description =
    "Collapses consecutive local.set + local.get pairs into local.tee.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = mapExpression(fn.body, _simplifyNode);
    }
  }
}

registerPass(SimplifyLocalsPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function _simplifyNode(expr: Expression): Expression {
  if (expr.kind !== ExpressionKind.Block) return expr;
  return _simplifyBlock(expr);
}

function _simplifyBlock(
  block: Extract<Expression, { kind: ExpressionKind.Block }>,
): Expression {
  const children = block.children;
  const result: Expression[] = [];
  let i = 0;

  while (i < children.length) {
    const curr = children[i];
    const next = i + 1 < children.length ? children[i + 1] : undefined;

    if (
      curr.kind === ExpressionKind.LocalSet &&
      next !== undefined &&
      next.kind === ExpressionKind.LocalGet &&
      curr.index === next.index
    ) {
      // Replace set+get pair with tee
      const tee: LocalTeeExpr = {
        kind: ExpressionKind.LocalTee,
        type: next.type,
        index: curr.index,
        value: curr.value,
      };
      result.push(tee);
      i += 2;
    } else {
      result.push(curr);
      i += 1;
    }
  }

  if (result.length === children.length) return block;

  const lastType = result[result.length - 1].type;
  return { ...block, type: lastType, children: result };
}