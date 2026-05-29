/**
 * @module scripts/diag_fib
 *
 * Isolate where `_fib` stops matching the input: compare `_fib(n)` of the
 * original against (a) our parse→encode (no passes) and (b) each -Oz pass added
 * cumulatively. Pinpoints whether a semantic divergence is in the encoder or a
 * specific pass.
 *
 * Run: deno run --allow-read scripts/diag_fib.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { createPass, PassRunner } from "../src/passes/pass.ts";
import "../src/passes/index.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const orig = new Uint8Array(await fs.readFile(ROOT + "fib-dbg.wasm"));

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
  "RemoveUnusedModuleElements",
];

// Permissive stub imports (fib only reads a global; everything stubbed to 0).
function stubImports(): Record<string, Record<string, unknown>> {
  return new Proxy({}, {
    get: () =>
      new Proxy({}, {
        get: () => {
          // Provide whatever shape is asked for: a memory, a global, or a fn.
          return undefined;
        },
      }),
  });
}

function fibOf(bytes: Uint8Array, n: number): string {
  try {
    const mod = parseWasm(bytes);
    const imports: Record<string, Record<string, unknown>> = {};
    for (const imp of mod.imports) {
      imports[imp.module] ??= {};
      if (imp.kind === "memory") {
        imports[imp.module][imp.base] = new WebAssembly.Memory({
          initial: imp.initial ?? 1,
          ...(imp.max != null ? { maximum: imp.max } : {}),
        });
      } else if (imp.kind === "global") {
        const t = imp.type === "i64"
          ? "i64"
          : imp.type === "f32"
          ? "f32"
          : imp.type === "f64"
          ? "f64"
          : "i32";
        imports[imp.module][imp.base] = new WebAssembly.Global({
          value: t as WebAssembly.ValueType,
          mutable: !!imp.mutable,
        }, t === "i64" ? 0n : 0);
      } else if (imp.kind === "table") {
        imports[imp.module][imp.base] = new WebAssembly.Table({
          element: "anyfunc",
          initial: imp.initial ?? 0,
          ...(imp.max != null ? { maximum: imp.max } : {}),
        });
      } else imports[imp.module][imp.base] = () => 0;
    }
    void stubImports;
    const inst = new WebAssembly.Instance(
      new WebAssembly.Module(bytes as BufferSource),
      imports as WebAssembly.Imports,
    );
    const f = inst.exports["_fib"] as (n: number) => number;
    return String(f(n));
  } catch (e) {
    return "ERR:" + (e as Error).message.slice(0, 50);
  }
}

const N = 7;
console.log(`# _fib(${N})`);
console.log(`input (original):        ${fibOf(orig, N)}`);
console.log(`ours parse->encode:      ${fibOf(encodeWasm(parseWasm(orig)), N)}`);

console.log("\n## cumulative:");
for (let i = 1; i <= OZ.length; i++) {
  const mod = parseWasm(orig);
  const runner = new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 });
  for (const n of OZ.slice(0, i)) runner.addPass(createPass(n));
  runner.run();
  console.log(`+${OZ[i - 1].padEnd(28)} ${fibOf(encodeWasm(mod), N)}`);
}

console.log("\n## each pass individually (fresh parse):");
for (const name of [...new Set(OZ)]) {
  const mod = parseWasm(orig);
  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 }).addPass(createPass(name)).run();
  console.log(`${name.padEnd(28)} ${fibOf(encodeWasm(mod), N)}`);
}
