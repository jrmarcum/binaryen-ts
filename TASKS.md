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
  - [x] GC: `0xFB` prefix — full struct/array/ref/i31/br_on decoder (Phase 7 ✅)
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
- GC struct/array opcodes — fully decoded (Phase 7 ✅); see `tests/binary/gc_parser_test.ts`
- Round-trip test (parse binary → IR → encode binary → re-parse → compare) — complete (Phase 7 ✅)

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
- GC expression kinds — fully encoded (Phase 7 ✅)
- EH / SIMD expression kinds fall through to nop (Phase 8, 9)

---

## Phase 4 — Core Optimization Passes (TypeScript) ✅ COMPLETE

Reference: `upstream/src/passes/`

**Goal**: Port the most impactful passes from C++. Each pass is one `.ts` file in `src/passes/`.

Shared infrastructure added: `src/ir/walk.ts` — `mapExpression` (bottom-up tree transform)
and `walkExpression` (pre-order visitor), used by all passes.

- [x] **Vacuum** (`vacuum.ts`) — remove nop, empty blocks, drop(pure) → nop
  - Reference: `upstream/src/passes/Vacuum.cpp`
- [x] **RemoveUnusedBrs** (`remove-unused-brs.ts`) — remove `br $B` / `br_if $B cond` at tail of block `$B`
  - Reference: `upstream/src/passes/RemoveUnusedBrs.cpp`
- [x] **OptimizeInstructions** (`optimize-instructions.ts`) — peephole rewrites + integer constant folding
  - Reference: `upstream/src/passes/OptimizeInstructions.cpp`
  - Algebraic identities: `add(x,0)→x`, `mul(x,1)→x`, `and(x,-1)→x`, shift-by-0, `eq(x,0)→eqz(x)`, etc.
  - Constant folding: all non-trapping i32/i64 binary ops; i32/i64 unary ops (clz, eqz, extend, wrap)
- [x] **CoalesceLocals** (`coalesce-locals.ts`) — dead-write elimination + linear-scan slot coalescing
  - Reference: `upstream/src/passes/CoalesceLocals.cpp`
  - Phase 4 implementation: replaces dead `local.set` with `drop`; greedy non-overlapping range coalescing
  - Full dataflow-based liveness deferred to a later pass refinement
- [x] **SimplifyLocals** (`simplify-locals.ts`) — collapse consecutive `local.set(i,v); local.get(i)` → `local.tee(i,v)`
  - Reference: `upstream/src/passes/SimplifyLocals.cpp`
- [x] **LocalCSE** (`local-cse.ts`) — common subexpression elimination within blocks
  - Reference: `upstream/src/passes/LocalCSE.cpp`
  - Wraps first occurrence in `local.tee(fresh, expr)`, replaces subsequent in `local.get(fresh)`
  - Invalidates cache on `local.set`, `global.set`, calls, and stores
- [x] **RemoveUnusedModuleElements** (`remove-unused-module-elements.ts`) — strip dead functions/globals
  - Reference: `upstream/src/passes/RemoveUnusedModuleElements.cpp`
  - Reachability from exports + element segments; fixed-point call-graph walk
- [x] **PickLoadSigns** (`pick-load-signs.ts`) — choose sign-extend vs zero-extend for narrow loads
  - Reference: `upstream/src/passes/PickLoadSigns.cpp`
  - Tracks `local.set(i, narrow_load)` patterns; classifies uses as signed/unsigned; flips load sign
- [x] Tests (`tests/passes/passes_test.ts`) — 26 tests, all passing

---

## Phase 5 — Inlining Pass ✅ COMPLETE

Reference: `upstream/src/passes/Inlining.cpp`

**Goal**: Inline small call targets to eliminate call overhead.

