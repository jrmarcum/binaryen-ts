/**
 * @module scripts/diag_sections
 *
 * Dump the top-level section list (id + name-for-custom + byte size) of a wasm
 * binary, for the original input and for our parse→encode round-trip output,
 * side by side. Surfaces which sections survive the round-trip — in particular
 * whether custom (e.g. DWARF `.debug_*`) sections are dropped.
 *
 * Run:
 *   deno run --allow-read scripts/diag_sections.ts <relpath-under-upstream/test>
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { BinaryReader } from "../src/binary/reader.ts";

const SECTION_NAMES: Record<number, string> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "datacount",
  13: "tag",
};

function sections(bytes: Uint8Array): { id: number; label: string; size: number }[] {
  const r = new BinaryReader(bytes);
  r.skip(8); // magic + version
  const out: { id: number; label: string; size: number }[] = [];
  while (!r.eof) {
    const id = r.readU8();
    const size = r.readU32();
    const bodyStart = r.position;
    let label = SECTION_NAMES[id] ?? `?${id}`;
    if (id === 0) {
      const nameLen = r.readU32();
      label = `custom:${r.readUTF8(nameLen)}`;
    }
    out.push({ id, label, size });
    r.seek(bodyStart + size);
  }
  return out;
}

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const rel = Deno.args[0];
const orig = new Uint8Array(await fs.readFile(ROOT + rel));
const reenc = encodeWasm(parseWasm(orig));

console.log(`# ${rel}`);
console.log(`# original ${orig.byteLength} B  →  re-encoded ${reenc.byteLength} B`);
console.log();
console.log("ORIGINAL sections:");
let oCustom = 0;
for (const s of sections(orig)) {
  console.log(`  ${s.label.padEnd(22)} ${s.size.toString().padStart(8)} B`);
  if (s.id === 0) oCustom += s.size;
}
console.log(`  (custom-section bytes total: ${oCustom})`);
console.log();
console.log("RE-ENCODED sections:");
for (const s of sections(reenc)) {
  console.log(`  ${s.label.padEnd(22)} ${s.size.toString().padStart(8)} B`);
}
