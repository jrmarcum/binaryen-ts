# Phase delivery status

Condensed. The canonical line-by-line per-phase record lives in the gitignored `CLAUDE.md`; this
table is the portable summary. Current version: **v1.3.5** on JSR.

## Core phases

| Phase | Status     | Scope                                                                                                                                                                                                                                   |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | ✅         | Foundation: IR types, expressions, module builder, pass infra, DCE, API, interop (`BinaryenInterop.create` closed under Phase 0.1)                                                                                                      |
| 1     | ✅         | WAT text parser (tokenizer → S-expr → IR)                                                                                                                                                                                               |
| 2     | ✅         | WASM binary parser (`.wasm → IR`)                                                                                                                                                                                                       |
| 3     | ✅         | WASM binary encoder (`IR → .wasm`); full round-trip                                                                                                                                                                                     |
| 4     | ✅         | Core optimization passes (8 passes). 4.1: CFG-based dataflow liveness for CoalesceLocals                                                                                                                                                |
| 5     | ✅         | Inlining (`Inlining` + `InliningOptimizing`). 5.1: split/partial inlining + cleanup wiring; 5.1c CLI flag; 5.2 return-call inlining                                                                                                     |
| 6     | ✅         | `wasm-opt` native CLI + RemoveUnusedNames                                                                                                                                                                                               |
| 7     | ✅         | GC proposal — heap types, struct/array/ref, parser+encoder+WAT. 7.1: call_indirect type-ref, table.get/set, multi-segment CoalesceLocals                                                                                                |
| 8     | ✅         | EH proposal — tags, throw/throw_ref/rethrow/try_table. 8.1: WAT inline-body try, EH-aware DCE, StripEH pass                                                                                                                             |
| 9     | ✅         | SIMD proposal — v128, all lane types, 0xFD prefix, parser+encoder+WAT                                                                                                                                                                   |
| 10    | ✅ Partial | WASM-kernel runtime + dogfood embed pipeline; demo kernel + boundary benchmark. Kernel selection deferred (single-op dispatch regresses)                                                                                                |
| 11    | ✅         | Cross-runtime migration (`Deno.*` → `node:`) + JSR publish hardening + license rework + 100% JSDoc. 11.1 CI green; 11.2 housekeeping; 11.3 publish guard; 11.4 `deno task bump`; 11.5 auto-tag; 11.6 release driver + CI provenance fix |
| 12    | ✅         | `npm:binaryen` compatibility facade (`/compat`). 12.1: programmatic module construction + `runPasses`                                                                                                                                   |
| 13    | ✅         | Tail-call proposal binary support (`return_call` / `return_call_indirect`)                                                                                                                                                              |
| 0.1   | ✅         | Phase 0 closure — in-process binaryen.js bridge                                                                                                                                                                                         |

## Wasmtk-migration critical path (WT series)

| Phase                 | Status | Scope                                                                                                                                                                    |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WT-1                  | ✅     | LEB128 signed-overflow parser fix; corpus 74 → 84 files, 1,432 → 82,912 expressions                                                                                      |
| WT-2 / WT-2b          | ✅     | Binary-parser round-trip validity (9 MVP-critical files validate); `WebAssembly.compile` failures 16 → 7 (remaining 7 deferred non-MVP)                                  |
| WT-2 (bench)          | ✅     | Head-to-head vs `npm:binaryen@^116` on `-Oz`: 7/7 validate, ~14× faster; honest code-size aggregate **1.12× (ours larger)** after correcting for dropped custom sections |
| WT-2c                 | ✅     | Six behavioral miscompiles via `equiv_check.ts` (elem segments, LocalCSE×2, Vacuum/SimplifyLocals type, makeIf LUB, CoalesceLocals identity)                             |
| WT-2d / WT-2e         | ✅     | wasmtk integration rounds 1–2: single-arm if arm-inversion; tag exports/type-index; flag-4 element segments                                                              |
| WT-2f                 | ✅     | round 3: inlining wrapper fallthru; CoalesceLocals call_indirect operand/target order; WAT export-kind `func→function`                                                   |
| WT-2g                 | ✅     | round 4: try/catch handler re-emitted wrapped in spurious block (`encodeCatchBody`)                                                                                      |
| WT-2h / WT-2i / WT-2j | ✅     | rounds 5–6: catch-param Pop seeding; multi-value tuple call Pops; three distinct LocalCSE invalidation bugs (WT-2j root-caused wasmtk's `skipBinaryenOpt`)               |

See [correctness.md](correctness.md) for the full root-cause detail on every WT fix.

## Versioning

Sub-version-capped-at-9: `1.0.9 → 1.1.0`, `1.9.9 → 2.0.0`, major uncapped (`9.9.9 → 10.0.0`).
Enforced by `deno task bump`. See [publishing.md](publishing.md).

## In progress

- **Asyncify** (`--asyncify` port, for TinyGo goroutines). **Stage 1 of 5 done** (2026-07-05,
  `2902fca`): runtime-support synthesis, differentially validated vs `wasm-opt` v130. Stages 2-4
  (ModuleAnalyzer / AsyncifyFlow / AsyncifyLocals) + Stage 5 (validate + register + CLI wiring) remain.
  Full detail + resume point in [passes.md](passes.md) § "Asyncify".

## Deferred / not-yet-done

- Phase 10 kernel selection (deferred until real-corpus profiling).
- TranslateEH (behind multivalue/tuple IR).
- Promote `scripts/verify_roundtrip.ts` to a real test once the parser is provably clean.
- Custom-section preservation (parse→encode drops DWARF `.debug_*`/`name`/`producers` — fine for
  production `-Oz`, must be acknowledged).
  </content>