- [x] Call graph analysis (`buildFunctionInfo` — size, refs, hasLoops, hasCalls, usedGlobally)
- [x] Inlineability heuristic: always ≤ 2, one-caller ≤ 10, flexible ≤ 20 at `-O3`; recursion blocked
- [x] Substitution: deep-copy callee body; remap local indices; `return` → `br $label`; assign operands to param locals; zero-init non-param locals
- [x] Dead callee removal: functions with all call-site refs inlined and not exported/globally used are removed
- [x] `InliningOptimizing` variant registered alongside `Inlining`
- [x] Tests (`tests/passes/inlining_test.ts`) — 14 tests, all passing

**Implementation file**: `src/passes/inlining.ts`

**Known gaps / deferred**:

- Split / partial inlining (Pattern A/B from upstream) — deferred
- Return-call (`isReturn`) inlining — deferred to EH/tail-call phase
- Post-inline Vacuum + OptimizeInstructions within `InliningOptimizing` — stub (optimize flag present but cleanup passes not yet wired into `_iteration`)

---

## Phase 6 — `wasm-opt` CLI Integration ✅ COMPLETE

**Goal**: Wire the native TypeScript optimization passes into the `wasm-opt` CLI tool
so it operates without the subprocess hybrid. WAT↔binary conversion and disassembly
are handled by `wabt-ts` and are out of scope here.

- [x] `wasm-opt` reads `.wasm` binary → `parseWasm` → IR (Phase 2 pipeline wired)
- [x] Runs selected optimization passes via `PassRunner` (Phase 4 passes wired)
- [x] Writes optimized `.wasm` binary via `encodeWasm` (Phase 3 encoder wired)
- [x] `-O1`/`-O2`/`-O3`/`-Os`/`-Oz` flag mapping to pass sets
- [x] `--pass-arg key=value` for per-pass tuning (forwarded as `PassOptions.passArgs`)
- [x] Explicit pass names via `--passname` CLI flags (e.g. `--vacuum --dce`)
- [x] `--print-all-passes` lists all registered passes and exits
- [x] Subprocess hybrid kept behind `--hybrid` flag for backward compat
- [x] **RemoveUnusedNames pass** (`src/passes/remove-unused-names.ts`) — strips unused
      block/loop labels; replaces no-back-edge loops with their bodies
- [x] `passArgs: Record<string, string>` added to `PassOptions` for future per-pass tuning
- [x] 14/14 tests passing (`tests/tools/wasm_opt_test.ts`)

**Implementation files**:

- `src/tools/wasm-opt.ts` — native pipeline (`_nativeOptimize`), updated CLI parser
- `src/passes/remove-unused-names.ts` — RemoveUnusedNames pass
- `src/passes/pass.ts` — `PassOptions.passArgs` field; `defaultPassOptions`/`shrinkPassOptions` updated
- `src/passes/index.ts` — RemoveUnusedNames registered

---

## Phase 7 — GC Proposal Instructions ✅ COMPLETE

Reference: `upstream/src/wasm.h` (GC expression types)

**Goal**: Full support for WasmGC proposal instructions.

- [x] **GC type system** (`src/ir/gc-types.ts`)
  - [x] `AbstractHeapType` enum (Func, NoFunc, Ext, NoExt, Any, Eq, I31, Struct, Array, None, Exn, NoExn)
  - [x] `RefType` — `{ heap: HeapType; nullable: boolean }`
  - [x] `FieldType` — `{ type: StorageType; mutable: boolean }`
  - [x] `TypeDef` discriminated union — `FuncTypeDef | StructTypeDef | ArrayTypeDef`
  - [x] `isRefType`, `refTypeToString` helpers
  - [x] `WasmModule.heapTypes: TypeDef[]` and `WasmModule.hasGC: boolean` fields
  - [x] `ModuleBuilder.addHeapType(def)` — appends to heapTypes; sets `_hasGC = true`
