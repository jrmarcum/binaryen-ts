# cmem — Portable Project Memory for binaryen-ts

This folder is the **authoritative, portable project memory** for `binaryen-ts`. It lives inside the
project tree, so it travels with the project (USB drive, clones) and is committed to git — unlike
the legacy `CLAUDE.md`, which is `.gitignore`d and therefore machine-local only.

**Format:** plain Markdown — one focused topic file per domain, so any single concern can be
reviewed and revised without wading through one giant file. Keep files small and single-topic.

This layout mirrors the `cmem/` convention established in the sibling `wasmtk` and `wabt-ts`
projects.

## Policy (durable)

- **`cmem/` is the single home for ALL project memory.** When the owner (or anyone) says "**update
  the project memory**," that means: update the matching `cmem/` topic file with the latest
  decisions, found bugs, design changes, and current state — then add/refresh its one-line pointer
  in the table below. Convert relative dates to absolute; update existing entries rather than
  duplicating.
- **`README.md` is NOT project memory.** It is the public, user-facing document shipped to GitHub
  and JSR. Keep internal decision logs / bug post-mortems out of it (those live here).
- The legacy `CLAUDE.md` (repo root, gitignored, machine-local) is the auto-loaded historical
  archive and remains the exhaustive line-by-line record; `cmem/` is the curated, portable source of
  truth that supersedes it going forward. When the two disagree, reconcile and prefer `cmem/`.

### The "update the project memory" trigger (binding on every agent)

When the owner says **"update the project memory"** (or any clear synonym — "update memory", "record
this", "remember this for the project"), the required action is:

1. **Revise all relevant `cmem/` files** — fold the latest decisions, found bugs, design changes,
   and current state into the matching topic file(s); refresh the one-line pointer in the Files
   table; convert relative dates to absolute; update existing entries instead of duplicating.
2. **Sync `README.md` where, and only where, the change is user-relevant** — install/usage,
   examples, capability surface, status. Keep internal detail in `cmem/` only.

This is the durable contract for this repo. Any agent reading this file is expected to honor it.

## Files

| File                               | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [overview.md](overview.md)         | What binaryen-ts is, its optimizer role in the wasmtk/wabt-ts/binaryang toolchain, the two-path optimization pipeline, repo layout, upstream C++ reference tree, core IR invariants                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [architecture.md](architecture.md) | Per-subsystem design: WAT parser (3-phase), binary parser, binary encoder, GC/EH/SIMD/tail-call proposals, hybrid mode (3 tiers + binaryen.js interop), WASM-kernel runtime, cross-runtime (`node:` imports) rules                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [passes.md](passes.md)             | The optimization pass set + pass-runner; per-pass design (Vacuum, OptimizeInstructions, CoalesceLocals + CFG liveness, LocalCSE, Inlining + split/partial + return-call, RemoveUnused*, PickLoadSigns); **Asyncify port ✅ COMPLETE (all 5 stages, registered `"Asyncify"`, runnable e2e matches wasm-opt v130; for TinyGo goroutines). Flatten pass (--flatten port) + `mapChildrenShallow` fix**                                                                                                                                                                                                                                                         |
| [correctness.md](correctness.md)   | **The load-bearing bug log + robustness contract.** Every resolution throws rather than silently miscompiling. The WT-2 differential-equivalence miscompile series (parser + pass correctness), the hardening Tiers 1–4 / A–C, branch-depth corruption, EH/tuple round-trip fixes, the 2026-07-07 four-pass fail-loud audit sweep (20 fixes incl. 6 behavioral miscompiles: the WAT-parser call/global type-inference root cause that fed Asyncify a None-typed local, parseLoop result type, Flatten tee clobber, PickLoadSigns, inlining ref/v128 reset, multi-table/blocktype corruption; v1.3.6). Each has a regression test — do not silently revert. |
| [testing.md](testing.md)           | How to run `deno task check` / `test` / `ci`; the Deno-only test suite (394 passing, 1 ignored as of 2026-07-07; asyncify COMPLETE; +9 flatten; four-pass fail-loud audit sweep — 20 fixes incl. 6 behavioral miscompiles, v1.3.6); the seeded differential optimizer fuzzer (`optimize_fuzz_test.ts`) and why behavioral fuzzing exists                                                                                                                                                                                                                                                                                                                   |
| [phases.md](phases.md)             | Phase delivery status (0–13 + sub-phases + WT-1…WT-2j) — condensed table; the canonical detail lives in CLAUDE.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [publishing.md](publishing.md)     | JSR `@jrmarcum/binaryen-ts`; tag-driven publish + OIDC provenance; `deno task bump` (sub-version-capped-at-9) + `deno task publish` (release driver); the gotchas (publish-guard, stale type-check cache, never `deno publish` locally, submodule remnant, tag-sync)                                                                                                                                                                                                                                                                                                                                                                                       |
| [licensing.md](licensing.md)       | MIT-primary with Apache-2.0 bonus; `LICENSE`/`LICENSE-MIT`/`LICENSE-APACHE` layout; single-SPDX + full-license-text JSR rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [bridge.md](bridge.md)             | Cross-project architecture (binaryen-ts ↔ wabt-ts ↔ wasmtk); the five agreed decisions; the constructor-API contract for the bridge; the wabt-ts handshake status; the binaryang merger target                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Related files outside cmem

- `README.md` — the **public, user-facing** doc for GitHub/JSR. NOT project memory.
- `CLAUDE.md` — legacy exhaustive memory archive (repo root, gitignored, machine-local; auto-loaded
  by Claude Code). The line-by-line historical record; superseded by `cmem/` as the curated source
  of truth.
- `TASKS.md` — granular phase-by-phase task list (gitignored, local-only).
  </content>
