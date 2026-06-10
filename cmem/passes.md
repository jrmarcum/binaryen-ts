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
(keys follow upstream `passname@argname`; currently plumbing only). The 19 placeholder
`ExpressionKind` members are dead but kept as a deliberate roadmap — `walk.ts` throws if one is ever
constructed without a case.
</content>
