/**
 * @module binaryen-ts/passes/cfg
 *
 * Control-flow graph construction + backward-flow liveness over the
 * binaryen-ts IR. Used by passes that need precise interference information,
 * principally {@link CoalesceLocalsPass}.
 *
 * The CFG models structured wasm control flow at the granularity of a
 * "basic block": a sequence of liveness-relevant actions (`local.get` /
 * `local.set` / `local.tee`) with single-entry / single-exit semantics.
 * Branches, returns, and unreachable terminate a block; if / loop / block
 * introduce edges between blocks; named loop labels carry a back-edge from
 * any `br` inside the body to the loop entry.
 *
 * Backward worklist liveness then computes, for each block:
 * - `start` — locals live on entry (live-in)
 * - `end`   — locals live on exit (live-out)
 *
 * The interference computation in CoalesceLocals walks each block forward
 * tracking `live`: at each effective `local.set`, all currently live locals
 * other than the one being written interfere with it.
 *
 * **Scope notes**:
 * - MVP + tail-call control flow is modelled precisely.
 * - Exception handling: a `try` pushes its catch entries onto a handler stack
 *   while its BODY is visited. Throwing instructions inside the body —
 *   `throw` / `throw_ref` / `rethrow`, and `call` / `call_indirect` — add an
 *   exceptional edge to those catch entries (all enclosing scopes, conservative)
 *   so the handler's live-in reaches the exact throw point. A throwing `call`
 *   also splits the block, so a wrapping `local.set` lands after the exceptional
 *   edge and its kill of the old value can't strip a local that is live on the
 *   handler path (e.g. `let r=-1; try { r=mayThrow() } catch {} return r` keeps
 *   `r`'s `-1`). Catch bodies are visited with their own try's scope popped, so a
 *   throw inside a catch transfers to the ENCLOSING handler (rethrow semantics).
 *   `throw` / `throw_ref` / `rethrow` terminate the current block for normal flow.
 * - Calls do not split blocks. They do not appear as `LivenessAction`s
 *   either — their effect on locals is captured by the surrounding
 *   `local.get` / `local.set` actions for any value they consume / produce.
 *
 * Reference: `upstream/src/cfg/cfg-traversal.h`, `upstream/src/cfg/liveness-traversal.h`
 *
 * @license MIT
 */

import { type Expression, ExpressionKind } from "../ir/expressions.ts";
import { visitChildren } from "../ir/walk.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A liveness-relevant operation observed at one point in a basic block. */
export interface LivenessAction {
  /** `"get"` for `local.get`, `"set"` for `local.set` / `local.tee`. */
  kind: "get" | "set";
  /** Local index touched. */
  index: number;
  /** The originating IR node — used by CoalesceLocals to mark effective sets. */
  origin: Expression;
}

/** A single-entry / single-exit straight-line region of the CFG. */
export interface BasicBlock {
  /** Block index assigned at construction time (stable, dense, starts at 0). */
  id: number;
  /** Liveness-relevant operations in execution order. */
  actions: LivenessAction[];
  /** Predecessor blocks (filled in during construction). */
  in: BasicBlock[];
  /** Successor blocks (filled in during construction). */
  out: BasicBlock[];
  /** Locals live on entry. Set by {@link computeLiveness}. */
  start: Set<number>;
  /** Locals live on exit. Set by {@link computeLiveness}. */
  end: Set<number>;
  /**
   * Call sites within this block, in execution order. `pos` is the number of
   * {@link actions} recorded before the call executes (so the locals live
   * *just after* the call = the live set reached by processing `actions[pos..]`
   * backward from {@link end}). Purely additive metadata — the get/set liveness
   * consumers (CoalesceLocals, {@link computeLiveness}) ignore it. Used by the
   * Asyncify pass to compute the locals that must be saved across a suspend.
   */
  callPoints: Array<{ pos: number; call: Expression }>;
}

/** Result of {@link buildCFG} — entry plus the dense block list. */
export interface CFG {
  /** First block executed when the function is called. */
  entry: BasicBlock;
  /** All blocks in construction order. Block `id` == index here. */
  blocks: BasicBlock[];
}

// ---------------------------------------------------------------------------
// CFG construction
// ---------------------------------------------------------------------------

