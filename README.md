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
└── upstream/      Upstream Binaryen C++ source (gitignored local clone, reference only)
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
//  "RemoveUnusedModuleElements", "RemoveUnusedNames", "SimplifyLocals",
//  "StripEH", "Vacuum"]
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

# Enable split / partial inlining (Pattern A/B); also accepts -pii N
wasm-opt input.wasm -o out.wasm -O3 --partial-inlining-ifs 4

# Use upstream wasm-opt subprocess (hybrid mode, requires wasm-opt on PATH)
wasm-opt input.wasm -o out.wasm -Oz --hybrid
```

## Optimization modes

`binaryen-ts` supports three optimization modes:

| Mode                                | What runs                                                          | Use when                                                                                |
| ----------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Native TypeScript** (default)     | Built-in passes in `src/passes/` — no subprocess, no binary        | Default for `mod.optimize()` and `wasm-opt` CLI                                         |
| **Hybrid subprocess** (`--hybrid`)  | Upstream `wasm-opt` binary on `PATH`                               | Maximum optimization fidelity; requires installed `wasm-opt`                            |
| **In-process binaryen.js** (tier 3) | Upstream `binaryen.js` Emscripten build, loaded via dynamic import | No subprocess required; browser-safe when binaryen.js resolves under the target runtime |

The native path is the default as of Phase 6: `parseWasm` → `PassRunner` → `encodeWasm`. Pass
`hybridMode: true` (or `--hybrid`) to delegate to the upstream `wasm-opt` subprocess. The in-process
binaryen.js path (tier 3) is opt-in — instantiate the bridge yourself:

```ts
import { BinaryenInterop } from "@jrmarcum/binaryen-ts/interop";

// Deno/Bun resolve npm: specifiers natively; Node requires `npm install binaryen` first.
const interop = await BinaryenInterop.create({ binaryenJsPath: "npm:binaryen" });

// WAT round-trip — `-Oz` shorthand or explicit { optimizeLevel, shrinkLevel, passes }
const optimizedWat = interop.optimizeWat(watText, "-Oz");

// Binary round-trip
const optimizedBytes = interop.optimizeBinary(wasmBytes, { optimizeLevel: 2 });
```

Pass a pre-loaded factory via `{ binaryen: <loaded module> }` to skip the dynamic import — useful
for tests, browser-loaded binaryen.js, or runtimes where dynamic `import()` is awkward.

## Migrating from `npm:binaryen`

Code written against the upstream `npm:binaryen` package can switch to binaryen-ts by changing the
import alone. The `@jrmarcum/binaryen-ts/compat` module re-exposes the upstream namespace API
(`readBinary`, `Features`, `setShrinkLevel`, `setOptimizeLevel`, `Module.optimize`/`setFeatures`/
`emitBinary`, and the inspection helpers `getExportInfo`/`getFunctionInfo`/`expandType`) on top of
the native TypeScript pipeline:

```ts
// before
import binaryen from "binaryen";

// after
import * as binaryen from "@jrmarcum/binaryen-ts/compat";

