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
  type LocalSetExpr,
  makeBlock,
  makeF32Const,
  makeF64Const,
  makeI32Const,
  makeI64Const,
  makeLocalSet,
  makeUnreachable,
} from "../ir/expressions.ts";
import type { Local, WasmFunction, WasmModule } from "../ir/module.ts";
import { None, Unreachable, ValType } from "../ir/types.ts";
import { mapExpression, walkExpression } from "../ir/walk.ts";
import { type Pass, type PassOptions, registerPass } from "./pass.ts";

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
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Core substitution — remap locals and convert returns to breaks
// ---------------------------------------------------------------------------

/** Remaps local indices and replaces `return` with `br $returnLabel` in a
 * deep-copied callee body. */
function substituteBody(
  body: Expression,
  localMapping: number[],
  returnLabel: string,
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
        const br: BreakExpr = {
          kind: ExpressionKind.Break,
          type: e.value ? e.value.type : None,
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

  // Deep copy the callee body then substitute locals + returns.
  const bodyCopy = deepCopy(callee.body);
  const substituted = substituteBody(bodyCopy, mapping, label);
  children.push(substituted);

  // 4. Result type of the wrapper block.
  const retType = callee.results.length > 0 ? callee.results[0] : None;

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

  run(module: WasmModule, opts: PassOptions): void {
    const numOriginal = module.functions.length;
    const maxIter = Math.min(MAX_ITERATIONS, numOriginal + 1);

    for (let iter = 0; iter < maxIter; iter++) {
      if (!this._iteration(module, opts)) break;
    }
  }

  private _iteration(module: WasmModule, opts: PassOptions): boolean {
    const info = buildFunctionInfo(module);

    // Build a set of defined (non-imported) function names for quick lookup.
    const importedNames = new Set(
      module.imports.filter((i) => i.kind === "function").map((i) => i.name),
    );

    // Collect inlineable functions.
    const inlineable = new Map<string, WasmFunction>();
    for (const fn of module.functions) {
      if (importedNames.has(fn.name)) continue;
      const fi = info.get(fn.name);
      if (fi && isInlineable(fi, opts)) {
        inlineable.set(fn.name, fn);
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

      // Count how many uses of each callee were consumed.
      walkExpression(fn.body, (e) => {
        if (e.kind === ExpressionKind.Call) {
          const prev = inlinedUses.get(e.target) ?? 0;
          // We only increment for calls that are NOT inlineable (the inlined
          // ones have already been replaced). Check the inlineable set.
          if (!inlineable.has(e.target)) {
            inlinedUses.set(e.target, prev);
          }
        }
      });

      // Mark each callee that was inlined (so we skip inlining INTO them).
      const bodyBefore = fn.body;
      walkExpression(bodyBefore, (e) => {
        if (e.kind === ExpressionKind.Block && e.name?.startsWith("__inlined_func$")) {
          // Extract callee name from label.
          const parts = e.name.split("$");
          if (parts.length >= 2) {
            const calleeName = parts[1];
            const prev = inlinedUses.get(calleeName) ?? 0;
            inlinedUses.set(calleeName, prev + 1);
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
