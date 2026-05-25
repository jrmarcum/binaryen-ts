/**
 * @module binaryen-ts
 *
 * `binaryen-ts` — A TypeScript / WebAssembly port of the Binaryen compiler
 * infrastructure, designed for use with Deno and the
 * [wasmtk](https://jsr.io/@jrmarcum/wasmtk) ecosystem.
 *
 * ## What is binaryen-ts?
 *
 * [Binaryen](https://github.com/WebAssembly/binaryen) is the WebAssembly
 * compiler infrastructure behind `wasm-opt`, Emscripten, and `wasmtk`. This
 * project is a TypeScript rewrite and ergonomic wrapper that:
 *
 * - Provides a **TypeScript-native IR** (intermediate representation) for
 *   building and analyzing WASM modules with full type safety.
 * - Implements **optimization passes** in TypeScript, with performance-critical
 *   ones compiled to WASM via `wasic`.
 * - Runs in **hybrid mode** — delegating complex pass pipelines to the upstream
 *   `binaryen.js` WASM binary while exposing a native TypeScript API surface.
 * - Integrates natively with the `wasmtk` CLI for polyglot WASM development.
 *
 * ## Quick start
 *
 * ```ts
 * import { createModule, BinaryOp, ValType } from "@jrmarcum/binaryen-ts/api";
 * import { writeFile } from "node:fs/promises";
 *
 * const mod = createModule((b, e) => {
 *   b.addFunction("add", [ValType.I32, ValType.I32], [ValType.I32],
 *     e.return(e.binary(BinaryOp.AddI32, e.localGet(0), e.localGet(1)))
 *   );
 *   b.addExport("add", "add");
 * });
 *
 * const wasm = await mod.optimize("-Oz", true); // hybrid mode via wasm-opt
 * await writeFile("add.wasm", wasm);
 * ```
 *
 * ## CLI
 *
 * Runs on Deno, Node 18+, and Bun. Examples:
 *
 * ```sh
 * # Deno (no install — runs directly from JSR)
 * deno run -A jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -Oz
 *
 * # Node (after `npx jsr add @jrmarcum/binaryen-ts`)
 * node --experimental-strip-types node_modules/@jrmarcum/binaryen-ts/main.ts wasm-opt input.wasm
 *
 * # Bun
 * bun node_modules/@jrmarcum/binaryen-ts/main.ts wasm-opt input.wasm
 * ```
 *
 * ## Architecture
 *
 * ```
 * binaryen-ts/ts/
 * ├── src/ir/        IR types and module builder  (@jrmarcum/binaryen-ts/ir)
 * ├── src/passes/    Optimization pass registry   (@jrmarcum/binaryen-ts/passes)
 * ├── src/tools/     CLI tools (wasm-opt, etc.)
 * ├── src/api/       Unified high-level API       (@jrmarcum/binaryen-ts/api)
 * ├── src/interop/   Upstream binaryen.js bridge  (@jrmarcum/binaryen-ts/interop)
 * └── upstream/      Upstream Binaryen C++ source (git submodule, reference)
 * ```
 *
 * @license MIT
 */

import process from "node:process";
import { main as wasmOptMain } from "./src/tools/wasm-opt.ts";

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  "wasm-opt": wasmOptMain,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log("binaryen-ts 0.1.0");
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run with --help to see available commands.`);
    process.exit(1);
  }

  await handler(rest);
}

function printHelp(): void {
  console.log(`binaryen-ts 0.1.0 — TypeScript port of Binaryen WebAssembly toolchain

USAGE:
  deno run -A jsr:@jrmarcum/binaryen-ts <command> [options]
  node main.ts <command> [options]    (Node 22+ with --experimental-strip-types)
  bun main.ts <command> [options]

COMMANDS:
  wasm-opt <input>    Optimize a WASM or WAT file
                      -o <file>     Output file (default: output.wasm)
                      -O0 .. -O4    Optimization level
                      -Os, -Oz      Size optimization (shrink level 1, 2)
                      -S            Emit WAT text
                      --hybrid      Use upstream wasm-opt subprocess

OPTIONS:
  --help, -h          Show this help
  --version, -v       Show version

EXPORTS (JSR):
  @jrmarcum/binaryen-ts/api      High-level API
  @jrmarcum/binaryen-ts/ir       IR types and module builder
  @jrmarcum/binaryen-ts/passes   Pass registry and runner
  @jrmarcum/binaryen-ts/interop  Upstream binaryen.js bridge

DOCS:
  https://jsr.io/@jrmarcum/binaryen-ts
`);
}

await main();
