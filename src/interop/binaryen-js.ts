/**
 * @module binaryen-ts/interop
 *
 * Interoperability bridge to the upstream `binaryen.js` WASM binary.
 *
 * This module provides a thin TypeScript wrapper around the `binaryen.js`
 * Emscripten-compiled WASM library from the upstream Binaryen project.
 * It is used in **hybrid mode** to delegate complex optimization passes
 * (e.g. Binaryen's full `-Oz` pipeline) to the battle-tested C++ implementation
 * while the rest of the toolchain runs as native TypeScript.
 *
 * **Hybrid mode architecture:**
 * ```
 * TypeScript IR  ──serialize──▶  WAT text  ──parse──▶  binaryen.js
 *                                                            │
 *                                                      optimize (C++)
 *                                                            │
 * TypeScript IR  ◀──deserialize──  WAT text  ◀──print──  binaryen.js
 * ```
 *
 * @example
 * ```ts
 * import { BinaryenInterop } from "@jrmarcum/binaryen-ts/interop";
 * import { ModuleBuilder, ValType } from "@jrmarcum/binaryen-ts/ir";
 *
 * const mod = new ModuleBuilder()
 *   .addFunction("add", [ValType.I32, ValType.I32], [ValType.I32], body)
 *   .build();
 *
 * const interop = await BinaryenInterop.create();
 * const optimized = await interop.optimizeWat(watText, "-Oz");
 * ```
 *
 * @license Apache-2.0
 */

// ---------------------------------------------------------------------------
// Binaryen.js type stubs
// These describe the subset of the binaryen.js API used for interop.
// The full API is documented at https://github.com/WebAssembly/binaryen#binaryenjs
// ---------------------------------------------------------------------------

/**
 * Minimal type declaration for the binaryen.js module factory.
 * The full binaryen.js type definitions can be installed from the `binaryen`
 * npm package (`npm:binaryen` in a Deno import map).
 *
 * @internal
 */
export interface BinaryenModule {
  /** Parse WAT text into a module. Returns 0 on failure. */
  parseText(wat: string): number;
  /** Serialize a module reference to WAT text. */
  emitText(moduleRef: number): string;
  /** Serialize a module reference to binary WASM. */
  emitBinary(moduleRef: number): Uint8Array;
  /** Run optimization passes on a module reference. */
  runPasses(moduleRef: number, passes: string[]): void;
  /** Set optimization level (0-4). */
  setOptimizeLevel(level: number): void;
  /** Set shrink level (0-2). */
  setShrinkLevel(level: number): void;
  /** Free a module reference. */
  disposeModule(moduleRef: number): void;
}

/** Options for the {@link BinaryenInterop} bridge. */
export interface BinaryenInteropOptions {
  /**
   * Path or URL to the `binaryen.js` file.
   * Defaults to the version bundled with the upstream submodule.
   */
  binaryenJsPath?: string;
}

/**
 * Bridge to the upstream `binaryen.js` WASM binary for hybrid mode.
 *
 * Use {@link BinaryenInterop.create} to instantiate. The bridge is stateless
 * after creation — optimization calls are independent and thread-safe.
 */
export class BinaryenInterop {
  private readonly _binaryen: BinaryenModule;

  private constructor(binaryen: BinaryenModule) {
    this._binaryen = binaryen;
  }

  /**
   * Loads and initializes the `binaryen.js` module.
   *
   * @param options - Optional configuration.
   * @throws If the `binaryen.js` binary cannot be loaded.
   */
  static async create(_options: BinaryenInteropOptions = {}): Promise<BinaryenInterop> {
    // TODO(phase 1): dynamically import binaryen.js from the upstream submodule
    // or from npm:binaryen. For now this is a placeholder that throws a
    // helpful error so callers know the feature is not yet implemented.
    throw new Error(
      "BinaryenInterop.create() is not yet implemented.\n" +
        "Track progress in: https://github.com/jrmarcum/binaryen-ts/issues\n\n" +
        "Workaround: use the upstream binaryen.js directly via `npm:binaryen`\n" +
        "or run wasm-opt as a subprocess via BinaryenInterop.optimizeViaSubprocess().",
    );
  }

  /**
   * Optimizes WAT text using the upstream `binaryen.js` WASM binary.
   *
   * @param wat - Input WAT text.
   * @param flags - Optimization flags (e.g. `"-Oz"`, `"-O3"`).
   * @returns Optimized WAT text.
   */
  optimizeWat(wat: string, _flags = "-Oz"): string {
    const ref = this._binaryen.parseText(wat);
    if (ref === 0) throw new Error("binaryen.js: failed to parse WAT");
    try {
      this._binaryen.runPasses(ref, ["Vacuum", "DCE", "OptimizeInstructions"]);
      return this._binaryen.emitText(ref);
    } finally {
      this._binaryen.disposeModule(ref);
    }
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
    const encoder = new TextEncoder();
    const cmd = new Deno.Command("wasm-opt", {
      args: [...flags, "--output=-", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const proc = cmd.spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(encoder.encode(wat));
    await writer.close();

    const { code, stdout, stderr } = await proc.output();
    if (code !== 0) {
      const errText = new TextDecoder().decode(stderr);
      throw new Error(`wasm-opt failed (exit ${code}):\n${errText}`);
    }
    return stdout;
  }
}
