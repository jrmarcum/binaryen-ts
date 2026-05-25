/**
 * @module binaryen-ts/passes/pass
 *
 * Pass infrastructure for the binaryen-ts optimizer.
 *
 * Optimization passes implement the {@link Pass} interface and are registered
 * with the {@link PassRunner} which schedules and applies them to a
 * {@link WasmModule}. This mirrors the pass infrastructure in the upstream
 * Binaryen C++ library (`src/pass.h`).
 *
 * **Hybrid note**: Individual passes may be implemented as:
 * - Pure TypeScript (run directly in Deno)
 * - TypeScript compiled to WASM via `wasic` (performance-critical paths)
 * - Delegated to the upstream `binaryen.js` WASM binary
 *
 * @example
 * ```ts
 * import { PassRunner } from "@jrmarcum/binaryen-ts/passes";
 *
 * const runner = new PassRunner(module);
 * runner.add("DCE").add("InliningOptimizing").run();
 * ```
 *
 * @license MIT
 */

import { WasmModule } from "../ir/module.ts";

// ---------------------------------------------------------------------------
// Pass interface
// ---------------------------------------------------------------------------

/**
 * A single optimization pass that transforms a {@link WasmModule} in place.
 *
 * Each pass focuses on one transformation concern (dead code elimination,
 * inlining, constant folding, etc.). Passes may be chained and the order
 * matters — see {@link PassRunner} for scheduling.
 */
export interface Pass {
  /** Unique identifier for this pass (used for registration and `--print-all-passes`). */
  readonly name: string;

  /** Human-readable description shown in help output. */
  readonly description: string;

  /**
   * Whether this pass requires the non-nullable local fixup pass to run after it.
   * Mirrors `requiresNonNullableLocalFixups()` in Binaryen's `pass.h`.
   */
  readonly requiresNonNullableLocalFixups: boolean;

  /**
   * Apply the pass to the module.
   * Must not retain references into `module` after returning (tree ownership rules).
   *
   * @param module - The module to transform (modified in place).
   * @param options - Runner-level options (optimization level, etc.).
   */
  run(module: WasmModule, options: PassOptions): void;
}

// ---------------------------------------------------------------------------
// Pass options
// ---------------------------------------------------------------------------

/**
 * Options forwarded to every pass during a runner cycle.
 * Mirrors `PassOptions` in `src/pass.h`.
 */
export interface PassOptions {
  /**
   * Optimization level (0 = none, 1 = `-O1`, 2 = `-O2`, 3 = `-O3`, 4 = `-O4`).
   * Higher levels may enable more aggressive transformations.
   */
  optimizeLevel: 0 | 1 | 2 | 3 | 4;

  /**
   * Code-size shrink level (0 = none, 1 = `-Os`, 2 = `-Oz`).
   * Enables size-reducing passes at the cost of some speed.
   */
  shrinkLevel: 0 | 1 | 2;

  /**
   * Whether to preserve debug names in the output.
   * When `false`, passes may strip or rename local/function names.
   */
  debugInfo: boolean;

  /**
   * Whether to generate closed world assumptions.
   * When `true`, passes may assume all callers of internal functions are visible.
   */
  closedWorld: boolean;

  /**
   * Per-pass arguments forwarded from `--pass-arg` CLI flags.
   * Keys follow the upstream convention `passname@argname`; values are strings.
   * Passes look up their own arguments by key at runtime.
   */
  passArgs: Record<string, string>;
}

/** Default pass options matching Binaryen's `-O2` preset. */
export const defaultPassOptions: PassOptions = {
  optimizeLevel: 2,
  shrinkLevel: 0,
  debugInfo: false,
  closedWorld: false,
  passArgs: {},
};

/** Pass options for size-optimized `-Oz` output (used by `wasic`). */
export const shrinkPassOptions: PassOptions = {
  optimizeLevel: 2,
  shrinkLevel: 2,
  debugInfo: false,
  closedWorld: false,
  passArgs: {},
};

// ---------------------------------------------------------------------------
// Pass registry
// ---------------------------------------------------------------------------

type PassCtor = new () => Pass;
const registry = new Map<string, PassCtor>();

