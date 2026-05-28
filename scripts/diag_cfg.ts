/**
 * @module scripts/diag_cfg
 *
 * Dump the CFG + liveness of _fib (fib-dbg defined-fn #5): per block its
 * actions, in/out edges, and computed live-in/live-out sets. Reveals where
 * liveness fails to propagate (e.g. a use whose block has no predecessor link).
 *
 * Run: deno run --allow-read scripts/diag_cfg.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { buildCFG, computeLiveness } from "../src/passes/cfg.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const mod = parseWasm(new Uint8Array(await fs.readFile(ROOT + "fib-dbg.wasm")));
const fib = mod.functions.find((f) => f.name === "$func5")!;

const cfg = buildCFG(fib.body);
computeLiveness(cfg);

const set = (s: Iterable<number>) => `{${[...s].sort((a, b) => a - b).join(",")}}`;
for (const b of cfg.blocks) {
  const acts = b.actions.map((a) => `${a.kind === "get" ? "g" : "s"}${a.index}`).join(" ");
  console.log(
    `B${b.id}  in=[${b.in.map((x) => x.id).join(",")}] out=[${
      b.out.map((x) => x.id).join(",")
    }]  ` +
      `start=${set(b.start)} end=${set(b.end)}  acts: ${acts}`,
  );
}
console.log(`\nentry=B${cfg.entry.id}, blocks=${cfg.blocks.length}`);
// Does any block set local 4 with 4 live-after (effective)? Quick check.
let eff4 = false;
for (const b of cfg.blocks) {
  const live = new Set(b.end);
  for (let i = b.actions.length - 1; i >= 0; i--) {
    const a = b.actions[i];
    if (a.kind === "get") live.add(a.index);
    else {
      if (a.index === 4 && live.has(4)) eff4 = true;
      live.delete(a.index);
    }
  }
}
console.log(`local 4 has an effective set: ${eff4}`);