const mod = binaryen.readBinary(bytes);
mod.setFeatures(binaryen.Features.All);
binaryen.setShrinkLevel(2);
binaryen.setOptimizeLevel(2);
mod.optimize();
const optimized = mod.emitBinary();
```

Programmatic construction works too (Phase 12.1) — `new binaryen.Module()` returns an empty module
you can populate with the namespaced expression factories upstream binaryen.js exposes on every
`Module` instance:

```ts
const mod = new binaryen.Module();
mod.addFunction(
  "add",
  binaryen.createType([binaryen.i32, binaryen.i32]),
  binaryen.i32,
  [],
  mod.i32.add(
    mod.local.get(0, binaryen.i32),
    mod.local.get(1, binaryen.i32),
  ),
);
mod.addFunctionExport("add", "add");
mod.runPasses(["DCE", "Vacuum"]);
const bytes = mod.emitBinary();
```

The shim runs the same `PassRunner` + `addDefaultOptimizationPasses()` pipeline used by the native
CLI, so optimization output is produced by the in-tree TypeScript passes — not by `wasm-opt` or
upstream binaryen.js. Numeric type IDs (`binaryen.i32` = 2, `binaryen.i64` = 3, …) and external kind
constants (`binaryen.ExternalFunction` = 0, …) match the upstream values, so type-discriminator
helpers like the common `getTypeName(typeId)` switch on identical numbers.

Surface still deliberately omitted (no current consumer needs them): SIMD / GC / EH expression
factory methods — drop down to the `make*` factories from [`/ir`](#module-exports-jsr) directly;
Relooper, source-map APIs, and debug-info builders.

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

| Import path                            | Contents                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `@jrmarcum/binaryen-ts`                | CLI entry point                                                                   |
| `@jrmarcum/binaryen-ts/api`            | High-level `createModule`, `Module`, `ExprBuilder`                                |
| `@jrmarcum/binaryen-ts/compat`         | `npm:binaryen`-compatible facade (`readBinary`, `Features`, `Module.optimize`, …) |
| `@jrmarcum/binaryen-ts/ir`             | `ValType`, `ModuleBuilder`, `BinaryOp`, `UnaryOp`, expression builders            |
| `@jrmarcum/binaryen-ts/binary`         | `parseWasm(bytes)` — WASM binary → IR                                             |
| `@jrmarcum/binaryen-ts/encoder`        | `encodeWasm(mod)` — IR → WASM binary                                              |
| `@jrmarcum/binaryen-ts/passes`         | `PassRunner`, `registerPass`, `listPasses`                                        |
| `@jrmarcum/binaryen-ts/interop`        | `BinaryenInterop` (upstream binaryen.js bridge)                                   |
| `@jrmarcum/binaryen-ts/tools/wasm-opt` | `wasmOpt()` function and `main()` CLI handler                                     |
| `@jrmarcum/binaryen-ts/wasm`           | `DEMO_BYTES`, `DEMO_KERNEL_EXPORTS` (embedded kernel bytes)                       |
| `@jrmarcum/binaryen-ts/wasm-runtime`   | `loadKernel`, `clearKernelCache`, `WasmRuntimeError` — lazy WASM cache            |

## Port roadmap

| Phase | Status     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | ✅ Done    | Project setup, upstream submodule, IR type system, pass infrastructure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 1     | ✅ Done    | WAT text parser (WASM → IR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2     | ✅ Done    | WASM binary parser (binary → IR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3     | ✅ Done    | WASM binary encoder (IR → .wasm) — full round-trip verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4     | ✅ Done    | Core optimization passes — 9 passes (Vacuum, OptimizeInstructions, CoalesceLocals, LocalCSE, …)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5     | ✅ Done    | Inlining pass — `Inlining` + `InliningOptimizing`, call-graph analysis, dead-callee removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6     | ✅ Done    | `wasm-opt` native CLI — pure TypeScript pipeline, no subprocess; `RemoveUnusedNames` pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7     | ✅ Done    | GC proposal — heap types, struct/array/ref instructions, binary parser + encoder + WAT parser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8     | ✅ Done    | Exception-handling proposal — tags, throw/throw_ref/rethrow/try_table, binary parser + encoder + WAT parser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 9     | ✅ Done    | SIMD instructions — v128, all lane types, 0xFD prefix decoder + encoder + WAT parser, 20/20 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 10    | ✅ Partial | WASM-kernel runtime + dogfood embed pipeline; demo kernel + boundary-cost benchmark prove single-op dispatch regresses, kernel migration deferred until profiling identifies workloads that amortize the ~3 ns/call WASM boundary tax                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11    | ✅ Done    | Cross-runtime migration + JSR publish hardening — single source tree runs on Deno, Node 18+, Bun, and modern browsers; tag-push CI publishes to JSR with OIDC provenance; license arrangement: MIT primary + Apache-2.0 alternative; JSDoc symbol coverage clean (0 `deno doc --lint` errors); 179/179 tests passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 11.1  | ✅ Done    | CI hardening + automated GitHub Release — `deno fmt`/`deno lint` clean across `src/` and `tests/`; `@std/assert` declared via import map; `actions/checkout` bumped to `@v6` (Node 24 runtime); publish workflow auto-creates a matching GitHub Release on tag push                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11.2  | ✅ Done    | Code-review housekeeping — LocalCSE internal cleanup (dropped dead `fn` parameter, hoisted `Object.values(ValType)` to a Set cache, single-pass candidate construction); JSDoc factory references corrected in `src/ir/expressions.ts`; no behavioral change, 179/179 tests still pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11.3  | ✅ Done    | Local-publish guardrail — `deno task publish` now refuses to run outside GitHub Actions (delegates to `scripts/guarded_publish.ts`, which checks `GITHUB_ACTIONS=true` and execs `deno publish` only inside CI); enforces the Phase 11 rule that JSR provenance requires the OIDC-issuing workflow, no behavioral change to CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11.4  | ✅ Done    | Version-aware release ergonomics — new `deno task bump` advances `deno.json` `version` under the project rule that sub-versions (patch, minor) max at 9 before rolling into the next greater segment (1.0.9 → 1.1.0, 1.9.9 → 2.0.0; major uncapped); guard's refusal message now substitutes the actual current + next version into the printed git commands instead of abstract `vX.Y.Z` placeholders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11.5  | ✅ Done    | Auto-tag on main version bump — new `.github/workflows/auto-tag.yml` fires on `push: branches: main`, reads `deno.json` `version`, and (if the matching `vX.Y.Z` tag does not yet exist) creates + pushes it then dispatches `publish.yml` via `gh workflow run`; closes the gap where version bumps committed to `main` without an accompanying tag push silently skipped publishing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11.6  | ✅ Done    | Release driver + CI provenance fix — `scripts/guarded_publish.ts` renamed to `scripts/publish.ts` and rewritten to actually _run_ the release (stage `deno.json`, commit, force-tag, push commit + tag atomically); `publish.yml` now calls `deno publish` **directly** instead of `deno task publish` — the previous indirection through `Deno.Command` was stripping JSR provenance because the OIDC token does not propagate cleanly into the subprocess (matches sibling `wasmtk`'s workflow shape)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 12    | ✅ Done    | `npm:binaryen` compatibility facade — new `@jrmarcum/binaryen-ts/compat` export exposes the upstream binaryen.js namespace API (`readBinary`, `Features`, `setShrinkLevel`/`setOptimizeLevel`, `Module.optimize` / `setFeatures` / `emitBinary` / `getNumExports` / `getExportByIndex` / `getFunction`, and the inspection trio `getExportInfo` / `getFunctionInfo` / `expandType` plus numeric type ID + external kind constants); also fixed `Module.toBinary()` in `src/api/index.ts` to wire through the existing `encodeWasm` encoder (the previous stale `throw new Error("not yet implemented")` predated Phase 3); 191/191 tests passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5.1   | ✅ Done    | Phase 5 inlining closure — InliningOptimizing now actually runs Vacuum + OptimizeInstructions on modified function bodies (its `optimize` flag was previously a no-op); split / partial inlining (Pattern A and Pattern B from upstream) added via new `PassOptions.partialInliningIfs` (default 0, opt-in); 210/210 tests passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 13    | ✅ Done    | Tail-call proposal binary support — `return_call` (opcode `0x12`) and `return_call_indirect` (`0x13`) wired end-to-end through binary parser + binary encoder + WAT parser (the IR's `isReturn` field was previously unused). 5 new binary round-trip tests, 215/215 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5.2   | ✅ Done    | Return-call inlining — when inlining a `return_call $f(args)`, the callee's `return` statements propagate as the caller's returns directly (matching tail-call semantics); the wrapper block is wrapped in `(return ...)` so fall-through also returns from the caller. Closes the only remaining Phase 5 inliner gap. 218/218 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7.1   | ✅ Done    | Pre-Phase-8 closure — three loose-end items: `parseCallIndirect` now resolves `(type $sig)` references via a `funcTypeDefs` map; `table.get` / `table.set` ported end-to-end (new IR nodes + factories, WAT parser, binary parser/encoder, walker support — previously stubbed as `nop` in the binary parser); `CoalesceLocals` rewritten to multi-segment liveness (each `local.set` opens a new segment, interference checked per-segment) — catches sequentially-used locals the old single-interval scan missed. 225/225 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 8.1   | ✅ Done    | EH closure — three deferred Phase 8 items shipped: WAT inline-body `try` now accepts inline instructions (not just the `(do ...)` wrapped form); `DCE` is EH-aware (`Try`/`TryTable` cases added; `eliminateDeadBlock` now actually recurses into nested constructs); new `StripEH` pass rewrites `Throw`/`ThrowRef`/`Rethrow`/`Try`/`TryTable` for callers that need to strip the EH proposal entirely. 14 new tests; 239/239 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.1   | ✅ Done    | Phase 0 closure — `BinaryenInterop.create()` in-process binaryen.js bridge. Was a stubbed `Promise.reject`. New `optimizeWat` / `optimizeBinary` honor `{ optimizeLevel, shrinkLevel, passes }` or shorthand (`-Oz`, `-O3`, …). Type stubs split into the actual upstream shape (`BinaryenJsLib` factory + `BinaryenWrappedModule` instance). Default specifier `"npm:binaryen"` (Deno/Bun resolve natively; Node needs `npm install binaryen`); a pre-loaded `{ binaryen: <factory> }` escape hatch skips the import for tests / browser. 12 new mock tests (real-binaryen test gated on `BINARYEN_LIVE=1`); 251/251 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5.1c  | ✅ Done    | Phase 5.1 CLI flag wiring closure — `--partial-inlining-ifs N` / `-pii N` wired through the `wasm-opt` arg parser and forwarded to the upstream subprocess in `--hybrid` mode; previously settable programmatically only. `parseArgs` + `ParsedArgs` exported from `src/tools/wasm-opt.ts` for embedders. 4 new arg-parser tests; 260/260 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12.1  | ✅ Done    | `npm:binaryen` compat facade closure — the two parity gaps Phase 12 left open are now implemented. **Programmatic construction**: `new binaryen.Module()` no-arg constructor + builder instance methods (`addFunction`, `addFunctionImport`, `addGlobal`, `addGlobalImport`, `addMemoryImport`, `setMemory`, `addExport` and per-kind variants); seven singleton namespace classes (`I32Ops`, `I64Ops`, `F32Ops`, `F64Ops`, `LocalOps`, `GlobalOps`, `MemoryOps`) reachable via `mod.i32`, `mod.local`, etc. so call sites match upstream verbatim; top-level expression factories (`block`, `if`, `loop`, `br`, `br_if`, `switch`, `call`, `return_call`, `call_indirect`, `return`, `nop`, `unreachable`, `drop`, `select`); new `createType` helper; 24 `ExpressionId*` numeric constants. **`Module.runPasses([names])`** runs an explicit pass list via `PassRunner` honoring the module-level optimization state (throws on unknown pass names). Plus `Module.validate()` (returns `1`, the upstream "valid" sentinel) and `Module.dispose()` (no-op) for parity. 11 new tests; 271/271 passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —     | ✅ Done    | Binary round-trip correctness on real-world wasm — strengthened the parse→encode verifier to run `WebAssembly.compile()` on the re-encoded output (not just structural counts), then fixed the bugs it surfaced on real DWARF-bearing modules (zlib, fannkuch, cubescript, …): signed-LEB128 5-/10-byte boundary decoding; `return` / unconditional `br` / `br_table` now typed `unreachable` per upstream `finalize` (so a block ending in one isn't mistyped); imported-function references unified onto the `$func${globalIndex}` naming the encoder's index map expects (calls to imports no longer collapse to index 0); and the loop/`try_table` multi-expression body wrapper is anonymous and carries the construct's declared result type (so a result-typed loop exiting via a back-edge `br` validates). Every real-world MVP module in the corpus now round-trips to a `WebAssembly.compile`-valid binary. 288/288 tests passing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| —     | ✅ Done    | Optimizer behavioral-equivalence hardening — built a differential check that instantiates the original input and our `-Oz` output with identical deterministic import stubs, calls each numeric-signature export in lockstep, and compares trap/return + final memory state (two stubbed instances stay bit-identical iff the optimization preserved semantics). The check surfaced — and six were fixed — semantic bugs that the parse→encode-validity check alone missed: (a) **element segments were silently dropped** on round-trip (parser parsed, then discarded — table never initialized, every `call_indirect` trapped); (b) **`LocalCSE` / `Vacuum` / `SimplifyLocals` clobbered a block's declared result type** by recomputing it from an `unreachable` tail child, breaking any result-typed block whose body exits via `br`/`return`; (c) **`makeIf` mistyped an `if` whose `then` arm was unreachable as `unreachable`** instead of taking the reachable `else` arm's type, which caused DCE to delete live code after such `if`s — including loop back-edges (silently breaking the loop); (d) **`CoalesceLocals`' rewrite lost original-node identity** when `mapExpression`'s unconditional spread rebuilt every ancestor of any renamed `local.get`, so the `effectiveSet.has(originalNode)` check always missed and EVERY `local.set` became a `drop` — the function returned 0; fixed by stamping a `Symbol` marker on ineffective sets during a pre-walk (symbol-keyed own properties survive object spread); (e) **`LocalCSE` left stale cache entries across a child that writes the cached local**, so a `tee` capturing the pre-write value was substituted for a later read of the post-write value, silently reading the wrong slot across the intervening `local.set` — `_fib(7)` came out as `fib(8) = 34`; fixed by post-invalidating each child's writes after rewrite. Head-to-head against `npm:binaryen@^116` on the wasic `-Oz` workload across a size-spread corpus: **7/7 both validate, ours ~14× faster, code-section size ~1.13× of upstream `-Oz` aggregate** (ours modestly less aggressive, as expected from a leaner pass set). **All 8 sampled MVP corpus modules now show zero behavioral divergence under full `-Oz`** — the WT-2 verdict "migration viable" is now backed by full equivalence on the sampled surface. 293/293 tests passing |
| —     | ✅ Done    | Round-1 wasmtk integration bug fixes — two real-world bugs reported by the wasmtk team after they began migrating from `npm:binaryen` to `@jrmarcum/binaryen-ts/compat`, surfacing as 4 test failures across phases 11/12/13. (a) **A single-arm `(if cond (then BODY))` was round-tripped with BODY in the ELSE arm** — the binary parser's end-of-frame handler treated `if` and `if/else` frames the same, but a single-arm `if` never assigns `frame.thenExprs`, so the BODY (accumulated in `frame.exprs`) ended up in the else arm and the then arm was empty. This silently inverted every wasic-emitted break condition, bounds check, and null guard, producing memory-out-of-bounds and null-function-call errors. (b) **EH tag exports were silently dropped** at parse time (no `case 0x04` in the export-section reader) AND, when re-emitted, **the tag's type-index was looked up against a different type collection than the one the binary's type section was actually emitted from** — so the tag pointed at an arbitrary entry of the wrong arity (the user observed `(param i32 i32)` becoming `(param f32) (result f64)` after a round-trip with multiple type entries). Three sub-fixes (parser tag-export case, encoder tag-export case, encoder tag-section's heap-types-aware type-index lookup) plus extending the `WasmExport.kind` union to include `"tag"`. 2 new regression tests; 295/295 passing; all 8 corpus equivalence files still green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| —     | ✅ Done    | Round-2 wasmtk integration bug fix — **expression-form (flag-4) element segments were silently dropped on round-trip**, leaving function tables unpopulated so every `call_indirect` trapped with `RuntimeError: null function` (V8 still accepted the binary). The binary parser's element-section reader only handled the legacy flag-0 form (a vector of raw function indices); `wabt` with reference-types enabled — which every `wabt-ts` front-end pass uses — encodes `(elem (offset) func $a $b)` as flag 4 (a vector of `ref.func` **expressions**), and any non-zero flag was silently skipped. Rewrote the reader to decode all eight element-segment flag forms; active segments (flags 0/2/4/6) are materialized, passive/declarative (1/3/5/7) are parsed for byte-alignment but not yet materialized (table.init / declarative forward-decl remain non-MVP). This was the root cause of the three remaining wasmtk failures, all of which dispatch `Array.map`/`filter`/`forEach` callbacks through funcref tables. 1 new regression test (hand-crafted flag-4 module, asserts segment survival + correct `call_indirect` dispatch after parse→encode→instantiate); 296/296 passing. |

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

# Lint
deno task lint

# CI bundle (check + test) — mirrors what GitHub Actions runs, minus fmt/lint/publish dry-run
deno task ci
```

