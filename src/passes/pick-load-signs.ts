/**
 * @module binaryen-ts/passes/pick-load-signs
 *
 * PickLoadSigns pass — selects the optimal sign for narrow memory loads.
 *
 * A narrow load (e.g., `i32.load8_u`) reads fewer bits than the target
 * register. The hardware can either zero-extend (unsigned) or sign-extend
 * (signed) the narrow value. If all downstream uses of the loaded value
 * already apply the same extension, the load itself can be changed to match —
 * eliminating the extension instruction.
 *
 * **Algorithm**:
 * 1. Walk each function to find all `local.set(i, load*())` assignments where
 *    the load has a width smaller than 32 bits (i.e., bytes < 4 for i32, or
 *    bytes < 8 for i64).
 * 2. For each such local `i`, classify every `local.get(i)` as:
 *    - **signed use**: the get feeds directly into a signed comparison
 *      (`lt_s`, `le_s`, `gt_s`, `ge_s`) or a sign-extending shift pair
 *      (`shr_s` after `shl`).
 *    - **unsigned use**: the get is masked with the load-width mask
 *      (`& 0xFF` for byte loads, `& 0xFFFF` for 16-bit loads) or feeds a
 *      zero-extending shift pair (`shr_u` after `shl`).
 *    - **neutral**: anything else (arithmetic where sign does not matter, e.g.
 *      `add`, `sub`, `mul`, `eq`, `ne`).
 * 3. If a local has only signed uses (and at least one), switch the load to
 *    the signed variant.  If it has only unsigned uses (and at least one),
 *    switch to the unsigned variant.  Mixed or neutral-only locals are left
 *    unchanged.
 *
 * **Scope**: only `local.set(i, narrow_load)` patterns are analysed. Loads
 * that are used directly without being stored to a local (e.g., as an operand
 * in a larger expression) are not currently optimised.
 *
 * Reference: `upstream/src/passes/PickLoadSigns.cpp`
 *
 * @license MIT
 */

import { BinaryOp, type Expression, ExpressionKind, type LoadExpr } from "../ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../ir/module.ts";
import { ValType } from "../ir/types.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/** Picks signed vs unsigned for narrow loads based on usage patterns. */
export class PickLoadSignsPass implements Pass {
  readonly name = "PickLoadSigns";
  readonly description =
    "Selects signed/unsigned narrow load variants based on how the loaded value is used.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    if (module.memories.length === 0) return; // no loads without memory
    for (const fn of module.functions) {
      _pickLoadSigns(fn);
    }
  }
}

