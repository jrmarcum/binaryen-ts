# binaryen-ts

[![JSR](https://jsr.io/badges/@jrmarcum/binaryen-ts)](https://jsr.io/@jrmarcum/binaryen-ts)
[![JSR Score](https://jsr.io/badges/@jrmarcum/binaryen-ts/score)](https://jsr.io/@jrmarcum/binaryen-ts)
[![CI](https://github.com/jrmarcum/binaryen-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/jrmarcum/binaryen-ts/actions/workflows/ci.yml)

A cross-runtime TypeScript port of the [Binaryen](https://github.com/WebAssembly/binaryen)
WebAssembly compiler infrastructure. Runs on **Deno, Node 18+, Bun, and modern browsers** from a
single source tree, designed for use with the [wasmtk](https://jsr.io/@jrmarcum/wasmtk) ecosystem.

## What is binaryen-ts?

[Binaryen](https://github.com/WebAssembly/binaryen) is the WebAssembly compiler infrastructure
behind `wasm-opt`, Emscripten, `wasmtk`, and many other WebAssembly toolchains. `binaryen-ts`
rewrites this infrastructure in TypeScript with three goals:

1. **Type-safe IR** — a discriminated-union expression tree with full TypeScript inference at every
   node.
2. **Cross-runtime tooling** — CLI tools (`wasm-opt`, `wasm-dis`) and the pure-TS optimizer pipeline
   run identically on Deno, Node, Bun, and the browser. I/O is via `node:` standard-library imports
   (supported by all three server runtimes); the browser uses `fetch` for module loading.
3. **Hybrid mode** — delegate complex pass pipelines to the battle-tested upstream `binaryen.js`
   WASM binary while keeping the API surface in TypeScript.

## Runtime compatibility

| Runtime         | Status   | Notes                                                                          |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| Deno 1.40+ / 2  | ✅ First | Canonical authoring runtime; drives the JSR publish workflow                   |
| Node.js 18+     | ✅ Full  | Install via `npx jsr add @jrmarcum/binaryen-ts`                                |
| Bun 1.0+        | ✅ Full  | Install via `bunx jsr add @jrmarcum/binaryen-ts` (or import directly from JSR) |
| Modern browsers | ✅ Lib   | Library code (IR / parser / encoder / passes / runtime); CLI + subprocess N/A  |

The library is split so that browser code paths (`api`, `ir`, `binary`, `encoder`, `passes`,
`wasm-runtime`) import only web-standard APIs (`Uint8Array`, `DataView`, `TextDecoder`,
`WebAssembly`). The CLI tooling (`tools/wasm-opt`) and subprocess hybrid bridge (`interop`) use
`node:fs/promises` and `node:child_process` and are Node-compatible runtimes only.

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
├── src/wasm/      Embedded WASM kernels (Phase 10)            → @jrmarcum/binaryen-ts/wasm
├── src/wasm-runtime.ts  Lazy-load + cache for WASM kernels   → @jrmarcum/binaryen-ts/wasm-runtime
└── upstream/      Upstream Binaryen C++ source (git submodule, reference only)
```

## Installation

### Deno (via JSR)

```ts
import { BinaryOp, createModule, ValType } from "jsr:@jrmarcum/binaryen-ts/api";
```

Or add to your `deno.json` imports:

```json
{
  "imports": {
    "@jrmarcum/binaryen-ts/api": "jsr:@jrmarcum/binaryen-ts@^1/api",
    "@jrmarcum/binaryen-ts/ir": "jsr:@jrmarcum/binaryen-ts@^1/ir"
  }
}
```

### Node.js (via JSR's npm compatibility)

```sh
npx jsr add @jrmarcum/binaryen-ts
```

Then import with the JSR-mapped specifier:

```ts
import { BinaryOp, createModule, ValType } from "@jrmarcum/binaryen-ts/api";
```

Node 18+ is required. The CLI entry point (`main.ts`) uses TypeScript natively under Node 22.6+ with
`--experimental-strip-types`; on older Nodes, transpile via `tsx`, `tsc`, or the bundled JSR build.

### Bun

```sh
bunx jsr add @jrmarcum/binaryen-ts
```

Or import directly from JSR (Bun resolves `jsr:` specifiers natively in recent versions):

```ts
import { createModule } from "jsr:@jrmarcum/binaryen-ts/api";
```

### Browser (via JSR ESM)

Library subpaths that do not depend on `node:` modules work in the browser. Resolve them through the
JSR ESM endpoint (or via a bundler like esbuild/Vite that supports the JSR registry):

```html
<script type="module">
  import { BinaryOp, createModule, ValType } from "https://esm.sh/jsr/@jrmarcum/binaryen-ts/api";
  // ... build and encode a module, then instantiate via WebAssembly.instantiate ...
</script>
```

Browser-safe subpaths: `/api`, `/ir`, `/binary`, `/encoder`, `/passes`, `/wasm`, `/wasm-runtime`.
Not browser-safe: `/tools/wasm-opt` (filesystem I/O), `/interop` (subprocess).

## Quick start

### Build and optimize a WASM module (Node / Deno / Bun)

```ts
import { BinaryOp, createModule, ValType } from "@jrmarcum/binaryen-ts/api";
import { writeFile } from "node:fs/promises";

const mod = createModule((b, e) => {
  // Define a function:  add(a: i32, b: i32) -> i32
  b.addFunction(
    "add",
    [ValType.I32, ValType.I32], // params
    [ValType.I32], // results
    e.return(
      e.binary(BinaryOp.AddI32, e.localGet(0), e.localGet(1)),
    ),
  );
  b.addExport("add", "add");
});

// Pure-TS pass pipeline (works on all runtimes including the browser)
const wasm: Uint8Array = await mod.optimize("-O2");
await writeFile("add.wasm", wasm);

// Or hybrid mode — delegates to `wasm-opt` subprocess (Node/Deno/Bun only)
const opt: Uint8Array = await mod.optimize("-Oz", true);
```

### Build and instantiate in the browser

```ts
import { BinaryOp, createModule, ValType } from "@jrmarcum/binaryen-ts/api";

const mod = createModule(/* ... as above ... */);
const wasm: Uint8Array = await mod.optimize("-O2");

const { instance } = await WebAssembly.instantiate(wasm);
const add = instance.exports.add as (a: number, b: number) => number;
console.log(add(2, 3)); // 5
```

### Use the IR directly

```ts
import {
  BinaryOp,
  makeBinary,
  makeLocalGet,
  makeReturn,
  ModuleBuilder,
  ValType,
} from "@jrmarcum/binaryen-ts/ir";

const body = makeReturn(
  makeBinary(BinaryOp.MulI32, makeLocalGet(0, ValType.I32), makeLocalGet(0, ValType.I32)),
);

const mod = new ModuleBuilder()
  .addFunction("square", [ValType.I32], [ValType.I32], body)
  .addExport("square", "square")
  .build();
```

### Run optimization passes

```ts
import { listPasses, PassRunner } from "@jrmarcum/binaryen-ts/passes";
import { ModuleBuilder } from "@jrmarcum/binaryen-ts/ir";

// ["CoalesceLocals", "DCE", "Inlining", "InliningOptimizing", "LocalCSE",
//  "OptimizeInstructions", "PickLoadSigns", "RemoveUnusedBrs",
//  "RemoveUnusedModuleElements", "RemoveUnusedNames", "SimplifyLocals", "Vacuum"]
console.log(listPasses());

const runner = new PassRunner(module, { optimizeLevel: 2, shrinkLevel: 0 });
runner.addDefaultOptimizationPasses().run();
```

### CLI — wasm-opt

The CLI runs on Deno, Node 18+, and Bun. Pick the launcher that matches your runtime:

```sh
# --- Deno (no install — runs directly from JSR) -----------------------------
deno run -A jsr:@jrmarcum/binaryen-ts wasm-opt input.wasm -o out.wasm -O2

# --- Node 22+ (TypeScript via --experimental-strip-types) -------------------
npx jsr add @jrmarcum/binaryen-ts
node --experimental-strip-types ./node_modules/@jrmarcum/binaryen-ts/main.ts \
  wasm-opt input.wasm -o out.wasm -O2

# --- Bun (TypeScript native) -----------------------------------------------
bunx jsr add @jrmarcum/binaryen-ts
bun ./node_modules/@jrmarcum/binaryen-ts/main.ts wasm-opt input.wasm -o out.wasm -O2
```

Common flag examples (any launcher):

```sh
# Size-optimize
wasm-opt input.wasm -o out.wasm -Oz

# Run specific passes only
wasm-opt input.wasm -o out.wasm --vacuum --dce

# List all registered passes
wasm-opt --print-all-passes

# Per-pass argument
wasm-opt input.wasm -o out.wasm --pass-arg inlining@maxSize=20

# Use upstream wasm-opt subprocess (hybrid mode, requires wasm-opt on PATH)
wasm-opt input.wasm -o out.wasm -Oz --hybrid
```

## Optimization modes

`binaryen-ts` supports three optimization modes:

| Mode                               | What runs                                                   | Use when                                                     |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| **Native TypeScript** (default)    | Built-in passes in `src/passes/` — no subprocess, no binary | Default; all phases 0–9 complete                             |
| **Hybrid subprocess** (`--hybrid`) | Upstream `wasm-opt` binary on `PATH`                        | Maximum optimization fidelity; requires installed `wasm-opt` |
| **Hybrid binaryen.js**             | Upstream `binaryen.js` WASM binary                          | Deferred — not on critical path                              |

The native path is the default as of Phase 6: `parseWasm` → `PassRunner` → `encodeWasm`. Pass
`hybridMode: true` (or `--hybrid`) to delegate to the upstream subprocess instead.

## WASM kernel runtime (Phase 10)

`binaryen-ts` ships a generic runtime for embedded WASM kernels — useful for performance-critical
pass logic that benefits from WASM execution (when the per-call work amortizes the boundary cost). A
trivial demo kernel is included as both a runtime smoke test and the boundary-cost benchmark
baseline. Kernels are built by binaryen-ts itself (Phase 1 WAT parser → Phase 3 binary encoder) — no
external toolchain dependency.

```ts
import { DEMO_BYTES, DEMO_KERNEL_EXPORTS } from "@jrmarcum/binaryen-ts/wasm";
import { loadKernel } from "@jrmarcum/binaryen-ts/wasm-runtime";

const demo = await loadKernel({
  name: "demo",
  bytes: DEMO_BYTES,
  exports: DEMO_KERNEL_EXPORTS,
});
const add = demo.exports.add_i32 as (a: number, b: number) => number;
console.log(add(3, 4)); // 7
```

> **Caveat — measure before porting**: A WASM call costs ~2–3 ns on top of the native op. Single-op
> kernels (one i32 arithmetic per call) regress against native JS by ~5–10× in V8. See
> `benches/wasm_dispatch_bench.ts` for the boundary-cost numbers and selection criteria — a kernel
> only earns its keep when each call does at least 2–3 ns more useful work than the equivalent
> native JS op.

## Module exports (JSR)

| Import path                            | Contents                                                               |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `@jrmarcum/binaryen-ts`                | CLI entry point                                                        |
| `@jrmarcum/binaryen-ts/api`            | High-level `createModule`, `Module`, `ExprBuilder`                     |
| `@jrmarcum/binaryen-ts/ir`             | `ValType`, `ModuleBuilder`, `BinaryOp`, `UnaryOp`, expression builders |
| `@jrmarcum/binaryen-ts/binary`         | `parseWasm(bytes)` — WASM binary → IR                                  |
| `@jrmarcum/binaryen-ts/encoder`        | `encodeWasm(mod)` — IR → WASM binary                                   |
| `@jrmarcum/binaryen-ts/passes`         | `PassRunner`, `registerPass`, `listPasses`                             |
| `@jrmarcum/binaryen-ts/interop`        | `BinaryenInterop` (upstream binaryen.js bridge)                        |
| `@jrmarcum/binaryen-ts/tools/wasm-opt` | `wasmOpt()` function and `main()` CLI handler                          |
| `@jrmarcum/binaryen-ts/wasm`           | `DEMO_BYTES`, `DEMO_KERNEL_EXPORTS` (embedded kernel bytes)            |
| `@jrmarcum/binaryen-ts/wasm-runtime`   | `loadKernel`, `clearKernelCache`, `WasmRuntimeError` — lazy WASM cache |

## Port roadmap

| Phase | Status     | Description                                                                                                                                                                                                                           |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | ✅ Done    | Project setup, upstream submodule, IR type system, pass infrastructure                                                                                                                                                                |
| 1     | ✅ Done    | WAT text parser (WASM → IR)                                                                                                                                                                                                           |
| 2     | ✅ Done    | WASM binary parser (binary → IR)                                                                                                                                                                                                      |
| 3     | ✅ Done    | WASM binary encoder (IR → .wasm) — full round-trip verified                                                                                                                                                                           |
| 4     | ✅ Done    | Core optimization passes — 9 passes (Vacuum, OptimizeInstructions, CoalesceLocals, LocalCSE, …)                                                                                                                                       |
| 5     | ✅ Done    | Inlining pass — `Inlining` + `InliningOptimizing`, call-graph analysis, dead-callee removal                                                                                                                                           |
| 6     | ✅ Done    | `wasm-opt` native CLI — pure TypeScript pipeline, no subprocess; `RemoveUnusedNames` pass                                                                                                                                             |
| 7     | ✅ Done    | GC proposal — heap types, struct/array/ref instructions, binary parser + encoder + WAT parser                                                                                                                                         |
| 8     | ✅ Done    | Exception-handling proposal — tags, throw/throw_ref/rethrow/try_table, binary parser + encoder + WAT parser                                                                                                                           |
| 9     | ✅ Done    | SIMD instructions — v128, all lane types, 0xFD prefix decoder + encoder + WAT parser, 20/20 tests                                                                                                                                     |
| 10    | ✅ Partial | WASM-kernel runtime + dogfood embed pipeline; demo kernel + boundary-cost benchmark prove single-op dispatch regresses, kernel migration deferred until profiling identifies workloads that amortize the ~3 ns/call WASM boundary tax |
| 11    | ✅ Done    | Cross-runtime migration — published library and CLI run on Deno, Node 18+, Bun, and modern browsers from a single source; tag-push CI publishes to JSR with OIDC provenance; 179/179 tests passing                                    |

## Contributing

The upstream C++ source is tracked as a git submodule at `upstream/` for reference. When porting a
pass from C++, consult the corresponding file in `upstream/src/passes/`.

```sh
# Type-check all TypeScript
deno task check

# Run tests
deno task test

# Format
deno task fmt

# CI bundle (check + test)
deno task ci
```

## Publishing

The package is published to [JSR](https://jsr.io/@jrmarcum/binaryen-ts) with
[OIDC provenance](https://docs.jsr.io/publishing-packages#publishing-from-github-actions) via GitHub
Actions. The pipeline:

1. Bump `version` in [deno.json](deno.json).
2. Commit on `main`.
3. Tag and push:

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

4. The [Publish workflow](.github/workflows/publish.yml) runs on the tag, verifies that the tag
   matches `deno.json`, type-checks, tests, then executes:

   ```sh
   deno task publish
   ```

   JSR detects the GitHub Actions OIDC token and stamps the release with provenance automatically.
   No publish token is required.

Local dry-run (verifies the manifest without publishing):

```sh
deno task publish:dry
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
