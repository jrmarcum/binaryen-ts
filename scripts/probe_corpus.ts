/**
 * @module scripts/probe_corpus
 *
 * Phase 10 profiling step 0 — discover which upstream/test/*.wasm files parse
 * cleanly with our binary parser. Reports byte size, function count, total
 * expression node count, and pass/fail. Output is consumed by the Phase 10
 * profiler harness when picking a corpus subset.
 *
 * Run:
 *   deno run --allow-read scripts/probe_corpus.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseWasm } from "../src/binary/wasm-parser.ts";
import { walkExpression } from "../src/ir/walk.ts";
import type { WasmModule } from "../src/ir/module.ts";

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");

async function findWasmFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(d: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await recurse(full);
      else if (e.isFile() && e.name.endsWith(".wasm")) out.push(full);
    }
  }
  await recurse(dir);
  return out;
}

function countExprs(mod: WasmModule): number {
  let n = 0;
  for (const fn of mod.functions) {
    if (!fn.body) continue;
    walkExpression(fn.body, () => {
      n++;
    });
  }
  return n;
}

interface ProbeResult {
  file: string;
  bytes: number;
  ok: boolean;
  err?: string;
  numFunctions?: number;
  numImportedFunctions?: number;
  numExprs?: number;
}

const files = await findWasmFiles(ROOT);
const results: ProbeResult[] = [];

for (const file of files) {
  const buf = await fs.readFile(file);
  const result: ProbeResult = {
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    bytes: buf.byteLength,
    ok: false,
  };
  try {
    const mod = parseWasm(new Uint8Array(buf), file);
    result.ok = true;
    result.numFunctions = mod.functions.length;
    result.numImportedFunctions = mod.imports.filter((i) => i.kind === "function").length;
    result.numExprs = countExprs(mod);
  } catch (e) {
    result.err = e instanceof Error ? e.message : String(e);
  }
  results.push(result);
}

results.sort((a, b) => (b.numExprs ?? 0) - (a.numExprs ?? 0));

const ok = results.filter((r) => r.ok);
const fail = results.filter((r) => !r.ok);

console.log(`# Corpus probe — ${results.length} files`);
console.log(`# OK: ${ok.length}, FAIL: ${fail.length}`);
console.log();
console.log("## Parsed successfully (top 30 by expression count)");
console.log("bytes,funcs,imp,exprs,file");
for (const r of ok.slice(0, 30)) {
  console.log(`${r.bytes},${r.numFunctions},${r.numImportedFunctions},${r.numExprs},${r.file}`);
}

console.log();
console.log("## Failed to parse (first 20)");
for (const r of fail.slice(0, 20)) {
  console.log(`  ${r.file}: ${r.err?.slice(0, 100)}`);
}

console.log();
console.log("## Summary by total bytes parsed");
const totalBytes = ok.reduce((a, b) => a + b.bytes, 0);
const totalExprs = ok.reduce((a, b) => a + (b.numExprs ?? 0), 0);
console.log(`  total OK bytes: ${totalBytes}`);
console.log(`  total OK exprs: ${totalExprs}`);
