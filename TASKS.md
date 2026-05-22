# binaryen-ts — Port Task List

This document tracks the work required to fully port Binaryen from C++ to TypeScript.
Each phase builds on the previous. The upstream C++ reference is at `upstream/`.

## Phase 0 — Project Foundation ✅ COMPLETE

- [x] Git submodule: `upstream/` → `https://github.com/WebAssembly/binaryen`
- [x] Deno project structure (`deno.json` with JSR settings)
- [x] IR type system (`src/ir/types.ts`) — `ValType`, `Type`, `None`, `Unreachable`, helpers
- [x] IR expression nodes (`src/ir/expressions.ts`) — all MVP + GC + EH + SIMD kinds defined
- [x] Module builder (`src/ir/module.ts`) — `WasmModule`, `ModuleBuilder` fluent API
- [x] Pass infrastructure (`src/passes/pass.ts`) — `Pass`, `PassRunner`, `PassOptions`, registry
- [x] DCE pass stub (`src/passes/dce.ts`) — dead code in blocks
- [x] High-level API (`src/api/index.ts`) — `createModule`, `Module`, `ExprBuilder`
- [x] binaryen.js interop bridge (`src/interop/binaryen-js.ts`) — subprocess + future binaryen.js
- [x] `wasm-opt` CLI tool (`src/tools/wasm-opt.ts`) — arg parsing, hybrid / native dispatch
- [x] CLI entry point (`main.ts`) — command dispatch
- [x] JSR-compliant `deno.json` with `provenance: true`
- [x] Full JSDoc on all exported symbols (JSR requirement)
- [x] `README.md` with JSR badges and usage examples

---

## Phase 1 — WAT Text Parser (WASM → IR) ✅ COMPLETE

Reference: `upstream/src/parser/` (C++ S-expression parser)

Two-phase design: tokenizer → S-expr tree → IR (chosen over porting the C++ streaming lexer).

- [x] Tokenizer (`src/parser/tokenizer.ts`) — WAT token stream; handles integers, floats (inc. hex, nan/inf, nan:0x...), strings, ids, keywords, line+block comments (nestable), position tracking
- [x] S-expression builder (`src/parser/sexpr.ts`) — `Token[]` → `SExpr` tree; query helpers (`listHead`, `listChildren`, `isListWith`, `atomString`, `sExprToString`, etc.)
- [x] WAT module parser (`src/parser/wat-parser.ts`)
  - [x] `(module ...)` top-level with optional name
  - [x] `(import ...)` — function imports with params/results
  - [x] `(func ...)` — params (named + unnamed), results, additional locals, body
  - [x] `(memory ...)` and `(table ...)`
  - [x] `(export ...)` standalone and inline `(export "name")` in func
  - [x] `(data ...)` — active and passive segments
- [x] Expression parser — all MVP instructions (all unary/binary ops, local.get/set/tee, global.get/set, call, call_indirect, memory.*, load/store, nop, unreachable, return, drop, select, block, loop, if/then/else, br, br_if, return_call)
- [x] All operator lookup tables (`UNARY_OPS`, `BINARY_OPS`) covering full MVP set
- [x] 47/47 tests passing (`tests/parser/tokenizer_test.ts`, `sexpr_test.ts`, `wat_parser_test.ts`)

**Bug fixed during Phase 1**: `-inf` / `-nan` sign dispatch — must route to `readKeywordOrSpecialFloat`, not `readNumber`, when sign is followed by `i` or `n`.

**Known gaps for future phases**:

- Global initializer expressions not yet built (deferred to second-pass; globals collected by name only)
- `br_table` (switch) expression not yet wired
- GC instructions (`struct.*`, `array.*`, `ref.*`) — stub as `nop`
- Round-trip test (parse → serialize → re-parse → compare) deferred to Phase 3 when serializer exists

---

## Phase 2 — WASM Binary Parser (binary → IR) 🚧 ACTIVE

Reference: `upstream/src/wasm-binary.h`, `upstream/src/parsing.h`

**Goal**: Read a `.wasm` binary file into the TypeScript IR. This is the primary input
path for the optimizer — WAT text ingestion is handled by wabt-ts.

Implementation files: `src/binary/reader.ts` (LEB128 + raw reads), `src/binary/wasm-parser.ts` (section + instruction decoder)

