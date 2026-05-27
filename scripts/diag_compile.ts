/**
 * @module scripts/diag_compile
 *
 * Parse + encode a corpus file and run the real WebAssembly.compile() validator
 * on the re-encoded output, reporting the exact validation error.
 *
 * Run:
 *   deno run --allow-read scripts/diag_compile.ts <relpath-under-upstream/test>
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const rel = Deno.args[0];
const orig = new Uint8Array(await fs.readFile(ROOT + rel));
const re = encodeWasm(parseWasm(orig));
try {
  await WebAssembly.compile(re);
  console.log("OK compiles");
} catch (e) {
  console.log("COMPILE ERR:", (e as Error).message);
}
