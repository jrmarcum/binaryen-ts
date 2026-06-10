# Architecture & per-subsystem design

Each subsystem ports a corresponding piece of upstream binaryen. Open the C++ in `upstream/src/`
alongside the `.ts` when porting. The IR tree-ownership rule (one parent per node; factories always
allocate) is in [overview.md](overview.md).

## IR (`src/ir/`)

- `types.ts` — `ValType`, `Type`, `None`, `Unreachable`; `V128`/`ExnRef`/`NullExnRef` added by the
  SIMD/EH phases.
- `gc-types.ts` — `AbstractHeapType`, `HeapType`, `RefType`, `TypeDef`, `FieldType`. `HeapType` is a
  `number | AbstractHeapType` union (numeric = user-defined type index; enum = abstract heap type).
  `writeHeapType` checks `h >= 0` (type index) vs abstract constant. Struct/array/func `TypeDef`s
  share one index space in `mod.heapTypes[]`.
- `expressions.ts` — all `ExpressionKind` variants + factory fns. **Factories compute correct result
  types** (the LUB/`unreachable` logic that several correctness fixes hardened — see
  [correctness.md](correctness.md)).
- `module.ts` — `WasmModule`, `ModuleBuilder` (fluent API),
  `ModuleBuilder.addFunction`/`addElement`/ `addTag`/`empty()`. `WasmFunction.bodyFrameLabel` +
  `IfExpr.name` carry branch labels (branch-depth fix). `WasmExport["kind"]` union includes
  `"function"`/`"table"`/`"memory"`/`"global"`/`"tag"`.
- `walk.ts` — `mapExpression` (bottom-up transform, children-first), `walkExpression` (pre-order
  visitor), `visitChildren`/`_visitChildren` (generic recursion used by the CFG builder). The
  `default` cases **throw** on an unhandled `ExpressionKind` — a future wired-up kind can't be
  silently invisible to passes.

## WAT text parser (`src/parser/`) — 3-phase, debuggability over speed

Deliberately NOT a port of the upstream streaming C++ pull-parser:

1. `tokenizer.ts` — character stream → flat `Token[]`.
2. `sexpr.ts` — `Token[]` → `SExpr` tree (`List` | `Atom`).
3. `wat-parser.ts` — `SExpr` tree → `WasmModule` IR.

**Route construction through the factories, never hand-build IR literals** (a Tier-1 fix: hand-built
`return`/`if` literals re-opened `unreachable`-typing bugs the factories fixed). `collectType`
populates `typeNames` + `funcTypeDefs` in the first pass; `(type $sig)` references in
`call_indirect` are authoritative when present (inline `param`/`result` ignored). Export kind maps
`func → "function"` (a WT-2f fix; raw keyword pass-through corrupted standalone exports).

## Binary parser (`src/binary/`) — `.wasm → IR`

`reader.ts` holds LEB128 (signed/unsigned, the WT-1 overflow boundary fix), float, UTF-8 helpers.
`wasm-parser.ts` is the section/opcode decoder. Hard-won correctness invariants (full detail in
[correctness.md](correctness.md)):

- Imported functions are named `$func${globalIndex}` (NOT `$import${n}`) so
  call/export/elem/ref.func references resolve.
- Block/loop/try frames are sealed with the **declared result type**, not the type inferred from the
  last child (which is `unreachable` when the block exits via `br`).
- `br`/`br_if`/`br_table` pop the branch value when the target block has a result type
  (`_branchValueArity`).
- `call`/`return_call` consult `importedFuncTypeIndices` for imported-function arities.
- Element segments are materialized via `addElement` (all 8 reference-types flag forms; expr-list
  `ref.func`/`ref.null` decoded). Multi-value tuple call results and EH catch-param binds seed typed
  `Pop`s so downstream consumers don't pop placeholder `nop`s.

## Binary encoder (`src/encoder/`) — `IR → .wasm`

