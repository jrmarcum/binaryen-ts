/**
 * @module scripts/diag_dce
 *
 * Dump _fib's IR before and after the DCE pass, side by side, to see exactly
 * which expressions DCE removes.
 *
 * Run: deno run --allow-read scripts/diag_dce.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { createPass, PassRunner } from "../src/passes/pass.ts";
import "../src/passes/index.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const orig = new Uint8Array(await fs.readFile(ROOT + "fib-dbg.wasm"));

// deno-lint-ignore no-explicit-any
function dump(e: any, depth: number, out: string[]): void {
  if (!e) return void out.push("  ".repeat(depth) + "<null>");
  const t = e.type !== undefined ? `:${JSON.stringify(e.type)}` : "";
  const extra: string[] = [];
  for (const k of ["op", "name", "index"]) {
    if (e[k] !== undefined && typeof e[k] !== "object") extra.push(`${k}=${e[k]}`);
  }
  out.push("  ".repeat(depth) + `${e.kind}${t} ${extra.join(" ")}`);
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (v && typeof v === "object" && v.kind) dump(v, depth + 1, out);
    else if (Array.isArray(v)) {
      for (const it of v) if (it && typeof it === "object" && it.kind) dump(it, depth + 1, out);
    }
  }
}

const before = parseWasm(orig);
const fibBefore = before.functions.find((f) => f.name === "$func5")!;
const a: string[] = [];
dump(fibBefore.body, 0, a);

const passName = Deno.args[0] ?? "DCE";
const after = parseWasm(orig);
new PassRunner(after, { optimizeLevel: 2, shrinkLevel: 2 }).addPass(createPass(passName)).run();
const fibAfter = after.functions.find((f) => f.name === "$func5")!;
const b: string[] = [];
dump(fibAfter.body, 0, b);

console.log(`# _fib IR — before (${a.length} nodes) | after ${passName} (${b.length} nodes)`);
const n = Math.max(a.length, b.length);
for (let i = 0; i < n; i++) {
  const mark = (a[i] ?? "") === (b[i] ?? "") ? "  " : "* ";
  console.log(`${mark}${(a[i] ?? "").padEnd(40)} | ${b[i] ?? ""}`);
}
