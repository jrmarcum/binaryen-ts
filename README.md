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
├── src/passes/    Optimization pass registry and runner       → @jrmarcum/binaryen-ts/passes
├── src/tools/     CLI tools (wasm-opt, wasm-dis, wasm-as)
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

console.log(listPasses()); // ["DCE", ...]

const runner = new PassRunner(module, { optimizeLevel: 3, shrinkLevel: 0 });
runner.addDefaultOptimizationPasses().run();
```

### CLI — wasm-opt

```sh
# Optimize a WASM file (uses upstream wasm-opt subprocess in hybrid mode)
deno run --allow-all jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -Oz

# Emit WAT text
deno run --allow-all jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -S
```

## Hybrid mode

`binaryen-ts` uses a **hybrid** approach to optimization:

| Mode | What runs | Use when |
| ---- | --------- | -------- |
| Native TypeScript | Built-in passes (`DCE`, `Vacuum`, etc.) | Fast iteration, unit testing passes |
| Hybrid (subprocess) | Upstream `wasm-opt` binary on `PATH` | Maximum optimization quality |
| Hybrid (binaryen.js) | Upstream `binaryen.js` WASM binary | No binary dependency, browser compat |

Enable hybrid mode by passing `hybridMode: true` to optimization calls, or by using the `--hybrid` CLI flag. The upstream `wasm-opt` binary must be on `PATH` for subprocess mode.

## Module exports (JSR)

| Import path | Contents |
| ----------- | -------- |
| `@jrmarcum/binaryen-ts` | CLI entry point |
| `@jrmarcum/binaryen-ts/api` | High-level `createModule`, `Module`, `ExprBuilder` |
| `@jrmarcum/binaryen-ts/ir` | `ValType`, `ModuleBuilder`, `BinaryOp`, `UnaryOp`, expression builders |
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
| 3 | 🚧 Active | WASM binary encoder (IR → .wasm) |
| 4 | Planned | Core optimization passes (Vacuum, RemoveUnusedBrs, OptimizeInstructions, CoalesceLocals) |
| 5 | Planned | Inlining pass |
| 6 | Planned | `wasm-opt` native CLI (no subprocess dependency) |
| 7 | Planned | GC proposal types and instructions |
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
