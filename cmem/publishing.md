# Publishing & release flow

Published as **`@jrmarcum/binaryen-ts`** on JSR. GitHub remote: `github.com/jrmarcum/binaryen-ts`.
Current version: **v1.3.9**. JSR publish runs via GitHub Actions with **OIDC provenance — no publish
token is stored anywhere**. ⚠️ Provenance recording is currently broken JSR-side for this package
since v1.3.5 — see "JSR-side provenance recording stopped" below.

## Never run `deno publish` locally

**Provenance only attaches when `deno publish` runs inside the GitHub Actions workflow** (the
workflow provides the OIDC token JSR fingerprints). A local `deno publish` succeeds and uploads, but
the version is permanently flagged "No provenance" on JSR — **it cannot be retro-fixed on that
version number**; you must bump and re-publish via the workflow. Versions `1.0.0`–`1.0.9` have
`rekorLogId=""` (published locally before the chain existed); v1.1.0+ have OIDC provenance. The only
safe local invocation is `deno task publish:dry` (`--allow-dirty`, never uploads).

Symptoms someone published locally: no git tag for the version; missing "Provenance" badge;
`deno.json` version bumped + published but no run at `.../actions/workflows/publish.yml`.

## Release flow

```sh
git add -A
git commit -m "..."   # commit ALL source changes manually FIRST (see publish-guard gotcha)
deno task bump        # writes the next deno.json version (sub-version-capped-at-9)
deno task publish     # guard passes, commits the bump, force-tags vX.Y.Z, pushes commit + tag atomically
```

`deno task publish` runs `scripts/publish.ts` — a **release driver** that stages `deno.json`,
commits `bump to vX.Y.Z`, force-tags, and pushes commit + tag in a single
`git push origin main vX.Y.Z`. It has **no `deno publish` call site** — local provenance protection
is structural, not defensive. The tag push fires `.github/workflows/publish.yml`, which verifies the
tag matches `deno.json` → `check` → `test` → `deno publish` **directly** (NOT `deno task publish` —
the indirection through `Deno.Command` strips provenance) →
`gh release create --generate-notes --verify-tag`.

**Safety net — `auto-tag.yml`**: if a `deno.json` version bump lands on `main` without going through
`deno task publish` (in-browser edit, forgotten tag), it creates + pushes the matching tag and
explicitly dispatches `publish.yml` via `gh workflow run` (required — GitHub doesn't fire workflows
for `GITHUB_TOKEN`-authored pushes; developer PAT pushes fire `publish.yml` directly).

## `deno task bump` (version rule)

Increments `deno.json` `version` in place; each sub-version (patch, minor) maxes at 9 before rolling
into the next greater segment; major uncapped. `1.0.9 → 1.1.0`, `1.9.9 → 2.0.0`, `9.9.9 → 10.0.0`.
**Only edits `deno.json`** (reversible via `git checkout deno.json`); commit/tag/push are explicit
user steps. Preserves formatting by regex-replacing only the `"version"` line (not JSON round-trip).
Shared helpers in `scripts/version.ts` (`readCurrentVersion`, `nextVersion`, `DENO_JSON_URL`).

## JSR setup precondition

The GitHub repo `jrmarcum/binaryen-ts` must be linked under "GitHub Actions" in the JSR package
settings, else OIDC provenance is rejected. Verify via the API if the settings UI is unreachable:
`curl https://api.jsr.io/scopes/jrmarcum/packages/binaryen-ts | jq .githubRepository` (the settings
UI once errored with a Fresh-framework bug `'ctx.state.user' may only be used during rendering`).
`provenance: true` is NOT a `deno.json` field (removed when JSR went OIDC-only — delete it if you
see an `unknown field provenance` parse error).

## Gotchas (recovery recipes)

### publish-guard — `scripts/publish.ts` only commits `deno.json`

