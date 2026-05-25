/**
 * @module scripts/version
 *
 * Shared version helpers for the release scripts. The binaryen-ts versioning
 * rule is: each sub-version maxes at 9 before rolling into the next greater
 * segment. So patch 9 → minor +1 (patch reset to 0), minor 9 → major +1
 * (minor + patch reset to 0).
 *
 *   1.0.6 → 1.0.7
 *   1.0.9 → 1.1.0
 *   1.9.9 → 2.0.0
 *
 * @license MIT
 */

/** Resolves the repository's `deno.json` regardless of CWD. */
export const DENO_JSON_URL: URL = new URL("../deno.json", import.meta.url);

/** Reads the current `version` field from `deno.json`. */
export async function readCurrentVersion(): Promise<string> {
  const text = await Deno.readTextFile(DENO_JSON_URL);
  const data = JSON.parse(text);
  const v = data.version;
  if (typeof v !== "string") {
    throw new Error(`deno.json has no string \`version\` field (got ${JSON.stringify(v)})`);
  }
  return v;
}

/**
 * Computes the next version under the sub-version-capped-at-9 rule.
 * Throws if `version` is not a parseable `major.minor.patch` triple.
 */
export function nextVersion(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    throw new Error(
      `Cannot parse version ${JSON.stringify(version)} — expected "major.minor.patch"`,
    );
  }
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);

  if (patch < 9) {
    patch += 1;
  } else {
    patch = 0;
    if (minor < 9) {
      minor += 1;
    } else {
      minor = 0;
      major += 1;
    }
  }
  return `${major}.${minor}.${patch}`;
}
