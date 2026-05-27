/**
 * @module scripts/diff_wat
 *
 * Disassembles the same wasm input two ways — directly, and after a parse+
 * encode round-trip through binaryen-ts — using upstream binaryen.js as a
 * trusted disassembler. Diffs the WAT to surface the structural difference
 * that the round-trip introduces.
 *
 * Run:
 *   deno run --allow-read --allow-env --allow-net scripts/diff_wat.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import upstream from "npm:binaryen@^116.0.0";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");
const TARGET_REL = "passes/fannkuch0_dwarf.wasm";
const TARGET_FN_HINT = "5"; // function #5 per the validator error

function emitText(bytes: Uint8Array): string {
  const u = upstream as unknown as Record<string, unknown>;
  const mod = (u["readBinary"] as (b: Uint8Array) => unknown)(bytes);
  const m = mod as Record<string, unknown>;
  // setFeatures(All) so any feature opcodes don't reject the read
  (m["setFeatures"] as (n: number) => void)(
    (u["Features"] as Record<string, number>)["All"],
  );
  const txt = (m["emitText"] as () => string)();
  (m["dispose"] as () => void)();
  return txt;
}

const file = path.join(ROOT, TARGET_REL.replace(/\//g, path.sep));
const original = new Uint8Array(await fs.readFile(file));
const mod = parseWasm(original);
const reEncoded = encodeWasm(mod);

console.log(`# Diffing WAT of ${TARGET_REL}`);
console.log(`# original=${original.byteLength}B, re-encoded=${reEncoded.byteLength}B`);
console.log();

let origText = "";
let reText = "";
try {
  origText = emitText(original);
} catch (e) {
  console.log("Upstream rejected original:", e);
  Deno.exit(1);
}
try {
  reText = emitText(reEncoded);
} catch (e) {
  console.log("Upstream rejected re-encoded:", e instanceof Error ? e.message : String(e));
  console.log("(This is expected if our encode produces invalid wasm; falling back to partial dump.)");
}

// Write the two WAT outputs to disk for manual diff
const outDir = new URL("../scripts/_diffs/", import.meta.url).pathname.replace(/^\//, "");
try {
  await fs.mkdir(outDir, { recursive: true });
} catch { /* exists */ }
await fs.writeFile(path.join(outDir, "fannkuch0_original.wat"), origText);
await fs.writeFile(path.join(outDir, "fannkuch0_reencoded.wat"), reText);
console.log(`wrote ${outDir}fannkuch0_original.wat`);
console.log(`wrote ${outDir}fannkuch0_reencoded.wat`);
console.log();

// Print just function #5 from both. Match by the "(func $f5" prefix (binaryen
// names defined functions by their global index when no name is present).
function extractFunction(wat: string, hint: string): string | null {
  // Try a few naming conventions; we just want the first function whose
  // surface form starts with $f5, $5, or the n'th (func ...) block.
  const lines = wat.split("\n");
  // Find lines starting with " (func"
  const funcStarts: { idx: number; header: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^\s*\(func\s/)) {
      funcStarts.push({ idx: i, header: lines[i].trim() });
    }
  }
  // Use hint as a 0-based index into defined functions
  const target = parseInt(hint, 10);
  if (Number.isFinite(target) && funcStarts[target]) {
    const start = funcStarts[target].idx;
    let depth = 0;
    let end = start;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth === 0) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end + 1).join("\n");
  }
  return null;
}

const origFn = extractFunction(origText, TARGET_FN_HINT);
const reFn = reText ? extractFunction(reText, TARGET_FN_HINT) : "";

if (origFn) {
  await fs.writeFile(path.join(outDir, "fannkuch0_original_fn5.wat"), origFn);
  console.log(`wrote fn5: ${origFn.split("\n").length} lines, ${origFn.length} chars`);
}
if (reFn) {
  await fs.writeFile(path.join(outDir, "fannkuch0_reencoded_fn5.wat"), reFn);
  console.log(`wrote fn5 (re-encoded): ${reFn.split("\n").length} lines, ${reFn.length} chars`);
}

if (origFn && reFn) {
  // Find first line that differs after trimming
  const aLines = origFn.split("\n");
  const bLines = reFn.split("\n");
  let firstDiff = -1;
  for (let i = 0; i < Math.min(aLines.length, bLines.length); i++) {
    if (aLines[i].trim() !== bLines[i].trim()) {
      firstDiff = i;
      break;
    }
  }
  console.log();
  console.log(`First diverging line: ${firstDiff}`);
  if (firstDiff >= 0) {
    console.log("orig:", aLines[firstDiff].trim());
    console.log("re  :", bLines[firstDiff].trim());
    console.log();
    console.log("Context (8 lines around first diff):");
    const lo = Math.max(0, firstDiff - 4);
    const hi = Math.min(aLines.length, firstDiff + 5);
    console.log("--- ORIGINAL ---");
    for (let i = lo; i < hi; i++) console.log(`${i}: ${aLines[i]}`);
    console.log("--- RE-ENCODED ---");
    for (let i = lo; i < hi; i++) console.log(`${i}: ${bLines[i]}`);
  }
}
