# Optimization passes

`src/passes/` — registry (`pass.ts`: `Pass` interface, `PassRunner`, registry, `PassOptions`),
runner, and one file per pass. Reference each upstream `.cpp` in `upstream/src/passes/` when
porting. **Correctness fixes to these passes are logged in [correctness.md](correctness.md)** — read
that before touching CoalesceLocals, LocalCSE, Inlining, or Vacuum.

## Shared IR walk utilities (`src/ir/walk.ts`)

- `mapExpression(expr, fn)` — bottom-up transform (children first). Used by Vacuum,
  OptimizeInstructions, RemoveUnusedBrs, SimplifyLocals, CoalesceLocals, LocalCSE, PickLoadSigns.
  **Caveat that bit CoalesceLocals**: `_mapChildren` UNCONDITIONALLY spreads (`{ ...expr }`), so any
  descendant rewrite rebuilds every ancestor as a copy — identity-based `Set.has(node)` checks fail.
  Mark nodes with a `Symbol`-keyed property instead (object spread copies symbol keys). See WT-2c
  #5.
- `walkExpression(expr, visitor)` — pre-order visitor (parent before children). Analysis-only
  passes.

## The pass set

| Pass                               | What it does                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dce.ts`                           | Dead code elimination. EH-aware (`Try`/`TryTable` cases; `eliminateDeadBlock` recurses).                                                                                                                                                                  |
| `vacuum.ts`                        | Remove `nop` from blocks; collapse empty + unnamed-single-child blocks (guarded: collapse only when child type matches the block OR is `unreachable`); `drop(const\|local.get\|global.get)` → `nop`. `vacuumNode` exported as a reusable per-node helper. |
| `optimize-instructions.ts`         | Algebraic identities (RHS-constant-first: shift-by-0, identity elements, ÷1) + i32/i64 constant folding (clz/eqz/extend/wrap/sign-extend). **Float ops excluded** (NaN). `optimizeNode` exported.                                                         |
| `remove-unused-brs.ts`             | Remove tail-position `br`/`br_if` to own label. Safety: the new last child must be type `none` so the block result type is unchanged.                                                                                                                     |
| `simplify-locals.ts`               | Consecutive `local.set(i) + local.get(i)` → `local.tee`. Same-block, no intervening instr.                                                                                                                                                                |
| `coalesce-locals.ts`               | Dead-write elimination + slot coalescing, driven by CFG liveness (see below).                                                                                                                                                                             |
| `cfg.ts`                           | Structural CFG + backward-flow worklist liveness. Shared infra.                                                                                                                                                                                           |
| `local-cse.ts`                     | Within-block common-subexpression elimination. Keys pure subexprs by structural string hash.                                                                                                                                                              |
| `remove-unused-module-elements.ts` | Reachability-based dead function/global removal. Seeds from exports + element segments; fixed-point call-graph walk via `Call` + `RefFunc`. Imported elements never removed.                                                                              |
| `pick-load-signs.ts`               | Sign/unsigned selection for narrow loads. Tracks `local.set(i, narrow_load)`, counts signed/unsigned uses, flips if all agree.                                                                                                                            |
| `inlining.ts`                      | `Inlining` + `InliningOptimizing` (see below).                                                                                                                                                                                                            |
| `remove-unused-names.ts`           | Strip unused block/loop labels (2-pass per fn: collect branch targets, then strip bottom-up). A loop with no back-edge → replaced by its body (type-guarded).                                                                                             |
| `strip-eh.ts`                      | `throw`/`throw_ref` → `block[drop(op)…, unreachable]`; `rethrow` → `unreachable`; `try`/`try_table` → body. Clears tags + `hasExceptionHandling`.                                                                                                         |
| `flatten.ts`                       | Rewrites functions into **Flat IR**: every value subexpr hoisted into its own `local.set`, operands trivial, control flow routes values through temp locals. Port of upstream `--flatten`. Registered. Prerequisite for Asyncify Stage 3b. Also surfaced the `mapChildrenShallow` fix in `walk.ts`. |
| `asyncify.ts`                      | **IN PROGRESS (Stage 3b/5 done).** Pause/resume (unwind/rewind the call stack) — port of upstream `--asyncify`. S1 runtime support; S2 `analyzeModule` instrument-set (oracle-validated); S3a flatten + S3b flow (control-flow skip/unwind, structural-validated) done. NOT registered until S4 (locals + intrinsic lowering) lands. See the dedicated section below. |

## CoalesceLocals + CFG liveness (`cfg.ts` + `coalesce-locals.ts`, Phase 4.1)

`cfg.ts` builds a structural CFG over Block/If/Loop/Br/BrIf/Switch/Return/Unreachable/Throw/Try/
TryTable and runs **backward-flow worklist liveness**. CoalesceLocals: per block, a backward scan
from live-out finds _effective sets_ (local live after the set) and _ends-live-range gets_; a
forward scan marks interference at each effective set; the interference graph is greedily coloured.
Loop back-edges propagate the loop top's live-in back into every predecessor (including the
back-edge), so loop-carried values (counters/accumulators read at iter N+1) stay live across
iterations.

**Two order-sensitivity fixes** (the CFG must visit children in wasm eval order, not syntactic
order):

- `Break` is handled explicitly (visits value before the branch).
- `CallIndirect` **must visit operands before `target`** (wasm evaluates the table index last) — a
  WT-2f fix; the generic `visitChildren` visited target first and mis-classified a `local.tee` in an
  operand that only the index re-reads, eliminating it → wrong-signature dispatch.

An EH-aware CFG (v1.3.4) models exception edges: a `try` pushes its catch entries onto a
`handlerStack` while its body is visited; throwing instructions (`throw`/`throw_ref`/`rethrow`, and
`call`/`call_indirect`) add exceptional edges to all enclosing handlers; a throwing `call` also
SPLITS its block so a wrapping `local.set`'s kill can't strip a handler-live local. Without this, a
local an exception handler reads looked dead inside the body and got wrongly coalesced —
miscompiling valid exception code.

## Inlining (`inlining.ts`, Phases 5 / 5.1 / 5.2)

- **Call-graph analysis** (`buildFunctionInfo`): counts call-site refs, detects
  `hasLoops`/`hasCalls`, marks `usedGlobally` from exports + element segments (keys on `"function"`
  — a WT-2f fix made the WAT parser emit `"function"` not `"func"`).
- **Thresholds** (upstream `pass.h` defaults): always inline if size ≤ 2; single-caller non-exported
  if size ≤ 10; `optimizeLevel ≥ 3` multi-caller if size ≤ 20. Recursion guard: never inline `$f` in
  `$f`.
- **Substitution**: wrapper block `(block $__inlined_func$callee …)`; extend caller locals with a
  `deepCopy` of callee locals; `local.set` per operand; zero-init non-param locals; remap local
  indices; rewrite callee `return` → `br $label`. `deepCopy` is required (tree-ownership: one parent
  per node, same fn may inline at many sites).
- **Wrapper fallthru** (WT-2f): when the callee delivers its result via `return` (→ `br $wrapper`)
  the body block is typed `unreachable` (void blocktype); append an explicit `makeUnreachable()` so
  the result-typed wrapper's structurally-reachable fallthru isn't an empty-stack error.
- **Dead-callee removal**: match against the known `inlineable` set — NOT `name.split("$")[1]`
  (which is `""` for `$`-prefixed names, so fully-inlined `$func`s were never removed — a Tier-4
  fix).
- **Split / partial inlining** (Phase 5.1, opt-in `PassOptions.partialInliningIfs`, default 0
  matching upstream): `FunctionSplitter` ports `Inlining.cpp:740-1240`. Pattern A
  (`if(simple) return; …rest`)
  - Pattern B (sequence of `if(simple) heavy`). `isSimple` allow-list mirrors upstream.
- **Return-call inlining** (Phase 5.2): `substituteBody(rewriteReturns=false)` when `call.isReturn`,
  so the callee's returns propagate as the caller's (tail-call frame-replacement semantics); wrap in
  `(return <block>)` for value callees, sequence `[block, (return null)]` for void.
- **InliningOptimizing** (Phase 5.1): after each inline, runs `mapExpression(body, vacuumNode)` +
  `mapExpression(body, optimizeNode)`.

## `wasm-opt` CLI (`src/tools/wasm-opt.ts`, Phase 6)

Native path: `parseWasm` → `PassRunner` → `encodeWasm` (subprocess-free). `--hybrid` routes to the
upstream binary. Pass selection: explicit `--<passname>` appends; else
`addDefaultOptimizationPasses()` runs for `-O1`+. `--pass-arg key=val` → `PassOptions.passArgs`.
`--partial-inlining-ifs N` / `-pii N` wired through `parseArgs` (added to `RECOGNIZED_LONG_FLAGS` so
it isn't read as a pass selector; forwarded as `-pii N` in hybrid mode). `--validate` runs
`WebAssembly.compile` on the output (default on for `wasmOpt` tests). `Module.optimize` parses the
`-O0/-O1/-O3` level (was hardcoded `optimizeLevel: 2`); `-O0` skips passes. `main.ts --version` uses
a single `VERSION` constant.

## PassOptions

`optimizeLevel`, `shrinkLevel`, `partialInliningIfs` (default 0), `passArgs: Record<string,string>`
(keys follow upstream `passname@argname`; `asyncify.ts`'s `parseAsyncifyOptions` is the first real
consumer of `passArgs`). The 19 placeholder
`ExpressionKind` members are dead but kept as a deliberate roadmap — `walk.ts` throws if one is ever
constructed without a case.

## Asyncify (`asyncify.ts`) — IN PROGRESS (Stage 1 of 5 done, 2026-07-05)

Faithful port of upstream `--asyncify` (`upstream/src/passes/Asyncify.cpp`, **2030 LOC**) into native
TS. **Driving use case:** be the `wasm-opt --asyncify` post-processing step that **TinyGo goroutine**
wasm requires, so wasmtk's `--lang=go` path needs no external binaryen (roadmap item #2 / wasmtk
`cmem/roadmap.md`). TinyGo depends on the exact ABI, so the transform + generated runtime-support must
match upstream in shape.

**Foundation (all present — this is a port, not a from-scratch build):** the 66 `make*` IR builders,
`ModuleBuilder`, the CFG + backward-flow liveness in `cfg.ts`/`coalesce-locals.ts` (exactly what
AsyncifyLocals needs), and the `Pass` framework. Upstream `Asyncify.cpp` + `upstream/test/unit/
test_asyncify.py` are vendored to port from and validate against.

**Reference oracle for differential validation:** real `wasm-opt` **v130** and **TinyGo 0.41.1** are
installed on this machine. Every stage is checked against `wasm-opt --asyncify` on identical inputs; a
real TinyGo goroutine module is the Stage-5 end-to-end acceptance test.

**ABI produced** (upstream header contract): global `$__asyncify_state` (i32: 0 normal / 1 unwind /
2 rewind) + `$__asyncify_data` (i32 ptr to `{ i32 stackPos@0; i32 stackEnd@4 }`; i64 fields @0/@8 for
wasm64). Five exported control fns: `asyncify_start_unwind(ptr)`, `asyncify_stop_unwind()`,
`asyncify_start_rewind(ptr)`, `asyncify_stop_rewind()`, `asyncify_get_state()`. Body transform = "skip
forward while rewinding, jump out while unwinding" over structured control flow (not a CFG rewrite).

**Staged plan** (commit `2902fca` = Stage 1):
- **Stage 1 ✅** — ABI constants (`State` 0/1/2, `DataOffset` 0/4, global + fn names),
  `parseAsyncifyOptions` (full `--pass-arg=asyncify-*` surface: imports / ignore-imports /
  ignore-indirect / add-remove-only lists / memory / import-export-globals), and
  `synthesizeRuntimeSupport` (2 mut-i32 globals + 5 exported control fns). Differentially validated:
  our emitted globals + 5 control fns are **byte-for-shape identical** to wasm-opt v130 (state values,
  `gt_u` stack-overflow check at offsets 0/4, export order); real wasm-opt round-trips our binary.
  **7 tests** in `tests/passes/asyncify_test.ts`; full suite **348/348**. wasm32 only (wasm64 throws a
  clear "not yet" — TinyGo is wasm32).
- **Stage 2 ✅** (commit `3b35d97`) — `analyzeModule(module, options)`: whole-program analysis of which
  functions can change state (transitive over the call graph; imports **default-can-unwind** unless
  `asyncify-imports`/`ignore-imports`; indirect calls default-can-unwind unless `ignore-indirect`;
  `add`/`remove`/`only` lists with backward propagation). Ported from `Asyncify.cpp` 538-808. The
  in-wasm `asyncify.*` import runtime mode is **rejected with a clear error** (not mis-analyzed) —
  TinyGo/host-driven pausing don't use it. **Differentially validated** vs `wasm-opt --asyncify
  --pass-arg=asyncify-verbose` v130 (parse the "[asyncify] X can change the state" lines): all 6 cases
  match. **10 tests** in `tests/passes/asyncify_analyzer_test.ts`; full suite **358/358**.
- **Stage 3a ✅** (commit `2e30ea4`) — ported `flatten` (`src/passes/flatten.ts`, registered) from
  upstream `Flatten.cpp`. Rewrites each function into Flat IR: every value subexpr hoisted into its
  own `local.set`, operands trivial (`local.get`/const), control flow (block/if/loop) routes values
  through temp locals with trivial conditions. Clean recursive `flattenExpr(e)→{pre,value}`
  formulation (equivalent to upstream's preludes-map). `local.get` IS reduced (preserves eval order
  across side-effecting preludes); const stays inline. EH/tuples/value-carrying branches throw
  (TinyGo code — loops/ifs/calls/locals — fully covered). **Surfaced+fixed a latent `walk.ts` bug:**
  `_mapChildren` recursed via `mapExpression` on every child, so there was no true one-level mapper;
  refactored it to apply its callback to DIRECT children only (`mapExpression` now passes a recursing
  callback — identical behavior, full suite green) and exposed `mapChildrenShallow`. Validation:
  behavioral equivalence (run original vs flattened, bit-identical) + flatness invariants (no
  local.tee, trivial conditions/operands, calls hoisted). **9 tests**; full suite **367/367**.
- **Stage 3b ✅** (commit `62a4573`) — `flowInstrumentFunction(func, ctx)` ported from AsyncifyFlow
  (`Asyncify.cpp` 878-1258). On a flattened instrumented func: wraps the body so a rewind pops its call
  index then re-executes skipping forward; linearizes if (→ guarded `rewinding||cond` arms) / loop /
  block (clumps non-state-changing runs under one `if(state==Normal)` skip); wraps each state-changing
  call (`makeCallSupport`) with a call-index check + possible-unwind; `local.set`-of-call defers via a
  per-type **fake global**. `exprCanChangeState` = the per-call-site walk. Emits 3 TEMPORARY intrinsics
  (`$__asyncify_get_call_index`/`_check_call_index`/`_unwind`) that Stage 4 implements — so flow output
  isn't runnable yet and is NOT wired into `run()` (kept as its own exported fn); validated
  **structurally** (rewind prelude, 1 check+unwind per call w/ distinct indices, if/loop linearization,
  fake-global deferral). **7 tests.** **Also fixed a latent Flatten gap it surfaced:** the parser leaves
  `Call.type===none`, so flatten was dropping value-returning calls as void — added `buildCallResultTypes`
  + a resolver threaded into `flattenFunction` (now takes the map; `FlattenPass` builds it). Full suite **374/374**.
- **Stage 4 (NEXT)** — `AsyncifyLocals` + **implement the 3 temporary intrinsics** (`Asyncify.cpp`
  ~1358-1700 + the intrinsic lowering). Adds, per instrumented func: the `$__asyncify_unwind` block
  target, local save (on unwind) / restore (on rewind) over the asyncify stack using liveness (reuse
  `cfg.ts`/`coalesce-locals.ts`), the call-index push/pop/check against the stack, and the increment of
  the stack pointer. Replaces the fake globals + intrinsic calls emitted in 3b with real stack ops.
  After this the module is RUNNABLE — first point behavioral tests are possible.
- **Stage 5** — port `test_asyncify.py` cases + a real TinyGo goroutine e2e; then `registerPass` +
  wire `--asyncify` into `wasm-opt.ts`/compat + `AsyncifyPass.run` (analyze → per-instrumented-func
  flatten+flow+locals → synthesize runtime support). The pass is deliberately **unregistered** until
  Stage 4 completes (nothing may invoke a half-instrumented transform).

**RESUME POINT (next session):** Stage 4 — port `AsyncifyLocals` (`Asyncify.cpp` ~1358-1700) and
**lower the 3 temporary intrinsics** that Stage 3b emits. Per instrumented (flat+flowed) function,
AsyncifyLocals: (1) wraps the body in a `$__asyncify_unwind` block; (2) uses liveness (reuse
`cfg.ts`/`coalesce-locals.ts`) to find the locals live across each call, and emits save-on-unwind /
restore-on-rewind over the asyncify stack (`__asyncify_data`'s stack ptr @0, end @4; STACK_ALIGN=4;
grows up); (3) lowers the intrinsics: `$__asyncify_check_call_index(i)` → compare the popped index to
`i`; `$__asyncify_get_call_index()` → load the next index from the stack; `$__asyncify_unwind(i)` →
push `i` + break to `$__asyncify_unwind`; and resolves the fake globals (`$asyncify_fake_call_global_*`)
into the local save/restore. See upstream `AsyncifyLocals` struct + `makeCallIndexPush/Peek` and the
`AsyncifyBuilder::makeGetStackPos`/`makeIncStackPos` (Asyncify.cpp 888-912) for the exact stack ops.
After Stage 4 the module is RUNNABLE → first behavioral tests (a hand-written suspend/resume driver,
then TinyGo). Then Stage 5 wires `AsyncifyPass.run` (analyze → per-func flatten+flow+locals →
synthesize) + registers the pass + `--asyncify` CLI. Exported building blocks already in `asyncify.ts`:
`analyzeModule`, `flowInstrumentFunction`, `materializeFakeGlobals`, `synthesizeRuntimeSupport`;
`flattenFunction`/`buildCallResultTypes` in `flatten.ts`.
</content>
