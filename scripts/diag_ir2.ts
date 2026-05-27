/**
 * @module scripts/diag_ir2
 *
 * Dump the IR of one function BOTH from the original parse and from a
 * parse→encode→reparse round-trip, side by side, so encoder-introduced drift
 * is visible directly.
 *
 * Run:
 *   deno run --allow-read scripts/diag_ir2.ts <relpath> <definedFnIndex>
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const rel = Deno.args[0];
const fnIdx = parseInt(Deno.args[1] ?? "0", 10);
const orig = new Uint8Array(await fs.readFile(ROOT + rel));
const mod1 = parseWasm(orig);
const mod2 = parseWasm(encodeWasm(mod1));

// deno-lint-ignore no-explicit-any
function dump(e: any, depth: number, out: string[]): void {
  if (!e) {
    out.push("  ".repeat(depth) + "<null>");
    return;
  }
  const t = e.type !== undefined ? `:${JSON.stringify(e.type)}` : "";
  const extra: string[] = [];
  for (const k of ["op", "name", "index", "target"]) {
    if (e[k] !== undefined && typeof e[k] !== "object") extra.push(`${k}=${e[k]}`);
  }
  out.push("  ".repeat(depth) + `${e.kind}${t} ${extra.join(" ")}`);
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (v && typeof v === "object" && v.kind) dump(v, depth + 1, out);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && item.kind) dump(item, depth + 1, out);
      }
    }
  }
}

const a: string[] = [], b: string[] = [];
dump(mod1.functions[fnIdx].body, 0, a);
dump(mod2.functions[fnIdx].body, 0, b);

console.log(`# ${rel} defined-fn #${fnIdx}  (orig ${a.length} lines | reparsed ${b.length} lines)`);
const n = Math.max(a.length, b.length);
for (let i = 0; i < n; i++) {
  const mark = (a[i] ?? "") === (b[i] ?? "") ? "  " : "* ";
  console.log(`${mark}${(a[i] ?? "").padEnd(46)} | ${b[i] ?? ""}`);
}
