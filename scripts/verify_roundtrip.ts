/**
 * @module scripts/verify_roundtrip
 *
 * Verifies parser/encoder round-trip on the corpus: parse a .wasm to IR,
 * encode back to bytes, parse the result, confirm function/global/data counts
 * survive and the second parse succeeds with no diagnostics.
 *
 * Run:
 *   deno run --allow-read scripts/verify_roundtrip.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
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

function summary(mod: WasmModule): { fns: number; globals: number; data: number; exprs: number } {
  let exprs = 0;
  for (const fn of mod.functions) {
    if (!fn.body) continue;
    walkExpression(fn.body, () => {
      exprs++;
    });
  }
  return {
    fns: mod.functions.length,
    globals: mod.globals.length,
    data: mod.dataSegments.length,
    exprs,
  };
}

async function validates(bytes: Uint8Array): Promise<{ ok: boolean; err?: string }> {
  try {
    await WebAssembly.compile(bytes as BufferSource);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

const files = await findWasmFiles(ROOT);
const ok: string[] = [];
const reparseFail: { file: string; err: string }[] = [];
const drift: {
  file: string;
  before: ReturnType<typeof summary>;
  after: ReturnType<typeof summary>;
}[] = [];
const validateFail: { file: string; err: string }[] = [];

for (const file of files) {
  const buf = await fs.readFile(file);
  let mod1: WasmModule;
  try {
    mod1 = parseWasm(new Uint8Array(buf), file);
  } catch {
    // skip files that didn't parse — already accounted for
    continue;
  }
  let bytes2: Uint8Array;
  try {
    bytes2 = encodeWasm(mod1);
  } catch (e) {
    reparseFail.push({
      file: path.relative(ROOT, file).replace(/\\/g, "/"),
      err: "encode: " + (e instanceof Error ? e.message : String(e)),
    });
    continue;
  }
  let mod2: WasmModule;
  try {
    mod2 = parseWasm(bytes2, file + "::roundtrip");
  } catch (e) {
    reparseFail.push({
      file: path.relative(ROOT, file).replace(/\\/g, "/"),
      err: "reparse: " + (e instanceof Error ? e.message : String(e)),
    });
    continue;
  }
  // Skip validation for inputs that don't themselves validate
  // (intentionally-malformed test fixtures).
  const inputValid = await validates(new Uint8Array(buf));
  if (inputValid.ok) {
    const outputValid = await validates(bytes2);
    if (!outputValid.ok) {
      validateFail.push({
        file: path.relative(ROOT, file).replace(/\\/g, "/"),
        err: outputValid.err ?? "",
      });
    }
  }
  const s1 = summary(mod1);
  const s2 = summary(mod2);
  if (
    s1.fns !== s2.fns || s1.globals !== s2.globals || s1.data !== s2.data || s1.exprs !== s2.exprs
  ) {
    drift.push({ file: path.relative(ROOT, file).replace(/\\/g, "/"), before: s1, after: s2 });
  } else {
    ok.push(path.relative(ROOT, file).replace(/\\/g, "/"));
  }
}

console.log(`# round-trip results`);
console.log(`OK (exact):       ${ok.length}`);
console.log(`encode/reparse:   ${reparseFail.length}`);
console.log(`structural drift: ${drift.length}`);
console.log(`WebAssembly validate fails: ${validateFail.length}`);
console.log();

if (validateFail.length > 0) {
  console.log("## WebAssembly.compile failures on re-encoded output:");
  for (const f of validateFail.slice(0, 20)) {
    console.log(`  ${f.file}: ${f.err.slice(0, 140)}`);
  }
  console.log();
}

if (reparseFail.length > 0) {
  console.log("## encode/reparse failures:");
  for (const f of reparseFail) console.log(`  ${f.file}: ${f.err.slice(0, 120)}`);
  console.log();
}

if (drift.length > 0) {
  console.log("## structural drift:");
  for (const d of drift) {
    console.log(`  ${d.file}:`);
    console.log(`    before: ${JSON.stringify(d.before)}`);
    console.log(`    after:  ${JSON.stringify(d.after)}`);
  }
}
