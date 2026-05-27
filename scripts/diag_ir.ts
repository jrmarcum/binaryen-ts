/**
 * @module scripts/diag_ir
 *
 * Dump the parsed IR tree of one function as an indented s-expression so we can
 * see node kinds and inferred `.type` fields directly.
 *
 * Run:
 *   deno run --allow-read scripts/diag_ir.ts <relpath> <funcIndexInDefined>
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const rel = Deno.args[0];
const fnIdx = parseInt(Deno.args[1] ?? "0", 10);
const orig = new Uint8Array(await fs.readFile(ROOT + rel));
const mod = parseWasm(orig);
const fn = mod.functions[fnIdx];
console.log(
  `# ${rel} defined-fn #${fnIdx}: ${fn.name} params=${JSON.stringify(fn.params)} results=${
    JSON.stringify(fn.results)
  }`,
);

// deno-lint-ignore no-explicit-any
function dump(e: any, depth: number): void {
  if (!e) {
    console.log("  ".repeat(depth) + "<null>");
    return;
  }
  const t = e.type !== undefined ? ` :${JSON.stringify(e.type)}` : "";
  const extra: string[] = [];
  for (const k of ["op", "name", "index", "label", "target"]) {
    if (e[k] !== undefined && typeof e[k] !== "object") extra.push(`${k}=${e[k]}`);
  }
  console.log("  ".repeat(depth) + `${e.kind}${t} ${extra.join(" ")}`);
  // recurse into known child fields
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (v && typeof v === "object" && v.kind) dump(v, depth + 1);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && item.kind) dump(item, depth + 1);
      }
    }
  }
}

dump(fn.body, 0);
