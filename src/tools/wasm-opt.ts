/**
 * @module binaryen-ts/tools/wasm-opt
 *
 * TypeScript implementation of the `wasm-opt` optimization tool.
 *
 * `wasm-opt` is the primary CLI tool produced by the upstream Binaryen project.
 * It reads a `.wasm` or `.wat` file, applies optimization passes, and writes
 * an optimized `.wasm` binary.
 *
 * This module provides a TypeScript-native implementation that delegates to
 * either the built-in TypeScript pass infrastructure or the upstream
 * `binaryen.js` WASM binary (hybrid mode), depending on the configuration.
 *
 * **CLI usage** (via `deno run` or `wasmtk`):
 * ```sh
 * deno run --allow-read --allow-write --allow-run main.ts wasm-opt input.wasm -o output.wasm -Oz
 * ```
 *
 * @license MIT OR Apache-2.0
 */

import { BinaryenInterop } from "../interop/binaryen-js.ts";
import { defaultPassOptions, PassRunner, shrinkPassOptions } from "../passes/index.ts";
import { PassOptions } from "../passes/pass.ts";
import { ModuleBuilder } from "../ir/module.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link wasmOpt}.
 * Mirrors the CLI flags accepted by the upstream `wasm-opt` binary.
 */
export interface WasmOptOptions {
  /** Output file path. Use `"-"` for stdout. Default: `"output.wasm"`. */
  output: string;
  /** Optimization level (0-4). Sets the opt / shrink level presets. */
  optimizeLevel: 0 | 1 | 2 | 3 | 4;
  /** Shrink level (0-2). */
  shrinkLevel: 0 | 1 | 2;
  /**
   * Whether to emit WAT text instead of binary WASM.
   * Equivalent to `--emit-text` / `-S`.
   */
  emitText: boolean;
  /**
   * Whether to validate the module after optimization.
   * Equivalent to `--validate`.
   */
  validate: boolean;
  /**
   * Specific passes to run (overrides the default pass sequence).
   * Equivalent to listing pass names on the `wasm-opt` command line.
   */
  passes: string[];
  /**
   * Hybrid mode: when `true`, delegate to the upstream `binaryen.js` binary
   * via {@link BinaryenInterop} rather than the TypeScript pass infrastructure.
   * Default: `false` (use TypeScript passes).
   */
  hybridMode: boolean;
  /** Whether to preserve debug names in the output. Default: `false`. */
  debugInfo: boolean;
  /** Whether to enable closed-world optimizations. Default: `false`. */
  closedWorld: boolean;
}