/**
 * Builds a CFG for a function body. The returned CFG has empty `start`/`end`
 * sets — call {@link computeLiveness} to populate them.
 *
 * @param body - The function body expression.
 * @returns A CFG with all blocks linked.
 */
export function buildCFG(body: Expression): CFG {
  const builder = new _CFGBuilder();
  builder.current = builder.newBlock();
  const entry = builder.current;
  builder.visit(body);
  return { entry, blocks: builder.blocks };
}

class _CFGBuilder {
  blocks: BasicBlock[] = [];
  current: BasicBlock | null = null;
  /** Stack of label scopes: label name → destination block. */
  private labelStack: Array<{ name: string; target: BasicBlock }> = [];
  /**
   * Stack of active exception-handler scopes. Each entry is the list of
   * catch-entry blocks for an enclosing `try` whose BODY we are currently
   * inside. A throwing instruction (explicit `throw`/`rethrow`, or a `call` /
   * `call_indirect` that may throw) links to these so the handler's live-in is
   * correctly propagated to the throw point. Catch bodies are visited with
   * their own try's scope POPPED, so a throw inside a catch transfers to the
   * ENCLOSING handler (matching wasm's rethrow semantics).
   */
  private handlerStack: BasicBlock[][] = [];

  /** Link `current` to every active handler catch-entry (all enclosing scopes —
   *  a conservative over-approximation that never strips a live local: if the
   *  innermost catch doesn't match the thrown tag, an outer one might). */
  private linkToHandlers(): void {
    if (this.current === null) return;
    for (const scope of this.handlerStack) {
      for (const h of scope) this.link(this.current, h);
    }
  }

  /**
   * Model a `call`/`call_indirect` inside a try body: it may throw (→ handlers,
   * with the live state BEFORE any wrapping `local.set`) or return normally.
   * The exceptional edge is added from the current block, then a fresh block is
   * started for the normal continuation — so a wrapping `local.set` lands AFTER
   * the exceptional edge and its kill of the old value can't strip a local that
   * is live on the exceptional (handler) path. No-op outside a try body.
   */
  private throwingCallContinuation(): void {
    if (this.handlerStack.length === 0 || this.current === null) return;
    this.linkToHandlers();
    const cont = this.newBlock();
    this.link(this.current, cont);
    this.current = cont;
  }

  newBlock(): BasicBlock {
    const b: BasicBlock = {
      id: this.blocks.length,
      actions: [],
      in: [],
      out: [],
      start: new Set(),
      end: new Set(),
      callPoints: [],
    };
    this.blocks.push(b);
    return b;
  }

  link(from: BasicBlock | null, to: BasicBlock): void {
    if (from === null) return;
    if (!from.out.includes(to)) {
      from.out.push(to);
      to.in.push(from);
    }
  }

  pushLabel(name: string, target: BasicBlock): void {
    this.labelStack.push({ name, target });
  }

  popLabel(): void {
    this.labelStack.pop();
  }

  resolveLabel(name: string): BasicBlock | null {
    for (let i = this.labelStack.length - 1; i >= 0; i--) {
      if (this.labelStack[i].name === name) return this.labelStack[i].target;
    }
    return null; // unknown label — treat as exiting the function
  }

