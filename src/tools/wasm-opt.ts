/**
 * @module binaryen-ts/tools/wasm-opt
 *
 * TypeScript implementation of the `wasm-opt` optimization tool.
 *
 * `wasm-opt` is the primary CLI tool produced by the upstream Binaryen project.
 * It reads a `.wasm` binary (or `.wat` text), applies optimization passes, and
 * writes an optimized `.wasm` binary.
 *
 * **Native path** (default): `.wasm` → {@link parseWasm} → {@link PassRunner} →
 * {@link encodeWasm} → `.wasm`. Pure TypeScript; no subprocess required.
 *
 * **Hybrid path** (`--hybrid`): delegates to the upstream `wasm-opt` subprocess
 * for cases not yet covered by the TypeScript pass set.
 *
 * **CLI usage** (runs on Deno, Node 18+, and Bun):
 * ```sh
 * deno run -A jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o output.wasm -O2
 * node main.ts wasm-opt input.wasm -o output.wasm -O2
 * bun main.ts wasm-opt input.wasm -o output.wasm -O2
 * ```
 *
 * @license MIT OR Apache-2.0
 */

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseWasm } from "../binary/index.ts";
import { encodeWasm } from "../encoder/index.ts";
import { parseWat } from "../parser/wat-parser.ts";
import { BinaryenInterop } from "../interop/binaryen-js.ts";
import {
  defaultPassOptions,
  listPasses,
  PassRunner,
  shrinkPassOptions,
} from "../passes/index.ts";
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
   * Only supported in `--hybrid` mode; the native path encodes binary only.
   */
  emitText: boolean;
  /**
   * Whether to validate the module after optimization.
   * Equivalent to `--validate`.
   */
  validate: boolean;
  /**
   * Specific passes to run (overrides the default pass sequence for the level).
   * Equivalent to listing pass names on the `wasm-opt` command line.
   */
  passes: string[];
  /**
   * Hybrid mode: when `true`, delegate to the upstream `wasm-opt` subprocess
   * via {@link BinaryenInterop} rather than the TypeScript pass infrastructure.
   * Default: `false` (use TypeScript passes).
   */
  hybridMode: boolean;
  /** Whether to preserve debug names in the output. Default: `false`. */
  debugInfo: boolean;
  /** Whether to enable closed-world optimizations. Default: `false`. */
  closedWorld: boolean;
  /**
   * Per-pass tuning arguments, forwarded to {@link PassOptions.passArgs}.
   * Keys follow the upstream convention `passname@argname`; values are strings.
   * Example: `{ "inlining@maxSize": "20" }`.
   */
  passArgs: Record<string, string>;
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
  passArgs: {},
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Runs `wasm-opt` on the given input file.
 *
 * The default (native) path uses the TypeScript pass infrastructure:
 * parse → run passes → encode. Pass `hybridMode: true` to delegate to the
 * upstream `wasm-opt` subprocess instead.
 *
 * @param inputPath - Path to the input `.wasm` or `.wat` file.
 * @param options   - Optimization options.
 * @returns The optimized WASM binary, or WAT text when `emitText` is `true`
 *          (hybrid mode only).
 */