- [x] **GC expression kinds + factory functions** (`src/ir/expressions.ts`)
  - [x] `RefEq`, `RefI31`, `I31Get` — i31 operations
  - [x] `StructNew`, `StructGet`, `StructSet` — struct operations
  - [x] `ArrayNew`, `ArrayNewFixed`, `ArrayGet`, `ArraySet`, `ArrayLen` — array operations
  - [x] `RefTest`, `RefCast` — casting and testing
  - [x] `BrOn` — branch-on-cast family (`BrOnOp` enum)
  - [x] All factory functions: `makeRefEq`, `makeRefI31`, `makeI31Get`, `makeStructNew`, `makeStructNewDefault`, `makeStructGet`, `makeStructSet`, `makeArrayNew`, `makeArrayNewDefault`, `makeArrayNewFixed`, `makeArrayGet`, `makeArraySet`, `makeArrayLen`, `makeRefTest`, `makeRefCast`, `makeBrOn`
- [x] **Binary parser GC support** (`src/binary/wasm-parser.ts`)
  - [x] Type section: 0x5f (struct), 0x5e (array) → `StructTypeDef` / `ArrayTypeDef`
  - [x] Type section: func types with `(ref ...)` params/results decoded as `RefType`
  - [x] `parseHeapTypeByte` — maps abstract 1-byte encodings to `AbstractHeapType` or type index
  - [x] `parseRefType` — handles 0x63 (ref null) and 0x64 (non-nullable ref)
  - [x] `0xFB` prefix instruction decoder — all struct/array/ref/i31/br_on opcodes
  - [x] `hasGC: this.heapTypeDefs.length > 0` set on returned module
  - [x] `ValType` ref aliases (anyref, eqref, i31ref, structref, arrayref) decoded correctly
- [x] **Binary encoder GC support** (`src/encoder/wasm-encoder.ts`)
  - [x] `writeHeapType` — type index as unsigned LEB128; abstract types as single-byte SLEB128
  - [x] `writeValueType` — handles `RefType` (0x63/0x64 prefix + heap type) and `ValType`
  - [x] `writeStorageType` — i8→0x78, i16→0x77, otherwise `writeValueType`
  - [x] `encodeTypeSection` — GC mode: emits struct (0x5f) / array (0x5e) / func (0x60) from `mod.heapTypes`
  - [x] `gcFuncTypeIndex` — scans `mod.heapTypes` for matching `FuncTypeDef`
  - [x] All 15 GC expression kinds encoded under `0xFB` prefix (struct/array/ref/i31/br_on/ref.eq)
  - [x] `walkChildren` extended for all GC expression kinds
- [x] **WAT parser GC support** (`src/parser/wat-parser.ts`)
  - [x] First pass `collectType` — parses `(type $name (struct ...))` and `(type $name (array ...))`
  - [x] `parseStructFields` / `parseArrayElement` / `parseStorageTypeSExpr` helpers
  - [x] `typeNames: Map<string, number>` — maps `$name` → heapTypes index
  - [x] `resolveTypeIndex` — resolves `$name` or numeric literal to type index
  - [x] `parseHeapType` — maps abstract names and `$names` to `HeapType`
  - [x] `tryParseValType` updated to handle `(ref ...)` list forms
  - [x] GC instruction cases in `parseListExpr`: ref.eq, ref.i31, i31.get_s/u, struct.new/new_default/get/get_s/get_u/set, array.new/new_default/new_fixed/get/get_s/get_u/set/len, ref.test/test_null/cast/cast_null
- [x] **Tests** — 15 new tests in `tests/binary/gc_parser_test.ts`, all passing
  - [x] Struct type decoded (2 fields, both i32 immutable)
  - [x] Func type with RefType result decoded
  - [x] `struct.new` decoded as `StructNewExpr`
  - [x] Array type decoded (mutable i32)
  - [x] `array.new_default` decoded as `ArrayNewExpr` with null init
  - [x] `ref.test` decoded as `RefTestExpr`
  - [x] `hasGC` flag set for GC modules
  - [x] Struct module round-trips (encode → parse)
  - [x] Struct fields preserved after round-trip
  - [x] `struct.new` preserved after round-trip
  - [x] Array module round-trips
  - [x] `array.new_default` preserved after round-trip
  - [x] `ref.test` round-trips
  - [x] IR-built struct type encodes and parses
  - [x] IR-built array type encodes and parses
- [x] Total: 141/141 tests passing (all previous tests unaffected)

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
