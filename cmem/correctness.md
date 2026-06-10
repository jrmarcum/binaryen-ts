# Correctness invariants & the bug log

The load-bearing record. Every fix here has a regression test; reintroducing the old shape defeats
the design. The exhaustive line-by-line version is in the legacy `CLAUDE.md`.

## The unifying robustness contract (durable; also in README §"Robustness & error handling")

**Every name / type / index / opcode / branch-label / type-id resolution in the parser → pass →
encoder pipeline either succeeds or THROWS** (`WasmEncodeError` / `WasmBinaryError` /
`WatParseError` / `TypeError`). **No silent fallback may emit valid-but-wrong wasm.** When proper
support for a non-MVP construct is out of scope, it fails loudly rather than corrupting. This is the
project's deepest lesson: every WT-2 miscompile below was _valid wasm, wrong value_ —
`WebAssembly.compile` validity never caught them. "Valid ≠ semantically equivalent."

## Why behavioral testing exists

The WT-2 series proved that structural round-trip checks (function/global/segment counts) and even
`WebAssembly.compile()` validity miss behavioral miscompiles. Two harnesses close that gap:

- **Differential behavioral-equivalence** (`scripts/equiv_check.ts`): two stubbed instances driven
  by the same call sequence stay bit-identical iff optimization preserved semantics (stubs need only
  be IDENTICAL, not meaningful). Surfaced six real miscompiles the bench had called "valid."
- **Seeded differential optimizer fuzzer** (`tests/passes/optimize_fuzz_test.ts`) — see
  [testing.md](testing.md). Has teeth: verified by reverting each fix.

---

## Hardening sweeps — Tiers 1–4 / A–C (post-v1.3.4)

Multi-agent code reviews swept for silent-miscompile bug classes, dead code, facade/CLI defects.
Suite 310 → 341.

- **Tier 1 — WAT-parser typing + encoder index resolution.** Route `return`/`if`/`call_indirect`
  through factories (hand-built literals re-opened `unreachable`-typing bugs). New `resolveRef`
  helper **throws** on a name→index miss at all ~15 entity-reference sites (was `?? 0`).
- **Tier 2 — silent `nop` fall-throughs → loud errors.** WAT unrecognized instruction; encoder
  unknown unary/binary op + default expr kind; binary-parser bulk-memory/table ops (`memory.init`,
  `table.*`, `data.drop`, `elem.drop`, `array.copy/fill/init_*`) + unknown opcodes — all
  decoded/encoded to `nop` (dropping operands → stack imbalance). Now throw.
- **Tier 3 — `select` LUB + encoder edge cases.** `makeSelect` computes the reachable-arm LUB (was
  blind `ifTrue.type`). Encoder throws on multi-value tuple blocktype, `ref.null` of an
  unrepresentable type, load/store with a non-numeric result type (was `default → i64`).
- **Tier 4 — pass correctness.** (a) Vacuum single-child block collapse guards the type. (b)
  Inlining dead-callee removal matched the `inlineable` set instead of `name.split("$")[1]` (`""`
  for `$`-prefixed names → fully-inlined fns never removed).
- **Tier A — type-index resolution + compat signatures + walk guard.**
  `getTypeIndex`/`gcFuncTypeIndex` throw on a miss (was 0). Compat `call_indirect` (table arg must
  be FIRST) + `setMemory` (missing `segments` param) fixed to upstream arg order. `walk.ts`
  `_mapChildren`/`_visitChildren` `default` throws on unhandled `ExpressionKind`.
- **Tier B — non-MVP constructs → loud failures.** Element-segment `ref.null` entries, passive/
  declarative element segments, multiple memories, ambiguous GC func-type matching — all throw.
- **Tier C — compat introspection parity.** `expandType(none)` → `[]`; `getFunctionInfo` reports
  `module`/`base` as `""` + adds a `type` field.
- **Round 3 / dead-code removal** — `v128.load`/`store` SIMD-form encode; real `parseHexFloat`
  (`Number("0x1.8p+1")` is `NaN`); `exprToWat` default throws (was a TODO comment the hybrid
  optimizer re-optimized); `--validate` actually runs `WebAssembly.compile`; `readU32`/`readU64`
  reject junk in the final LEB byte; `br_on_cast`/`_fail` round-trip source heap-type.
  `Module.optimize` hardcoded `optimizeLevel: 2` → parses the level. The 5 SIMD `?? <default>`
  sub-opcode fallbacks → throws.

## Branch-depth corruption (the deepest pre-WT fix)

The IR stored branch labels only for `Block`/`Loop` — `if` had no `name` and the function-frame
label was dropped. A `br` to an `if` or the function frame stored a label the encoder couldn't
reproduce; `resolveLabel` missed and silently `return 0`'d, re-pointing the branch at the
**innermost** frame — correct only when the target _was_ innermost, so it corrupted control flow
from deeper nesting (a branch meant to exit the function instead exited an inner block). Fix:
`IfExpr.name` + `WasmFunction.bodyFrameLabel`, threaded parser → `addFunction` → encoder; the
encoder pushes the `if`'s label and seeds the function-frame label at the bottom of its label stack
(phantom, no opcode); `resolveLabel` **throws** on a genuine miss. `_idToValTypeArray` (compat)
throws on an unrecognized type ID (was dropping → arity change). Regressions in
`tests/binary/control_flow_regression_test.ts`.