registerPass(PickLoadSignsPass);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Marks a load whose sign step 3 decided to flip, so the decision survives
 *  `mapExpression`'s node rebuild (object spread copies symbol-keyed props).
 *  Keying a `Map` by the original node reference did NOT survive the rebuild —
 *  the pass was silently inert (the WT-2c #5 identity-loss class). */
const _PICK_SIGN = Symbol("pickLoadSign");

/** Zero-extension mask for a load of the given byte width. */
function _zeroMask(bytes: number): number {
  if (bytes === 1) return 0xFF;
  if (bytes === 2) return 0xFFFF;
  return 0xFFFFFFFF;
}

interface LoadInfo {
  load: LoadExpr;
  localIndex: number;
}

interface Usage {
  signedCount: number;
  unsignedCount: number;
  /** EVERY use of the local, extension or not. The flip is safe only when every
   *  use re-extends the value (signedCount + unsignedCount === totalCount) — any
   *  observing use (comparison, arithmetic, store, call operand) sees the sign
   *  and would be corrupted by a flip. Mirrors upstream's `totalUsages` guard. */
  totalCount: number;
}

function _pickLoadSigns(fn: WasmFunction): void {
  // --- Step 1: find local.set(i, narrow_load) sites ---
  const loadsByLocal = new Map<number, LoadInfo>();

  walkExpression(fn.body, (expr) => {
    if (
      expr.kind === ExpressionKind.LocalSet &&
      expr.value.kind === ExpressionKind.Load
    ) {
      const load = expr.value as LoadExpr;
      // Only narrow loads need attention
      const resultType = load.type;
      if (resultType !== ValType.I32 && resultType !== ValType.I64) return;
      const maxBytes = resultType === ValType.I32 ? 4 : 8;
      if (load.bytes >= maxBytes) return; // already full-width
      loadsByLocal.set(expr.index, { load, localIndex: expr.index });
    }
  });

  if (loadsByLocal.size === 0) return;

  // --- Step 2: classify uses of each tracked local ---
  const usages = new Map<number, Usage>();
  for (const idx of loadsByLocal.keys()) {
    usages.set(idx, { signedCount: 0, unsignedCount: 0, totalCount: 0 });
  }

  // Walk with parent context to classify uses. Per upstream PickLoadSigns.cpp,
  // the ONLY uses that let us safely change a load's sign are ones that
  // re-extend the value to the same width — then the load's own extension is
  // redundant and the choice is free. Every other use OBSERVES the value; a
  // signed/unsigned COMPARISON in particular changes its result if the load's
  // sign flips, so it must be counted as neutral (totalCount only), NOT as a
  // sign-determining use. (The prior code counted comparisons as the flip
  // signal — a latent miscompile that only stayed dormant because step 3's
  // rewrite was itself inert; see the identity-loss note below.)
  _walkWithParent(fn.body, null, (expr, parent) => {
    if (expr.kind !== ExpressionKind.LocalGet) return;
    const info = loadsByLocal.get(expr.index);
    if (!info) return;
    const usage = usages.get(expr.index)!;
    usage.totalCount++;

    if (!parent) return; // observing use (bare get)

    // One-level zero-extension mask: `(x & 0xFF)` for a byte load, etc. (The
    // two-level sign-extend shift pair `(x << K) >> K` needs grandparent context
    // this single-parent walk doesn't have — not detected, a conservative miss
    // that only forgoes an optimization, never miscompiles.)
    if (
      parent.kind === ExpressionKind.Binary &&
      parent.op === BinaryOp.AndI32 &&
      parent.right.kind === ExpressionKind.Const &&
      "i32" in parent.right.value &&
      (parent.right.value.i32 as number) === _zeroMask(info.load.bytes as number)
    ) {
      usage.unsignedCount++;
    }
    // Everything else counts toward totalCount only → blocks the flip below.
  });

  // --- Step 3: flip load sign only when EVERY use re-extends it ---
  const toFlip: LoadExpr[] = [];
  for (const [idx, info] of loadsByLocal) {
    const usage = usages.get(idx)!;
    // Upstream guard: give up unless all uses are sign/zero-extends. A single
    // observing use makes the sign visible and the flip unsafe.
    if (usage.totalCount === 0) continue;
    if (usage.signedCount + usage.unsignedCount !== usage.totalCount) continue;
    if (usage.unsignedCount > 0 && usage.signedCount === 0 && info.load.signed) {
      (info.load as unknown as Record<symbol, boolean>)[_PICK_SIGN] = false;
      toFlip.push(info.load);
    } else if (usage.signedCount > 0 && usage.unsignedCount === 0 && !info.load.signed) {
      (info.load as unknown as Record<symbol, boolean>)[_PICK_SIGN] = true;
      toFlip.push(info.load);
    }
  }

  if (toFlip.length === 0) return;

  // Read the decision off the symbol marker (not a reference-keyed Map): object
  // spread inside mapExpression copies symbol props, so the mark survives the
  // node rebuild that previously neutered this pass.
  fn.body = mapExpression(fn.body, (expr) => {
    if (expr.kind === ExpressionKind.Load && _PICK_SIGN in expr) {
      const rec = expr as unknown as Record<symbol, boolean>;
      const signed = rec[_PICK_SIGN];
      const cleaned = { ...expr, signed };
      delete (cleaned as unknown as Record<symbol, boolean>)[_PICK_SIGN];
      return cleaned;
    }
    return expr;
  });
  for (const load of toFlip) delete (load as unknown as Record<symbol, boolean>)[_PICK_SIGN];
}

// ---------------------------------------------------------------------------
// Walk with parent reference
// ---------------------------------------------------------------------------

function _walkWithParent(
  expr: Expression,
  parent: Expression | null,
  visitor: (e: Expression, parent: Expression | null) => void,
): void {
  visitor(expr, parent);

  switch (expr.kind) {
    case ExpressionKind.Block:
      expr.children.forEach((c) => _walkWithParent(c, expr, visitor));
      break;
    case ExpressionKind.If:
      _walkWithParent(expr.condition, expr, visitor);
      _walkWithParent(expr.ifTrue, expr, visitor);
      if (expr.ifFalse) _walkWithParent(expr.ifFalse, expr, visitor);
      break;
    case ExpressionKind.Loop:
      _walkWithParent(expr.body, expr, visitor);
      break;
    case ExpressionKind.Binary:
      _walkWithParent(expr.left, expr, visitor);
      _walkWithParent(expr.right, expr, visitor);
      break;
    case ExpressionKind.Unary:
      _walkWithParent(expr.value, expr, visitor);
      break;
    case ExpressionKind.LocalSet:
    case ExpressionKind.LocalTee:
      _walkWithParent(expr.value, expr, visitor);
      break;
    case ExpressionKind.GlobalSet:
      _walkWithParent(expr.value, expr, visitor);
      break;
    case ExpressionKind.Drop:
      _walkWithParent(expr.value, expr, visitor);
      break;
    case ExpressionKind.Return:
      if (expr.value) _walkWithParent(expr.value, expr, visitor);
      break;
    case ExpressionKind.Call:
      expr.operands.forEach((o) => _walkWithParent(o, expr, visitor));
      break;
    case ExpressionKind.CallIndirect:
      _walkWithParent(expr.target, expr, visitor);
      expr.operands.forEach((o) => _walkWithParent(o, expr, visitor));
      break;
    case ExpressionKind.Load:
      _walkWithParent(expr.ptr, expr, visitor);
      break;
    case ExpressionKind.Store:
      _walkWithParent(expr.ptr, expr, visitor);
      _walkWithParent(expr.value, expr, visitor);
      break;
    case ExpressionKind.Select:
      _walkWithParent(expr.ifTrue, expr, visitor);
      _walkWithParent(expr.ifFalse, expr, visitor);
      _walkWithParent(expr.condition, expr, visitor);
      break;
    default:
      break;
  }
}