/**
 * Registers a pass class under its `name`.
 * Throws if a pass with the same name is already registered.
 *
 * @param ctor - The pass constructor. The class must have a `name` property.
 */
export function registerPass(ctor: PassCtor): void {
  const instance = new ctor();
  if (registry.has(instance.name)) {
    throw new Error(`Pass "${instance.name}" is already registered`);
  }
  registry.set(instance.name, ctor);
}

/**
 * Returns the list of all registered pass names.
 * Equivalent to Binaryen's `--print-all-passes` output.
 */
export function listPasses(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Creates a pass instance by name.
 * Throws if the name is unknown.
 */
export function createPass(name: string): Pass {
  const ctor = registry.get(name);
  if (!ctor) {
    throw new Error(
      `Unknown pass: "${name}". Run listPasses() to see registered passes.`,
    );
  }
  return new ctor();
}

// ---------------------------------------------------------------------------
// PassRunner
// ---------------------------------------------------------------------------

/**
 * Schedules and applies a sequence of passes to a module.
 *
 * Passes are applied in the order they are added.
 * After each pass, if {@link Pass.requiresNonNullableLocalFixups} is `true`,
 * the non-nullable local fixup pass is automatically inserted.
 *
 * @example
 * ```ts
 * const runner = new PassRunner(module, { optimizeLevel: 3, shrinkLevel: 0 });
 * runner.addDefaultOptimizationPasses();
 * runner.run();
 * ```
 */
export class PassRunner {
  private readonly _module: WasmModule;
  private readonly _options: PassOptions;
  private readonly _queue: Pass[] = [];

  /**
   * @param module - The module to optimize.
   * @param options - Runner options (defaults to {@link defaultPassOptions}).
   */
  constructor(module: WasmModule, options: Partial<PassOptions> = {}) {
    this._module = module;
    this._options = { ...defaultPassOptions, ...options };
  }

  /**
   * Enqueues a pass by name.
   *
   * @param name - The registered pass name.
   * @returns `this` for chaining.
   */
  add(name: string): this {
    this._queue.push(createPass(name));
    return this;
  }

  /**
   * Enqueues a pass instance directly (useful for unregistered or custom passes).
   *
   * @returns `this` for chaining.
   */
  addPass(pass: Pass): this {
    this._queue.push(pass);
    return this;
  }

  /**
   * Adds the standard optimization passes for the configured {@link PassOptions.optimizeLevel}.
   * Mirrors `PassRunner::addDefaultOptimizationPasses` in Binaryen.
   *
   * @returns `this` for chaining.
   */
  addDefaultOptimizationPasses(): this {
    const passes = getDefaultOptimizationPasses(this._options);
    for (const name of passes) {
      this._queue.push(createPass(name));
    }
    return this;
  }

  /**
   * Runs all enqueued passes in order, then clears the queue.
   */
  run(): void {
    for (const pass of this._queue) {
      pass.run(this._module, this._options);
    }
    this._queue.length = 0;
  }

  /** The current pass queue (read-only). */
  get queue(): readonly Pass[] {
    return this._queue;
  }
}

// ---------------------------------------------------------------------------
// Default pass sequences
// ---------------------------------------------------------------------------

/**
 * Returns the ordered list of pass names for the standard optimization pipeline.
 * Mirrors Binaryen's default optimization pass selection logic.
 *
 * @internal
 */
function getDefaultOptimizationPasses(opts: PassOptions): string[] {
  const passes: string[] = [];

  if (opts.optimizeLevel >= 1) {
    passes.push("DCE", "PickLoadSigns", "Vacuum");
  }
  if (opts.optimizeLevel >= 2) {
    passes.push(
      "RemoveUnusedBrs",
      "RemoveUnusedNames",
      "OptimizeInstructions",
      "CoalesceLocals",
      "SimplifyLocals",
      "LocalCSE",
    );
  }
  if (opts.optimizeLevel >= 3) {
    passes.push("Inlining", "OptimizeInstructions", "CoalesceLocals");
  }
  if (opts.shrinkLevel >= 1) {
    passes.push("Vacuum", "RemoveUnusedModuleElements");
  }

  return passes;
}