- [ ] Binary reader (`src/binary/reader.ts`)
  - [ ] `BinaryReader` class wrapping a `Uint8Array` with a position cursor
  - [ ] LEB128 unsigned (`readU32`, `readU64`)
  - [ ] LEB128 signed (`readI32`, `readI64`)
  - [ ] Raw reads: `readU8`, `readU16`, `readBytes(n)`, `readUTF8(n)`
  - [ ] EOF and bounds checking with descriptive errors
- [ ] Section parser (`src/binary/wasm-parser.ts`)
  - [ ] Magic + version header check (`\0asm`, version 1)
  - [ ] Section dispatch loop (id → handler)
  - [ ] Type section — function type signatures → `FuncType[]`
  - [ ] Import section — func/table/memory/global imports → `WasmImport[]`
  - [ ] Function section — type index per function
  - [ ] Table section — `WasmTable[]`
  - [ ] Memory section — `WasmMemory[]`
  - [ ] Global section — type + mutability + init expr → `WasmGlobal[]`
  - [ ] Export section — name + kind + index → `WasmExport[]`
  - [ ] Code section — local decls + instruction stream → function bodies
  - [ ] Data section — active (memory index + offset) and passive segments
  - [ ] Element section — function reference segments
  - [ ] Custom sections — skip gracefully (preserve name section if present)
- [ ] Instruction decoder — opcode byte(s) → `Expression` node
  - [ ] All MVP opcodes (control flow, numeric, memory, parametric)
  - [ ] Multi-byte opcodes: `0xFC` prefix (bulk memory, saturating trunc)
  - [ ] SIMD: `0xFD` prefix — stub as `nop` for now (Phase 9)
  - [ ] GC: `0xFB` prefix — stub as `nop` for now (Phase 7)
  - [ ] EH: `0x06`/`0x19` prefix — stub as `nop` for now (Phase 8)
- [ ] `parseWasm(bytes: Uint8Array): WasmModule` — public entry point
- [ ] Tests (`tests/binary/wasm_parser_test.ts`)
  - [ ] Parse magic/version rejection
  - [ ] Parse a minimal hand-crafted `.wasm` (add function)
  - [ ] Parse a `.wasm` produced by wasmtk or wabt-ts `wat2wasm`
  - [ ] Round-trip: WAT → `wat2wasm` (wabt-ts) → `parseWasm` → check IR shape

---

## Phase 3 — WASM Binary Encoder (IR → binary)

Reference: `upstream/src/wasm-binary.h`

**Goal**: Serialize the IR back to a `.wasm` binary. WAT text output is handled by
`wabt-ts` (`wasm2wat`) and is out of scope here.

- [ ] WASM binary encoder (`src/encoder/wasm-encoder.ts`)
  - [ ] LEB128 writer (signed + unsigned)
  - [ ] Section encoding for all section types (type, import, function, table, memory, global, export, code, data, element)
  - [ ] Code section: function bodies, instruction encoding
  - [ ] Data section with offset expressions
- [ ] Round-trip test: IR → WASM binary → parse (Phase 2) → IR (must be structurally equal)

---

## Phase 4 — Core Optimization Passes (TypeScript)

Reference: `upstream/src/passes/`

**Goal**: Port the most impactful passes from C++. Each pass is one `.ts` file in `src/passes/`.

- [ ] **Vacuum** (`vacuum.ts`) — remove nop, trivially dead expressions
  - Reference: `upstream/src/passes/Vacuum.cpp`
- [ ] **RemoveUnusedBrs** (`remove-unused-brs.ts`) — remove branches with no targets
  - Reference: `upstream/src/passes/RemoveUnusedBrs.cpp`
- [ ] **OptimizeInstructions** (`optimize-instructions.ts`) — peephole rewrites
  - Reference: `upstream/src/passes/OptimizeInstructions.cpp`
  - Priority rules: `i32.add(x, 0) → x`, `i32.mul(x, 1) → x`, etc.
- [ ] **CoalesceLocals** (`coalesce-locals.ts`) — reduce local variable count via liveness
  - Reference: `upstream/src/passes/CoalesceLocals.cpp`
- [ ] **SimplifyLocals** (`simplify-locals.ts`) — collapse local set/get pairs
  - Reference: `upstream/src/passes/SimplifyLocals.cpp`
- [ ] **LocalCSE** (`local-cse.ts`) — common subexpression elimination within functions
  - Reference: `upstream/src/passes/LocalCSE.cpp`
- [ ] **RemoveUnusedModuleElements** (`remove-unused-module-elements.ts`) — strip dead functions/globals
  - Reference: `upstream/src/passes/RemoveUnusedModuleElements.cpp`
