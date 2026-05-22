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

## Phase 2 — WASM Binary Parser (binary → IR) ✅ COMPLETE

Reference: `upstream/src/wasm-binary.h`, `upstream/src/parsing.h`

**Goal**: Read a `.wasm` binary file into the TypeScript IR. This is the primary input
path for the optimizer — WAT text ingestion is handled by wabt-ts.

Implementation files: `src/binary/reader.ts` (LEB128 + raw reads), `src/binary/wasm-parser.ts` (section + instruction decoder)

- [x] Binary reader (`src/binary/reader.ts`)
  - [x] `BinaryReader` class wrapping a `Uint8Array` with a position cursor
  - [x] LEB128 unsigned (`readU32`, `readU64`)
  - [x] LEB128 signed (`readI32`, `readI64`)
  - [x] Raw reads: `readU8`, `readU16`, `readBytes(n)`, `readUTF8(n)`
  - [x] EOF and bounds checking with descriptive errors
- [x] Section parser (`src/binary/wasm-parser.ts`)
  - [x] Magic + version header check (`\0asm`, version 1)
  - [x] Section dispatch loop (id → handler)
  - [x] Type section — function type signatures → `FuncType[]`
  - [x] Import section — func/table/memory/global imports → `WasmImport[]`
  - [x] Function section — type index per function
  - [x] Table section — `WasmTable[]`
  - [x] Memory section — `WasmMemory[]`
  - [x] Global section — type + mutability + init expr → `WasmGlobal[]`
  - [x] Export section — name + kind + index → `WasmExport[]`
  - [x] Code section — local decls + instruction stream → function bodies
  - [x] Data section — active (memory index + offset) and passive segments
  - [x] Element section — function reference segments (kind 0; others skipped)
  - [x] Custom sections — skip gracefully; name section parsed for function name recovery
- [x] Instruction decoder — opcode byte(s) → `Expression` node
  - [x] All MVP opcodes (control flow, numeric, memory, parametric)
  - [x] Multi-byte opcodes: `0xFC` prefix (bulk memory, saturating trunc)
  - [x] SIMD: `0xFD` prefix — stubbed as `nop` (Phase 9)
  - [x] Atomics: `0xFE` prefix — stubbed as `nop` (future)
  - [x] GC: `0xFB` prefix — stubbed as `nop` (Phase 7)
- [x] `parseWasm(bytes: Uint8Array, filename?: string): WasmModule` — public entry point
- [x] `src/binary/index.ts` — re-exports `parseWasm`, `WasmBinaryError`, `BinaryReader`
- [x] `"./binary"` export added to `deno.json`
- [x] Tests (`tests/binary/wasm_parser_test.ts`) — 9 tests, all passing
  - [x] Reject wrong magic bytes
  - [x] Reject wrong version
  - [x] Reject truncated header
  - [x] Empty module produces empty IR collections
  - [x] `add(i32,i32)->i32` function signature, export, and body shape
  - [x] Mutable i32 global with const init
  - [x] Function body containing `global.get`

**Known gaps for future phases**:

- `table.get` / `table.set` stubbed as `nop` (table instructions)
- EH opcodes not yet decoded (Phase 8)
- GC struct/array opcodes not yet decoded (Phase 7)
- Round-trip test (parse binary → IR → encode binary → re-parse → compare) deferred to Phase 3

---

## Phase 3 — WASM Binary Encoder (IR → binary) ✅ COMPLETE

Reference: `upstream/src/wasm-binary.h`

**Goal**: Serialize the IR back to a `.wasm` binary. WAT text output is handled by
`wabt-ts` (`wasm2wat`) and is out of scope here.

- [x] WASM binary encoder (`src/encoder/wasm-encoder.ts`)
  - [x] `BinaryWriter` — growable byte buffer with LEB128 (signed + unsigned), raw scalar, UTF-8, and F32/F64 writes
  - [x] Section encoding for all section types (type, import, function, table, memory, global, export, element, code, data)
  - [x] Type deduplication — unique FuncType → index map; call_indirect types collected by tree walk
  - [x] Name-to-index resolution for functions, globals, and tables (imports first, then local defs)
  - [x] Code section: function bodies with run-length-encoded non-param locals + recursive expression encoder
  - [x] Instruction encoder for all MVP expression kinds (control flow, arithmetic, memory, calls, refs)
  - [x] Load/store opcode resolution from `(bytes, signed, resultType)` tuple
  - [x] Data section with active (offset init expr) and passive segments
  - [x] `src/encoder/index.ts` — re-exports `encodeWasm`, `WasmEncodeError`
  - [x] `"./encoder"` export added to `deno.json`
- [x] Round-trip tests (`tests/encoder/wasm_encoder_test.ts`) — 14 tests, all passing
  - [x] Header bytes correct
  - [x] Empty module re-parseable
  - [x] add function: signature, export, binary op preserved through encode → parse
  - [x] Global module: global count, type, mutability, init value (i32.const 42), global.get in body
  - [x] ModuleBuilder → encode → parse round-trip
  - [x] Memory section with max limit
  - [x] Active and passive data segments
  - [x] i32.const value fidelity

**Known gaps for future phases**:

- `if` block labels: encoded with an empty label string (no impact on correctness)
- Saturating-truncation ops (`0xFC` prefix trunc) emitted as regular trunc (correct semantics, non-trapping flavor lost)
- GC / EH / SIMD expression kinds fall through to nop (Phase 7, 8, 9)

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
