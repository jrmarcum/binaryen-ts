/**
 * @module scripts/bisect_validation
 *
 * Bisects where validation breaks for ours: encoder-only, then each pass
 * individually on top of the parse, on a previously-failing module.
 *
 * Outputs which step (no-op encoder vs each pass) is the first to produce
 * a non-validating .wasm.
 *
 * Run:
 *   deno run --allow-read --allow-env scripts/bisect_validation.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { createPass, type PassOptions } from "../src/passes/pass.ts";
import "../src/passes/index.ts";

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");

const TARGET = "passes/fannkuch0_dwarf.wasm"; // smallest failing case

const PASSES = [
  "DCE",
  "PickLoadSigns",
  "Vacuum",
  "RemoveUnusedBrs",
  "RemoveUnusedNames",
  "OptimizeInstructions",
  "CoalesceLocals",
  "SimplifyLocals",
  "LocalCSE",
  "RemoveUnusedModuleElements",
];

const OPTS: PassOptions = {
  optimizeLevel: 2,
  shrinkLevel: 2,
  debugInfo: false,
  closedWorld: false,
  passArgs: {},
  partialInliningIfs: 0,
};

async function validates(bytes: Uint8Array): Promise<{ ok: boolean; err?: string }> {
  try {
    await WebAssembly.compile(bytes as BufferSource);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

const file = path.join(ROOT, TARGET.replace(/\//g, path.sep));
const buf = await fs.readFile(file);
const inputBytes = new Uint8Array(buf);

console.log(`# Bisecting validation: ${TARGET} (${inputBytes.byteLength} bytes)`);
console.log();

// Step 1: input itself validates?
{
  const v = await validates(inputBytes);
  console.log(`input validates? ${v.ok ? "YES" : "NO"} ${v.err ?? ""}`);
}

// Step 2: parse + encode (no passes) — pure round-trip
{
  const mod = parseWasm(inputBytes);
  const out = encodeWasm(mod);
  const v = await validates(out);
  console.log(
    `parse+encode (no passes): ${v.ok ? "YES" : "NO"} bytes=${out.byteLength} ${v.err ?? ""}`,
  );
}

console.log();
console.log("## Each pass applied individually after parse:");
for (const passName of PASSES) {
  const mod = parseWasm(inputBytes);
  const pass = createPass(passName);
  try {
    pass.run(mod, OPTS);
  } catch (e) {
    console.log(
      `${passName.padEnd(28)} CRASHED  ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`,
    );
    continue;
  }
  let out: Uint8Array;
  try {
    out = encodeWasm(mod);
  } catch (e) {
    console.log(
      `${passName.padEnd(28)} ENCODE-CRASH  ${
        e instanceof Error ? e.message.slice(0, 100) : String(e)
      }`,
    );
    continue;
  }
  const v = await validates(out);
  console.log(
    `${passName.padEnd(28)} ${v.ok ? "OK" : "FAIL"}  bytes=${out.byteLength}  ${
      v.err?.slice(0, 120) ?? ""
    }`,
  );
}
