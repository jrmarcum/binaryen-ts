/**
 * @module binaryen-ts/interop
 *
 * Interoperability bridge to the upstream `binaryen.js` WASM binary
 * (the Emscripten-compiled build of the upstream C++ Binaryen library).
 *
 * This module provides a thin TypeScript wrapper used in **hybrid mode** to
 * delegate optimization passes to the upstream C++ implementation while the
 * rest of the toolchain runs as native TypeScript.
 *
 * Two tiers of hybrid execution are available:
 *
 * **Tier 2 — subprocess**: invokes a `wasm-opt` binary on `PATH`. Use
 * {@link BinaryenInterop.optimizeViaSubprocess} — it does not require loading
 * binaryen.js itself, just the `wasm-opt` CLI. Works whenever the upstream
 * binary is installed.
 *
 * **Tier 3 — in-process binaryen.js**: dynamically loads the upstream
 * `binaryen.js` Emscripten build and calls its API in-process. Use
 * {@link BinaryenInterop.create} + {@link BinaryenInterop.optimizeWat}. No
 * subprocess required, suitable for browser environments that have loaded
 * binaryen.js.
 *
 * @example Subprocess (tier 2)
 * ```ts
 * import { BinaryenInterop } from "@jrmarcum/binaryen-ts/interop";
 * const optimized = await BinaryenInterop.optimizeViaSubprocess(watText, ["-Oz"]);
 * ```
 *
 * @example In-process (tier 3)
 * ```ts
 * import { BinaryenInterop } from "@jrmarcum/binaryen-ts/interop";
 *
 * // Deno auto-resolves npm: specifiers.
 * const interop = await BinaryenInterop.create({ binaryenJsPath: "npm:binaryen" });
 * const optimizedWat = interop.optimizeWat(watText, { optimizeLevel: 2, shrinkLevel: 2 });
 * ```
 *
 * ## Runtime requirements
 *
 * - Subprocess (`optimizeViaSubprocess`) uses `node:child_process` — Deno 1.40+,
 *   Node 18+, or Bun. Not available in the browser.
 * - In-process (`create`) is browser-safe **as long as** the caller supplies a
 *   binaryen.js module that resolves under the target runtime (e.g. via an
 *   ESM CDN URL or pre-loaded instance).
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Binaryen.js type stubs
// These describe the subset of the binaryen.js API used for interop.
// Reference: upstream/src/js/binaryen.js-post.js — the Module namespace
// (factory) and the object returned by Module['parseText'] / wrapModule.
// ---------------------------------------------------------------------------

/**
 * The wrapped Module object returned by binaryen.js's `parseText` / `readBinary`.
 * Methods invoke the underlying C++ Binaryen `_BinaryenModule*` functions.
 */
export interface BinaryenWrappedModule {
  /** Serialize this module to WAT text. */
  emitText(): string;
  /** Serialize this module to a binary `.wasm` byte sequence. */
  emitBinary(sourceMapUrl?: string): Uint8Array;
  /** Run the default optimization pipeline (uses module-level shrink/optimize levels). */
  optimize(): void;
  /** Run the named passes in order. */
  runPasses(passes: string[]): void;
  /** Validate this module. Returns truthy on success. */
  validate(): number;
  /** Release native resources held by this module. */
  dispose(): void;
}

/**
 * The binaryen.js factory/namespace — the object returned by `require("binaryen")`
 * or `import * as binaryen from "binaryen"`. Holds the parse entry points and the
 * module-level shrink/optimize settings the C++ pipeline reads when `optimize()`
 * runs.
 */
export interface BinaryenJsLib {
  /** Parse WAT text into a wrapped module. Throws/returns 0 on failure. */
  parseText(text: string): BinaryenWrappedModule;
  /** Parse a `.wasm` byte sequence into a wrapped module. */
  readBinary(data: Uint8Array): BinaryenWrappedModule;
  /** Set the optimization level the next `optimize()` call will use (0–4). */
  setOptimizeLevel(level: number): void;
  /** Set the shrink level the next `optimize()` call will use (0–2). */
  setShrinkLevel(level: number): void;
  /** Get the current optimization level. */
  getOptimizeLevel?(): number;
  /** Get the current shrink level. */
  getShrinkLevel?(): number;
}

