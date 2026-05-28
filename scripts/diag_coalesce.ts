/**
 * @module scripts/diag_coalesce
 *
 * For _fib (fib-dbg defined-fn #5), list every `local.set` in the original IR
 * and report what CoalesceLocals turned it into (a `local.set` with renamed
 * index, a `local.tee` with renamed index, or a `drop`). Side-by-side with the
 * locals count change and the local-index mapping inferred from gets.
 *
 * Run: deno run --allow-read scripts/diag_coalesce.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import { ExpressionKind } from "../src/ir/expressions.ts";
import { createPass, PassRunner } from "../src/passes/pass.ts";
import { walkExpression } from "../src/ir/walk.ts";
import "../src/passes/index.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");
const before = parseWasm(new Uint8Array(await fs.readFile(ROOT + "fib-dbg.wasm")));
const fibBefore = before.functions.find((f) => f.name === "$func5")!;

const after = parseWasm(new Uint8Array(await fs.readFile(ROOT + "fib-dbg.wasm")));
new PassRunner(after, { optimizeLevel: 2, shrinkLevel: 2 }).addPass(createPass("CoalesceLocals"))
  .run();
const fibAfter = after.functions.find((f) => f.name === "$func5")!;

console.log(`# _fib locals before: ${fibBefore.locals.length}, after: ${fibAfter.locals.length}`);
console.log(`# (params: ${fibBefore.params.length})`);
console.log();

// Walk both trees in pre-order, recording every local.set / local.tee / drop
// node with its index (or the indices of any local.get children for drops, to
// help correlate).
interface Op {
  kind: "set" | "tee" | "drop" | "get";
  index?: number;
}
function ops(body: import("../src/ir/expressions.ts").Expression): Op[] {
  const out: Op[] = [];
  walkExpression(body, (e) => {
    if (e.kind === ExpressionKind.LocalSet) out.push({ kind: "set", index: e.index });
    else if (e.kind === ExpressionKind.LocalTee) out.push({ kind: "tee", index: e.index });
    else if (e.kind === ExpressionKind.Drop) out.push({ kind: "drop" });
    else if (e.kind === ExpressionKind.LocalGet) out.push({ kind: "get", index: e.index });
  });
  return out;
}

const a = ops(fibBefore.body);
const b = ops(fibAfter.body);
console.log(`# ops walk: before=${a.length} ops, after=${b.length} ops`);
console.log();

console.log("idx | before                | after");
console.log("----+-----------------------+----------------------");
const n = Math.max(a.length, b.length);
let setsBecameDrops = 0;
let setsRenamed = 0;
for (let i = 0; i < n; i++) {
  const x = a[i], y = b[i];
  const fx = x ? `${x.kind}${x.index !== undefined ? " #" + x.index : ""}` : "—";
  const fy = y ? `${y.kind}${y.index !== undefined ? " #" + y.index : ""}` : "—";
  const change = x && y && x.kind !== y.kind && (x.kind === "set" || x.kind === "tee");
  if (x?.kind === "set" && y?.kind === "drop") setsBecameDrops++;
  if (x?.kind === "set" && y?.kind === "set" && x.index !== y.index) setsRenamed++;
  console.log(
    `${String(i).padStart(3)} | ${fx.padEnd(21)} | ${fy}${change ? "  <-- CHANGED KIND" : ""}`,
  );
}
console.log();
console.log(`## summary: ${setsBecameDrops} sets became drops; ${setsRenamed} sets renamed`);
