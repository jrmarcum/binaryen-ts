/**
 * @module binaryen-ts/passes/remove-unused-brs
 *
 * RemoveUnusedBrs pass — removes branches that go to where execution would
 * fall through anyway.
 *
 * Two transformations are applied at the end of named blocks:
 *
 * 1. `(block $B ... (br $B))` — the unconditional branch at the tail of its
 *    own block is always redundant: execution falls through to the block exit
 *    regardless. Removed.
 *
 * 2. `(block $B ... (br_if $B cond))` — a conditional branch to the block's
 *    own exit at the tail. Whether the condition is true or false, execution
 *    ends up at the block exit, so the branch becomes `(drop cond)`.
 *    (The condition is preserved because it may have side effects.)
 *
 * Only tail-position branches are considered. Branches that appear earlier in
 * a block, or that target an outer block, are left unchanged.
 *
 * Precondition: the tail child must have type `none` so that removing the
 * branch does not change the block's result type.
 *
 * Reference: `upstream/src/passes/RemoveUnusedBrs.cpp`
 *
 * @license MIT OR Apache-2.0
 */

import {
  Expression,
  ExpressionKind,
  makeDrop,
  makeNop,
} from "../ir/expressions.ts";
import { WasmModule } from "../ir/module.ts";
import { None } from "../ir/types.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";
import { mapExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Removes unconditional and conditional branches to the immediately-following block exit. */
export class RemoveUnusedBrsPass implements Pass {
  readonly name = "RemoveUnusedBrs";
  readonly description =
    "Removes branches to where execution falls through anyway (tail-of-block optimisation).";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = mapExpression(fn.body, _removeUnusedBrsNode);
    }
  }
}

registerPass(RemoveUnusedBrsPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function _removeUnusedBrsNode(expr: Expression): Expression {
  if (expr.kind !== ExpressionKind.Block) return expr;
  return _optimizeBlock(expr);
}

function _optimizeBlock(
  block: Extract<Expression, { kind: ExpressionKind.Block }>,
): Expression {
  if (!block.name || block.children.length === 0) return block;

  const last = block.children[block.children.length - 1];

  // Case 1: (br $name) — unconditional, no value, at end of own block
  if (
    last.kind === ExpressionKind.Break &&
    last.condition === null &&
    last.value === null &&
    last.name === block.name
  ) {
    const rest = block.children.slice(0, -1);
    if (rest.length === 0) return makeNop();
    const newLast = rest[rest.length - 1];
    // Only safe when the new tail has type none (block type is preserved)
    if (newLast.type !== None) return block;
    return { ...block, type: None, children: rest };
  }

  // Case 2: (br_if $name cond) — conditional, no value, at end of own block
  if (
    last.kind === ExpressionKind.Break &&
    last.condition !== null &&
    last.value === null &&
    last.name === block.name
  ) {
    const drop = makeDrop(last.condition);
    const newChildren = [...block.children.slice(0, -1), drop];
    return { ...block, type: None, children: newChildren };
  }

  return block;
}