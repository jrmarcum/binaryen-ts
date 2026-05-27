/**
 * @module scripts/diff_function
 *
 * Byte-level diff of the same function across the original input wasm and
 * our re-encoded output. Locates the first divergence so we can identify the
 * pathological instruction that breaks the parse+encode round-trip.
 *
 * Run:
 *   deno run --allow-read scripts/diff_function.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { BinaryReader } from "../src/binary/reader.ts";

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");
const TARGET_REL = "passes/fannkuch0_dwarf.wasm";
const TARGET_FN_INDEX = 5; // from validator error: function #5

// ---------------------------------------------------------------------------
// Find the byte range of a function body in a .wasm
// ---------------------------------------------------------------------------

interface FuncRange {
  fnIndex: number; // global function index (imports + defined)
  defIndex: number; // index within defined functions (0-based)
  bodyStart: number; // start of the function-body bytes (after size LEB128)
  bodyEnd: number; // exclusive end
}

function findFunctionRanges(bytes: Uint8Array): FuncRange[] {
  const r = new BinaryReader(bytes);
  // Skip magic + version
  r.skip(8);
  // Walk sections
  let numImportedFunctions = 0;
  const funcs: FuncRange[] = [];
  while (!r.eof) {
    const sectionId = r.readU8();
    const sectionSize = r.readU32();
    const sectionStart = r.position;
    if (sectionId === 2) {
      // import section: count function imports
      const numImports = r.readU32();
      for (let i = 0; i < numImports; i++) {
        const moduleLen = r.readU32();
        r.skip(moduleLen);
        const nameLen = r.readU32();
        r.skip(nameLen);
        const kind = r.readU8();
        if (kind === 0) {
          numImportedFunctions++;
          r.readU32(); // type index
        } else if (kind === 1) {
          // table: reftype + limits
          r.readI32(); // reftype (SLEB128)
          const limFlags = r.readU8();
          r.readU32(); // min
          if (limFlags & 1) r.readU32(); // max
        } else if (kind === 2) {
          // memory: limits
          const limFlags = r.readU8();
          r.readU32(); // min
          if (limFlags & 1) r.readU32(); // max
        } else if (kind === 3) {
          // global: valtype + mut
          r.readI32(); // valtype
          r.readU8(); // mut
        } else {
          // unknown — bail
          r.seek(sectionStart + sectionSize);
          break;
        }
      }
    } else if (sectionId === 10) {
      // code section
      const numBodies = r.readU32();
      for (let i = 0; i < numBodies; i++) {
        const bodySize = r.readU32();
        const bodyStart = r.position;
        const bodyEnd = bodyStart + bodySize;
        funcs.push({
          fnIndex: numImportedFunctions + i,
          defIndex: i,
          bodyStart,
          bodyEnd,
        });
        r.seek(bodyEnd);
      }
    } else {
      r.seek(sectionStart + sectionSize);
    }
  }
  return funcs;
}

function hex(b: number): string {
  return b.toString(16).padStart(2, "0");
}

function hexdump(bytes: Uint8Array, start: number, len: number, label: string): void {
  console.log(`  ${label} [${start}..${start + len})`);
  for (let i = 0; i < len; i += 16) {
    const chunk = bytes.subarray(start + i, Math.min(start + i + 16, start + len));
    const offsetStr = (start + i).toString(16).padStart(8, "0");
    const hexStr = Array.from(chunk, (b) => hex(b)).join(" ");
    console.log(`    ${offsetStr}: ${hexStr}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const file = path.join(ROOT, TARGET_REL.replace(/\//g, path.sep));
const original = new Uint8Array(await fs.readFile(file));
const mod = parseWasm(original);
const reEncoded = encodeWasm(mod);

console.log(`# Diffing function #${TARGET_FN_INDEX} of ${TARGET_REL}`);
console.log(`# Original: ${original.byteLength} bytes`);
console.log(`# Re-encoded: ${reEncoded.byteLength} bytes`);
console.log();

const origFuncs = findFunctionRanges(original);
const reFuncs = findFunctionRanges(reEncoded);

console.log(`Original code section: ${origFuncs.length} function bodies`);
for (const f of origFuncs) {
  console.log(`  fn#${f.fnIndex} (def #${f.defIndex}): ${f.bodyEnd - f.bodyStart} bytes`);
}
console.log();
console.log(`Re-encoded code section: ${reFuncs.length} function bodies`);
for (const f of reFuncs) {
  console.log(`  fn#${f.fnIndex} (def #${f.defIndex}): ${f.bodyEnd - f.bodyStart} bytes`);
}
console.log();

const origFn = origFuncs.find((f) => f.fnIndex === TARGET_FN_INDEX);
const reFn = reFuncs.find((f) => f.fnIndex === TARGET_FN_INDEX);

if (!origFn || !reFn) {
  console.log(`Function #${TARGET_FN_INDEX} not found in one of the modules!`);
  Deno.exit(1);
}

const origLen = origFn.bodyEnd - origFn.bodyStart;
const reLen = reFn.bodyEnd - reFn.bodyStart;

console.log(`## Function #${TARGET_FN_INDEX} byte ranges:`);
console.log(`  original:   [${origFn.bodyStart}..${origFn.bodyEnd}) — ${origLen} bytes`);
console.log(`  re-encoded: [${reFn.bodyStart}..${reFn.bodyEnd}) — ${reLen} bytes`);
console.log();

// Find first divergence
const minLen = Math.min(origLen, reLen);
let divergeAt = -1;
for (let i = 0; i < minLen; i++) {
  if (original[origFn.bodyStart + i] !== reEncoded[reFn.bodyStart + i]) {
    divergeAt = i;
    break;
  }
}
if (divergeAt === -1 && origLen !== reLen) {
  divergeAt = minLen; // they share a prefix; one is longer
}

if (divergeAt === -1) {
  console.log("Bodies are byte-identical — divergence must be elsewhere.");
  Deno.exit(0);
}

console.log(`First divergence: at function-body offset ${divergeAt} (0x${divergeAt.toString(16)})`);
console.log();

// Dump 32 bytes of context around the divergence in both
const ctxBefore = 16;
const ctxAfter = 48;
const start = Math.max(0, divergeAt - ctxBefore);
const lenDump = ctxBefore + ctxAfter;

hexdump(original, origFn.bodyStart + start, Math.min(lenDump, origLen - start), "ORIGINAL");
console.log();
hexdump(reEncoded, reFn.bodyStart + start, Math.min(lenDump, reLen - start), "RE-ENCODED");
console.log();

// Identify divergent byte values explicitly
console.log(`At fn-body offset ${divergeAt}:`);
console.log(`  original   byte = 0x${hex(original[origFn.bodyStart + divergeAt])}`);
if (divergeAt < reLen) {
  console.log(`  re-encoded byte = 0x${hex(reEncoded[reFn.bodyStart + divergeAt])}`);
} else {
  console.log(`  re-encoded body is shorter; ends at offset ${reLen}`);
}
