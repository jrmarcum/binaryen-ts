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

The shim runs the same `PassRunner` + `addDefaultOptimizationPasses()` pipeline used by the native
CLI, so optimization output is produced by the in-tree TypeScript passes — not by `wasm-opt` or
upstream binaryen.js. Numeric type IDs (`binaryen.i32` = 2, `binaryen.i64` = 3, …) and external kind
constants (`binaryen.ExternalFunction` = 0, …) match the upstream values, so type-discriminator
helpers like the common `getTypeName(typeId)` switch on identical numbers.

What the facade does **not** cover today: programmatic module construction (`new binaryen.Module()`
plus low-level `binaryen.Const` / `binaryen.Add` / … factories) — for that, drop down to the native
[`/api`](#module-exports-jsr) entry point and use `createModule` + `ExprBuilder` instead.

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

| Phase | Status     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | ✅ Done    | Project setup, upstream submodule, IR type system, pass infrastructure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1     | ✅ Done    | WAT text parser (WASM → IR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2     | ✅ Done    | WASM binary parser (binary → IR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3     | ✅ Done    | WASM binary encoder (IR → .wasm) — full round-trip verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4     | ✅ Done    | Core optimization passes — 9 passes (Vacuum, OptimizeInstructions, CoalesceLocals, LocalCSE, …)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5     | ✅ Done    | Inlining pass — `Inlining` + `InliningOptimizing`, call-graph analysis, dead-callee removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6     | ✅ Done    | `wasm-opt` native CLI — pure TypeScript pipeline, no subprocess; `RemoveUnusedNames` pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7     | ✅ Done    | GC proposal — heap types, struct/array/ref instructions, binary parser + encoder + WAT parser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8     | ✅ Done    | Exception-handling proposal — tags, throw/throw_ref/rethrow/try_table, binary parser + encoder + WAT parser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9     | ✅ Done    | SIMD instructions — v128, all lane types, 0xFD prefix decoder + encoder + WAT parser, 20/20 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10    | ✅ Partial | WASM-kernel runtime + dogfood embed pipeline; demo kernel + boundary-cost benchmark prove single-op dispatch regresses, kernel migration deferred until profiling identifies workloads that amortize the ~3 ns/call WASM boundary tax                                                                                                                                                                                                                                                                                                                                                                                                            |
| 11    | ✅ Done    | Cross-runtime migration + JSR publish hardening — single source tree runs on Deno, Node 18+, Bun, and modern browsers; tag-push CI publishes to JSR with OIDC provenance; license arrangement: MIT primary + Apache-2.0 alternative; JSDoc symbol coverage clean (0 `deno doc --lint` errors); 179/179 tests passing                                                                                                                                                                                                                                                                                                                             |
| 11.1  | ✅ Done    | CI hardening + automated GitHub Release — `deno fmt`/`deno lint` clean across `src/` and `tests/`; `@std/assert` declared via import map; `actions/checkout` bumped to `@v6` (Node 24 runtime); publish workflow auto-creates a matching GitHub Release on tag push                                                                                                                                                                                                                                                                                                                                                                              |
| 11.2  | ✅ Done    | Code-review housekeeping — LocalCSE internal cleanup (dropped dead `fn` parameter, hoisted `Object.values(ValType)` to a Set cache, single-pass candidate construction); JSDoc factory references corrected in `src/ir/expressions.ts`; no behavioral change, 179/179 tests still pass                                                                                                                                                                                                                                                                                                                                                           |
| 11.3  | ✅ Done    | Local-publish guardrail — `deno task publish` now refuses to run outside GitHub Actions (delegates to `scripts/guarded_publish.ts`, which checks `GITHUB_ACTIONS=true` and execs `deno publish` only inside CI); enforces the Phase 11 rule that JSR provenance requires the OIDC-issuing workflow, no behavioral change to CI                                                                                                                                                                                                                                                                                                                   |
| 11.4  | ✅ Done    | Version-aware release ergonomics — new `deno task bump` advances `deno.json` `version` under the project rule that sub-versions (patch, minor) max at 9 before rolling into the next greater segment (1.0.9 → 1.1.0, 1.9.9 → 2.0.0; major uncapped); guard's refusal message now substitutes the actual current + next version into the printed git commands instead of abstract `vX.Y.Z` placeholders                                                                                                                                                                                                                                           |
| 11.5  | ✅ Done    | Auto-tag on main version bump — new `.github/workflows/auto-tag.yml` fires on `push: branches: main`, reads `deno.json` `version`, and (if the matching `vX.Y.Z` tag does not yet exist) creates + pushes it then dispatches `publish.yml` via `gh workflow run`; closes the gap where version bumps committed to `main` without an accompanying tag push silently skipped publishing                                                                                                                                                                                                                                                            |
| 11.6  | ✅ Done    | Release driver + CI provenance fix — `scripts/guarded_publish.ts` renamed to `scripts/publish.ts` and rewritten to actually _run_ the release (stage `deno.json`, commit, force-tag, push commit + tag atomically); `publish.yml` now calls `deno publish` **directly** instead of `deno task publish` — the previous indirection through `Deno.Command` was stripping JSR provenance because the OIDC token does not propagate cleanly into the subprocess (matches sibling `wasmtk`'s workflow shape)                                                                                                                                          |
| 12    | ✅ Done    | `npm:binaryen` compatibility facade — new `@jrmarcum/binaryen-ts/compat` export exposes the upstream binaryen.js namespace API (`readBinary`, `Features`, `setShrinkLevel`/`setOptimizeLevel`, `Module.optimize` / `setFeatures` / `emitBinary` / `getNumExports` / `getExportByIndex` / `getFunction`, and the inspection trio `getExportInfo` / `getFunctionInfo` / `expandType` plus numeric type ID + external kind constants); also fixed `Module.toBinary()` in `src/api/index.ts` to wire through the existing `encodeWasm` encoder (the previous stale `throw new Error("not yet implemented")` predated Phase 3); 191/191 tests passing |
| 5.1   | ✅ Done    | Phase 5 inlining closure — InliningOptimizing now actually runs Vacuum + OptimizeInstructions on modified function bodies (its `optimize` flag was previously a no-op); split / partial inlining (Pattern A and Pattern B from upstream) added via new `PassOptions.partialInliningIfs` (default 0, opt-in); 210/210 tests passing                                                                                                                                                                                                                                                                                                               |
| 13    | ✅ Done    | Tail-call proposal binary support — `return_call` (opcode `0x12`) and `return_call_indirect` (`0x13`) wired end-to-end through binary parser + binary encoder + WAT parser (the IR's `isReturn` field was previously unused). 5 new binary round-trip tests, 215/215 passing                                                                                                                                                                                                                                                                                                                                                                     |
| 5.2   | ✅ Done    | Return-call inlining — when inlining a `return_call $f(args)`, the callee's `return` statements propagate as the caller's returns directly (matching tail-call semantics); the wrapper block is wrapped in `(return ...)` so fall-through also returns from the caller. Closes the only remaining Phase 5 inliner gap. 218/218 passing                                                                                                                                                                                                                                                                                                           |
| 7.1   | ✅ Done    | Pre-Phase-8 closure — three loose-end items: `parseCallIndirect` now resolves `(type $sig)` references via a `funcTypeDefs` map; `table.get` / `table.set` ported end-to-end (new IR nodes + factories, WAT parser, binary parser/encoder, walker support — previously stubbed as `nop` in the binary parser); `CoalesceLocals` rewritten to multi-segment liveness (each `local.set` opens a new segment, interference checked per-segment) — catches sequentially-used locals the old single-interval scan missed. 225/225 passing                                                                                                             |
| 8.1   | ✅ Done    | EH closure — three deferred Phase 8 items shipped: WAT inline-body `try` now accepts inline instructions (not just the `(do ...)` wrapped form); `DCE` is EH-aware (`Try`/`TryTable` cases added; `eliminateDeadBlock` now actually recurses into nested constructs); new `StripEH` pass rewrites `Throw`/`ThrowRef`/`Rethrow`/`Try`/`TryTable` for callers that need to strip the EH proposal entirely. 14 new tests; 239/239 passing                                                                                                                                                                                                           |
| 0.1   | ✅ Done    | Phase 0 closure — `BinaryenInterop.create()` in-process binaryen.js bridge. Was a stubbed `Promise.reject`. New `optimizeWat` / `optimizeBinary` honor `{ optimizeLevel, shrinkLevel, passes }` or shorthand (`-Oz`, `-O3`, …). Type stubs split into the actual upstream shape (`BinaryenJsLib` factory + `BinaryenWrappedModule` instance). Default specifier `"npm:binaryen"` (Deno/Bun resolve natively; Node needs `npm install binaryen`); a pre-loaded `{ binaryen: <factory> }` escape hatch skips the import for tests / browser. 12 new mock tests (real-binaryen test gated on `BINARYEN_LIVE=1`); 251/251 passing                    |

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

> **Heads-up**: `deno task publish` is **not** for local use. It runs a guard that refuses to
> execute unless `GITHUB_ACTIONS=true` is set, because a local `deno publish` would upload to JSR
> without provenance and permanently flag that version. The refusal message prints the actual
> current and next version from `deno.json`, so the suggested `git commit`/`git tag`/`git push`
> commands are copy-pasteable.

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