const defaults: WasmOptOptions = {
  output: "output.wasm",
  optimizeLevel: 0,
  shrinkLevel: 0,
  emitText: false,
  validate: true,
  passes: [],
  hybridMode: false,
  debugInfo: false,
  closedWorld: false,
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Runs `wasm-opt` on the given input file.
 *
 * When `hybridMode` is `false` (default), the TypeScript pass infrastructure
 * is used. When `true`, the upstream `binaryen.js` binary is invoked.
 *
 * @param inputPath - Path to the input `.wasm` or `.wat` file.
 * @param options - Optimization options.
 * @returns The optimized WASM binary (or WAT text when `emitText` is true).
 */
export async function wasmOpt(
  inputPath: string,
  options: Partial<WasmOptOptions> = {},
): Promise<Uint8Array | string> {
  const opts: WasmOptOptions = { ...defaults, ...options };

  const inputBytes = await Deno.readFile(inputPath);
  const isWat = inputPath.endsWith(".wat");

  if (opts.hybridMode) {
    return await _hybridOptimize(inputBytes, isWat, opts);
  }
  return await _nativeOptimize(inputBytes, isWat, opts);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parses `Deno.args` and runs `wasm-opt`.
 * Called when this module is executed directly as a CLI script.
 *
 * @example
 * ```sh
 * deno run --allow-all tools/wasm-opt.ts input.wasm -o out.wasm -Oz
 * ```
 */
export async function main(args: string[] = Deno.args): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed.input) {
    console.error("Usage: wasm-opt <input.wasm> [options]");
    console.error("  -o <file>      Output file (default: output.wasm)");
    console.error("  -O0 .. -O4     Optimization level");
    console.error("  -Os, -Oz       Size optimization (shrink level 1, 2)");
    console.error("  -S             Emit WAT text instead of binary");
    console.error("  --hybrid       Use upstream binaryen.js for optimization");
    Deno.exit(1);
  }

  const result = await wasmOpt(parsed.input, parsed.options);
  const outPath = parsed.options.output ?? "output.wasm";

  if (typeof result === "string") {
    if (outPath === "-") {
      console.log(result);
    } else {
      await Deno.writeTextFile(outPath, result);
      console.log(`Wrote WAT: ${outPath}`);
    }
  } else {
    if (outPath === "-") {
      await Deno.stdout.write(result);
    } else {
      await Deno.writeFile(outPath, result);
      console.log(`Wrote WASM: ${outPath} (${result.byteLength} bytes)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: native TypeScript optimization
// ---------------------------------------------------------------------------

async function _nativeOptimize(
  inputBytes: Uint8Array,
  isWat: boolean,
  opts: WasmOptOptions,
): Promise<Uint8Array | string> {
  // TODO(phase 2): implement WAT/WASM parser to load the module into the IR.
  // For now, fall through to subprocess mode and log a warning.
  console.warn(
    "[wasm-opt] Native TypeScript IR optimization is not yet implemented.\n" +
      "Falling back to wasm-opt subprocess. Use --hybrid for binaryen.js mode.",
  );
  const wat = isWat
    ? new TextDecoder().decode(inputBytes)
    : await _disassembleViaSubprocess(inputBytes);

  return BinaryenInterop.optimizeViaSubprocess(
    wat,
    buildSubprocessFlags(opts),
  );
}

// ---------------------------------------------------------------------------
// Internal: hybrid binaryen.js optimization
// ---------------------------------------------------------------------------

async function _hybridOptimize(
  inputBytes: Uint8Array,
  isWat: boolean,
  opts: WasmOptOptions,
): Promise<Uint8Array | string> {
  const wat = isWat
    ? new TextDecoder().decode(inputBytes)
    : await _disassembleViaSubprocess(inputBytes);

  return BinaryenInterop.optimizeViaSubprocess(wat, buildSubprocessFlags(opts));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSubprocessFlags(opts: WasmOptOptions): string[] {
  const flags: string[] = [];
  if (opts.optimizeLevel > 0) flags.push(`-O${opts.optimizeLevel}`);
  if (opts.shrinkLevel === 1) flags.push("-Os");
  if (opts.shrinkLevel === 2) flags.push("-Oz");
  if (opts.debugInfo) flags.push("-g");
  if (opts.closedWorld) flags.push("--closed-world");
  for (const p of opts.passes) flags.push(`--${p}`);
  if (opts.emitText) flags.push("-S");
  return flags;
}

async function _disassembleViaSubprocess(wasm: Uint8Array): Promise<string> {
  const cmd = new Deno.Command("wasm-opt", {
    args: ["--emit-text", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(wasm);
  await writer.close();
  const { code, stdout, stderr } = await proc.output();
  if (code !== 0) {
    throw new Error(
      `wasm-opt disassemble failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

interface ParsedArgs {
  input: string | null;
  options: Partial<WasmOptOptions>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { input: null, options: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--output") {
      result.options.output = args[++i];
    } else if (a === "-O0") {
      result.options.optimizeLevel = 0;
    } else if (a === "-O1") {
      result.options.optimizeLevel = 1;
    } else if (a === "-O2") {
      result.options.optimizeLevel = 2;
    } else if (a === "-O3") {
      result.options.optimizeLevel = 3;
    } else if (a === "-O4") {
      result.options.optimizeLevel = 4;
    } else if (a === "-Os") {
      result.options.optimizeLevel = 2;
      result.options.shrinkLevel = 1;
    } else if (a === "-Oz") {
      result.options.optimizeLevel = 2;
      result.options.shrinkLevel = 2;
    } else if (a === "-S" || a === "--emit-text") {
      result.options.emitText = true;
    } else if (a === "-g" || a === "--debug-info") {
      result.options.debugInfo = true;
    } else if (a === "--hybrid") {
      result.options.hybridMode = true;
    } else if (!a.startsWith("-")) {
      result.input = a;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Convenience re-exports from pass layer (avoids separate imports for callers)
// ---------------------------------------------------------------------------

export { PassRunner, defaultPassOptions, shrinkPassOptions };
export type { PassOptions };

// Allow `ignore unused` for ModuleBuilder re-export (used in JSDoc examples)
export { ModuleBuilder };

// ---------------------------------------------------------------------------
// Run as CLI if executed directly
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await main();
}