- `BinaryWriter` — growable `number[]` with LEB128/IEEE-754/UTF-8 helpers. Two-pass section encoding
  (encode body to scratch writer → prepend id + byte-length).
- **Name → index resolution**: imports first, then local defs; built once per encode. A `resolveRef`
  helper **throws** on any miss (no `?? 0` silent fallback — that was the entire WT-2b "call index
  0" bug class).
- **Type dedup**: unique `FuncType`s collected by tree walk, contiguous indices. GC mode
  (`mod.heapTypes.length > 0`) emits types directly from `mod.heapTypes` and looks up func-type
  indices via `gcFuncTypeIndex()`; non-GC mode uses the deduped `this.types` map. The tag section
  must use the same `mod.heapTypes`-indexed path in GC mode (a WT-2d fix).
- **Null-name block unpacking**: a `BlockExpr` with `name === null` is the function-body container
  produced by the binary parser — unpacked directly, not wrapped in `0x02…0x0b`. Same unpacking is
  applied to anonymous catch-handler blocks (`encodeCatchBody`, a WT-2g fix).
- **Load/store opcodes** derived from `(bytes, signed, resultType)` / `(bytes, value.type)`; SIMD
  form (`0xFD`) emitted for `v128.load`/`store`. **Label depth**: a `string[]` label stack; the
  function frame is seeded as a phantom at the bottom (branch-depth fix); `resolveLabel` **throws**
  on a miss.

## Proposal support (binary parser + encoder + WAT parser)

- **GC (Phase 7)** — heap types, struct/array/ref instructions; `0xFB` prefix sub-opcodes; `ref.eq`
  is `0xd3` (no prefix). Ref params/results round-trip-shimmed to `ValType.AnyRef`.
- **EH (Phase 8)** — tags (tag section id=13, between memory and globals), `throw`/`throw_ref`/
  `rethrow`/`try_table`/legacy `try`. `Pop` pseudo-instruction is the catch binding placeholder
  (encoded as nothing; preserved by Vacuum). `StripEH` pass available.
- **SIMD (Phase 9)** — `ValType.V128` (0x7b); `0xFD` prefix + U32 LEB128 sub-opcode. Most ops reuse
  `UnaryExpr`/`BinaryExpr` with SIMD-prefixed op strings; **SIMD prefix checks must precede scalar
  prefix checks** in `inferUnaryType`/`inferBinaryType` (else `i32x4.splat` misclassifies as `i32`).
  7 specialized nodes for extract/replace/shuffle/ternary/shift/load/loadstore-lane.
- **Tail calls (Phase 13)** — `0x12` `return_call` / `0x13` `return_call_indirect` decode to
  `Call`/`CallIndirect` with `isReturn=true`; encoder emits the tail-call opcode when set.

## Hybrid mode — three optimization tiers (Phase 0 decision)

1. **Native TS passes** — `src/passes/` (the default; see [passes.md](passes.md)).
2. **Subprocess hybrid** — pipe through the system `wasm-opt` binary
   (`BinaryenInterop.optimizeViaSubprocess`); `hybridMode: true` routes here. `emitText`/`-S` is
   hybrid-only (WAT output is wabt-ts's domain).
3. **In-process binaryen.js** — dynamically import the upstream Emscripten build and call its API
   in-process. Opt-in: `await BinaryenInterop.create(...)` then `optimizeWat`/`optimizeBinary`.

### binaryen.js interop shape (`src/interop/binaryen-js.ts`)

The real binaryen.js shape (per `upstream/src/js/binaryen.js-post.js`) is a **factory namespace**
(`parseText`/`readBinary`/`setOptimizeLevel`/`setShrinkLevel` → returns a **wrapped module** with
`emitText`/`emitBinary`/`optimize`/`runPasses`/`validate`/`dispose`) — NOT the C-API `fn(moduleRef)`
shape. `create()` defaults to `binaryenJsPath: "npm:binaryen"` (Deno/Bun resolve natively; Node
needs `npm install binaryen`); pass `{ binaryen: <factory> }` to skip the import (tests, browser).
`-Oz` → `(optimizeLevel 2, shrinkLevel 2)`, `-Os` → `(2,1)`, `-O3` → `(3,0)`, etc. `dispose` runs in
`finally`. Tests use a hand-written mock factory recording `MockEvent`s — zero CI dependency; a live
`npm:binaryen` test is gated on `BINARYEN_LIVE=1`.

## `npm:binaryen` compatibility facade (`src/api/binaryen-compat.ts`, `/compat` export)

Lets code written against upstream `npm:binaryen` consume binaryen-ts by changing only the `import`.
Built to unblock the wasmtk migration. Mirrors upstream numeric constants exactly (`i32`=2 …
`none`=0; `ExternalFunction`=0 …; `ExpressionId*` BlockId=1 … UnreachableId=23). `Module.optimize()`
runs the in-tree `PassRunner` (output may differ from upstream `-Oz` at the byte level — both
valid). Module-level `setShrinkLevel`/`setOptimizeLevel`/`setDebugInfo` are global `let`s read at
`optimize()` time. `new Module()` builds programmatically (`mod.i32.add`, `mod.local.get`, …).
`runPasses([names])` looks each name up via `createPass()` (throws `Unknown pass`).
`_idToValTypeArray` **throws** `TypeError` on an unrecognized type ID (was silently dropping → arity
change). Omitted: SIMD/GC/EH factory methods (drop to `make*` from `/ir`), Relooper/source-map APIs.

## WASM-kernel runtime (`src/wasm/`, `src/wasm-runtime.ts`) — infra only

Dogfooded build pipeline: `gen_demo_bytes.ts` runs `parseWat` → `encodeWasm` on `demo.wat`, writes
`demo.wasm` + `demo_bytes.ts` (no wabt/binaryen npm dep). `loadKernel(spec)` returns
`{ instance, exports }`, module + instance cached by `spec.name`. **Per-call boundary tax
dominates**: a WASM `add_i32` is ~3.6 ns vs ~0.34 ns native — WASM is ~5–10× slower for single i32
ops. A kernel only pays off if `per_op_savings × ops_per_call > boundary_tax (~2–3 ns)`; pure-i32
dispatch can never break even. The demo kernel is NOT a production pass (intentionally not wired
into `OptimizeInstructions`). Kernel selection deferred until real-corpus profiling.

## Cross-runtime rules (Phase 11)

- **`node:` standard-library imports only** (`node:fs/promises`, `node:child_process`,
  `node:process`) — universal across Deno 1.40+ / Node 18+ / Bun. **No `Deno.*` in `src/` or
  `main.ts`** (a `Grep` check is part of the migration audit; tests stay on `Deno.test`).
- `Buffer` is Node-only; type subprocess chunks as `Uint8Array`, concat via `_concatU8`, decode via
  `new TextDecoder().decode(...)`.
- No `import.meta.main` in published modules (Node 18 lacks it) — CLI entry is always `main.ts`;
  submodules export `main()`.
- Browser-safe subpaths: `/api`, `/ir`, `/binary`, `/encoder`, `/passes`, `/wasm`, `/wasm-runtime`.
  Node/Deno/Bun-only: `/tools/wasm-opt` (fs), `/interop` (subprocess).
- `deno.json` `compilerOptions.lib`: `["deno.ns", "esnext", "dom"]` (the old `["deno.window"]`
  blocked `node:` imports from type-checking).
- Two `async` stubs (`BinaryenInterop.create`, `WasmCompiler.optimize`) intentionally use
  `Promise.resolve/reject` not `async` (a no-`await` body + `async` trips `require-await`). **Do not
  re-add `async`** without making the body actually `await`. The codebase has no `deno-lint-ignore`
  precedent — prefer structural fixes over suppressors.
  </content>
