/**
 * @module binaryen-ts/passes/inlining
 *
 * Inlining pass — replaces direct calls to small functions with the callee body.
 *
 * Two registered passes are provided:
 *
 * - `Inlining` — inline only, no post-inline optimization.
 * - `InliningOptimizing` — inline then run Vacuum + OptimizeInstructions on
 *   each modified function (mirrors upstream `InliningOptimizing`).
 *
 * Inlineability heuristics (size = instruction node count in body):
 *
 * - Always inline if `size <= 2` (trivially small).
 * - Inline single-caller functions if `size <= 10` and not exported/global.
 * - With `optimizeLevel >= 3`: inline multi-caller functions if `size <= 20`.
 *
 * Guarded exclusions:
 * - Recursive calls (callee === caller) are never inlined.
 * - Imported functions (no body in this module) are never inlined.
 * - Functions referenced from element segments (used indirectly) are considered
 *   globally used and not removed after inlining, though they may still be
 *   inlined at their call sites.
 *
 * Reference: `upstream/src/passes/Inlining.cpp`
 *
 * @license MIT
 */

import {
  type BlockExpr,
  type BreakExpr,
  type CallExpr,
  type Expression,
  ExpressionKind,
  type IfExpr,
  type LocalSetExpr,
  makeBlock,
  makeCall,
  makeF32Const,
  makeF64Const,
  makeI32Const,
  makeI64Const,
  makeLocalGet,
  makeLocalSet,
  makeRefNull,
  makeReturn,
  makeUnary,
  makeUnreachable,
  makeV128Const,
  type RefIsNullExpr,
  type UnaryExpr,
  UnaryOp,
} from "../ir/expressions.ts";
import type { Local, WasmFunction, WasmModule } from "../ir/module.ts";
import { isRef, None, Unreachable, ValType } from "../ir/types.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";
import { optimizeNode } from "./optimize-instructions.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";
import { vacuumNode } from "./vacuum.ts";

// ---------------------------------------------------------------------------
// Size thresholds (matching upstream defaults in pass.h)
// ---------------------------------------------------------------------------

const ALWAYS_INLINE_MAX_SIZE = 2;
const ONE_CALLER_INLINE_MAX_SIZE = 10;
const FLEXIBLE_INLINE_MAX_SIZE = 20;
const MAX_ITERATIONS = 5;

// ---------------------------------------------------------------------------
// Function metadata
// ---------------------------------------------------------------------------

interface FunctionInfo {
  size: number;
  refs: number;
  hasLoops: boolean;
  hasCalls: boolean;
  usedGlobally: boolean;
}

function buildFunctionInfo(module: WasmModule): Map<string, FunctionInfo> {
  const info = new Map<string, FunctionInfo>();

  // Initialise an entry for every defined function.
  for (const fn of module.functions) {
    info.set(fn.name, {
      size: 0,
      refs: 0,
      hasLoops: false,
      hasCalls: false,
      usedGlobally: false,
    });
  }

  // Scan each function body.
  for (const fn of module.functions) {
    const entry = info.get(fn.name)!;
    walkExpression(fn.body, (e) => {
      entry.size++;
      if (e.kind === ExpressionKind.Loop) entry.hasLoops = true;
      if (e.kind === ExpressionKind.Call) {
        entry.hasCalls = true;
        // Count reference to the callee.
        const target = info.get(e.target);
        if (target) target.refs++;
      }
      if (e.kind === ExpressionKind.RefFunc) {
        const target = info.get(e.func);
        if (target) {
          target.refs++;
          target.usedGlobally = true;
        }
      }
    });
  }

  // Exports make a function globally used.
  for (const ex of module.exports) {
    if (ex.kind === "function") {
      const entry = info.get(ex.value);
      if (entry) entry.usedGlobally = true;
    }
  }

  // Element segment references make a function globally used.
  for (const seg of module.elements) {
    for (const name of seg.data) {
      const entry = info.get(name);
      if (entry) {
        entry.usedGlobally = true;
        entry.refs++;
      }
    }
  }

  return info;
}

// ---------------------------------------------------------------------------
// Inlineability decision
// ---------------------------------------------------------------------------