`deno fmt` and `deno lint` are configured to skip the `upstream/` reference clone (formerly a git
submodule, now gitignored) so local runs see the same file set CI does.

## Publishing

The package is published to [JSR](https://jsr.io/@jrmarcum/binaryen-ts) with
[OIDC provenance](https://docs.jsr.io/publishing-packages#publishing-from-github-actions) via GitHub
Actions. The pipeline:

1. Bump `version` in [deno.json](deno.json) — easiest via:

   ```sh
   deno task bump
   ```

   This advances `version` under the project rule that each sub-version (patch, minor) caps at 9
   before rolling into the next greater segment (so `1.0.9 → 1.1.0`, `1.9.9 → 2.0.0`, and major is
   uncapped). The task only edits `deno.json` — commit/tag/push are separate user steps.
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

5. After the JSR publish succeeds, the workflow runs `gh release create` with `--generate-notes` to
   automatically create a matching
   [GitHub Release](https://github.com/jrmarcum/binaryen-ts/releases) for the tag. Release notes are
   derived from commit messages and PR titles since the previous tag, and can be edited on GitHub
   after the fact.

Local dry-run (verifies the manifest without publishing):

```sh
deno task publish:dry
```

> **`deno task publish` is the local release driver** — it commits `deno.json`, tags `vX.Y.Z`, and
> pushes commit + tag in a single atomic `git push origin main vX.Y.Z`. The tag push fires
> `publish.yml`, which is the only place `deno publish` itself ever runs (the workflow's OIDC token
> is what stamps the JSR provenance). The script will NEVER run `deno publish` from your machine.
>
> **Working-tree guard**: the script refuses to run if you have uncommitted changes to any tracked
> file outside `deno.json`. Without this guard, the bump commit would silently ship to JSR
> containing only the version bump — your actual source changes would be left behind in the working
> tree. Untracked files (new diagnostic scripts, scratch work) don't block; only modified tracked
> files do. Recovery is in the guard's error message: `git add -A && git commit -m '...'` first,
> then `deno task bump` → `deno task publish`.
>
> **Watch the workflow after the tag push** — `publish.yml` runs `deno task check` and
> `deno task test` before publishing. CI starts with no Deno type-check cache; locally those steps
> can pass while a type change in file A leaves file B's cached PASS result reused even though B's
> types now resolve differently. If you see a tag on the repo but no JSR version and no GitHub
> Release, check the Actions tab first — the workflow may have died on type-check.

## External references

This repo does not depend on any other source tree at build time. Two related projects are useful to
keep on disk for cross-reference, but they are **not** tracked from inside this repo — both are
gitignored so the publish manifest stays clean and CI clones stay fast.

- **`upstream/`** — Read-only clone of
  [WebAssembly/binaryen](https://github.com/WebAssembly/binaryen). Consult its `src/` when porting
  passes or parsing logic. Refresh whenever you want:

  ```sh
  cd upstream && git pull
  ```

- **wabt-ts** — Sibling TypeScript port of [wabt](https://github.com/WebAssembly/wabt) at
  [jsr:@jrmarcum/wabt-ts](https://jsr.io/@jrmarcum/wabt-ts). Provides the WAT front door and the IR
  bridge that walks wabt's tree into binaryen-ts's constructor API. binaryen-ts does **not** import
  wabt-ts; the dependency arrow points the other way (wabt-ts imports `@jrmarcum/binaryen-ts/ir` and
  `/encoder`). Keep a sibling clone next to this repo if you want to read its source:

  ```sh
  cd .. && git clone https://github.com/jrmarcum/wabt-ts.git
  ```

## License

binaryen-ts is licensed under the [MIT License](LICENSE).

An Apache-2.0 alternative is provided in [LICENSE-APACHE](LICENSE-APACHE) for users whose project
policies require an Apache-2.0-compatible upstream — pick whichever fits your needs. The upstream
Binaryen project itself is Apache-2.0; attribution to the upstream is retained either way.

JSR records the declared package license as MIT.