/** Options for {@link BinaryenInterop.create}. */
export interface BinaryenInteropOptions {
  /**
   * Module specifier or URL passed directly to dynamic `import()`. The default,
   * `"npm:binaryen"`, works under Deno and Bun without setup; under Node it
   * requires `npm install binaryen` first.
   *
   * Other examples:
   * - `"npm:binaryen"` — Deno / Bun
   * - `"binaryen"` — Node (after `npm install binaryen`)
   * - `"https://esm.sh/binaryen"` — browser / Deno via ESM CDN
   * - `"./vendor/binaryen.js"` — file path
   */
  binaryenJsPath?: string;
  /**
   * An already-loaded binaryen.js factory. Takes precedence over
   * `binaryenJsPath` if both are provided. Useful for tests and for runtimes
   * where the caller has its own loading strategy.
   */
  binaryen?: BinaryenJsLib;
}

/** Options for {@link BinaryenInterop.optimizeWat} and {@link BinaryenInterop.optimizeBinary}. */
export interface OptimizeOptions {
  /** Optimization level (0–4). Default: 2. */
  optimizeLevel?: number;
  /** Shrink level (0–2). Default: 0. */
  shrinkLevel?: number;
  /**
   * Optional explicit pass list. When provided, the named passes run in order
   * INSTEAD of the default pipeline driven by `optimizeLevel` / `shrinkLevel`.
   */
  passes?: string[];
}

/**
 * Bridge to the upstream `binaryen.js` WASM binary for hybrid mode.
 *
 * Use {@link BinaryenInterop.create} to instantiate.
 */
export class BinaryenInterop {
  private readonly _binaryen: BinaryenJsLib;

  private constructor(binaryen: BinaryenJsLib) {
    this._binaryen = binaryen;
  }

  /**
   * Loads and initializes a `binaryen.js` instance.
   *
   * @param options - Either `binaryen` (pre-loaded) or `binaryenJsPath` (module
   *                  specifier). Defaults to `binaryenJsPath: "npm:binaryen"`.
   * @throws If the binaryen.js module cannot be loaded or does not match the
   *         expected API shape.
   */
  static async create(options: BinaryenInteropOptions = {}): Promise<BinaryenInterop> {
    if (options.binaryen) {
      _validateBinaryenLib(options.binaryen, "<options.binaryen>");
      return new BinaryenInterop(options.binaryen);
    }
    const path = options.binaryenJsPath ?? "npm:binaryen";
    let mod: unknown;
    try {
      mod = await import(path);
    } catch (err) {
      throw new Error(
        `BinaryenInterop.create: failed to import binaryen.js from "${path}".\n` +
          `Underlying error: ${(err as Error).message}\n\n` +
          `Hint: install via "npm install binaryen" (Node) or use a path/URL that\n` +
          `resolves under your runtime. To supply an already-loaded instance, pass\n` +
          `{ binaryen: <loaded binaryen module> } instead of binaryenJsPath.`,
      );
    }
    // ESM modules expose the binaryen namespace as `default`; CJS modules
    // (Node `require("binaryen")`) expose it directly.
    const binaryen = (mod as { default?: BinaryenJsLib }).default ?? (mod as BinaryenJsLib);
    _validateBinaryenLib(binaryen, path);
    return new BinaryenInterop(binaryen);
  }

  /**
   * Optimize a WAT text snippet and return optimized WAT.
   *
   * @param wat - Input WAT text.
   * @param options - Optimization settings; defaults to `{ optimizeLevel: 2 }`.
   *                  String shorthand `"-Oz"`, `"-O3"` etc. is also accepted.
   * @returns Optimized WAT text.
   */
  optimizeWat(wat: string, options: OptimizeOptions | string = {}): string {
    const opts = typeof options === "string" ? _parseFlagShorthand(options) : options;
    const ref = this._binaryen.parseText(wat);
    if (!ref) throw new Error("binaryen.js: parseText failed");
    try {
      this._runOptimization(ref, opts);
      return ref.emitText();
    } finally {
      ref.dispose();
    }
  }