function isInlineable(
  info: FunctionInfo,
  opts: PassOptions,
): boolean {
  if (info.size <= ALWAYS_INLINE_MAX_SIZE) return true;
  if (
    info.refs === 1 && !info.usedGlobally &&
    info.size <= ONE_CALLER_INLINE_MAX_SIZE
  ) return true;
  if (opts.optimizeLevel >= 3 && info.size <= FLEXIBLE_INLINE_MAX_SIZE) {
    return !info.hasCalls || !info.hasLoops;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Split inlining (Pattern A / Pattern B) — port of upstream FunctionSplitter
// (`upstream/src/passes/Inlining.cpp` lines 740-1240). Enabled by setting
// `PassOptions.partialInliningIfs >= 1`. Disabled by default (matches upstream
// which also defaults to 0). Trades code size for speed: turns a call + branch
// on the cold path into a single branch by inlining only the "fast-path"
// portion of a function at every call site, leaving the heavy work as an
// outlined helper.
// ---------------------------------------------------------------------------

/** Classification result for {@link FunctionSplitter.getSplitMode}. */
type SplitMode =
  | "Uninlineable"
  /** The function isn't worth splitting on its own, but the would-be outlined
   *  chunk is small enough to fully inline — skip the inlineable/outlined
   *  intermediate state and just full-inline the whole function. */
  | "Full"
  /** `if (simple_cond) return; ... lots of code ...` */
  | "SplitPatternA"
  /** `if (simple_A_1) heavy_1; if (simple_A_2) heavy_2; ... [simple_final]` */
  | "SplitPatternB";

/** Upstream's `isSimple` — the allow-list of expressions cheap enough to
 *  duplicate at every call site as part of a partial inline. Intentionally
 *  narrow: `LocalGet` / `GlobalGet` / `Unary(simple)` / `RefIsNull(simple)`.
 *  Notably NOT `Const` (no benefit — already trivial), NOT `Binary` (compute
 *  cost matters). Matches `upstream/src/passes/Inlining.cpp:1222`. */
function isSimple(e: Expression): boolean {
  if (e.type === Unreachable) return false;
  if (e.kind === ExpressionKind.LocalGet || e.kind === ExpressionKind.GlobalGet) return true;
  if (e.kind === ExpressionKind.Unary) return isSimple((e as UnaryExpr).value);
  if (e.kind === ExpressionKind.RefIsNull) return isSimple((e as RefIsNullExpr).value);
  return false;
}

/** Returns the i-th item in a sequence of initial items. If `e` is a Block,
 *  this indexes into `children`; otherwise the sole "item" is `e` itself at
 *  index 0. Returns `null` past the end. Mirrors upstream `getItem`. */
function getItem(e: Expression, i = 0): Expression | null {
  if (e.kind === ExpressionKind.Block) {
    const b = e as BlockExpr;
    return b.children[i] ?? null;
  }
  return i === 0 ? e : null;
}

/** Returns the i-th item if it's an `IfExpr`, else `null`. */
function getIf(e: Expression, i = 0): IfExpr | null {
  const item = getItem(e, i);
  return item && item.kind === ExpressionKind.If ? item as IfExpr : null;
}

/** Does the expression tree contain a `br`/`br_if` targeting `label`? */
function hasBreakTo(e: Expression, label: string): boolean {
  let found = false;
  walkExpression(e, (n) => {
    if (n.kind === ExpressionKind.Break && (n as BreakExpr).name === label) found = true;
    if (n.kind === ExpressionKind.Switch) {
      const sw = n as { targets: string[]; defaultTarget: string };
      if (sw.targets.includes(label) || sw.defaultTarget === label) found = true;
    }
  });
  return found;
}

/** Does the expression tree contain a `Return` instruction? */
function hasReturn(e: Expression): boolean {
  let found = false;
  walkExpression(e, (n) => {
    if (n.kind === ExpressionKind.Return) found = true;
  });
  return found;
}

/** Collects local indices written by any `LocalSet` in the subtree. */
function collectLocalSets(e: Expression, into: Set<number>): void {
  walkExpression(e, (n) => {
    if (n.kind === ExpressionKind.LocalSet) into.add((n as LocalSetExpr).index);
  });
}

/** Collects local indices read by any `LocalGet` in the subtree. */
function collectLocalGets(e: Expression): number[] {
  const out: number[] = [];
  walkExpression(e, (n) => {
    if (n.kind === ExpressionKind.LocalGet) out.push((n as { index: number }).index);
  });
  return out;
}

/** Builds `(local.get i)` for each parameter of `fn`, in order. The forwarded
 *  args bind the inlineable shell's params (which are identical to the original
 *  function's params) into the outlined call. */
function getForwardedArgs(fn: WasmFunction): Expression[] {
  return fn.params.map((type, i) => makeLocalGet(i, type));
}

/** Per-pass cache of which functions we've split, and the inlineable templates
 *  produced. The templates are NOT added to `module.functions` — they are pure
 *  body sources used by `inlineCallSite`. The outlined functions ARE real and
 *  do get added to the module. Matches upstream's structure. */
class FunctionSplitter {
  private cache = new Map<string, WasmFunction>();

  constructor(private readonly module: WasmModule, private readonly opts: PassOptions) {}

  /** Classify `fn` per upstream's two patterns. Returns `"Uninlineable"` if
   *  no pattern matches or partial inlining is disabled. */
  getSplitMode(fn: WasmFunction, info: FunctionInfo): SplitMode {
    if (this.opts.partialInliningIfs <= 0) return "Uninlineable";

    const body = fn.body;

    // A block with a self-targeted break can't be safely outlined.
    if (body.kind === ExpressionKind.Block) {
      const b = body as BlockExpr;
      if (b.name && hasBreakTo(body, b.name)) return "Uninlineable";
    }

    const iff = getIf(body);
    if (!iff) return "Uninlineable";
    if (!isSimple(iff.condition)) return "Uninlineable";

    // ---- Pattern A: `if (simple) return; ...rest` ----
    if (!iff.ifFalse && fn.results.length === 0 && iff.ifTrue.kind === ExpressionKind.Return) {
      // Must be a block — otherwise the whole function is just the if and the
      // normal inliner would have taken it already.
      if (body.kind !== ExpressionKind.Block) return "Uninlineable";

      const outlinedSize = info.size - measureSize(iff);
      if (this.outlinedFunctionWorthInlining(info, outlinedSize)) return "Full";

      return "SplitPatternA";
    }

    // ---- Pattern B: sequence of `if (simple) { heavy }` plus optional final ----
    const maxIfs = this.opts.partialInliningIfs;
    let numIfs = 0;
    while (numIfs <= maxIfs && getIf(body, numIfs)) numIfs++;
    if (numIfs === 0 || numIfs > maxIfs) return "Uninlineable";

    const finalItem = getItem(body, numIfs);
    if (finalItem && !isSimple(finalItem)) return "Uninlineable";
    if (finalItem && getItem(body, numIfs + 1)) return "Uninlineable";

    const writtenLocals = new Set<number>();
    for (let i = 0; i < numIfs; i++) {
      const ifI = getIf(body, i)!;
      if (!isSimple(ifI.condition) || ifI.ifFalse) return "Uninlineable";

      const bodyType = ifI.ifTrue.type;
      if (bodyType === None) {
        if (hasReturn(ifI.ifTrue)) return "Uninlineable";
      } else if (bodyType !== Unreachable) {
        // An if-without-else must have type none or unreachable. Anything
        // else would mean the if produces a value, which Pattern B doesn't
        // currently outline cleanly.
        return "Uninlineable";
      }

      if (finalItem) collectLocalSets(ifI, writtenLocals);
    }
    if (finalItem) {
      for (const localIdx of collectLocalGets(finalItem)) {
        if (writtenLocals.has(localIdx)) return "Uninlineable";
      }
    }

    if (numIfs === 1) {
      const ifI = getIf(body, 0)!;
      const outlinedSize = measureSize(ifI.ifTrue);
      if (this.outlinedFunctionWorthInlining(info, outlinedSize)) return "Full";
    }

    return "SplitPatternB";
  }

  /** Returns (and caches) the inlineable-shell `WasmFunction` for `fn`. The
   *  template is never added to `module.functions`; its body just serves as
   *  the substitution payload for `inlineCallSite`. Outlined functions
   *  created along the way DO get pushed to `module.functions`. */
  getInlineableTemplate(fn: WasmFunction, mode: SplitMode): WasmFunction {
    const cached = this.cache.get(fn.name);
    if (cached) return cached;
    const template = mode === "SplitPatternA" ? this.doSplitA(fn) : this.doSplitB(fn);
    this.cache.set(fn.name, template);
    return template;
  }

  /** Conservative estimate of whether the outlined remainder would itself be
   *  worth full-inlining at the same call sites. If yes, the caller skips the
   *  split intermediate state and just full-inlines the original. Mirrors
   *  upstream's `outlinedFunctionWorthInlining`. */
  private outlinedFunctionWorthInlining(origin: FunctionInfo, sizeEstimate: number): boolean {
    const projected: FunctionInfo = { ...origin, size: sizeEstimate };
    // Use the same predicate the standard inliner uses, with optimizeLevel
    // bumped to 3 so the "flexible" tier kicks in — this matches upstream's
    // `worthFullInlining` which is the equivalent of our isInlineable() call
    // at the highest tier.
    return isInlineable(projected, { ...this.opts, optimizeLevel: 3 });
  }

  /** Pattern A split: turn `if (cond) return; ...rest` into:
   *    inlineable shell: `if (eqz cond) call $outlined(args)`
   *    outlined function: `...rest`
   *  Note that flipping the condition with `i32.eqz` lets the inlineable
   *  shell preserve the original early-exit semantics — the call to outlined
   *  happens only when the original would have continued past the `return`. */
  private doSplitA(fn: WasmFunction): WasmFunction {
    const body = fn.body as BlockExpr;
    const originalIf = getIf(body)!;

    // Outlined function: body minus the first if.
    const outlinedBody = makeBlock(
      body.children.slice(1).map((c) => deepCopy(c)),
      body.name,
    );
    const outlined: WasmFunction = {
      name: `byn-split-outlined-A$${fn.name}`,
      params: fn.params.slice(),
      results: fn.results.slice(),
      locals: copyLocals(fn.locals),
      body: outlinedBody,
    };
    this.module.functions.push(outlined);

    // Inlineable shell: just the if, condition flipped, body replaced with
    // a call to the outlined function.
    const shellIf: IfExpr = {
      kind: ExpressionKind.If,
      type: originalIf.type,
      condition: makeUnary(UnaryOp.EqzI32, deepCopy(originalIf.condition)),
      ifTrue: makeCall(outlined.name, getForwardedArgs(fn), None),
      ifFalse: null,
    };

    return {
      name: `byn-split-inlineable-A$${fn.name}`,
      params: fn.params.slice(),
      results: fn.results.slice(),
      locals: copyLocals(fn.locals),
      body: shellIf,
    };
  }

  /** Pattern B split: for each of the first MaxIfs ifs in the body, outline
   *  the if's body into its own function and replace the if's body with a
   *  call to it (wrapped in `return` when the outlined function returns a
   *  value matching the original's result type). */
  private doSplitB(fn: WasmFunction): WasmFunction {
    const maxIfs = this.opts.partialInliningIfs;
    const inlineableBody = deepCopy(fn.body);

    for (let i = 0; i < maxIfs; i++) {
      const ifI = getIf(inlineableBody, i);
      if (!ifI) break;

      const valueReturned = fn.results.length > 0 && ifI.ifTrue.type !== None &&
        ifI.ifTrue.type !== Unreachable;
      const outlinedResults = valueReturned ? fn.results.slice() : [];

      const outlined: WasmFunction = {
        name: `byn-split-outlined-B$${fn.name}$${i}`,
        params: fn.params.slice(),
        results: outlinedResults,
        locals: copyLocals(fn.locals),
        body: ifI.ifTrue,
      };
      this.module.functions.push(outlined);

      const callType = valueReturned ? (outlinedResults[0] as ValType) : None;
      const call = makeCall(outlined.name, getForwardedArgs(fn), callType);
      ifI.ifTrue = valueReturned ? makeReturn(call) : call;
    }

    return {
      name: `byn-split-inlineable-B$${fn.name}`,
      params: fn.params.slice(),
      results: fn.results.slice(),
      locals: copyLocals(fn.locals),
      body: inlineableBody,
    };
  }
}

/** Shallow-copy a locals array (`Local` is a flat record with no nested objects). */
function copyLocals(locals: Local[]): Local[] {
  return locals.map((l) => ({ ...l }));
}

// ---------------------------------------------------------------------------
// Deep copy
// ---------------------------------------------------------------------------

/** Structural deep copy of an expression tree. Required before inlining a body
 * at multiple call sites (tree ownership rule: one parent per node). */
function deepCopy(expr: Expression): Expression {
  switch (expr.kind) {
    case ExpressionKind.Nop:
    case ExpressionKind.Unreachable:
    case ExpressionKind.MemorySize:
    case ExpressionKind.LocalGet:
    case ExpressionKind.GlobalGet:
    case ExpressionKind.RefNull:
    case ExpressionKind.RefFunc:
      return { ...expr };

    case ExpressionKind.Const:
      return { ...expr };

    case ExpressionKind.Block:
      return { ...expr, children: expr.children.map(deepCopy) };

    case ExpressionKind.If:
      return {
        ...expr,
        condition: deepCopy(expr.condition),
        ifTrue: deepCopy(expr.ifTrue),
        ifFalse: expr.ifFalse ? deepCopy(expr.ifFalse) : null,
      };

    case ExpressionKind.Loop:
      return { ...expr, body: deepCopy(expr.body) };

    case ExpressionKind.Break:
      return {
        ...expr,
        condition: expr.condition ? deepCopy(expr.condition) : null,
        value: expr.value ? deepCopy(expr.value) : null,
      };

    case ExpressionKind.Switch:
      return {
        ...expr,
        condition: deepCopy(expr.condition),
        value: expr.value ? deepCopy(expr.value) : null,
      };

    case ExpressionKind.Return:
      return { ...expr, value: expr.value ? deepCopy(expr.value) : null };

    case ExpressionKind.LocalSet:
      return { ...expr, value: deepCopy(expr.value) };

    case ExpressionKind.LocalTee:
      return { ...expr, value: deepCopy(expr.value) };

    case ExpressionKind.GlobalSet:
      return { ...expr, value: deepCopy(expr.value) };

    case ExpressionKind.Unary:
      return { ...expr, value: deepCopy(expr.value) };

    case ExpressionKind.Binary:
      return { ...expr, left: deepCopy(expr.left), right: deepCopy(expr.right) };

    case ExpressionKind.Select:
      return {
        ...expr,
        ifTrue: deepCopy(expr.ifTrue),
        ifFalse: deepCopy(expr.ifFalse),
        condition: deepCopy(expr.condition),
      };

    case ExpressionKind.Drop:
      return { ...expr, value: deepCopy(expr.value) };

    case ExpressionKind.Load:
      return { ...expr, ptr: deepCopy(expr.ptr) };

    case ExpressionKind.Store:
      return { ...expr, ptr: deepCopy(expr.ptr), value: deepCopy(expr.value) };

    case ExpressionKind.MemoryGrow:
      return { ...expr, delta: deepCopy(expr.delta) };

    case ExpressionKind.MemoryCopy:
      return {
        ...expr,
        dest: deepCopy(expr.dest),
        source: deepCopy(expr.source),
        size: deepCopy(expr.size),
      };

    case ExpressionKind.MemoryFill:
      return {
        ...expr,
        dest: deepCopy(expr.dest),
        value: deepCopy(expr.value),
        size: deepCopy(expr.size),
      };

    case ExpressionKind.Call:
      return { ...expr, operands: expr.operands.map(deepCopy) };

    case ExpressionKind.CallIndirect:
      return {
        ...expr,
        target: deepCopy(expr.target),
        operands: expr.operands.map(deepCopy),
      };

    case ExpressionKind.RefIsNull:
      return { ...expr, value: deepCopy(expr.value) };

    default:
      // Unknown kind (future IR extension) — return as-is; no children to copy.
      return expr;
  }
}

// ---------------------------------------------------------------------------
// Label collection
// ---------------------------------------------------------------------------

/** Returns all block/loop label names defined or referenced in a tree. */
function collectLabels(expr: Expression): Set<string> {
  const labels = new Set<string>();
  walkExpression(expr, (e) => {
    if (e.kind === ExpressionKind.Block && e.name !== null) labels.add(e.name);
    if (e.kind === ExpressionKind.Loop) labels.add(e.name);
    if (e.kind === ExpressionKind.Break) labels.add(e.name);
    if (e.kind === ExpressionKind.Switch) {
      e.targets.forEach((t) => labels.add(t));
      labels.add(e.defaultTarget);
    }
  });
  return labels;
}

/** Generates a label name that does not appear in `used`, then adds it. */
function freshLabel(base: string, used: Set<string>): string {
  let label = base;
  let n = 0;
  while (used.has(label)) label = `${base}$${++n}`;
  used.add(label);
  return label;
}

// ---------------------------------------------------------------------------
// Zero initialiser for a local type
// ---------------------------------------------------------------------------

function zeroForType(type: ValType): Expression | null {
  switch (type) {
    case ValType.I32:
      return makeI32Const(0);
    case ValType.I64:
      return makeI64Const(0n);
    case ValType.F32:
      return makeF32Const(0);
    case ValType.F64:
      return makeF64Const(0);
    case ValType.V128:
      return makeV128Const(new Uint8Array(16));
    default:
      // Reference-typed local: its wasm default is `null`. In the coarse
      // ref-type model every ref local is nullable, so `ref.null` is the
      // correct per-entry reset (the pass runner fixes up any non-nullable
      // locals afterward). Returning `null` here — as the old code did for all
      // non-numeric types — skipped the reset, so an inlined callee's ref/v128
      // local kept the PREVIOUS execution's value when the call site runs more
      // than once (e.g. inside a loop): a stale-value miscompile.
      if (isRef(type)) return makeRefNull(type);
      return null;
  }
}

// ---------------------------------------------------------------------------
// Core substitution — remap locals and convert returns to breaks
// ---------------------------------------------------------------------------

/** Remaps local indices and (when `rewriteReturns` is true) replaces `return`
 * with `br $returnLabel` in a deep-copied callee body.
 *
 * For tail-call (`return_call`) inlining we pass `rewriteReturns = false`:
 * the callee's `return`s should propagate as the caller's `return`s directly,
 * because `return_call $f(args)` semantically *is* `return f(args)` — the
 * callee frame replaces the caller frame, and the callee's return exits the
 * caller. See Phase 5.2. */
function substituteBody(
  body: Expression,
  localMapping: number[],
  returnLabel: string,
  rewriteReturns = true,
): Expression {
  return mapExpression(body, (e): Expression => {
    switch (e.kind) {
      case ExpressionKind.LocalGet:
        return { ...e, index: localMapping[e.index] };

      case ExpressionKind.LocalSet:
        return { ...e, index: localMapping[e.index] };

      case ExpressionKind.LocalTee:
        return { ...e, index: localMapping[e.index] };

      case ExpressionKind.Return: {
        if (!rewriteReturns) return e;
        // An unconditional `br` always transfers control, so its type is
        // `unreachable` (mirrors `makeBreak` / upstream `Break::finalize`). The
        // old code stamped it with the value's type (e.g. `i32`), which mistypes
        // any block that infers its type from this `br` as its last child.
        const br: BreakExpr = {
          kind: ExpressionKind.Break,
          type: Unreachable,
          name: returnLabel,
          condition: null,
          value: e.value ?? null,
        };
        return br;
      }

      default:
        return e;
    }
  });
}

// ---------------------------------------------------------------------------
// Core inlining of a single call site
// ---------------------------------------------------------------------------

/**
 * Returns the replacement expression for a `call $callee(args)` node.
 *
 * Adds new locals to `into.locals` for all of `callee`'s locals (params + vars).
 * The label hint is an integer appended to the generated block label to reduce
 * collision risk when inlining the same function at multiple call sites.
 */
function inlineCallSite(
  callee: WasmFunction,
  call: CallExpr,
  into: WasmFunction,
  labelHint: number,
  usedLabels: Set<string>,
): Expression {
  // 1. Extend caller locals with a copy of all callee locals.
  const baseIndex = into.locals.length;
  const mapping: number[] = [];
  for (let i = 0; i < callee.locals.length; i++) {
    mapping.push(baseIndex + i);
    into.locals.push({ ...callee.locals[i] } as Local);
  }

  // 2. Pick a unique block label.
  const labelBase = labelHint > 0
    ? `__inlined_func$${callee.name}$${labelHint}`
    : `__inlined_func$${callee.name}`;
  const label = freshLabel(labelBase, usedLabels);

  // 3. Build the block contents.
  const children: Expression[] = [];

  // Assign call operands to param slots (operands moved from the call node).
  for (let i = 0; i < callee.params.length; i++) {
    const setParam: LocalSetExpr = {
      kind: ExpressionKind.LocalSet,
      type: None,
      index: mapping[i],
      value: call.operands[i],
    };
    children.push(setParam);
  }

  // Zero-initialise non-param locals (needed for correctness in loops).
  const varBase = callee.params.length;
  for (let i = varBase; i < callee.locals.length; i++) {
    const zero = zeroForType(callee.locals[i].type);
    if (zero !== null) {
      children.push(makeLocalSet(mapping[i], zero));
    }
  }

  // Deep copy the callee body then substitute locals (and, for non-tail
  // calls, rewrite `return` → `br $wrapperLabel`). For tail calls we leave
  // returns alone so they propagate out as the caller's returns.
  const bodyCopy = deepCopy(callee.body);
  const substituted = substituteBody(bodyCopy, mapping, label, !call.isReturn);
  children.push(substituted);

  // 4. Result type of the wrapper block.
  const retType = callee.results.length > 0 ? callee.results[0] : None;

  // 4a. Guarantee a valid wrapper fallthrough.
  //
  // When the callee delivers its result solely through `return` (rewritten to
  // `br $label`) rather than by falling off the end, the wrapper's structural
  // fallthrough produces no value — yet the wrapper is typed `retType` to
  // receive the value the `br` carries. The validator does NOT treat the
  // wrapper's end as unreachable just because the body's last expression is a
  // block that exits via `br` to the wrapper: a block exiting to an *outer*
  // label still leaves the outer block's fallthrough reachable. So it would
  // reject the wrapper with "expected 1 element on the stack for fallthru,
  // found 0". Append an explicit `unreachable` to mark that fallthrough dead.
  //
  // Safe because the only live exits from the wrapper are the `br $label`s the
  // returns became — the post-body position is dynamically never reached. We
  // append whenever the body does not fall through with `retType` (i.e. its
  // type is `none` or `unreachable`); for a body that already ends unreachable
  // the extra `unreachable` is redundant but harmless (Vacuum drops it).
  if (retType !== None && substituted.type !== retType) {
    children.push(makeUnreachable());
  }

  // 5. If the original call was unreachable (an operand was unreachable),
  //    propagate unreachability: wrap in sequence ending with unreachable.
  const block: BlockExpr = {
    kind: ExpressionKind.Block,
    type: retType,
    name: label,
    children,
  };

  if (call.type === Unreachable && !call.isReturn) {
    return makeBlock(
      [
        block.type !== None ? { kind: ExpressionKind.Drop, type: None, value: block } : block,
        makeUnreachable(),
      ],
    );
  }

  // Tail-call (`return_call`) inlining. The callee's frame semantically
  // replaces the caller's, so:
  //   - Value-returning callee: the wrapper block's value is the value the
  //     caller returns. Wrap in `(return <block>)`.
  //   - Void-returning callee: execute the wrapper for side effects, then
  //     return from the caller with no value. Sequence `[block, return(null)]`.
  // Either way, `substituteBody` was called with `rewriteReturns=false`, so
  // any explicit `return` inside the callee body propagates out of the
  // caller as the caller's own return — matching tail-call semantics.
  if (call.isReturn) {
    if (retType === None) {
      return makeBlock([block, { kind: ExpressionKind.Return, type: Unreachable, value: null }]);
    }
    return { kind: ExpressionKind.Return, type: Unreachable, value: block };
  }

  return block;
}

// ---------------------------------------------------------------------------
// Walk a function body and inline eligible calls
// ---------------------------------------------------------------------------

/**
 * Walks `fn.body` bottom-up and replaces eligible `Call` nodes.
 *
 * @returns `true` if at least one call was inlined.
 */
function inlineIntoFunction(
  fn: WasmFunction,
  inlineable: Map<string, WasmFunction>,
  _opts: PassOptions,
  labelHint: { value: number },
): boolean {
  const usedLabels = collectLabels(fn.body);
  let changed = false;

  fn.body = mapExpression(fn.body, (e): Expression => {
    if (e.kind !== ExpressionKind.Call) return e;
    const call = e as CallExpr;
    if (call.target === fn.name) return e; // skip recursive calls
    const callee = inlineable.get(call.target);
    if (!callee) return e;

    changed = true;
    return inlineCallSite(callee, call, fn, labelHint.value++, usedLabels);
  });

  return changed;
}

// ---------------------------------------------------------------------------
// Pass classes
// ---------------------------------------------------------------------------

/**
 * Inlining pass.
 *
 * Iterates until no more inlining opportunities are found, up to
 * `MAX_ITERATIONS` rounds.
 */
export class InliningPass implements Pass {
  readonly name: string = "Inlining";
  readonly description: string = "Inlines small direct-call targets to eliminate call overhead.";
  readonly requiresNonNullableLocalFixups = false;

  /** Whether to run Vacuum + OptimizeInstructions on modified functions. */
  protected readonly optimize: boolean = false;

  /** Per-pass cache of split-inlining decisions. Shared across iterations so a
   *  function only gets classified + split once per `run`. Recreated on each
   *  new `run` call. */
  private _splitter: FunctionSplitter | null = null;

  run(module: WasmModule, opts: PassOptions): void {
    const numOriginal = module.functions.length;
    const maxIter = Math.min(MAX_ITERATIONS, numOriginal + 1);

    this._splitter = opts.partialInliningIfs > 0 ? new FunctionSplitter(module, opts) : null;

    for (let iter = 0; iter < maxIter; iter++) {
      if (!this._iteration(module, opts)) break;
    }

    this._splitter = null;
  }

  private _iteration(module: WasmModule, opts: PassOptions): boolean {
    const info = buildFunctionInfo(module);

    // Build a set of defined (non-imported) function names for quick lookup.
    const importedNames = new Set(
      module.imports.filter((i) => i.kind === "function").map((i) => i.name),
    );

    // Collect inlineable functions. Two passes: first the standard
    // size-threshold inliner, then (if `partialInliningIfs > 0`) the split
    // inliner picks up any function the normal inliner rejected.
    const inlineable = new Map<string, WasmFunction>();
    for (const fn of module.functions) {
      if (importedNames.has(fn.name)) continue;
      // Synthetic outlined-* functions skip both classifiers — they would
      // either get inlined right back into the shells we just produced
      // (defeating the split) or thrash the iteration counter.
      if (fn.name.startsWith("byn-split-outlined-")) continue;
      const fi = info.get(fn.name);
      if (fi && isInlineable(fi, opts)) {
        inlineable.set(fn.name, fn);
      }
    }

    if (this._splitter) {
      for (const fn of module.functions) {
        if (importedNames.has(fn.name)) continue;
        if (inlineable.has(fn.name)) continue;
        if (fn.name.startsWith("byn-split-")) continue;
        const fi = info.get(fn.name);
        if (!fi) continue;
        const mode = this._splitter.getSplitMode(fn, fi);
        if (mode === "Uninlineable") continue;
        if (mode === "Full") {
          // Outlined chunk would itself be inlineable — skip the
          // intermediate and inline the whole original.
          inlineable.set(fn.name, fn);
          continue;
        }
        // SplitPatternA or SplitPatternB: use the inlineable shell as the
        // substitution template under the original function's name. Calls to
        // `fn` get rewritten to the shell body (which contains a call to the
        // outlined function the splitter just added to module.functions).
        inlineable.set(fn.name, this._splitter.getInlineableTemplate(fn, mode));
      }
    }

    if (inlineable.size === 0) return false;

    const labelHint = { value: 0 };
    const inlinedUses = new Map<string, number>();
    let anyInlined = false;

    for (const fn of module.functions) {
      if (importedNames.has(fn.name)) continue;
      // Don't inline into a function that was itself inlined elsewhere this
      // iteration (avoids unsafe mutation of a function being read as callee).
      if (inlinedUses.has(fn.name)) continue;

      const changed = inlineIntoFunction(fn, inlineable, opts, labelHint);
      if (!changed) continue;

      anyInlined = true;

      // Post-inline cleanup (InliningOptimizing only). Inlining drops the
      // callee body into a wrapper block plus zero-init local.sets for the
      // callee's locals; Vacuum collapses unnecessary block/nop shells and
      // OptimizeInstructions constant-folds any newly-revealed identities
      // (e.g. callee body that becomes `(i32.const 5)` after substitution).
      // Without this step, `InliningOptimizing` was indistinguishable from
      // plain `Inlining` — the `optimize` flag existed but was never read.
      if (this.optimize) {
        fn.body = mapExpression(fn.body, vacuumNode);
        fn.body = mapExpression(fn.body, optimizeNode);
      }

      // Mark each callee that was inlined — both so dead-callee removal can tell
      // when ALL of a callee's references were consumed, and so we skip inlining
      // INTO a function that was itself inlined this iteration. The wrapper label
      // is `__inlined_func$<callee.name>` with an optional `$<hint>` suffix. The
      // old `name.split("$")[1]` mis-recovered the callee: `callee.name` itself
      // starts with `$` (e.g. `$func5`), so `split("$")` was
      // `["__inlined_func", "", "func5"]` and `[1]` was the empty string — so
      // nothing was ever counted and fully-inlined functions were never removed.
      // Recover the callee by matching the known inlineable names (which may
      // themselves contain `$`, e.g. the `byn-split-*` helpers), preferring the
      // longest match to disambiguate a name that is a prefix of another.
      const bodyBefore = fn.body;
      walkExpression(bodyBefore, (e) => {
        if (e.kind === ExpressionKind.Block && e.name?.startsWith("__inlined_func$")) {
          const rest = e.name.slice("__inlined_func$".length);
          let calleeName: string | undefined;
          for (const name of inlineable.keys()) {
            if (rest === name || rest.startsWith(name + "$")) {
              if (calleeName === undefined || name.length > calleeName.length) {
                calleeName = name;
              }
            }
          }
          if (calleeName !== undefined) {
            inlinedUses.set(calleeName, (inlinedUses.get(calleeName) ?? 0) + 1);
          }
        }
      });
    }

    if (!anyInlined) return false;

    // Remove functions that are now fully inlined away (all refs consumed,
    // not exported or referenced from tables).
    module.functions = module.functions.filter((fn) => {
      const fi = info.get(fn.name);
      if (!fi) return true;
      if (fi.usedGlobally) return true;
      const used = inlinedUses.get(fn.name) ?? 0;
      // Keep if not all call-site references were inlined.
      return used < fi.refs;
    });

    return true;
  }
}

/**
 * Inlining pass with post-inline optimization.
 *
 * After each inlining iteration runs Vacuum and OptimizeInstructions on
 * every modified function to clean up the inlined code.
 */
export class InliningOptimizingPass extends InliningPass {
  override readonly name: string = "InliningOptimizing";
  override readonly description: string =
    "Inlines small direct-call targets and optimizes the resulting code.";
  protected override readonly optimize: boolean = true;
}

registerPass(InliningPass);
registerPass(InliningOptimizingPass);

// ---------------------------------------------------------------------------
// Exported helpers (used by tests)
// ---------------------------------------------------------------------------

export { deepCopy, measureSize };

/** Counts instruction nodes in an expression tree. */
function measureSize(expr: Expression): number {
  let n = 0;
  walkExpression(expr, () => n++);
  return n;
}