- [ ] **PickLoadSigns** (`pick-load-signs.ts`) — choose sign-extend vs zero-extend for loads
  - Reference: `upstream/src/passes/PickLoadSigns.cpp`

---

## Phase 5 — Inlining Pass

Reference: `upstream/src/passes/Inlining.cpp`

**Goal**: Inline small call targets to eliminate call overhead.

- [ ] Call graph analysis
- [ ] Inlineability heuristic (function size, recursion check)
- [ ] Substitution: replace `call $f(args)` with function body, renaming locals
- [ ] Post-inline DCE
- [ ] Test: verify inlined output is equivalent

---

## Phase 6 — `wasm-opt` CLI Integration

**Goal**: Wire the native TypeScript optimization passes into the `wasm-opt` CLI tool
so it operates without the subprocess hybrid. WAT↔binary conversion and disassembly
are handled by `wabt-ts` and are out of scope here.

- [ ] `wasm-opt` reads `.wasm` binary → parses IR (requires Phase 2)
- [ ] Runs selected optimization passes (requires Phase 4)
- [ ] Writes optimized `.wasm` binary (requires Phase 3)
- [ ] `-O1`/`-O2`/`-O3`/`-Os`/`-Oz` flag mapping to pass sets
- [ ] `--pass-arg` for per-pass tuning
- [ ] Remove subprocess hybrid dependency once native passes are complete

---

## Phase 7 — GC Proposal Instructions

Reference: `upstream/src/wasm.h` (GC expression types)

**Goal**: Full support for WasmGC proposal instructions.

- [ ] Heap type definitions in IR (`src/ir/gc-types.ts`)
- [ ] `struct.new`, `struct.get`, `struct.set`
- [ ] `array.new`, `array.get`, `array.set`, `array.len`
- [ ] `ref.cast`, `ref.test`, `br_on_cast`
- [ ] `ref.i31`, `i31.get_s`, `i31.get_u`
- [ ] Parser + printer support (phases 1, 3)

---

## Phase 8 — Exception Handling Proposal

Reference: `upstream/src/passes/` (EH-related passes)

**Goal**: Full support for the WASM exception-handling proposal.

- [ ] `try`, `catch`, `throw`, `rethrow`, `throw_ref` expressions in parser/printer
- [ ] `try_table` with `catch` clauses
- [ ] EH-aware DCE (pop instruction support)
- [ ] `Vacuum` extension for EH pop fixup

---

## Phase 9 — SIMD Instructions

Reference: `upstream/src/wasm.h` (SIMD expression types)

**Goal**: Full SIMD (v128) expression support.

- [ ] `v128.const`, `i8x16.splat`, etc.
- [ ] Lane extract / replace
- [ ] Shuffle
- [ ] Arithmetic ops (add, sub, mul, min, max per lane type)
- [ ] Parser + printer support

---

## Phase 10 — WASM-compiled Passes via wasic

Reference: `../wasmtk/src/wasic.ts`

**Goal**: Compile performance-critical pass logic to WASM via `wasmtk wasic` for faster execution.

- [ ] Identify bottleneck passes (likely `OptimizeInstructions`, `CoalesceLocals`)
- [ ] Port hot loops to `wasic`-compatible TypeScript subset
- [ ] Compile to `.wasm` and embed in `src/wasm/` (as `mathlib.wasm` pattern from wasmtk)
- [ ] Wire `src/passes/` to call WASM-compiled pass core via WASM host call
- [ ] Benchmark native TypeScript vs. WASM-compiled vs. upstream binaryen.js

---

## Ongoing

- [ ] Expand test suite as each phase completes
- [ ] Update `CLAUDE.md` with design decisions as they are made
- [ ] Keep `upstream/` submodule pinned to a known-good binaryen commit
- [ ] Publish each stable phase to JSR with provenance

---

## Dependency graph

```text
Phase 0 (foundation)
   └── Phase 1 (WAT parser — IR construction + testing)
   └── Phase 2 (binary parser — .wasm → IR)
         └── Phase 3 (binary encoder — IR → .wasm)
               └── Phase 4 (core passes)
                     └── Phase 5 (inlining)
                           └── Phase 6 (wasm-opt native CLI)
   └── Phase 7 (GC) ← extends IR + passes
   └── Phase 8 (EH) ← extends IR + passes
   └── Phase 9 (SIMD) ← extends IR + passes
   └── Phase 10 (wasic compilation) ← requires Phase 4

Note: WAT text output (wasm2wat) and validation (wasm-validate) are handled
by wabt-ts and are out of scope for binaryen-ts.
```
