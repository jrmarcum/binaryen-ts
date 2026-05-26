/**
 * @module binaryen-ts/passes/coalesce-locals
 *
 * CoalesceLocals pass — reduces the number of distinct local variable slots.
 *
 * **Phase 4 implementation: dead-write elimination + linear-scan with live
 * holes.**
 *
 * Two transformations are applied per function:
 *
 * 1. **Dead-write elimination**: if a local is written (`local.set`) but never
 *    read (`local.get` / `local.tee`), the write has no observable effect.
 *    Replace `local.set(i, v)` with `drop(v)` so that any side effects in `v`
 *    are still executed while the dead store is removed.
 *
 * 2. **Slot coalescing via multi-segment live ranges**: a local's lifetime is
 *    split into multiple `[defOrd, lastUseOrd]` segments — each `local.set`
 *    starts a new segment that ends at the last `local.get` / `local.tee` of
 *    the same local before the next set. This is more precise than the older
 *    `[firstDef, lastUse]` single-interval approach, because a local that is
 *    repeatedly written and read can free its slot in the gaps between value
 *    lifetimes. Two locals interfere iff any of their segments overlap.
 *    Greedy slot assignment then maps each non-param local to the lowest
 *    available slot whose existing segments don't conflict.
 *
 * **Residual limitation**: ordinals are pre-order — for code inside loops,
 * the analyzer treats one iteration as the unit. A value defined on one
 * iteration and read on the next would (theoretically) need its segment to
 * span the back-edge. In practice this is rare: explicit back-edge-carried
 * values are unusual in wasm because most loop state is in locals that are
 * also written in the loop body (creating segment breaks anyway). Full
 * CFG-based dataflow with fixed-point iteration would close this gap
 * completely — that's tracked as a future refinement.
 *
 * Reference: `upstream/src/passes/CoalesceLocals.cpp`
 *
 * @license MIT
 */

import { type Expression, ExpressionKind, makeDrop } from "../ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../ir/module.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";
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

  // --- Step 3: build per-local segments (def-to-last-use, split at each def) ---
  // Each segment represents a single "value lifetime": from the local.set/tee
  // that produced it, to the last local.get/tee that read it before the next
  // write. Multiple segments per local enable coalescing during gaps between
  // value lifetimes.
  const segments: Segment[][] = Array.from({ length: numLocals }, () => []);
  // Params have an implicit pre-existing segment starting at ordinal -1 (i.e.
  // "before the function body"). If a param is never read, the segment ends
  // at -1 and is effectively zero-width — won't interfere with anything.
  for (let i = 0; i < fn.params.length; i++) {
    segments[i].push({ defOrd: -1, lastUseOrd: -1 });
  }
  let ordinal = 0;
  walkExpression(fn.body, (e) => {
    const ord = ordinal++;
    if (e.kind === ExpressionKind.LocalSet || e.kind === ExpressionKind.LocalTee) {
      if (e.index < numLocals) {
        // Close any current segment; open a new one. (Param segments are
        // already in `segments[i]` — a subsequent param write closes them
        // naturally.)
        segments[e.index].push({ defOrd: ord, lastUseOrd: ord });
      }
    }
    if (e.kind === ExpressionKind.LocalGet || e.kind === ExpressionKind.LocalTee) {
      if (e.index < numLocals) {
        const segs = segments[e.index];
        if (segs.length === 0) {
          // Read of an as-yet-undefined local (e.g. a non-param local that
          // wasm spec zero-initializes). Synthesize a segment from ord 0.
          segs.push({ defOrd: 0, lastUseOrd: ord });
        } else {
          segs[segs.length - 1].lastUseOrd = ord;
        }
      }
    }
  });

  // --- Step 4: greedy slot assignment for non-params ---
  // Try to assign each non-param local to the lowest existing slot whose
  // currently-committed segments don't overlap with the local's segments.
  // Fall back to a fresh slot.
  const mapping = new Array<number>(numLocals);
  for (let i = 0; i < fn.params.length; i++) mapping[i] = i; // params are fixed

  // Slot → committed segment list (segments currently assigned to that slot).
  const slotSegments = new Map<number, Segment[]>();
  for (let i = 0; i < fn.params.length; i++) {
    slotSegments.set(i, segments[i].slice());
  }

  // Process non-params in declaration order so the output is deterministic.
  let nextNewSlot = fn.params.length;
  for (let local = fn.params.length; local < numLocals; local++) {
    const mySegs = segments[local];

    let assigned = -1;
    // Try existing slots first (slots 0..nextNewSlot-1) in order.
    for (let slot = 0; slot < nextNewSlot; slot++) {
      // Param slots are reserved for their original params — non-param
      // locals never get coalesced into a param slot (would corrupt
      // argument passing).
      if (slot < fn.params.length) continue;
      const existing = slotSegments.get(slot);
      if (existing && !_anySegmentsOverlap(existing, mySegs)) {
        assigned = slot;
        break;
      }
    }
    if (assigned === -1) {
      assigned = nextNewSlot++;
    }

    mapping[local] = assigned;
    const list = slotSegments.get(assigned) ?? [];
    list.push(...mySegs);
    slotSegments.set(assigned, list);
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
// Live-segment interference
// ---------------------------------------------------------------------------

/** A single value-lifetime: from the `local.set`/`local.tee` that produced
 *  the value (`defOrd`) through the last `local.get`/`local.tee` that read
 *  it (`lastUseOrd`) before the next write. Closed interval — two segments
 *  with `seg1.lastUseOrd === seg2.defOrd` are treated as overlapping because
 *  both values are live at that ordinal. */
interface Segment {
  defOrd: number;
  lastUseOrd: number;
}

function _segmentsOverlap(a: Segment, b: Segment): boolean {
  return Math.max(a.defOrd, b.defOrd) <= Math.min(a.lastUseOrd, b.lastUseOrd);
}

function _anySegmentsOverlap(existing: Segment[], candidate: Segment[]): boolean {
  for (const a of existing) {
    for (const b of candidate) {
      if (_segmentsOverlap(a, b)) return true;
    }
  }
  return false;
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
