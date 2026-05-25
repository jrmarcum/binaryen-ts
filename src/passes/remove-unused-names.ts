/**
 * @module binaryen-ts/passes/remove-unused-names
 *
 * RemoveUnusedNames pass — strips block and loop labels that are never
 * referenced by a branch instruction.
 *
 * A block label is unused when no `br`, `br_if`, or `br_table` instruction
 * names it as a branch target. Such names are meaningless noise that the
 * encoder still has to emit (and the decoder parse), so removing them
 * shrinks the binary and simplifies downstream passes.
 *
 * An unnamed loop (no back-edge `br` to its label) executes at most once
 * and is therefore equivalent to a straight-line sequence — the loop wrapper
 * is replaced by its body.
 *
 * Reference: `upstream/src/passes/RemoveUnusedNames.cpp`
 *
 * @license MIT
 */

import {
  BlockExpr,
  Expression,
  ExpressionKind,
  LoopExpr,
} from "../ir/expressions.ts";
import { WasmModule } from "../ir/module.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Removes unused block/loop names and replaces no-back-edge loops with their bodies. */
export class RemoveUnusedNamesPass implements Pass {
  readonly name = "RemoveUnusedNames";
  readonly description =
    "Remove unused block and loop names; replace back-edge-free loops with their bodies.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      fn.body = _processBody(fn.body);
    }
  }
}

registerPass(RemoveUnusedNamesPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function _processBody(body: Expression): Expression {
  // Pass 1: collect every branch-target name that appears in the tree.
  const targets = new Set<string>();
  walkExpression(body, (e) => {
    if (e.kind === ExpressionKind.Break) {
      targets.add(e.name);
    } else if (e.kind === ExpressionKind.Switch) {
      for (const t of e.targets) targets.add(t);
      targets.add(e.defaultTarget);
    }
  });

  // Pass 2: strip unused names bottom-up so inner structures are cleaned first.
  return mapExpression(body, (expr) => _strip(expr, targets));
}

function _strip(expr: Expression, targets: Set<string>): Expression {
  if (expr.kind === ExpressionKind.Block) {
    const block = expr as BlockExpr;
    if (block.name !== null && !targets.has(block.name)) {
      return { ...block, name: null };
    }
    return block;
  }

  if (expr.kind === ExpressionKind.Loop) {
    const loop = expr as LoopExpr;
    // A loop with no back-edge br executes exactly once — replace with body.
    // Type guard: only replace when types match (always true for valid MVP WASM).
    if (!targets.has(loop.name) && loop.type === loop.body.type) {
      return loop.body;
    }
    return loop;
  }

  return expr;
}