export async function wasmOpt(
  inputPath: string,
  options: Partial<WasmOptOptions> = {},
): Promise<Uint8Array | string> {
  const opts: WasmOptOptions = { ...defaults, ...options };

  const inputBytes = new Uint8Array(await readFile(inputPath));
  const isWat = inputPath.endsWith(".wat");

  if (opts.hybridMode) {
    return await _hybridOptimize(inputBytes, isWat, opts);
  }
  return _nativeOptimize(inputBytes, isWat, opts);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parses CLI args and runs `wasm-opt`.
 * Defaults to `process.argv.slice(2)` when invoked as a CLI script.
 *
 * Works on Deno, Node 18+, and Bun via `node:` standard-library imports.
 *
 * @example
 * ```sh
 * deno run -A jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -O2
 * node main.ts wasm-opt input.wasm -o out.wasm -O2
 * ```
 */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.printAllPasses) {
    for (const name of listPasses()) {
      console.log(name);
    }
    return;
  }

  if (!parsed.input) {
    console.error("Usage: wasm-opt <input.wasm> [options]");
    console.error("  -o <file>            Output file (default: output.wasm)");
    console.error("  -O0 .. -O4           Optimization level");
    console.error("  -Os, -Oz             Size optimization (shrink level 1, 2)");
    console.error("  -S                   Emit WAT text (hybrid mode only)");
    console.error("  --<pass-name>        Run a specific pass by name");
    console.error("  --pass-arg key=val   Per-pass argument (passname@key=val)");
    console.error("  --print-all-passes   List all registered passes and exit");
    console.error("  --hybrid             Use upstream wasm-opt subprocess");
    process.exit(1);
  }

  const result = await wasmOpt(parsed.input, parsed.options);
  const outPath = parsed.options.output ?? "output.wasm";

  if (typeof result === "string") {
    if (outPath === "-") {
      console.log(result);
    } else {
      await writeFile(outPath, result);
      console.log(`Wrote WAT: ${outPath}`);
    }
  } else {
    if (outPath === "-") {
      process.stdout.write(result);
    } else {
      await writeFile(outPath, result);
      console.log(`Wrote WASM: ${outPath} (${result.byteLength} bytes)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: native TypeScript optimization
// ---------------------------------------------------------------------------

function _nativeOptimize(
  inputBytes: Uint8Array,
  isWat: boolean,
  opts: WasmOptOptions,
): Uint8Array {
  if (opts.emitText) {
    throw new Error(
      "WAT text output (--emit-text / -S) requires wabt-ts wasm2wat. " +
        "Use --hybrid for subprocess-based WAT output.",
    );
  }

  const module = isWat
    ? parseWat(new TextDecoder().decode(inputBytes))
    : parseWasm(inputBytes);

  const passOpts: PassOptions = {
    optimizeLevel: opts.optimizeLevel,
    shrinkLevel: opts.shrinkLevel,
    debugInfo: opts.debugInfo,
    closedWorld: opts.closedWorld,
    passArgs: opts.passArgs,
  };

  const runner = new PassRunner(module, passOpts);

  if (opts.passes.length > 0) {
    for (const name of opts.passes) {
      runner.add(name);
    }
  } else if (opts.optimizeLevel > 0 || opts.shrinkLevel > 0) {
    runner.addDefaultOptimizationPasses();
  }

  runner.run();
  return encodeWasm(module);
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
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const proc = spawn("wasm-opt", ["--emit-text", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    proc.stdout.on("data", (c: Uint8Array) => stdoutChunks.push(c));
    proc.stderr.on("data", (c: Uint8Array) => stderrChunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code: number | null) => {
      const decoder = new TextDecoder();
      if (code !== 0) {
        reject(
          new Error(
            `wasm-opt disassemble failed: ${decoder.decode(_concatU8(stderrChunks))}`,
          ),
        );
      } else {
        resolve(decoder.decode(_concatU8(stdoutChunks)));
      }
    });
    proc.stdin.end(wasm);
  });
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

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  input: string | null;
  options: Partial<WasmOptOptions>;
  printAllPasses: boolean;
}

/**
 * Recognized long-option names that are NOT pass names.
 * Everything else that starts with `--` is treated as an explicit pass name.
 */
const RECOGNIZED_LONG_FLAGS = new Set([
  "--output",
  "--emit-text",
  "--debug-info",
  "--hybrid",
  "--validate",
  "--no-validate",
  "--closed-world",
  "--pass-arg",
  "--print-all-passes",
  "--help",
]);

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    input: null,
    options: {},
    printAllPasses: false,
  };
  const passes: string[] = [];
  const passArgs: Record<string, string> = {};

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
    } else if (a === "--validate") {
      result.options.validate = true;
    } else if (a === "--no-validate") {
      result.options.validate = false;
    } else if (a === "--closed-world") {
      result.options.closedWorld = true;
    } else if (a === "--pass-arg") {
      const kv = args[++i];
      if (kv) {
        const eq = kv.indexOf("=");
        if (eq > 0) {
          passArgs[kv.slice(0, eq)] = kv.slice(eq + 1);
        } else {
          passArgs[kv] = "";
        }
      }
    } else if (a === "--print-all-passes") {
      result.printAllPasses = true;
    } else if (a.startsWith("--") && !RECOGNIZED_LONG_FLAGS.has(a)) {
      // Treat unknown --flags as pass names (e.g. --vacuum, --dce)
      passes.push(a.slice(2));
    } else if (!a.startsWith("-")) {
      result.input = a;
    }
  }

  if (passes.length > 0) result.options.passes = passes;
  if (Object.keys(passArgs).length > 0) result.options.passArgs = passArgs;
  return result;
}

// ---------------------------------------------------------------------------
// Convenience re-exports from pass layer
// ---------------------------------------------------------------------------

export { defaultPassOptions, listPasses, PassRunner, shrinkPassOptions };
export type { PassOptions };

// Allow `ignore unused` for ModuleBuilder re-export (used in JSDoc examples)
export { ModuleBuilder };

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
//
// For CLI use, invoke via the top-level `main.ts` dispatcher (works on Deno,
// Node 18+, and Bun). The `if (import.meta.main)` check used in Deno-only
// builds is intentionally omitted here for cross-runtime portability —
// `import.meta.main` is not yet universal across Node versions binaryen-ts
// supports. Callers that need standalone execution can import `main` from
// this module and call it directly.