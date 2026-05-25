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
│   ├── binary/       WASM binary parser (.wasm → IR)
│   ├── encoder/      WASM binary encoder (IR → .wasm)
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

### Constructor API status

Phase 0 established the constructor API. Phases 2 and 3 completed the stabilization
exercise — the binary parser was the first client that had to call a constructor for every
MVP opcode, and the encoder was the first client that had to invert every opcode back to
a byte sequence. All MVP factory functions are now present and exercised:
`makeI32Const`, `makeI64Const`, `makeF32Const`, `makeF64Const`, `makeLocalGet`,
`makeLocalSet`, `makeLocalTee`, `makeGlobalGet`, `makeGlobalSet`, `makeBinary`,
`makeUnary`, `makeReturn`, `makeCall`, `makeCallIndirect`, `makeIf`, `makeBlock`,
`makeLoop`, `makeBreak`, `makeSwitch`, `makeSelect`, `makeDrop`, `makeNop`,
`makeUnreachable`, `makeLoad`, `makeStore`, `makeMemorySize`, `makeMemoryGrow`,
`makeMemoryCopy`, `makeMemoryFill`, `makeRefNull`, `makeRefFunc`, `makeRefIsNull`.

The constructor API is now **stable and complete for MVP**. It is ready for the
wabt-ts IR bridge dry-run (step 3 of the handshake plan below).

### Handshake plan with wabt-ts

1. Module-level constructor signatures (`ModuleBuilder.addFunction`, `addGlobal`,
   `addMemory`, `addFunctionImport`, `addExport`) are already stable — share with
   wabt-ts immediately for early boundary validation. ✅ Complete.
2. When Phase 2 instruction decoder reaches MVP opcode completeness, flag wabt-ts.
   ✅ Complete — Phase 2 done; all MVP opcodes decoded.
3. wabt-ts performs a dry-run: walk a sample wabt IR and map each node to a binaryen
   constructor call, without committing to bridge implementation.
4. Both sides review for structural mismatch before either project commits to the bridge.

## Portability Note

All project context for Claude Code lives in this file (`CLAUDE.md`) to keep the project fully portable across machines. Do not store project-specific knowledge in machine-local Claude memory.

When something needs to be remembered for future sessions, write it into the appropriate project file — not into machine-local memory. Use the table below to decide where:

| What changed | Record it in |
| ------------ | ------------ |
| Architecture decision, cross-project agreement, design constraint, license, ecosystem context | `CLAUDE.md` — permanent project knowledge |
| Phase task added, completed, deferred, or re-scoped | `TASKS.md` — phase-by-phase work tracking |
| Phase status visible to users / external contributors | `README.md` — phase table and feature list |
| All three touch points (e.g. completing a phase) | Update all three files consistently |

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
│   │   ├── gc-types.ts     AbstractHeapType, HeapType, RefType, TypeDef, FieldType (Phase 7)
│   │   ├── expressions.ts  All ExpressionKind variants + factory fns
│   │   ├── module.ts       WasmModule, ModuleBuilder (fluent API)
│   │   ├── walk.ts         mapExpression (bottom-up transform), walkExpression (pre-order visitor)
│   │   └── index.ts        Re-exports
│   ├── parser/         WAT text parser (Phase 1)
│   │   ├── tokenizer.ts    WAT lexer → Token stream
│   │   ├── sexpr.ts        S-expression tree (List / Atom)
│   │   └── wat-parser.ts   S-expr tree → WasmModule IR
│   ├── passes/         Optimization pass registry and runner (Phases 4–5)
│   │   ├── pass.ts                         Pass interface, PassRunner, registry
│   │   ├── dce.ts                          Dead code elimination
│   │   ├── vacuum.ts                       Remove nops, empty blocks, drop(pure)
│   │   ├── optimize-instructions.ts        Algebraic identities + i32/i64 constant folding
│   │   ├── remove-unused-brs.ts            Remove tail-of-block br/br_if to own label
│   │   ├── simplify-locals.ts              local.set+local.get → local.tee
│   │   ├── coalesce-locals.ts              Dead-write elimination + linear-scan slot coalescing
│   │   ├── local-cse.ts                    Within-block common subexpression elimination
│   │   ├── remove-unused-module-elements.ts  Reachability-based dead function/global removal
│   │   ├── pick-load-signs.ts              Sign/unsigned selection for narrow loads
│   │   ├── inlining.ts                     Inlining + InliningOptimizing (Phase 5)
│   │   ├── remove-unused-names.ts          Strip unused block/loop labels (Phase 6)
│   │   └── index.ts                        Re-exports + side-effect pass registration
│   ├── encoder/        WASM binary encoder (Phase 3)
│   │   ├── wasm-encoder.ts BinaryWriter + WasmEncoder (IR → .wasm)
│   │   └── index.ts        Re-exports encodeWasm, WasmEncodeError
│   ├── tools/
│   │   └── wasm-opt.ts     wasm-opt CLI (native/hybrid dispatch)
│   ├── api/
│   │   └── index.ts        createModule, ExprBuilder, WAT stub serializer
│   └── interop/
│       └── binaryen-js.ts  Hybrid bridge to upstream binaryen.js WASM
└── tests/
    ├── parser/         WAT parser round-trip tests
    ├── binary/         WASM binary parser tests + GC parser/encoder tests (Phase 7)
    ├── encoder/        WASM binary encoder round-trip tests
    ├── passes/         Optimization pass tests (Phases 4–5)
    └── tools/          wasm-opt CLI tests (Phase 6)
