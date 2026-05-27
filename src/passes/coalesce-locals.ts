/**
 * @module binaryen-ts/passes/coalesce-locals
 *
 * CoalesceLocals pass — reduces the number of distinct local variable slots.
 *
 * **Implementation: CFG-based liveness + greedy graph colouring.**
 *
 * For each function, the pass:
 *
 * 1. Builds a control-flow graph over the function body (handling `block`,
 *    `if`, `loop`, `br` / `br_if` / `br_table`, `return`, `unreachable`,
 *    `throw` / `try` / `try_table`).
 * 2. Runs backward-flow liveness to compute, per basic block, the set of
 *    locals live on entry (`start`) and on exit (`end`). This is a standard
 *    monotonically-growing fixed-point.
 * 3. Determines which `local.set` / `local.tee` instructions are *effective*
 *    (their value can be read by a later use) and which `local.get`s end a
 *    live range — both fall out of the backward scan over each block's
 *    actions starting from the block's `end`.
 * 4. Builds an interference graph by walking each block forward: at each
 *    effective set, all currently live locals (other than the one being
 *    written) interfere with it. Params interfere with each other
 *    pairwise; zero-initialised locals that are live at function entry
 *    interfere with every param.
 * 5. Greedily colours the interference graph — each non-param local is
 *    assigned to the lowest slot whose existing tenants do not interfere.
 * 6. Rewrites the body: renames local indices through the mapping, replaces
 *    ineffective `local.set` with `drop`, replaces ineffective `local.tee`
 *    with the bare value. The `fn.locals` array is rebuilt to match the
 *    new slot count.
 *
 * Because liveness is computed across CFG edges, values that flow around
 * loop back-edges are kept live across the back-edge — so two locals whose
 * values are simultaneously live on different iterations are correctly
 * treated as interfering. This closes the residual gap from the previous
 * ordinal-based segment model.
 *
 * Reference: `upstream/src/passes/CoalesceLocals.cpp`,
 * `upstream/src/cfg/liveness-traversal.h`
 *
 * @license MIT
 */

import { type Expression, ExpressionKind, makeDrop } from "../ir/expressions.ts";
import type { WasmFunction, WasmModule } from "../ir/module.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";
import { mapExpression } from "../ir/walk.ts";
import { buildCFG, type CFG, computeLiveness, type LivenessAction } from "./cfg.ts";

// ---------------------------------------------------------------------------
// Pass class
// ---------------------------------------------------------------------------

/**
 * Eliminates dead local writes and merges non-interfering locals into shared
 * slots using a CFG-based liveness analysis.
 */
export class CoalesceLocalsPass implements Pass {
  readonly name = "CoalesceLocals";
  readonly description =
    "Eliminates dead local writes and merges non-interfering locals into shared slots.";
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
  const numParams = fn.params.length;

  // 1. CFG + liveness ------------------------------------------------------
  const cfg = buildCFG(fn.body);
  computeLiveness(cfg);

  // 2. Per-block effective-set / ends-live-range maps ----------------------
  // For each LocalSet/LocalTee origin, was its result ever used?
  // For each LocalGet origin, was it the last use within its block?
  const effectiveSet = new Set<Expression>();
  const endsLiveRange = new Set<Expression>();
  for (const b of cfg.blocks) {
    _classifyActions(b.actions, b.end, effectiveSet, endsLiveRange);
  }

  // 3. Interference matrix -------------------------------------------------
  // Upper-triangular: interferes(low, high) only.
  const interferes = new _InterferenceMatrix(numLocals);

  // Params interfere with each other so they can never be merged.
  for (let i = 0; i < numParams; i++) {
    for (let j = i + 1; j < numParams; j++) interferes.set(i, j);
  }
  // Locals live at function entry but not in the param range are reading the
  // wasm-spec zero-init value before any set. They interfere with all params
  // because their "value" is conceptually a set at function start.
  for (const x of cfg.entry.start) {
    if (x >= numParams) {
      for (let p = 0; p < numParams; p++) interferes.set(p, x);
    }
  }

  // Per-block forward scan to record interference at each effective set.
  for (const b of cfg.blocks) {
    _markBlockInterference(b, effectiveSet, endsLiveRange, interferes);
  }

  // 4. Greedy slot assignment ---------------------------------------------
  const mapping = new Array<number>(numLocals);
  for (let i = 0; i < numParams; i++) mapping[i] = i;

  // Slot → list of locals currently assigned to it.
  const slotMembers = new Map<number, number[]>();
  for (let i = 0; i < numParams; i++) slotMembers.set(i, [i]);