`scripts/publish.ts` runs `git status --porcelain` first and **refuses if any tracked file outside
`deno.json` is dirty** (untracked `??` files don't block). This is how v1.2.3 shipped as effectively
v1.2.2 with a different version string — two sessions of WT-2c work sat uncommitted while only the
bump was tagged; the wasmtk team reported "the bugs you fixed are still there" because the artifact
had none of the fixes. **Commit all source changes manually before `deno task bump`.**

### stale type-check cache — v1.2.4 lesson

`deno task check` caches per-file by hash. Editing file A and re-running `check` does NOT re-check
file B even if B's types depend on A (B's own bytes didn't change). CI starts with no cache and
catches the mismatch; local lies. This shipped v1.2.4 broken (a new `WasmExport.kind` member made a
compat `Record` incomplete; local passed, CI failed at publish step 5 → orphaned tag, no JSR
publish, no Release). **Recovery**: bump and re-publish (JSR has no record of the failed version).
Future-proofing (not yet applied): `deno task check --reload` + `deno task test` in
`scripts/publish.ts` before the tag push.

### JSR-side provenance recording stopped (v1.3.5+, unresolved as of 2026-07-08)

**Symptom**: `curl .../versions/X.Y.Z | grep rekorLogId` returns `"rekorLogId":null` for every
binaryen-ts version since **v1.3.5 (~2026-06-10)**, even though the publish workflow is green and
the `deno publish` step prints
`Provenance transparency log available at https://search.sigstore.dev/?logIndex=…`

- `Successfully published`. v1.1.1–v1.3.3 have a numeric `rekorLogId`.

**Key distinction**: that Sigstore line proves **Deno created + uploaded the attestation** — it does
NOT prove **JSR recorded it**. JSR records provenance in an async step a few seconds after publish;
the tell is `updatedAt` vs `createdAt` on the version: working versions differ by ~5–10s (JSR's
recording step ran), broken ones have `updatedAt == createdAt` (it never ran). `rekorLogId` in the
JSR API is the authoritative indicator; the deno log line is not.

**This is NOT** (all eliminated, four throwaway publishes v1.3.6–v1.3.9):

- **Not a local publish** — those have `rekorLogId=""` (empty), these are `null`; all went through
  CI.
- **Not the Deno version** — v1.3.8 pinned to Deno **2.8.1** (the exact version that recorded fine
  for v1.3.3) still came out null. So the 2.8.1→2.8.2 boundary was coincidental; the pin was
  reverted.
- **Not the publish command** — sibling `@jrmarcum/wasmtk` + `@jrmarcum/wabt-ts` use byte-for-byte
  the same workflow (`deno publish`, `setup-deno@v2` `v2.x`, tag-push, `id-token: write`) and DO
  record provenance (published 2026-07-03). So `npx jsr publish` vs `deno publish` is not the fix.
- **Not JSR-wide / not the account** — `@std/assert`, `@oak/oak`, and the two siblings all record
  it.
- **Not a stale repo link** — JSR `githubRepository.id` (1226815384) matches the live GitHub repo
  id. Unlink+relink in the JSR UI did **not** change the link's `createdAt` (still 2026-05-25) — JSR
  appears to treat a same-repo relink as idempotent, so the timestamp is not a reliable "did it
  take" signal.

**Conclusion**: JSR-side state specific to the `binaryen-ts` package record; nothing in this repo's
config can fix it (identical setup works for the siblings). **Contacted JSR support 2026-07-08.**
Provenance **cannot be backfilled** onto v1.3.6–v1.3.9 — it attaches on the next publish _after_ JSR
fixes their side. When they confirm a fix: bump + publish, then verify `rekorLogId` is a number
within seconds (don't trust the deno Sigstore line alone). Diagnostic scripts were ad-hoc `curl` to
`api.jsr.io/scopes/jrmarcum/packages/binaryen-ts[/versions/X.Y.Z]` and the GitHub Actions job-log
API.

### tag-sync — `would clobber existing tag`

If `git fetch origin --tags` rejects `! [rejected] vX.Y.Z (would clobber existing tag)`, the local
tag points at a different commit than the remote's. The remote is canonical (created by
`auto-tag.yml` or `deno task publish`). Fix: `git tag -d vX.Y.Z && git fetch origin --tags`.

### submodule remnant — former submodule keeps showing in IDE source control

`git rm --cached <submodule>` is NOT enough: it leaves a one-line `.git` file in the dir (IDE treats
it as a wedged nested repo — surfaces "Merge Changes" forever if it was mid-rebase) AND the
`.git/modules/<name>/` storage (hundreds of MB). Full cleanup after `git rm --cached` + gitignore:

```sh
(cd <path> && git rebase --abort 2>/dev/null; true)   # release file locks
rm -rf <path>                                          # delete working tree
rm -rf .git/modules/<name>                             # delete submodule git storage
```

Then reload the IDE window. Hit with `wabt-ts/`; `upstream/` still has the same remnant pattern
locally — leave it unless the IDE starts flagging it.

## CI workflows & pinning

`.github/workflows/`: `ci.yml` (type-check + lint + test + publish dry-run on push/PR),
`publish.yml` (tag-push → JSR OIDC + GitHub Release), `auto-tag.yml` (version-bump safety net). Pin
actions to the **major-version tag** (`actions/checkout@v6`, `denoland/setup-deno@v2`) — mutable,
auto-flows patches, guards the major boundary. `checkout@v4 → @v6` was forced by GitHub's Node 20
runtime deprecation (off 2026-06-02, removed 2026-09-16); current action runtime target is `node24`.

## Git-ignore / memory portability

`CLAUDE.md` and `TASKS.md` are gitignored (machine-local working notes). `cmem/` is **committed**
portable memory (this folder) — the shared source of truth that supersedes the gitignored
`CLAUDE.md`. `README.md` is the only other durable git-tracked project-knowledge file (public,
user-facing). Routing rule: **if a teammate would need to see it, it goes in `README.md`; if it's
curated internal project memory, it goes in `cmem/`.**
</content>
