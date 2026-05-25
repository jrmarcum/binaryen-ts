/**
 * @module scripts/publish
 *
 * Local release driver. Commits and tags whatever `deno.json` currently says,
 * then pushes commit + tag in a single atomic `git push origin main vX.Y.Z`.
 * The tag push triggers `.github/workflows/publish.yml` on GitHub: developer
 * pushes are authenticated with a PAT (not GITHUB_TOKEN), so the tag push
 * fires the workflow directly without going through the auto-tag detour.
 *
 * Typical flow:
 *   1. deno task bump        # writes the next version into deno.json
 *   2. deno task publish     # commits + tags + pushes (this script)
 *   3. Watch the Actions tab — JSR publish + GitHub Release are both
 *      produced by publish.yml.
 *
 * Why this script does NOT call `deno publish` itself: JSR provenance
 * requires the GitHub-issued OIDC token, which is only available inside the
 * GitHub Actions workflow. A local `deno publish` succeeds but the resulting
 * version is permanently flagged "No provenance" on JSR. So the local script
 * stops at "push the tag" — `deno publish` runs only inside `publish.yml`,
 * and only there.
 *
 * Match-up with sibling wasmtk's `scripts/publish.ts`: same commit + tag +
 * push shape, minus the `sync-version.ts` step (binaryen-ts has no
 * package.json or src/utils.ts mirror to keep in sync).
 *
 * @license MIT
 */

import { readCurrentVersion } from "./version.ts";

async function run(cmd: string[]): Promise<void> {
  console.log(`$ ${cmd.join(" ")}`);
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) {
    console.error(`\nCommand failed with exit code ${code}: ${cmd.join(" ")}`);
    Deno.exit(code);
  }
}

const version = await readCurrentVersion();
const tag = `v${version}`;

console.log(`Releasing ${tag}\n`);

// 1. Stage deno.json (only file we touch on a release)
await run(["git", "add", "deno.json"]);

// 2. Commit only if there's actually something staged. `deno task bump` +
//    `deno task publish` is the common path (deno.json is dirty), but if the
//    user already committed the bump manually, skip the no-op commit.
const diffCheck = new Deno.Command("git", {
  args: ["diff", "--cached", "--quiet"],
});
const { code: diffCode } = await diffCheck.output();
if (diffCode !== 0) {
  await run(["git", "commit", "-m", `bump to ${tag}`]);
} else {
  console.log("(deno.json already committed — skipping commit)\n");
}

// 3. Force-tag locally for re-run safety: if a previous publish attempt got
//    as far as creating the tag but failed before pushing, this overwrites
//    the stale local tag instead of erroring.
await run(["git", "tag", "-f", tag]);

// 4. Push commit + tag in a single operation. Atomic from git's perspective,
//    which avoids racing `auto-tag.yml` (it sees the tag already exists when
//    it fires on the main push and no-ops).
await run(["git", "push", "origin", "main", tag]);

console.log(`\nPushed ${tag}. publish.yml will run:`);
console.log(`  https://github.com/jrmarcum/binaryen-ts/actions`);
console.log("");
console.log("It performs: version verify -> check -> test -> deno publish (with OIDC");
console.log("provenance) -> create GitHub Release.");
