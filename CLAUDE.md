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
├── CLAUDE.md     Project context for Claude Code (this file)
└── LICENSE       Apache-2.0
```

The upstream C++ binaryen source lives entirely in `upstream/` and is not built.
Consult it when porting passes or parsing logic to TypeScript.

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
| 2 | Planned | WASM binary parser |
| 3 | Planned | WAT/WASM serializer (IR → text / binary) |
| 4 | Planned | Core optimization passes (Vacuum, RemoveUnusedBrs, OptimizeInstructions, etc.) |
| 5 | Planned | Inlining pass |
| 6 | Planned | `wasm-dis` / `wasm-as` CLI tools |
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