  let nextSlot = numParams;
  for (let local = numParams; local < numLocals; local++) {
    const myType = fn.locals[local].type;
    let assigned = -1;
    // Try existing non-param slots in order.
    for (let slot = numParams; slot < nextSlot; slot++) {
      const members = slotMembers.get(slot)!;
      // Type must match (slots are typed).
      if (fn.locals[members[0]].type !== myType) continue;
      let ok = true;
      for (const m of members) {
        if (interferes.get(m, local)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        assigned = slot;
        break;
      }
    }
    if (assigned === -1) {
      assigned = nextSlot++;
      slotMembers.set(assigned, []);
    }
    mapping[local] = assigned;
    slotMembers.get(assigned)!.push(local);
  }

  // 5. Rewrite the body ----------------------------------------------------
  const mappingChanged = mapping.some((v, i) => v !== i);
  const hasIneffective = _hasAnyIneffective(cfg, effectiveSet);

  if (mappingChanged || hasIneffective) {
    fn.body = _rewriteBody(fn.body, mapping, effectiveSet);
  }

  // 6. Rebuild fn.locals ---------------------------------------------------
  if (mappingChanged) {
    const newLocals = new Array(nextSlot);
    for (let i = 0; i < numParams; i++) newLocals[i] = fn.locals[i];
    for (let i = numParams; i < numLocals; i++) {
      newLocals[mapping[i]] = fn.locals[i];
    }
    // Defensive: fill any gaps (shouldn't happen — every slot from numParams
    // to nextSlot-1 was allocated by the loop above).
    for (let i = numParams; i < nextSlot; i++) {
      if (!newLocals[i]) newLocals[i] = fn.locals[numParams] ?? fn.locals[0];
    }
    fn.locals = newLocals;
  }
}

// ---------------------------------------------------------------------------
// Backward classification: effective sets + ends-live-range gets
// ---------------------------------------------------------------------------

function _classifyActions(
  actions: LivenessAction[],
  liveAtEnd: ReadonlySet<number>,
  effectiveSet: Set<Expression>,
  endsLiveRange: Set<Expression>,
): void {
  const live = new Set(liveAtEnd);
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.kind === "get") {
      if (!live.has(a.index)) {
        endsLiveRange.add(a.origin);
        live.add(a.index);
      }
    } else {
      // set / tee
      if (live.has(a.index)) {
        effectiveSet.add(a.origin);
        live.delete(a.index);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Forward interference marking for one block
// ---------------------------------------------------------------------------

function _markBlockInterference(
  block: { actions: LivenessAction[]; start: ReadonlySet<number> },
  effectiveSet: ReadonlySet<Expression>,
  endsLiveRange: ReadonlySet<Expression>,
  interferes: _InterferenceMatrix,
): void {
  const live = new Set(block.start);
  for (const a of block.actions) {
    if (a.kind === "get") {
      if (endsLiveRange.has(a.origin)) live.delete(a.index);
      continue;
    }
    // set
    if (!effectiveSet.has(a.origin)) continue;
    for (const other of live) {
      if (other !== a.index) interferes.set(other, a.index);
    }
    live.add(a.index);
  }
}

// ---------------------------------------------------------------------------
// Upper-triangular interference matrix
// ---------------------------------------------------------------------------

class _InterferenceMatrix {
  private readonly n: number;
  private readonly bits: Uint8Array;
  constructor(n: number) {
    this.n = n;
    // n*(n-1)/2 entries; store as a flat byte array.
    this.bits = new Uint8Array(Math.max(0, (n * (n - 1)) >> 1));
  }
  private indexOf(low: number, high: number): number {
    // low < high; pair (i, j) → i * n - i*(i+1)/2 + (j - i - 1)
    return low * this.n - ((low * (low + 1)) >> 1) + (high - low - 1);
  }
  set(a: number, b: number): void {
    if (a === b) return;
    const low = a < b ? a : b;
    const high = a < b ? b : a;
    if (low < 0 || high >= this.n) return;
    this.bits[this.indexOf(low, high)] = 1;
  }
  get(a: number, b: number): boolean {
    if (a === b) return false;
    const low = a < b ? a : b;
    const high = a < b ? b : a;
    if (low < 0 || high >= this.n) return false;
    return this.bits[this.indexOf(low, high)] === 1;
  }
}

// ---------------------------------------------------------------------------
// Body rewrite — rename indices + replace ineffective sets/tees
// ---------------------------------------------------------------------------

function _hasAnyIneffective(cfg: CFG, effectiveSet: ReadonlySet<Expression>): boolean {
  for (const b of cfg.blocks) {
    for (const a of b.actions) {
      if (a.kind === "set" && !effectiveSet.has(a.origin)) return true;
    }
  }
  return false;
}

function _rewriteBody(
  expr: Expression,
  mapping: number[],
  effectiveSet: ReadonlySet<Expression>,
): Expression {
  return mapExpression(expr, (e) => {
    if (e.kind === ExpressionKind.LocalSet) {
      const renamed = mapping[e.index] !== e.index ? { ...e, index: mapping[e.index] } : e;
      // If this set's value never gets read by any get, replace with drop.
      if (!effectiveSet.has(e)) {
        return makeDrop(renamed.value);
      }
      return renamed;
    }
    if (e.kind === ExpressionKind.LocalTee) {
      // Tee both writes and pushes the value. If the write is ineffective,
      // the tee degrades to just the value (which is still on the stack).
      if (!effectiveSet.has(e)) return e.value;
      if (mapping[e.index] !== e.index) return { ...e, index: mapping[e.index] };
      return e;
    }
    if (e.kind === ExpressionKind.LocalGet) {
      if (e.index < mapping.length && mapping[e.index] !== e.index) {
        return { ...e, index: mapping[e.index] };
      }
    }
    return e;
  });
}
