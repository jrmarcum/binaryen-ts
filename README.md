# binaryen-ts

[![JSR](https://jsr.io/badges/@jrmarcum/binaryen-ts)](https://jsr.io/@jrmarcum/binaryen-ts)
[![JSR Score](https://jsr.io/badges/@jrmarcum/binaryen-ts/score)](https://jsr.io/@jrmarcum/binaryen-ts)

A TypeScript / Deno port of the [Binaryen](https://github.com/WebAssembly/binaryen) WebAssembly compiler infrastructure, designed for use with the [wasmtk](https://jsr.io/@jrmarcum/wasmtk) ecosystem.

## What is binaryen-ts?

[Binaryen](https://github.com/WebAssembly/binaryen) is the WebAssembly compiler infrastructure behind `wasm-opt`, Emscripten, `wasmtk`, and many other WebAssembly toolchains. `binaryen-ts` rewrites this infrastructure in TypeScript with three goals:

1. **Type-safe IR** — a discriminated-union expression tree with full TypeScript inference at every node.
2. **Deno-native tooling** — CLI tools (`wasm-opt`, `wasm-dis`) that run natively in Deno without Emscripten.
3. **Hybrid mode** — delegate complex pass pipelines to the battle-tested upstream `binaryen.js` WASM binary while keeping the API surface in TypeScript.

### Architecture

```text
binaryen-ts/
├── src/ir/        IR types, expression nodes, module builder  → @jrmarcum/binaryen-ts/ir
├── src/parser/    WAT text parser (tokenizer → S-expr → IR)  → (internal; wabt-ts is the external front door)
├── src/binary/    WASM binary parser (.wasm → IR)             → @jrmarcum/binaryen-ts/binary
├── src/encoder/   WASM binary encoder (IR → .wasm)           → @jrmarcum/binaryen-ts/encoder
├── src/passes/    Optimization pass registry and runner       → @jrmarcum/binaryen-ts/passes
├── src/tools/     CLI tools (wasm-opt)
├── src/api/       Unified high-level API                      → @jrmarcum/binaryen-ts/api
├── src/interop/   Upstream binaryen.js bridge (hybrid mode)  → @jrmarcum/binaryen-ts/interop
└── upstream/      Upstream Binaryen C++ source (git submodule, reference only)
```

## Installation

### Deno (via JSR)

```ts
import { createModule, BinaryOp, ValType } from "jsr:@jrmarcum/binaryen-ts/api";
```

Or add to your `deno.json` imports:

```json
{
  "imports": {
    "@jrmarcum/binaryen-ts/api": "jsr:@jrmarcum/binaryen-ts@^0.1/api",
    "@jrmarcum/binaryen-ts/ir":  "jsr:@jrmarcum/binaryen-ts@^0.1/ir"
  }
}
```

### Node.js / Bun (via npm compat)

```sh
npx jsr add @jrmarcum/binaryen-ts
# or
bunx jsr add @jrmarcum/binaryen-ts
```

## Quick start

### Build and optimize a WASM module

```ts
import { createModule, BinaryOp, ValType } from "@jrmarcum/binaryen-ts/api";

const mod = createModule((b, e) => {
  // Define a function:  add(a: i32, b: i32) -> i32
  b.addFunction(
    "add",
    [ValType.I32, ValType.I32], // params
    [ValType.I32],              // results
    e.return(
      e.binary(BinaryOp.AddI32, e.localGet(0), e.localGet(1))
    ),
  );
  b.addExport("add", "add");
});

// Optimize via upstream wasm-opt (hybrid mode)
const wasm: Uint8Array = await mod.optimize("-Oz", true);
await Deno.writeFile("add.wasm", wasm);
```

### Use the IR directly

```ts
import {
  ModuleBuilder,
  ValType,
  BinaryOp,
  makeLocalGet,
  makeBinary,
  makeReturn,
} from "@jrmarcum/binaryen-ts/ir";

const body = makeReturn(
  makeBinary(BinaryOp.MulI32, makeLocalGet(0, ValType.I32), makeLocalGet(0, ValType.I32))
);

const mod = new ModuleBuilder()
  .addFunction("square", [ValType.I32], [ValType.I32], body)
  .addExport("square", "square")
  .build();
```

### Run optimization passes

```ts
import { PassRunner, listPasses } from "@jrmarcum/binaryen-ts/passes";
import { ModuleBuilder } from "@jrmarcum/binaryen-ts/ir";

// ["CoalesceLocals", "DCE", "Inlining", "InliningOptimizing", "LocalCSE",
//  "OptimizeInstructions", "PickLoadSigns", "RemoveUnusedBrs",
//  "RemoveUnusedModuleElements", "RemoveUnusedNames", "SimplifyLocals", "Vacuum"]
console.log(listPasses());

const runner = new PassRunner(module, { optimizeLevel: 2, shrinkLevel: 0 });
runner.addDefaultOptimizationPasses().run();
```

### CLI — wasm-opt

```sh
# Optimize a WASM file (native TypeScript passes — no subprocess required)
deno run --allow-read --allow-write jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -O2

# Size-optimize
deno run --allow-read --allow-write jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -Oz

# Run specific passes only
deno run --allow-read --allow-write jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm --vacuum --dce

# List all registered passes
deno run jsr:@jrmarcum/binaryen-ts wasm-opt --print-all-passes

# Per-pass argument
deno run --allow-read --allow-write jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm --pass-arg inlining@maxSize=20

# Use upstream wasm-opt subprocess (hybrid mode, requires wasm-opt on PATH)
deno run --allow-all jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -Oz --hybrid
```

## Optimization modes

`binaryen-ts` supports three optimization modes:

| Mode | What runs | Use when |
| ---- | --------- | -------- |
| **Native TypeScript** (default) | Built-in passes in `src/passes/` — no subprocess, no binary | Default; all phases 0–6 complete |
| **Hybrid subprocess** (`--hybrid`) | Upstream `wasm-opt` binary on `PATH` | Maximum optimization fidelity; requires installed `wasm-opt` |
| **Hybrid binaryen.js** | Upstream `binaryen.js` WASM binary | Deferred — not on critical path |

The native path is the default as of Phase 6: `parseWasm` → `PassRunner` → `encodeWasm`. Pass `hybridMode: true` (or `--hybrid`) to delegate to the upstream subprocess instead.

## Module exports (JSR)

| Import path | Contents |
| ----------- | -------- |
| `@jrmarcum/binaryen-ts` | CLI entry point |
| `@jrmarcum/binaryen-ts/api` | High-level `createModule`, `Module`, `ExprBuilder` |
| `@jrmarcum/binaryen-ts/ir` | `ValType`, `ModuleBuilder`, `BinaryOp`, `UnaryOp`, expression builders |
| `@jrmarcum/binaryen-ts/binary` | `parseWasm(bytes)` — WASM binary → IR |
| `@jrmarcum/binaryen-ts/encoder` | `encodeWasm(mod)` — IR → WASM binary |
| `@jrmarcum/binaryen-ts/passes` | `PassRunner`, `registerPass`, `listPasses` |
| `@jrmarcum/binaryen-ts/interop` | `BinaryenInterop` (upstream binaryen.js bridge) |
| `@jrmarcum/binaryen-ts/tools/wasm-opt` | `wasmOpt()` function and `main()` CLI handler |

## Port roadmap

This is an active port — see [TASKS.md](TASKS.md) for the full task list.

| Phase | Status | Description |
| ----- | ------ | ----------- |
| 0 | ✅ Done | Project setup, upstream submodule, IR type system, pass infrastructure |
| 1 | ✅ Done | WAT text parser (WASM → IR) |
| 2 | ✅ Done | WASM binary parser (binary → IR) |
| 3 | ✅ Done | WASM binary encoder (IR → .wasm) — full round-trip verified |
| 4 | ✅ Done | Core optimization passes — 9 passes (Vacuum, OptimizeInstructions, CoalesceLocals, LocalCSE, …) |
| 5 | ✅ Done | Inlining pass — `Inlining` + `InliningOptimizing`, call-graph analysis, dead-callee removal |
| 6 | ✅ Done | `wasm-opt` native CLI — pure TypeScript pipeline, no subprocess; `RemoveUnusedNames` pass |
| 7 | 🚧 Next | GC proposal types and instructions |
| 8 | Planned | Exception-handling proposal |
| 9 | Planned | SIMD instructions |
| 10 | Planned | Compile performance-critical passes to WASM via `wasic` |

## Contributing

The upstream C++ source is tracked as a git submodule at `upstream/` for reference.
When porting a pass from C++, consult the corresponding file in `upstream/src/passes/`.

```sh
# Type-check all TypeScript
deno task check

# Run tests
deno task test

# Format
deno task fmt
```

## Submodule references

To update the upstream binaryen C++ reference:

```sh
cd upstream && git fetch --depth 1 origin main && git checkout FETCH_HEAD
cd .. && git add upstream && git commit -m "bump upstream binaryen"
```

To update the wabt-ts sibling reference:

```sh
cd wabt-ts && git fetch --depth 1 origin main && git checkout FETCH_HEAD
cd .. && git add wabt-ts && git commit -m "bump wabt-ts reference"
```

## License

Apache-2.0 — same as the upstream Binaryen project. See [LICENSE](LICENSE) for details.
