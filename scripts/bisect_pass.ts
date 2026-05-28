/**
 * @module scripts/bisect_pass
 *
 * Isolate which optimization pass turns a (valid) parsed module into invalid
 * wasm. Runs each named pass individually (parse → single pass → encode →
 * WebAssembly.compile) and reports per-pass validity, then runs the cumulative
 * -Oz pipeline prefix-by-prefix to find the first breaking step.
 *
 * Run:
 *   deno run --allow-read scripts/bisect_pass.ts <relpath>
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { createPass, PassRunner } from "../src/passes/pass.ts";
import "../src/passes/index.ts"; // side-effect: register all built-in passes

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const rel = Deno.args[0];
const orig = new Uint8Array(await fs.readFile(ROOT + rel));

const OZ = [
  "DCE",
  "PickLoadSigns",
  "Vacuum",
  "RemoveUnusedBrs",
  "RemoveUnusedNames",
  "OptimizeInstructions",
  "CoalesceLocals",
  "SimplifyLocals",
  "LocalCSE",
  "Vacuum",
  "RemoveUnusedModuleElements",
];

async function compiles(bytes: Uint8Array): Promise<string> {
  try {
    await WebAssembly.compile(bytes as BufferSource);
    return "ok";
  } catch (e) {
    return (e as Error).message.slice(0, 110);
  }
}

console.log(`# bisect ${rel}`);
console.log(`baseline parse->encode: ${await compiles(encodeWasm(parseWasm(orig)))}`);
console.log();

console.log("## each pass individually (parse -> pass -> encode):");
for (const name of [...new Set(OZ)]) {
  const mod = parseWasm(orig);
  try {
    new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 }).addPass(createPass(name)).run();
    console.log(`  ${name.padEnd(28)} ${await compiles(encodeWasm(mod))}`);
  } catch (e) {
    console.log(`  ${name.padEnd(28)} THREW: ${(e as Error).message.slice(0, 80)}`);
  }
}

console.log();
console.log("## cumulative -Oz prefix:");
for (let i = 1; i <= OZ.length; i++) {
  const prefix = OZ.slice(0, i);
  const mod = parseWasm(orig);
  const runner = new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 });
  for (const n of prefix) runner.addPass(createPass(n));
  let res: string;
  try {
    runner.run();
    res = await compiles(encodeWasm(mod));
  } catch (e) {
    res = "THREW: " + (e as Error).message.slice(0, 80);
  }
  console.log(`  [${i}] +${prefix[i - 1].padEnd(26)} ${res}`);
  if (res !== "ok") break;
}
