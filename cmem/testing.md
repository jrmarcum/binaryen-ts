# Testing

## Running

```sh
deno task check       # type-check all files
deno task test        # run the full suite (341 passed, 1 ignored — verified 2026-06-09)
deno task fmt         # format
deno task lint        # lint
deno task ci          # check + test (the bundle CI runs)
deno task publish:dry # validate the JSR manifest without publishing (--allow-dirty)
```

The 1 ignored test is the live `npm:binaryen` interop test, gated on `BINARYEN_LIVE=1`.

Tests are **Deno-only** (`Deno.test` + `@std/assert` via the `imports` map in `deno.json`) — kept on
Deno when the library went cross-runtime (May 2026). The published library is runtime-agnostic and
validated to compile under Node + Bun via the JSR `slow-types` check during publish. The publish
manifest excludes `tests/`, `benches/`, `scripts/`, `upstream/`, `wabt-ts/`, so the test-runner
choice has zero consumer impact.

`@std/assert` is declared once in `deno.json`'s `imports` (`"@std/assert": "jsr:@std/assert@^1"`)
and referenced by mapped name in every test — never an inline `jsr:` specifier (trips
`no-import-prefix`/`no-unversioned-import`).

## Test tree (mirrors `src/`)

`tests/parser/`, `tests/binary/` (+ GC/EH/SIMD parser+encoder; `control_flow_regression_test.ts`,
`reader_test.ts`, `table_ops_test.ts`, `eh_test.ts`), `tests/encoder/`, `tests/passes/`
(`passes_test.ts`, `inlining_test.ts`, `optimize_pipeline_test.ts`, `optimize_fuzz_test.ts`),
`tests/tools/`, `tests/wasm/`, `tests/api/` (`binaryen_compat_test.ts`), `tests/interop/`
(`binaryen_interop_test.ts` — mock factory, zero CI dep; live test gated on `BINARYEN_LIVE=1`).

## The differential optimizer fuzzer (`tests/passes/optimize_fuzz_test.ts`)

Because every WT-2f…WT-2j optimizer bug was a **behavioral** miscompile (valid wasm, wrong value)
that `WebAssembly.compile` validity never caught, a seeded differential fuzzer generates random
`i32` functions packed with the recurring hazards:

- `local.tee K` whose value a sibling operand re-reads (WT-2j within-expression eval-order)
- writes to `K` nested in `if` branches that a later sibling reads (WT-2i cross-sibling)
- repeated pure subexpressions over a small local pool (CSE candidates)
- plus dead/live sets, drops, `select`, nested blocks

For each function it runs the real pipeline (build IR → encode → `parseWasm` → full `-Oz` → encode),
then asserts the optimized binary is **valid** AND returns **bit-identical** results to the
unoptimized build over edge-case inputs; on divergence it bisects the pipeline to name the first
offending pass and prints a reproducible seed + the function IR.

Deterministic (seeds 1..N), CI-safe; default 350 functions. Crank ad-hoc:

```sh
FUZZ_ITERS=30000 deno test --allow-read --allow-env tests/passes/optimize_fuzz_test.ts
```

**It has teeth** — verified by reverting each fix: WT-2i recursion removed fails at seed 4; WT-2j
`Binary`-case `_invalidate` removed fails at seed 18; both correctly name `LocalCSE` as the first
bad pass. 50k+ functions across multiple seed ranges pass with the fixes in place.

**Not fuzzed**: the dangling-stack family (multi-value tuple calls, catch-param `Pop` threading) —
hand-generating valid tuple-consuming / catch-binding IR is fragile. Covered instead by real-fixture
regression tests in `tests/passes/optimize_pipeline_test.ts` (46_TemplateEscapes) and
`tests/binary/eh_test.ts`.

## The behavioral-equivalence harness (`scripts/equiv_check.ts`)

Not a `Deno.test` — a script. Two stubbed instances driven by the same call sequence stay
bit-identical iff optimization preserved semantics (stubs only need to be IDENTICAL, not
meaningful). This surfaced the six WT-2c miscompiles the validity-only bench had called "valid." See
[correctness.md](correctness.md).

## Regression-test placement convention

When fixing a footgun/silently-wrong bug, add the regression test alongside the invariant note in
[correctness.md](correctness.md). **Fail-loud (throw) over silent-wrong output is the project
contract.** Key files: `tests/binary/control_flow_regression_test.ts` (branch-depth, single-arm if,
tag exports, WT-2b frames), `tests/passes/optimize_pipeline_test.ts` (WT-2i/j behavioral), the
proposal `*_test.ts` files for GC/EH/SIMD round-trips.

## CI gate

`.github/workflows/ci.yml` runs type-check + lint + test + `deno publish --dry-run` on every push/PR
— catches `slow-types` regressions, manifest changes, excluded-file drift. **Local fmt/lint must
walk the same trees as CI**: CI checks out without submodules, so `deno.json`
`fmt.exclude`/`lint.exclude` mirror `["upstream/", "wabt-ts/", "node_modules/"]` (else local flags
~5500 unrelated issues and "passes locally / fails on CI" diverge). See
[publishing.md](publishing.md) for the stale-type-check- cache gotcha that lets local `check` lie
when a cross-file type dependency changes.
</content>
