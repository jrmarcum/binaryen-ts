// deno-lint-ignore-file no-import-prefix -- diagnostic script: intentionally
// imports upstream binaryen via npm: specifier for head-to-head comparison.

/**
 * Trace a small failing module to find the producer instruction whose
 * parser handler isn't pushing.
 *
 * Run:
 *   deno run --allow-read --allow-env --allow-net scripts/trace_failing.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import upstream from "npm:binaryen@^116.0.0";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");

const targets = [
  "break-within-catch.wasm",
  "unit/input/atomics_target_feature.wasm",
];

function emitText(bytes: Uint8Array): string {
  const u = upstream as unknown as Record<string, unknown>;
  try {
    const mod = (u["readBinary"] as (b: Uint8Array) => unknown)(bytes);
    const m = mod as Record<string, unknown>;
    (m["setFeatures"] as (n: number) => void)(
      (u["Features"] as Record<string, number>)["All"],
    );
    const txt = (m["emitText"] as () => string)();
    (m["dispose"] as () => void)();
    return txt;
  } catch (e) {
    return "// upstream readBinary failed: " + (e instanceof Error ? e.message : String(e));
  }
}

for (const rel of targets) {
  const file = path.join(ROOT, rel.replace(/\//g, path.sep));
  const original = new Uint8Array(await fs.readFile(file));
  console.log(`\n=== ${rel} (${original.byteLength} bytes) ===`);
  console.log();
  console.log("ORIGINAL:");
  console.log(emitText(original));
  console.log();
  const mod = parseWasm(original);
  const reBytes = encodeWasm(mod);
  console.log(`RE-ENCODED (${reBytes.byteLength} bytes):`);
  console.log(emitText(reBytes));
}