```

### Phase Status

| Phase | Status | Description |
| ----- | ------ | ----------- |
| 0 | ✅ Done | Foundation: IR types, expressions, module builder, pass infra, DCE, API, interop |
| 1 | ✅ Done | WAT text parser (tokenizer → S-expr → IR) — 47/47 tests passing |
| 2 | ✅ Done | WASM binary parser (.wasm → IR) — 9/9 tests passing |
| 3 | ✅ Done | WASM binary encoder (IR → .wasm) — 14/14 tests passing; full round-trip verified |
| 4 | ✅ Done | Core optimization passes — 8 passes, 26/26 tests passing |
| 5 | ✅ Done | Inlining pass — `Inlining` + `InliningOptimizing`, 14/14 tests passing |
| 6 | ✅ Done | `wasm-opt` native CLI + RemoveUnusedNames pass — 14/14 tests passing |
| 7 | ✅ Done | GC proposal — heap types, struct/array/ref instructions, binary parser + encoder + WAT parser, 141/141 tests |
| 8+ | Planned | EH, SIMD, wasic compilation |

### Key Design Decisions

#### Hybrid mode (Phase 0 decision)

Three optimization tiers:

1. **Native TypeScript passes** — pure TypeScript in the pass registry (`src/passes/`).
2. **Subprocess hybrid** — pipe WAT through system `wasm-opt` binary (`BinaryenInterop.optimizeViaSubprocess`). Works today.
3. **binaryen.js WASM hybrid** — load upstream `binaryen.js` Emscripten binary. Deferred (not on the critical path now that a native encoder exists in Phase 3).

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

#### Binary encoder design (Phase 3)

- **`BinaryWriter`**: simple growable `number[]` buffer with LEB128 (signed + unsigned), IEEE 754 float, and UTF-8 helpers. Two-pass section encoding: each section is encoded into a scratch `BinaryWriter`, then the id + byte-length prefix + body are appended to the main output.
- **Name → index resolution**: imported entities come first (functions, globals, tables), local definitions follow. Maps are built once at encode time from the `WasmModule` structure.
- **Type deduplication**: unique `FuncType` signatures are collected by a tree walk over all functions and `call_indirect` expressions and assigned contiguous indices.
- **Null-name block unpacking**: a `BlockExpr` with `name === null` is the function body container produced by the binary parser. The encoder unpacks it directly into the function body byte stream rather than wrapping it in a `0x02...0x0b` block.
- **Load/store opcode resolution**: derived from `(bytes, signed, resultType)` for loads and `(bytes, value.type)` for stores — no separate opcode field stored in the IR.
- **Label depth resolution**: a `string[]` label stack grows as blocks/loops are entered and shrinks on exit; `br`/`br_if`/`br_table` depths are computed as `stack.length - 1 - lastIndexOf(name)`.

#### Optimization pass design (Phase 4)

All passes use two shared IR utilities in `src/ir/walk.ts`:

- `mapExpression(expr, fn)` — bottom-up tree transform (children first, then parent). Used by Vacuum, OptimizeInstructions, RemoveUnusedBrs, SimplifyLocals, CoalesceLocals, LocalCSE, PickLoadSigns.
- `walkExpression(expr, visitor)` — pre-order visitor (parent before children). Used by analysis-only passes.

Key design decisions:

- **Vacuum**: removes `nop` from blocks; collapses empty and unnamed-single-child blocks; `drop(const|local.get|global.get)` → `nop`.
- **OptimizeInstructions**: algebraic identities applied RHS-constant-first (covers shift-by-zero, identity elements for add/mul/and/or/xor, division by 1); constant folding for all non-trapping i32/i64 binary ops and unary ops (clz, eqz, extend, wrap, sign-extend). Float ops excluded (NaN semantics).
- **RemoveUnusedBrs**: only tail-position branches are removed. Safety condition: the new last child must have type `none` so the block's result type is unchanged.
- **SimplifyLocals**: only consecutive `local.set(i) + local.get(i)` pairs in the same block. No intervening instructions by construction.
- **CoalesceLocals**: Phase 4 does dead-write elimination (set → drop when local has no reads) plus linear-scan range coalescing. Full dataflow liveness (for loops) is deferred.
- **LocalCSE**: keys pure sub-expressions by structural string hash. Invalidates on `local.set`, `global.set`, calls, and stores. Recurses into `drop`/`return`/`local.set` children when counting and rewriting.
- **RemoveUnusedModuleElements**: seeds from exports + element segments; fixed-point call-graph walk via `Call` and `RefFunc` nodes. Imported elements are never removed.
- **PickLoadSigns**: tracks `local.set(i, narrow_load)` → counts signed/unsigned uses of `i` → flips load sign if all uses agree. Uses parent-context walk to classify comparison operators.
- **RemoveUnusedNames**: two-pass per function — collect branch targets, then strip unused block/loop labels bottom-up. Loops with no back-edge are replaced by their bodies. (Phase 6)

#### Inlining pass design (Phase 5)

`src/passes/inlining.ts` provides two registered passes: `Inlining` and `InliningOptimizing`.

Key design decisions:

- **Call graph analysis**: `buildFunctionInfo` walks every defined function body to count call-site references (`refs`), detect `hasLoops` / `hasCalls`, and mark `usedGlobally` from exports and element segments.
- **Inlineability thresholds** (matching upstream `pass.h` defaults): always inline if `size ≤ 2`; inline single-caller functions if `size ≤ 10` and not exported; with `optimizeLevel ≥ 3` inline multi-caller functions if `size ≤ 20`.
- **Recursion guard**: a call `$f` inside function `$f` is never inlined.
- **Substitution**: the wrapper block is `(block $__inlined_func$callee ...)`. Steps: (1) extend caller locals with a copy of all callee locals (params + vars); (2) emit `local.set` for each call operand; (3) emit zero-init `local.set` for each non-param local; (4) `deepCopy` the callee body then apply `mapExpression` to remap local indices and rewrite `return` → `br $label`.
- **`deepCopy`**: structural deep copy required because the same function may be inlined at multiple call sites (tree ownership rule: one parent per node).
- **Dead callee removal**: after each iteration, functions whose entire ref-count was consumed by inlining and that are not globally used are removed from `module.functions`.
- **Iteration**: up to `min(5, numFunctions+1)` rounds; stops early when no inlining occurs.
- **Deferred**: split/partial inlining (Pattern A/B), return-call handling, post-inline cleanup passes inside `InliningOptimizing`.

#### wasm-opt native CLI design (Phase 6)

`src/tools/wasm-opt.ts` implements the native pipeline: `.wasm` → `parseWasm` → `PassRunner` → `encodeWasm` → `.wasm`. No subprocess required.

Key design decisions:

- **Native path** (`_nativeOptimize`): pure TypeScript — `parseWasm` (Phase 2) feeds into `PassRunner` (Phase 4), which feeds into `encodeWasm` (Phase 3). Completely subprocess-free.
- **Hybrid path** (`--hybrid`): the original `BinaryenInterop.optimizeViaSubprocess` path is preserved for users who need the upstream binary. `emitText` (`-S`) is only supported in hybrid mode (WAT output is wabt-ts's domain).
- **Pass selection**: if `opts.passes` is non-empty, only those passes run; otherwise `addDefaultOptimizationPasses()` is called for `-O1` and above.
- **CLI flags**: `--<passname>` (e.g. `--vacuum`) appends to the explicit pass list; `--pass-arg key=val` populates `PassOptions.passArgs`; `--print-all-passes` lists the registry and exits.
- **`passArgs: Record<string, string>`**: added to `PassOptions` for per-pass tuning arguments. Keys follow the upstream convention `passname@argname`. Currently plumbing only; individual passes can look up their args at runtime.

#### RemoveUnusedNames pass design (Phase 6)

`src/passes/remove-unused-names.ts` — reference: `upstream/src/passes/RemoveUnusedNames.cpp`.

Two-pass approach per function:

1. **Collect branch targets** (`walkExpression`): gather every label named by `br`, `br_if`, and `br_table` instructions.
2. **Strip unused names** (`mapExpression`, bottom-up): for each `BlockExpr`, if its `name` is not in the targets set, set `name: null`. For each `LoopExpr`, if its `name` is not in the targets set (no back-edge `br`), replace the loop with its body (since a loop with no back-edge executes at most once — equivalent to straight-line code). Type guard: only replace when `loop.type === loop.body.type`.

Deferred from upstream: single-child named-block merge (redirect branches from outer to inner block and eliminate the outer wrapper).

#### GC proposal design (Phase 7)

`src/ir/gc-types.ts` — new file; `src/ir/expressions.ts`, `src/binary/wasm-parser.ts`, `src/encoder/wasm-encoder.ts`, `src/parser/wat-parser.ts` extended.

Key design decisions:

- **`AbstractHeapType` byte encoding**: single SLEB128 byte — Func=0x70(-16), NoFunc=0x73(-13), Ext=0x6f(-17), NoExt=0x72(-14), Any=0x6e(-18), Eq=0x6d(-19), I31=0x6c(-20), Struct=0x6b(-21), Array=0x6a(-22), None=0x71(-15), Exn=0x69(-23), NoExn=0x74(-12). User-defined types encoded as unsigned LEB128 type index.
- **`HeapType` union**: `number | AbstractHeapType` — numeric literal for user-defined type index, enum value for abstract. `writeHeapType` checks `h >= 0` (type index) vs abstract constant.
- **`TypeDef` in `mod.heapTypes[]`**: struct, array, and func types share the same index space. The type section emits all three flavors from `mod.heapTypes` in GC mode.
- **GC mode vs non-GC mode in encoder**: `mod.heapTypes.length > 0` switches to GC encoding. Non-GC mode uses the collected/deduplicated func types map. GC mode looks up function type indices via `gcFuncTypeIndex()` which scans `mod.heapTypes`.
- **Ref type round-trip shim**: the binary parser maps `RefType` params/results to `ValType.AnyRef` in `WasmFunction.params/results` for backward compatibility. `gcFuncTypeIndex()` accounts for this by comparing `isRefType(dp) ? ValType.AnyRef : dp` against the function's stored param type.
- **`(ref ...)` in WAT parser**: `tryParseValType` handles `(ref null $T)` and `(ref $T)` list forms, returning `ValType.AnyRef` (approximate; full ref type propagation deferred until the WAT printer tracks heap type context).
- **WAT parser `collectType`**: runs in the first pass alongside imports/globals/etc. Accumulates `typeNames: Map<string, number>` mapping `$name` → heapTypes index. Called via `case "type": this.collectType(child as SList)`.
- **`0xFB` prefix sub-opcodes**: struct.new=0x00, struct.new_default=0x01, struct.get=0x02, struct.get_s=0x03, struct.get_u=0x04, struct.set=0x05, array.new=0x06, array.new_default=0x07, array.new_fixed=0x08, array.get=0x0b, array.get_s=0x0c, array.get_u=0x0d, array.set=0x0e, array.len=0x0f, ref.test=0x14, ref.test_null=0x15, ref.cast=0x16, ref.cast_null=0x17, br_on_cast=0x18, br_on_cast_fail=0x19, ref.i31=0x1c, i31.get_s=0x1d, i31.get_u=0x1e. `ref.eq`=0xd3 (no 0xFB prefix).
- **Tests in `tests/binary/gc_parser_test.ts`**: hand-crafted binary modules for struct, array, and ref.test; 7 parser tests + 8 encoder round-trip tests = 15 total.

#### Upstream C++ reference

When porting any component, always check `upstream/src/` first. Key upstream files:

- `upstream/src/parser/lexer.h` — Lexer token types and character classes
- `upstream/src/parser/wat-parser.cpp` — WAT module/expression parsing logic
- `upstream/src/wasm.h` — All IR expression types (ExpressionId enum)
- `upstream/src/passes/` — Each pass in its own `.cpp` file
