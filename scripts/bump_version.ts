/**
 * @module scripts/bump_version
 *
 * Bumps `deno.json` `version` to the next value under the sub-version-
 * capped-at-9 rule (see `./version.ts` for the rule). Prints the old → new
 * transition. Does not commit or tag — the release-flow caller handles that.
 *
 * Run:
 *   deno task bump
 *
 * @license MIT
 */

import { DENO_JSON_URL, nextVersion, readCurrentVersion } from "./version.ts";

const current = await readCurrentVersion();
const next = nextVersion(current);

const text = await Deno.readTextFile(DENO_JSON_URL);
const updated = text.replace(
  /("version"\s*:\s*)"[^"]*"/,
  (_match, prefix) => `${prefix}"${next}"`,
);
if (updated === text) {
  console.error("Could not locate the `version` field in deno.json to rewrite.");
  Deno.exit(1);
}
await Deno.writeTextFile(DENO_JSON_URL, updated);

console.log(`${current} -> ${next}`);
console.log("");
console.log("Next step:");
console.log("  deno task publish");
console.log("");
console.log(
  `That commits the bump, tags v${next}, and pushes both. The tag push triggers`,
);
console.log("publish.yml on GitHub, which runs deno publish with OIDC provenance.");