---

## The WT (wasmtk-migration) series

### WT-1 — LEB128 signed-overflow (parser)

`readI32`/`readI64` used `shift >= 35` / `>= 70n` overflow checks, rejecting valid 5-byte i32 /
10-byte i64 encodings on the last byte (the `do/while` incremented `shift` unconditionally, unlike
`readU32`). Fix: `>= 35 → > 35`, `>= 70n → > 70n`. Corpus 74 → 84 parseable files; 1,432 → 82,912
expressions. 11 boundary regression tests in `tests/binary/reader_test.ts`.

### WT-2 / WT-2b — binary-parser round-trip correctness (validity)

Found because `verify_roundtrip.ts` originally only checked counts, never `WebAssembly.compile`.
Root causes:

- `makeReturn` typed `unreachable` not the value type (a void block ending in `(return x)` was
  mistyped); `makeBreak`/`makeSwitch` typed per upstream `finalize` (unconditional `br`/any
  `br_table` = `unreachable`, `br_if` follows fallthrough).
- **Imported functions named `$func${globalIndex}`** (was `$import${n}` — the encoder's `funcIndex`
  map missed → every imported call encoded as index 0; **the entire "call need N got M" cluster**).
- `br`/`br_if`/`br_table` pop the branch value for result-typed targets (`_branchValueArity`).
- Block/loop/try frames sealed with the **declared result type** (not last-child-inferred); loop/
  try_table wrapper block is anonymous + stamped with the declared type (reusing the loop label gave
  `(loop $L (block $L))` → back-edge `br` hit the wrong target).
- `call`/`return_call` consult `importedFuncTypeIndices` for imported arities.

### WT-2c — six behavioral miscompiles (pass correctness)

Surfaced by `equiv_check.ts`; all six fixed:

