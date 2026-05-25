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
 * code. See CLAUDE.md "Do not run `deno publish` locally" for full rationale.
 *
 * @license MIT
 */

if (Deno.env.get("GITHUB_ACTIONS") !== "true") {
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
      "Correct release flow:",
      "  1. Bump `version` in deno.json on a clean main branch",
      '  2. git commit -am "bump to vX.Y.Z"',
      "  3. git tag vX.Y.Z",
      "  4. git push origin main vX.Y.Z",
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
