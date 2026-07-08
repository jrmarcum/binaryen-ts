# Overview

`binaryen-ts` is a **cross-runtime TypeScript port of
[WebAssembly/binaryen](https://github.com/WebAssembly/binaryen)**, the C++ WebAssembly compiler
infrastructure behind `wasm-opt`, Emscripten, and many toolchains. It is published to JSR as
**`@jrmarcum/binaryen-ts`** and runs on **Deno 1.40+, Node 18+, Bun, and modern browsers** from a
single source tree.

- **Repository:** <https://github.com/jrmarcum/binaryen-ts>
- **Upstream reference:** <https://github.com/WebAssembly/binaryen>
- **Authoring runtime:** Deno 2.x (canonical — drives `deno task` scripts and the JSR publish)
- **Current version:** v1.3.9 (see [phases.md](phases.md) / [publishing.md](publishing.md))

## Role in the toolchain

binaryen-ts is the **optimizer**: IR, optimization passes, and `wasm-opt`. It is one of three
projects that will eventually merge into a single project called **`binaryang`**:

| Project         | Role                                                                                           | JSR                     |
| --------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| wasmtk          | WASM compiler, bundler (`wasmbundler`), `wasic` compiler                                       | `@jrmarcum/wasmtk`      |
| wabt-ts         | Format tools: `wat2wasm`, `wasm2wat`, `wasm-validate`, `wasm-objdump`, `wasm-strip`, `wasm2ts` | `@jrmarcum/wabt-ts`     |
| **binaryen-ts** | **Optimizer: IR, optimization passes, `wasm-opt`**                                             | `@jrmarcum/binaryen-ts` |

Design package boundaries to keep the eventual binaryang merge clean. See [bridge.md](bridge.md) for
the cross-project agreements.

### NOT in scope for binaryen-ts (handled elsewhere)

WAT printer / `wasm-dis`, `wasm-as`, validation → wabt-ts. `wasm2js`, `wasm-shell`/interpreter →
Deno & Bun run wasm natively. `wasm-merge` → wasmtk's `wasmbundler`. `wasm-ctor-eval`,
`wasm-reduce`, Relooper, `wasm2c` (→ wabt-ts `wasm2ts`), Python dev scripts → out of scope.

## The two-path optimization pipeline

Both paths are first-class:

```text
Bridge path (production route when wabt-ts has already processed the module):
  WAT / .wasm → wabt-ts parser → wabt IR → IR bridge → binaryen IR
              → binaryen-ts passes → binaryen-ts encoder → .wasm → wasmtime

Direct path (pure optimization, no prior wabt-ts step):
  .wasm → binaryen-ts parseWasm() → binaryen IR → passes → encoder → .wasm
```

Re-serializing to binary between wabt-ts and binaryen-ts steps just to use the direct path is
wasteful and wrong — use the bridge.

## Repo layout

```text
binaryen-ts/
├── main.ts             CLI entry point (cross-runtime via node:process)
├── deno.json           Deno config + JSR exports (canonical package manifest)
├── src/
│   ├── ir/             WASM IR — types, gc-types, expressions (+ factory fns), module builder, walk
│   ├── parser/         WAT text parser (tokenizer → S-expr → IR)
│   ├── binary/         WASM binary parser (.wasm → IR)  [reader.ts = LEB128 etc.]
│   ├── encoder/        WASM binary encoder (IR → .wasm)
│   ├── passes/         Optimization pass registry + runner + cfg.ts liveness infra
│   ├── tools/          CLI tools (wasm-opt)
│   ├── api/            High-level public API (index.ts) + binaryen-compat.ts (npm:binaryen facade)
│   ├── interop/        Upstream binaryen.js hybrid bridge
│   ├── wasm/           Embedded WASM kernels (.wat sources + auto-gen *_bytes.ts)
│   └── wasm-runtime.ts Lazy load + cache for embedded kernels
├── tests/              Deno.test suites mirroring src/ (parser/ binary/ encoder/ passes/ tools/ wasm/ api/ interop/)
├── benches/            Deno.bench boundary-cost benchmarks
├── scripts/            Build + release scripts (gen_demo_bytes.ts, publish.ts, bump_version.ts, version.ts, diagnostics)
├── upstream/           Upstream binaryen C++ source (gitignored local clone, read-only reference)
└── cmem/               this portable project-memory folder
```

`upstream/` is the C++ binaryen source — **consult it when porting passes/parsing**; it is not
built. It was a git submodule through Phase 10, then untracked + gitignored (see
[publishing.md](publishing.md) "submodule remnant gotcha"). `wabt-ts` is no longer a folder here;
the sibling clone lives at `../wabt-ts/` — consult it for bridge work, never write to it from inside
this repo.

### Key upstream reference files

- `upstream/src/parser/lexer.h` — WAT lexer character classes / token types
- `upstream/src/parser/wat-parser.cpp` — WAT module + expression parsing
- `upstream/src/wasm.h` — all IR expression types (`ExpressionId` enum)
- `upstream/src/passes/` — each optimization pass in its own `.cpp` file
- `upstream/src/binaryen-c.h` — public C API (validates the TS constructor-API shape)
- `upstream/src/js/binaryen.js-post.js` — the binaryen.js JS surface (validates `/compat` + interop)

## Developer notes (IR invariants)

- The IR is a **tree** — each expression has exactly one parent; never reuse nodes across positions.
  Factory functions (`makeI32Const`, `makeBinary`, …) always create new objects.
- Binaryen IR has an `unreachable` type not present in the wasm spec.
- The pass runner auto-fixes non-nullable local validation after each pass
  (`requiresNonNullableLocalFixups()` in upstream `pass.h`).
  </content>
  </invoke>