  /**
   * Optimize a `.wasm` binary and return the optimized binary.
   *
   * @param bytes - Input `.wasm` bytes.
   * @param options - Optimization settings; defaults to `{ optimizeLevel: 2 }`.
   * @returns Optimized `.wasm` bytes.
   */
  optimizeBinary(bytes: Uint8Array, options: OptimizeOptions | string = {}): Uint8Array {
    const opts = typeof options === "string" ? _parseFlagShorthand(options) : options;
    const ref = this._binaryen.readBinary(bytes);
    if (!ref) throw new Error("binaryen.js: readBinary failed");
    try {
      this._runOptimization(ref, opts);
      return ref.emitBinary();
    } finally {
      ref.dispose();
    }
  }

  /** Returns the underlying binaryen.js factory. Escape hatch for advanced uses. */
  get binaryen(): BinaryenJsLib {
    return this._binaryen;
  }

  private _runOptimization(ref: BinaryenWrappedModule, opts: OptimizeOptions): void {
    if (opts.passes && opts.passes.length > 0) {
      ref.runPasses(opts.passes);
      return;
    }
    this._binaryen.setOptimizeLevel(opts.optimizeLevel ?? 2);
    this._binaryen.setShrinkLevel(opts.shrinkLevel ?? 0);
    ref.optimize();
  }

  /**
   * Optimizes WAT text by running `wasm-opt` as a subprocess.
   *
   * This does not require loading `binaryen.js` and works whenever the
   * `wasm-opt` binary is on `PATH` (e.g. installed via the upstream build).
   *
   * @param wat - Input WAT text.
   * @param flags - `wasm-opt` flags (default: `["-Oz"]`).
   * @returns Optimized WASM binary bytes.
   */
  static async optimizeViaSubprocess(
    wat: string,
    flags: string[] = ["-Oz"],
  ): Promise<Uint8Array> {
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      const proc = spawn("wasm-opt", [...flags, "--output=-", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      proc.stdout.on("data", (c: Uint8Array) => stdoutChunks.push(c));
      proc.stderr.on("data", (c: Uint8Array) => stderrChunks.push(c));
      proc.on("error", reject);
      proc.on("close", (code: number | null) => {
        if (code !== 0) {
          reject(
            new Error(
              `wasm-opt failed (exit ${code}):\n` +
                new TextDecoder().decode(_concatU8(stderrChunks)),
            ),
          );
        } else {
          resolve(_concatU8(stdoutChunks));
        }
      });
      proc.stdin.end(new TextEncoder().encode(wat));
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _validateBinaryenLib(bin: unknown, source: string): asserts bin is BinaryenJsLib {
  const b = bin as Partial<BinaryenJsLib>;
  if (
    !b ||
    typeof b.parseText !== "function" ||
    typeof b.readBinary !== "function" ||
    typeof b.setOptimizeLevel !== "function" ||
    typeof b.setShrinkLevel !== "function"
  ) {
    throw new Error(
      `BinaryenInterop: module loaded from "${source}" does not match the ` +
        `binaryen.js API (missing parseText / readBinary / setOptimizeLevel / setShrinkLevel).`,
    );
  }
}

/**
 * Translate `-O0`/`-O1`/`-O2`/`-O3`/`-O4`/`-Os`/`-Oz` to the
 * (optimizeLevel, shrinkLevel) pair upstream uses. Matches the mapping in
 * `wasm-opt`'s argument parser.
 */
function _parseFlagShorthand(flag: string): OptimizeOptions {
  switch (flag) {
    case "-O0":
      return { optimizeLevel: 0, shrinkLevel: 0 };
    case "-O1":
      return { optimizeLevel: 1, shrinkLevel: 0 };
    case "-O2":
      return { optimizeLevel: 2, shrinkLevel: 0 };
    case "-O3":
      return { optimizeLevel: 3, shrinkLevel: 0 };
    case "-O4":
      return { optimizeLevel: 4, shrinkLevel: 0 };
    case "-Os":
      return { optimizeLevel: 2, shrinkLevel: 1 };
    case "-Oz":
      return { optimizeLevel: 2, shrinkLevel: 2 };
    default:
      throw new Error(`Unknown optimization shorthand: "${flag}"`);
  }
}

function _concatU8(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