  visit(e: Expression): void {
    switch (e.kind) {
      // -------------------------------------------------------------------
      // Locals — record the action
      // -------------------------------------------------------------------
      case ExpressionKind.LocalGet:
        if (this.current) {
          this.current.actions.push({ kind: "get", index: e.index, origin: e });
        }
        return;

      case ExpressionKind.LocalSet:
      case ExpressionKind.LocalTee:
        this.visit(e.value);
        if (this.current) {
          this.current.actions.push({ kind: "set", index: e.index, origin: e });
        }
        return;

      // -------------------------------------------------------------------
      // Block — children execute in order; named blocks accept forward
      // branches into a merge block after the last child.
      // -------------------------------------------------------------------
      case ExpressionKind.Block: {
        const merge = this.newBlock();
        if (e.name) this.pushLabel(e.name, merge);
        for (const child of e.children) this.visit(child);
        if (e.name) this.popLabel();
        this.link(this.current, merge);
        this.current = merge;
        return;
      }

      // -------------------------------------------------------------------
      // Loop — labelled body. A `br $name` inside loops back to the top.
      // Control falls through the loop body once otherwise.
      // -------------------------------------------------------------------
      case ExpressionKind.Loop: {
        const loopTop = this.newBlock();
        this.link(this.current, loopTop);
        this.current = loopTop;
        this.pushLabel(e.name, loopTop);
        this.visit(e.body);
        this.popLabel();
        // current naturally falls through; the merge happens at whatever
        // wraps the loop. No explicit post-loop block needed.
        return;
      }

      // -------------------------------------------------------------------
      // If — condition then split + merge.
      // -------------------------------------------------------------------
      case ExpressionKind.If: {
        this.visit(e.condition);
        const pre = this.current;
        const merge = this.newBlock();

        const thenBlock = this.newBlock();
        this.link(pre, thenBlock);
        this.current = thenBlock;
        this.visit(e.ifTrue);
        this.link(this.current, merge);

        if (e.ifFalse) {
          const elseBlock = this.newBlock();
          this.link(pre, elseBlock);
          this.current = elseBlock;
          this.visit(e.ifFalse);
          this.link(this.current, merge);
        } else {
          // else-less if: the false path bypasses the body
          this.link(pre, merge);
        }

        this.current = merge;
        return;
      }

      // -------------------------------------------------------------------
      // Branches — wasm spec evaluation order is value, then condition.
      // -------------------------------------------------------------------
      case ExpressionKind.Break: {
        if (e.value) this.visit(e.value);
        if (e.condition) this.visit(e.condition);
        const target = this.resolveLabel(e.name);
        if (target) this.link(this.current, target);
        if (e.condition) {
          // br_if: fall through if condition is zero
          const fall = this.newBlock();
          this.link(this.current, fall);
          this.current = fall;
        } else {
          // unconditional br: rest is unreachable until the next merge
          this.current = null;
        }
        return;
      }

      case ExpressionKind.Switch: {
        if (e.value) this.visit(e.value);
        this.visit(e.condition);
        const seen = new Set<string>();
        for (const name of [...e.targets, e.defaultTarget]) {
          if (seen.has(name)) continue;
          seen.add(name);
          const target = this.resolveLabel(name);
          if (target) this.link(this.current, target);
        }
        this.current = null;
        return;
      }

      case ExpressionKind.Return: {
        if (e.value) this.visit(e.value);
        this.current = null;
        return;
      }

      case ExpressionKind.Unreachable:
        this.current = null;
        return;

      // -------------------------------------------------------------------
      // Exception handling — see scope note in module header.
      // -------------------------------------------------------------------
      case ExpressionKind.Throw: {
        for (const op of e.operands) this.visit(op);
        this.linkToHandlers(); // exceptional transfer to enclosing catch handler(s)
        this.current = null;
        return;
      }

      case ExpressionKind.ThrowRef: {
        this.visit(e.exnref);
        this.linkToHandlers();
        this.current = null;
        return;
      }

      case ExpressionKind.Rethrow:
        this.linkToHandlers();
        this.current = null;
        return;

      case ExpressionKind.Try: {
        const merge = this.newBlock();
        const bodyEntry = this.newBlock();
        this.link(this.current, bodyEntry);

        // Conservative entry edge: even the first action in the body could throw.
        const catchEntries = e.catchBodies.map(() => this.newBlock());
        for (const ce of catchEntries) this.link(bodyEntry, ce);

        // While inside the body, throwing instructions (throw/rethrow, call/
        // call_indirect) transfer to THESE catch entries — pushed so the live
        // state at each throw point reaches the handler (see linkToHandlers /
        // throwingCallContinuation).
        this.current = bodyEntry;
        this.handlerStack.push(catchEntries);
        this.visit(e.body);
        this.handlerStack.pop();
        this.link(this.current, merge);

        // Catch bodies run with this try's scope popped — a throw inside a catch
        // transfers to the ENCLOSING handler (rethrow semantics), not back to
        // this try's own catch.
        for (let i = 0; i < e.catchBodies.length; i++) {
          this.current = catchEntries[i];
          this.visit(e.catchBodies[i]);
          this.link(this.current, merge);
        }

        this.current = merge;
        return;
      }

      case ExpressionKind.TryTable: {
        const merge = this.newBlock();
        const bodyEntry = this.newBlock();
        this.link(this.current, bodyEntry);
        // Each catch clause names a destination label, so the throw edge is
        // modelled as: bodyEntry → target-of(catch.dest). If no matching
        // catch resolves, the throw exits the function (we drop the edge).
        for (const cc of e.catches) {
          const target = this.resolveLabel(cc.dest);
          if (target) this.link(bodyEntry, target);
        }
        this.current = bodyEntry;
        this.visit(e.body);
        this.link(this.current, merge);
        this.current = merge;
        return;
      }

      // -------------------------------------------------------------------
      // call_indirect — wasm evaluation order is operands FIRST, then the
      // table index (`target`) LAST. The generic `visitChildren` helper visits
      // `target` before `operands` (fine for a pre-order walk, wrong for
      // liveness): it would record the index's `local.get`s before the
      // operands' `local.set`/`local.tee`s, so a `local.tee` in an operand
      // whose value is consumed ONLY by the index expression looks dead. The
      // dead-set elimination in CoalesceLocals then drops that write, and the
      // index reads a stale slot → `call_indirect` dispatches to the wrong
      // (wrong-signature) function at runtime. Visit in true execution order.
      case ExpressionKind.CallIndirect: {
        for (const op of e.operands) this.visit(op);
        this.visit(e.target);
        if (this.current) this.current.callPoints.push({ pos: this.current.actions.length, call: e });
        this.throwingCallContinuation(); // may throw → enclosing handler (if in a try)
        return;
      }

      // -------------------------------------------------------------------
      // call — operands in order, then (if inside a try) an exceptional edge
      // to the enclosing handler plus a normal-continuation split.
      // -------------------------------------------------------------------
      case ExpressionKind.Call: {
        for (const op of e.operands) this.visit(op);
        if (this.current) this.current.callPoints.push({ pos: this.current.actions.length, call: e });
        this.throwingCallContinuation();
        return;
      }

      // -------------------------------------------------------------------
      // Everything else — straight-line evaluation, walk children in order.
      // -------------------------------------------------------------------
      default:
        visitChildren(e, (c) => this.visit(c));
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Liveness analysis (backward-flow worklist)
// ---------------------------------------------------------------------------

/**
 * Computes live-in (`start`) and live-out (`end`) for every block in `cfg`
 * via a standard backward-flow worklist. Initial sets are empty; each
 * iteration only adds locals, so the analysis monotonically converges.
 *
 * @param cfg - The CFG to annotate. `start` and `end` are populated in place.
 * @param extraLiveIn - Locals to seed as live-in to every block (rare —
 *   used for params under specific edge cases). Default empty.
 */
export function computeLiveness(cfg: CFG): void {
  // Initial: scan each block once with end = empty to get a starting `start`.
  // We then re-flow until convergence. A block's end is the union of its
  // successors' starts.
  const queue: BasicBlock[] = [];
  const queued = new Set<number>();
  for (const b of cfg.blocks) {
    queue.push(b);
    queued.add(b.id);
  }

  while (queue.length > 0) {
    const b = queue.shift()!;
    queued.delete(b.id);

    // new_end = ⋃ successors' starts
    const newEnd = new Set<number>();
    for (const s of b.out) {
      for (const x of s.start) newEnd.add(x);
    }

    // new_start = scan actions backward
    const newStart = scanBackward(b.actions, newEnd);

    const startChanged = !setsEqual(newStart, b.start);

    b.start = newStart;
    b.end = newEnd;

    if (startChanged) {
      // Predecessors depend on our start; re-flow them. (An `end` change that
      // doesn't move `start` can't affect any predecessor, so no wake-up.)
      for (const p of b.in) {
        if (!queued.has(p.id)) {
          queue.push(p);
          queued.add(p.id);
        }
      }
    }
  }
}

/**
 * Returns `live_before_first_action` given `actions` and `live_after_last_action`.
 * Scans actions from end to start, updating `live`: each `get` adds the index,
 * each `set` removes it. The input set is not mutated.
 */
function scanBackward(
  actions: LivenessAction[],
  liveAtEnd: ReadonlySet<number>,
): Set<number> {
  const live = new Set(liveAtEnd);
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.kind === "get") {
      live.add(a.index);
    } else {
      // set / tee — kills the previous value (whatever flows in from
      // beyond this point is no longer live at the point before the set).
      live.delete(a.index);
    }
  }
  return live;
}

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
