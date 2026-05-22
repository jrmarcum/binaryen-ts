# CLAUDE.md — Project Context for Claude Code

## Project Overview

This is a TypeScript/Deno rewrite of the [Binaryen](https://github.com/WebAssembly/binaryen) WebAssembly compiler infrastructure, published to JSR as `@jrmarcum/binaryen-ts`.

- **Repository**: <https://github.com/jrmarcum/binaryen-ts>
- **Upstream reference**: <https://github.com/WebAssembly/binaryen>
- **Primary language**: TypeScript (Deno)
- **JSR package**: `@jrmarcum/binaryen-ts`
- **Local path**: `d:\Programs\_ProgramExamples\Example_Programs\wasmExamples\binaryen-ts`

## What Binaryen Does

Binaryen is a compiler and toolchain infrastructure library for WebAssembly. Key tools:

- `wasm-opt` — WebAssembly optimizer (runs IR passes to reduce size/improve speed)
- `wasm-as` / `wasm-dis` — WebAssembly assembler/disassembler
- `wasm2js` — WebAssembly to JavaScript compiler
- `binaryen.js` — JavaScript/Node.js API for creating and optimizing Wasm modules

## Repository Structure

```text
binaryen-ts/
├── src/          TypeScript source
│   ├── ir/           WASM IR — types, expression nodes, module builder
│   ├── parser/       WAT text parser (tokenizer → S-expr → IR)
│   ├── passes/       Optimization pass registry and runner
│   ├── tools/        CLI tools (wasm-opt, ...)
│   ├── api/          High-level public API
│   └── interop/      Upstream binaryen.js hybrid bridge
├── tests/        Test suite
├── main.ts       CLI entry point
├── deno.json     Deno config, JSR exports, provenance publishing
├── TASKS.md      Phase-by-phase port task list
├── upstream/     Upstream Binaryen C++ source (git submodule, read-only reference)
├── wabt-ts/      Sibling project — wabt TypeScript port (git submodule, read-only reference)
├── CLAUDE.md     Project context for Claude Code (this file)
├── LICENSE       Dual-license notice (MIT OR Apache-2.0)
├── LICENSE-MIT   MIT license text
└── LICENSE-APACHE  Apache License 2.0 text (copied from upstream)
```

The upstream C++ binaryen source lives entirely in `upstream/` and is not built.
Consult it when porting passes or parsing logic to TypeScript.

`wabt-ts/` is tracked for cross-project coordination — particularly the IR bridge
handshake and Phase 2 IR design alignment. Read-only reference; do not modify.

## Key Upstream Reference Files

- `upstream/src/parser/lexer.h` — WAT lexer character classes and token types
- `upstream/src/parser/wat-parser.cpp` — WAT module and expression parsing
- `upstream/src/wasm.h` — All IR expression types (`ExpressionId` enum)
- `upstream/src/passes/` — Each optimization pass in its own `.cpp` file
- `upstream/src/binaryen-c.h` — Public C API (used to validate TypeScript API shape)

## Developer Notes

- The IR is a **tree structure** — each expression must have exactly one parent; do not reuse nodes across the tree.
- Binaryen IR has an `unreachable` type not present in the wasm spec.
- Pass runner automatically fixes up non-nullable local validation after each pass (`requiresNonNullableLocalFixups()` in `pass.h`).

## Testing

```sh
deno task check   # type-check all files
deno task test    # run test suite
deno task fmt     # format
```

## Ecosystem Context

binaryen-ts is one of three projects in the toolchain. Understanding the division of labor
is important when deciding whether to port a component here or defer to a sibling project.

| Project | Role | JSR |
| ------- | ---- | --- |
| wasmtk | WASM compiler, bundler (`wasmbundler`), `wasic` compiler | `@jrmarcum/wasmtk` |
| wabt-ts | Format tools: `wat2wasm`, `wasm2wat`, `wasm-validate`, `wasm-objdump`, `wasm-strip`, `wasm2ts` | `@jrmarcum/wabt-ts` |
| binaryen-ts | Optimizer: IR, optimization passes, `wasm-opt` | `@jrmarcum/binaryen-ts` |

**Planned merger**: All three projects will eventually merge into a single project called
**`binaryang`**. Design decisions should keep the package boundaries clean to make that
merge straightforward.

### What is NOT in scope for binaryen-ts (handled elsewhere)

| Component | Reason |
| --------- | ------ |
| WAT printer / `wasm-dis` | wabt-ts (`wasm2wat`) |
| `wasm-as` | wabt-ts (`wat2wasm`) |
| Validation | wabt-ts (`wasm-validate`) |
| `wasm2js` | Deno/Bun run wasm natively |
| `wasm-shell` / interpreter | Deno/Bun have native wasm JIT |
| `wasm-merge` | wasmtk covers via wasmbundler |
| `wasm-ctor-eval` | Not in toolchain critical path |
| `wasm-reduce` | C++ dev tooling only |
| Relooper | Not needed for the pass set being ported |
| `wasm2c` | wabt-ts `wasm2ts` replaces it |
| Python scripts | All dev/CI tooling; no functional role in the optimizer |

## Cross-Project Architecture (binaryen-ts ↔ wabt-ts coordination)

These decisions were agreed between binaryen-ts and wabt-ts and must be respected
in both projects. The eventual merger target is **binaryang**.

### Agreed pipeline

```text
WAT / .wasm input
    ↓  wabt-ts parser         → wabt format IR (tree-shaped, post-order traversable)
    ↓  IR bridge              → binaryen optimization IR   ← the architectural join
    ↓  binaryen-ts passes     → optimized binaryen IR
    ↓  binaryen-ts encoder    → .wasm output
    ↓  wasmtime               → native execution
    ↓  canonical ABI          → component boundary (wasmtk's concern)
```

There is also a **direct path** for pure optimization (no prior wabt-ts processing):

```text
.wasm binary → binaryen-ts parseWasm() → binaryen optimization IR → passes → encoder
```

Both paths are first-class. The bridge path is the production route when wabt-ts tools
(validate, strip, etc.) have already processed the module. Re-serializing to binary
between wabt-ts and binaryen-ts steps just to use the direct path is wasteful and wrong.

### Five agreed decisions

| Decision | Resolution |
| -------- | ---------- |
| Binary encoder ownership | binaryen-ts encoder = canonical output for optimized wasm; wabt-ts encoder = format tools and round-trip fidelity only |
| WAT parser front door | wabt-ts WAT parser = front door for all external input (user-authored .wat, wasmtk source); binaryen-ts WAT parser = internal IR construction, tests, and pass development only |
| Bridge architecture | Bridge = wabt-ts calling binaryen-ts constructor API directly; not a separate translation layer |
| wabt-ts IR shape | Tree-shaped (not flat stack-machine list); post-order traversable; no parent context required to resolve a child node; no upward references |
| binaryang merger | All three projects (wasmtk, wabt-ts, binaryen-ts) eventually merge into binaryang; design package boundaries to make that merge clean |

### IR bridge design constraints

The bridge reduces to a single recursive post-order walk over the wabt format IR,
calling binaryen constructor functions at each node. For this to work:

- wabt-ts expression nodes must be resolvable bottom-up (children before parents)
- No node may require parent context to be constructed
- binaryen-ts constructor API must be flat, stable, and complete for all MVP opcodes

The original binaryen C API (`BinaryenConst()`, `BinaryenBinary()`, `BinaryenAddFunction()`,
etc.) demonstrates the right shape. The TypeScript constructor API inherits that property
intentionally: `makeI32Const`, `makeBinary`, `makeBlock`, `ModuleBuilder.addFunction`, etc.

### Constructor API status and gap

Phase 0 established the constructor API. Phase 2 (binary parser) is the stabilization
exercise — the parser is the first client that must call a constructor for every MVP opcode.
Known gaps (IR types defined but factory functions missing as of Phase 1 completion):
`makeGlobalGet`, `makeGlobalSet`, `makeLoad`, `makeStore`, `makeCallIndirect`, `makeLoop`,
`makeBreak`, `makeBrTable`, `makeSelect`, `makeMemorySize`, `makeMemoryGrow`.
Phase 2 will surface and fill all remaining gaps.

### Handshake plan with wabt-ts

1. Module-level constructor signatures (`ModuleBuilder.addFunction`, `addGlobal`,
   `addMemory`, `addFunctionImport`, `addExport`) are already stable — share with
   wabt-ts immediately for early boundary validation.
2. When Phase 2 instruction decoder reaches MVP opcode completeness, flag wabt-ts.
3. wabt-ts performs a dry-run: walk a sample wabt IR and map each node to a binaryen
   constructor call, without committing to bridge implementation.
4. Both sides review for structural mismatch before either project commits to the bridge.

## Portability Note

All project context for Claude Code lives in this file (`CLAUDE.md`) to keep the project fully portable across machines. Do not store project-specific knowledge in machine-local Claude memory.

---

## TypeScript Port — binaryen-ts

### Architecture

```text
binaryen-ts/
├── main.ts             CLI entry point; dispatches sub-commands
├── deno.json           Deno config with JSR provenance publishing
├── src/
│   ├── ir/             WASM IR — types, expression nodes, module builder
│   │   ├── types.ts        ValType, Type, None, Unreachable
│   │   ├── expressions.ts  All ExpressionKind variants + factory fns
│   │   ├── module.ts       WasmModule, ModuleBuilder (fluent API)
│   │   └── index.ts        Re-exports
│   ├── parser/         WAT text parser (Phase 1)
│   │   ├── tokenizer.ts    WAT lexer → Token stream
│   │   ├── sexpr.ts        S-expression tree (List / Atom)
│   │   └── wat-parser.ts   S-expr tree → WasmModule IR
│   ├── passes/         Optimization pass registry and runner
│   │   ├── pass.ts         Pass interface, PassRunner, registry
│   │   ├── dce.ts          Dead code elimination (first working pass)
│   │   └── index.ts        Re-exports + side-effect pass registration
│   ├── tools/
│   │   └── wasm-opt.ts     wasm-opt CLI (native/hybrid dispatch)
│   ├── api/
│   │   └── index.ts        createModule, ExprBuilder, WAT stub serializer
│   └── interop/
│       └── binaryen-js.ts  Hybrid bridge to upstream binaryen.js WASM
└── tests/
    └── parser/         WAT parser round-trip tests
```

### Phase Status

| Phase | Status | Description |
| ----- | ------ | ----------- |
| 0 | ✅ Done | Foundation: IR types, expressions, module builder, pass infra, DCE, API, interop |
| 1 | ✅ Done | WAT text parser (tokenizer → S-expr → IR) — 47/47 tests passing |
| 2 | 🚧 Active | WASM binary parser |
| 3 | Planned | WASM binary encoder (IR → .wasm) — WAT text output handled by wabt-ts |
| 4 | Planned | Core optimization passes (Vacuum, RemoveUnusedBrs, OptimizeInstructions, etc.) |
| 5 | Planned | Inlining pass |
| 6 | Planned | `wasm-opt` native CLI (no subprocess dependency) |
| 7+ | Planned | GC, EH, SIMD, wasic compilation |

### Key Design Decisions

#### Hybrid mode (Phase 0 decision)

Three optimization tiers:

1. **Native TypeScript passes** — pure TypeScript in the pass registry (`src/passes/`).
2. **Subprocess hybrid** — pipe WAT through system `wasm-opt` binary (`BinaryenInterop.optimizeViaSubprocess`). Works today.
3. **binaryen.js WASM hybrid** — load upstream `binaryen.js` Emscripten binary. Planned Phase 1.

`hybridMode: true` on any optimization call routes to tier 2 (subprocess). Tier 3 is behind `BinaryenInterop.create()` which currently throws a not-implemented error.

#### WAT parser design (Phase 1)

Two-phase approach for debuggability:

1. **Tokenizer** (`tokenizer.ts`): character stream → flat `Token[]` array.
2. **S-expression builder** (`sexpr.ts`): `Token[]` → `SExpr` tree (List | Atom nodes).
3. **WAT parser** (`wat-parser.ts`): `SExpr` tree → `WasmModule` IR.

Choosing NOT to port the upstream C++ lexer directly — the C++ lexer is a streaming pull-parser optimized for C++ iterators. The TypeScript version uses a simpler up-front tokenize-all approach that is easier to test and debug.

#### JSR provenance publishing

All exported symbols must have JSDoc. File-level `@module` tags required. `deno.json` has `"publish": { "provenance": true }`.

#### IR tree ownership

Same invariant as upstream Binaryen: each expression node must have exactly one parent. Never share `Expression` objects across tree positions. Factory functions (`makeI32Const`, `makeBinary`, etc.) always create new objects.

#### Upstream C++ reference

When porting any component, always check `upstream/src/` first. Key upstream files:

- `upstream/src/parser/lexer.h` — Lexer token types and character classes
- `upstream/src/parser/wat-parser.cpp` — WAT module/expression parsing logic
- `upstream/src/wasm.h` — All IR expression types (ExpressionId enum)
- `upstream/src/passes/` — Each pass in its own `.cpp` file