1. **Element segments silently dropped** (`readElementSection` `void seg`'d them) → table
   uninitialized → every `call_indirect` trapped. Added `ModuleBuilder.addElement`. (Also
   retro-explains WT-2's bogus "cube 0.78× smaller" — without elem-seeded reachability,
   `RemoveUnusedModuleElements` deleted table-referenced functions.)
2. **LocalCSE clobbered block result type** (recomputed `block.type` from last child after rewrite;
   when the block exits via `br`/`return` the last child is `unreachable` → overwrote a declared
   `i32`). CSE preserves type — drop the recompute.
3. **Vacuum + SimplifyLocals** had the identical `block.type = lastChild.type` defect — same fix.
4. **`makeIf` type LUB** — used `ifTrue.type` blindly; when `then` is `unreachable` but `else` falls
   through, the `if` was mistyped `unreachable` → DCE deleted everything after it, including a loop
   back-edge `br` (silently broke the loop; `_fib` returned 0). Fixed to the reachable-arm type per
   upstream `If::finalize`.
5. **CoalesceLocals `_rewriteBody` identity loss** — `effectiveSet: Set<Expression>` keyed by
   ORIGINAL node refs, but `mapExpression`'s `_mapChildren` unconditionally spreads, rebuilding
   every ancestor → `effectiveSet.has(e)` always false → **every `local.set` became a `drop`**. Fix:
   pre-walk and stamp a `Symbol`-keyed `_INEFFECTIVE` marker (object spread copies symbol keys,
   surviving every rebuild).
6. **LocalCSE post-write cache staleness** — `_cseBlock` invalidated cache BEFORE each child but
   never AFTER, so a `tee N` created inside a child whose surrounding `set K` writes the slot left
   `lg:K → N` cached for the next child, which read the PRE-set value. Fix: POST-invalidate after
   each child.

### WT-2d / WT-2e — wasmtk integration rounds 1–2 (parser)

- **Single-arm `(if cond (then BODY))` round-tripped with body in the ELSE arm** — pivot on
  `frame.kind` (`"if"` → `frame.exprs` IS the then-arm; `"else"` → `frame.thenExprs` is the
  then-arm). Inverted every wasic break/bounds/null-guard.
- **Tag exports dropped + tag type-index retyped after RemoveUnusedModuleElements** — added export-
  section `case 0x04` (parser, `$tag${index}`), encoder `case "tag"` (kind 0x04), and the GC-mode
  `mod.heapTypes`-indexed lookup in `encodeTagSection` (was using the deduped `getTypeIndex`).
- **Flag-4 (expression-form) element segments silently dropped** — WT-2c only handled
  `segKind === 0`; wabt with reference-types encodes active segments as flag 4 (`ref.func` expr
  list). Rewrote `readElementSection` to decode all 8 flag forms; `readElemExprFuncName()` helper.
  Every `Array.map/filter/forEach` callback dispatch through funcref tables had been trapping at
  runtime.

### WT-2f — round 3 (pass correctness)

1. **Inlining invalid wrapper-block fallthru** — see [passes.md](passes.md) Inlining; append
   explicit `makeUnreachable()`; type the synthesized `br` as `Unreachable` (was `value.type`).
2. **CoalesceLocals dispatched `call_indirect` to the wrong function** — the CFG must visit operands
   before `target` (wasm evaluates the table index last). Explicit `CallIndirect` case in `cfg.ts`.
3. **WAT parser emitted export kind `"func"` not `"function"`** — encoder switch + inliner
   `usedGlobally` both key on `"function"` → standalone-exported fn corrupted on encode AND deleted
   by Inlining. Map `func → function` in `parseExport`.

### WT-2g — round 4 (encoder, EH)

**`try`/`catch` handler body re-emitted wrapped in a spurious `block`** — the binary parser packs a
multi-instruction catch handler into an anonymous `Block`; the generic `encodeExpr` wrapped it in
`0x02…0x0b` (void blocktype), so the `catch` edge's pushed params landed on the wrong stack and the
handler's leading `local.set`s ran on an empty stack ("not enough arguments on the stack for
local.set"). Bare round-trip corruption. Fix: `encodeCatchBody` UNPACKS an anonymous-Block handler,
mirroring function-body unpacking.

### WT-2h / WT-2i / WT-2j — rounds 5–6 + the skipBinaryenOpt root-cause

These are three _distinct_ LocalCSE invalidation bugs plus catch/tuple parser bugs. Keep them
separate:

- **WT-2h** — catch-region operand handling: the catch handler seeded one hard-coded `makePop(I32)`
  regardless of tag arity, and `pop()` blindly took the top `exprs` entry (consuming `nop`
  placeholders). Fix: seed one typed `Pop` per tag param; `pop()` returns the topmost
  _value-producing_ expr, skipping `none`-typed statements (preserving side effects). Surfaced a
  WAT-parser gap: `ref.null`/`ref.func`/`ref.is_null` had no handler (fell to `nop`) — added the
  three handlers.
- **WT-2i** — (1) **multi-value (tuple) call returns**: a `call` returning N>1 results is one IR
  node but N stack values; the decoder modeled only the first consumer → the others popped `nop` →
  dangling stack. `pushMultiValueCall` seeds N-1 typed `Pop`s below the call. (2) **LocalCSE
  substituted a `local.get` across a write nested in an `if`** — `_invalidate` inspected only
  top-level child kind; now `walkExpression`s the whole child subtree. (True behavioral miscompile,
  present-but-unobservable before; `-1` printed as `1` in itoa.) Detour worth noting: `nextLocal` is
  `fn.locals.length` — `fn.locals` ALREADY includes params (`encoder`
  `fn.locals.slice(fn.params.length)` proves it).
- **WT-2j** — a THIRD LocalCSE bug, distinct from WT-2i: `_rewriteExpr` walks a single child's tree
  and substitutes cached `local.get`s WITHOUT invalidating mid-tree. For `add(LEFT, RIGHT)` where
  `LEFT` contains a nested `local.tee K` and `RIGHT` reads `local.get K`, `RIGHT` read the
  entry-time tee (pre-mutation value). Fix: the `Binary` case `_invalidate`s on the ORIGINAL `left`
  before rewriting `right` (within-expression analogue of WT-2i's cross-sibling invalidation).
  **This root-caused wasmtk's `skipBinaryenOpt` workaround** on the wasmmerge path (doubly-merged
  modules miscompiled); unblocks removing it after a binaryen-ts publish.

## CoalesceLocals try/catch EH-aware CFG (v1.3.4)

See [passes.md](passes.md) "EH-aware CFG". Before v1.3.4 the CFG only added a conservative
`bodyEntry → catchEntry` edge and didn't model that a deep `throw` transfers to the _enclosing_
handler, nor that a `local.set` whose value can throw must not kill the old value on the exceptional
path → a handler-read local looked dead → wrongly coalesced. Found via sibling `wasmtk`. Let wasmtk
drop its "skip Binaryen `-Oz` for exception modules" workaround once it bumps to `^1.3.4`.

## Diagnostic scripts (for the next investigation)

`scripts/{equiv_check,headtohead_bench,diag_sections,bisect_pass,bisect_validation,diff_function,
diff_wat,trace_failing,repro_branch_value,diag_fib,diag_dce,diag_cfg,diag_coalesce}.ts`.
`scripts/verify_roundtrip.ts` validates via `WebAssembly.compile` (promote it to a real test once
the parser is provably clean).

## Owner policy (from auto-memory)

**Fix footguns immediately** — don't defer silent-corruption/footgun fixes; fail-loud is the norm.
Only defer a fix if the fix itself risks rejecting valid input.
</content>
