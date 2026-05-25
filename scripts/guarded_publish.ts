/**
 * @module scripts/guarded_publish
 *
 * Guard for `deno task publish`. JSR provenance only attaches when
 * `deno publish` runs inside the GitHub Actions workflow, because JSR
 * fingerprints the GitHub-issued OIDC token. A local `deno publish` succeeds
 * but the resulting version is permanently flagged as having no provenance,
 * which lowers the JSR package score and cannot be retro-fixed on that
 * version number — only by bumping and re-publishing.
 *
 * This script refuses to run unless `GITHUB_ACTIONS=true` is set in the
 * environment (which GitHub Actions does automatically for every workflow
 * step). Inside CI, it delegates to `deno publish` and forwards the exit
 * code. Outside CI, it prints the release flow with the actual current
 * version from `deno.json` substituted in, so the suggested git commands
 * are copy-pasteable. See CLAUDE.md "Do not run `deno publish` locally"
 * for full rationale.
 *
 * @license MIT
 */

import { nextVersion, readCurrentVersion } from "./version.ts";

if (Deno.env.get("GITHUB_ACTIONS") !== "true") {
  const current = await readCurrentVersion();
  let next: string;
  try {
    next = nextVersion(current);
  } catch {
    next = "X.Y.Z";
  }

  console.error(
    [
      "Refusing to run `deno publish` outside GitHub Actions.",
      "",
      "JSR provenance requires the GitHub Actions OIDC token. A local publish",
      "would upload the package but permanently flag the version as having no",
      "provenance, lowering the JSR package score. Once published without",
      "provenance, a version cannot be retro-fixed — only superseded by a",
      "version bump + re-publish via the workflow.",
      "",
      `Current version (from deno.json): v${current}`,
      `Next version (bump rule):         v${next}`,
      "",
      "Correct release flow:",
      "  1. deno task bump                  # writes the next version to deno.json",
      `  2. git commit -am "bump to v${next}"`,
      `  3. git tag v${next}`,
      `  4. git push origin main v${next}`,
      "",
      "The .github/workflows/publish.yml workflow takes it from there.",
      "",
      "To validate the publish manifest locally without uploading:",
      "  deno task publish:dry",
    ].join("\n"),
  );
  Deno.exit(1);
}

const cmd = new Deno.Command("deno", {
  args: ["publish"],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
