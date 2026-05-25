/**
 * @module binaryen-ts/passes/coalesce-locals
 *
 * CoalesceLocals pass — reduces the number of distinct local variable slots.
 *
 * **Phase 4 implementation: dead-write elimination + live-range coalescing.**
 *
 * Two transformations are applied per function:
 *
 * 1. **Dead-write elimination**: if a local is written (`local.set`) but never
 *    read (`local.get` / `local.tee`), the write has no observable effect.
 *    Replace `local.set(i, v)` with `drop(v)` so that any side effects in `v`
 *    are still executed while the dead store is removed.
 *
 * 2. **Slot coalescing**: two locals whose live ranges do not overlap can share
 *    the same slot. This pass uses a simple linear-scan approximation:
 *    - A local's live range is approximated by its first write and last read in
 *      a pre-order traversal of the function body.
 *    - Locals are sorted by first write; each is assigned the lowest available
 *      slot not currently occupied by an overlapping local.
 *    - All `local.get`, `local.set`, and `local.tee` references, plus the
 *      `WasmFunction.locals` array, are updated accordingly.
 *
 * **Limitations**: the linear-scan approximation is conservative — loops may
 * cause live ranges to appear longer than they truly are, inhibiting some
 * coalescing opportunities that a full dataflow analysis would find. Full
 * liveness analysis is deferred to a later phase.
 *
 * Reference: `upstream/src/passes/CoalesceLocals.cpp`
 *
 * @license MIT
 */

import {
  Expression,
  ExpressionKind,
  makeDrop,
} from "../ir/expressions.ts";
import { WasmFunction, WasmModule } from "../ir/module.ts";
import { Pass, PassOptions, registerPass } from "./pass.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/**
 * Eliminates dead local writes and merges non-overlapping live ranges into
 * shared local slots.
 */
export class CoalesceLocalsPass implements Pass {
  readonly name = "CoalesceLocals";
  readonly description =
    "Eliminates dead local writes and merges non-overlapping locals into shared slots.";
  readonly requiresNonNullableLocalFixups = false;

  run(module: WasmModule, _options: PassOptions): void {
    for (const fn of module.functions) {
      _coalesceFunction(fn);
    }
  }
}

registerPass(CoalesceLocalsPass);

// ---------------------------------------------------------------------------
// Per-function implementation
// ---------------------------------------------------------------------------

function _coalesceFunction(fn: WasmFunction): void {
  const numLocals = fn.locals.length;
  if (numLocals === 0) return;

  // --- Step 1: count reads per local ---
  const readCounts = new Array<number>(numLocals).fill(0);
  walkExpression(fn.body, (e) => {
    if (
      e.kind === ExpressionKind.LocalGet ||
      e.kind === ExpressionKind.LocalTee
    ) {
      if (e.index < numLocals) readCounts[e.index]++;
    }
  });

  // --- Step 2: eliminate dead writes (locals never read) ---
  const deadLocals = new Set<number>();
  for (let i = fn.params.length; i < numLocals; i++) {
    if (readCounts[i] === 0) deadLocals.add(i);
  }
  if (deadLocals.size > 0) {
    fn.body = _eliminateDeadWrites(fn.body, deadLocals);
    // Recount after elimination (tee → set that was removed could change counts)
    readCounts.fill(0);
    walkExpression(fn.body, (e) => {
      if (
        e.kind === ExpressionKind.LocalGet ||
        e.kind === ExpressionKind.LocalTee
      ) {
        if (e.index < numLocals) readCounts[e.index]++;
      }
    });
  }

  // --- Step 3: compute linear-scan live ranges ---
  // firstDef[i] = ordinal of first write; lastUse[i] = ordinal of last read/tee
  const firstDef = new Array<number>(numLocals).fill(Infinity);
  const lastUse = new Array<number>(numLocals).fill(-1);
  let ordinal = 0;

  walkExpression(fn.body, (e) => {
    const ord = ordinal++;
    if (e.kind === ExpressionKind.LocalSet || e.kind === ExpressionKind.LocalTee) {
      if (e.index < numLocals) {
        if (ord < firstDef[e.index]) firstDef[e.index] = ord;
      }
    }
    if (e.kind === ExpressionKind.LocalGet || e.kind === ExpressionKind.LocalTee) {
      if (e.index < numLocals) {
        if (ord > lastUse[e.index]) lastUse[e.index] = ord;
      }
    }
  });

  // --- Step 4: greedy slot assignment for non-params ---
  const mapping = new Array<number>(numLocals);
  for (let i = 0; i < fn.params.length; i++) mapping[i] = i; // params are fixed

  // Work list of non-param locals sorted by firstDef
  const nonParams: number[] = [];
  for (let i = fn.params.length; i < numLocals; i++) {
    if (firstDef[i] !== Infinity || lastUse[i] !== -1) nonParams.push(i);
    else nonParams.push(i); // unreferenced locals still need a slot
  }
  nonParams.sort((a, b) => firstDef[a] - firstDef[b]);

  // Active intervals: [firstDef, lastUse] for each assigned slot
  const slotLastUse = new Map<number, number>(); // slot → lastUse ordinal
  let nextNewSlot = fn.params.length;

  for (const local of nonParams) {
    const fd = firstDef[local];
    const lu = lastUse[local];

    // Find a free slot whose previous occupant's range has ended
    let assigned = -1;
    for (const [slot, slu] of slotLastUse) {
      if (slu < fd) {
        // This slot's last occupant expired before our firstDef
        assigned = slot;
        slotLastUse.delete(slot);
        break;
      }
    }

    if (assigned === -1) {
      assigned = nextNewSlot++;
    }

    mapping[local] = assigned;
    slotLastUse.set(assigned, lu);
  }

  // --- Step 5: apply renaming if any slot changed ---
  const changed = mapping.some((slot, i) => slot !== i);
  if (!changed) return;

  fn.body = _renameLocals(fn.body, mapping);

  // Rebuild locals array using the new slot assignments
  const newLocals = new Array(nextNewSlot);
  for (let i = 0; i < fn.params.length; i++) newLocals[i] = fn.locals[i];
  for (let i = fn.params.length; i < numLocals; i++) {
    newLocals[mapping[i]] = fn.locals[i];
  }
  // Fill any holes (slots introduced for new ranges with no original local)
  for (let i = 0; i < nextNewSlot; i++) {
    if (!newLocals[i]) newLocals[i] = fn.locals[fn.params.length] ?? fn.locals[0];
  }
  fn.locals = newLocals;
}

// ---------------------------------------------------------------------------
// Dead-write elimination
// ---------------------------------------------------------------------------

function _eliminateDeadWrites(
  expr: Expression,
  dead: Set<number>,
): Expression {
  return mapExpression(expr, (e) => {
    if (e.kind === ExpressionKind.LocalSet && dead.has(e.index)) {
      return makeDrop(e.value);
    }
    // local.tee on a dead local: replace with just the value (the tee
    // both sets and returns; since no one reads the local, drop the set)
    if (e.kind === ExpressionKind.LocalTee && dead.has(e.index)) {
      return e.value;
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Local renaming
// ---------------------------------------------------------------------------

function _renameLocals(expr: Expression, mapping: number[]): Expression {
  return mapExpression(expr, (e) => {
    if (
      (e.kind === ExpressionKind.LocalGet ||
        e.kind === ExpressionKind.LocalSet ||
        e.kind === ExpressionKind.LocalTee) &&
      e.index < mapping.length &&
      mapping[e.index] !== e.index
    ) {
      return { ...e, index: mapping[e.index] };
    }
    return e;
  });
}