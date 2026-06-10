# Licensing

binaryen-ts is **single-license MIT** in JSR metadata, with Apache-2.0 provided as a bonus
alternative file. This mirrors sibling `wasmtk` / `wabt-ts` and was adopted after a failed JSR
publish.

## File layout

| File             | Purpose                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`        | **The declared package license — full MIT text.** JSR fingerprints this (content hash vs the SPDX template). Must be the first content, no markdown decoration. |
| `LICENSE-MIT`    | Identical copy of `LICENSE`. Convention-only, redundant, kept for symmetry with `LICENSE-APACHE`.                                                               |
| `LICENSE-APACHE` | Full Apache-2.0 text. Bonus — JSR ignores it; users who need Apache-2.0 (and upstream binaryen attribution) can adopt it.                                       |
| `deno.json`      | `"license": "MIT"` — single SPDX identifier, matches the LICENSE content.                                                                                       |

## JSR rejects on two conditions (both must hold)

1. The `license` field in `deno.json` must be a **single SPDX identifier** (`"MIT"`). Compound
   expressions like `"MIT OR Apache-2.0"` are syntactically valid but unreliable — JSR may accept
   the field yet still reject the publish. **Prefer a single identifier.**
2. The `LICENSE` file must contain the **actual full license text** (matched by content hash).
   Pointer documents ("this project is dual-licensed, see LICENSE-MIT and LICENSE-APACHE") have no
   SPDX fingerprint and are rejected with
   `invalidLicense: The license specified … was not recognized.`

**Symptom of failure**: `Publish failed: invalidLicense: …`. Fix: replace `LICENSE` with real
license boilerplate (e.g. `cp ../wasmtk/LICENSE LICENSE`) and verify `deno.json` declares a single
SPDX matching its content.

Bonus license files are communicated **socially** — their presence in the published tarball signals
dual-license availability, but JSR records only the `license` field's value.

## JSR provenance + JSDoc

JSR provenance publishing requires all exported symbols to have JSDoc and file-level `@module` tags
(100% lint-clean coverage was reached in Phase 11 — 352 `deno doc --lint` errors fixed). Don't add a
new export without at least a one-line JSDoc. JSDoc `{@link}` / `@example` snippets are NOT
type-checked — grep for an old factory name in JSDoc as well as code when renaming (Phase 11.2 found
stale `makeConst()` refs; the real factories are per-type
`makeI32Const`/`makeI64Const`/`makeF32Const`/ `makeF64Const`).
</content>
