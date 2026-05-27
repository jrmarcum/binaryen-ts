/**
 * @module scripts/profile_phase10
 *
 * Phase 10 — per-pass + encoder profiling harness.
 *
 * Decides whether any WASM kernel is worth porting by measuring where time
 * is actually spent in the existing TypeScript pipeline. For each pass and
 * for the encoder, reports total wall time, per-call wall time, and
 * throughput (ns per IR node).
 *
 * The kernel-selection criterion (CLAUDE.md § "Phase 10"):
 *   `(per_op_savings × ops_per_call) > boundary_tax (~3 ns)`
 *
 * So a pass that consumes < 50 ns per IR node is, practically, never
 * portable: even a 100% native-code win per node would not amortize the
 * boundary tax.
 *
 * Run:
 *   deno run --allow-read scripts/profile_phase10.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { parseWasm } from "../src/binary/wasm-parser.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { walkExpression } from "../src/ir/walk.ts";
import type { WasmModule } from "../src/ir/module.ts";
import { ModuleBuilder } from "../src/ir/module.ts";
import { ValType } from "../src/ir/types.ts";
import {
  BinaryOp,
  type Expression,
  makeBinary,
  makeBlock,
  makeI32Const,
  makeIf,
  makeLocalGet,
  makeLocalSet,
  makeLoop,
  makeUnary,
  UnaryOp,
} from "../src/ir/expressions.ts";

import { createPass, type Pass, type PassOptions } from "../src/passes/pass.ts";
// Side-effect import to register passes
import "../src/passes/index.ts";

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");

interface CorpusEntry {
  source: string;
  bytes: Uint8Array;
  numExprs: number;
}

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

async function loadRealCorpus(): Promise<CorpusEntry[]> {
  const files = await findWasmFiles(ROOT);
  const out: CorpusEntry[] = [];
  for (const file of files) {
    const buf = await fs.readFile(file);
    try {
      const mod = parseWasm(new Uint8Array(buf), file);
      const numExprs = countExprs(mod);
      // Skip trivial modules: they pollute averages without exercising passes
      if (numExprs < 10) continue;
      out.push({
        source: path.relative(ROOT, file).replace(/\\/g, "/"),
        bytes: new Uint8Array(buf),
        numExprs,
      });
    } catch {
      // skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic stress module
// ---------------------------------------------------------------------------

/**
 * Builds one large function with `numIters` arithmetic chunks. Each chunk is a
 * (local.set, local.get binary local.get, if/else branch on the result) pattern
 * — designed to exercise locals, binary ops, blocks, ifs, and constants.
 *
 * Result: ~9 expressions per chunk, plus the function-level wrapper.
 */
function buildStressFunction(numChunks: number): Expression {
  const body: Expression[] = [];
  // We'll have 8 i32 locals: 0..7
  for (let i = 0; i < numChunks; i++) {
    const slot = i & 7; // 8 locals cycled
    const otherSlot = (i + 3) & 7;
    // local.set $slot, (i32.add (local.get $slot) (i32.const i))
    body.push(
      makeLocalSet(
        slot,
        makeBinary(
          BinaryOp.AddI32,
          makeLocalGet(slot, ValType.I32),
          makeI32Const(i + 1),
        ),
      ),
    );
    // if (i32.eqz local.get $slot) local.set $other, ...
    body.push(
      makeIf(
        makeUnary(UnaryOp.EqzI32, makeLocalGet(slot, ValType.I32)),
        makeLocalSet(
          otherSlot,
          makeBinary(
            BinaryOp.XorI32,
            makeLocalGet(otherSlot, ValType.I32),
            makeI32Const(0x5a5a),
          ),
        ),
        makeLocalSet(
          otherSlot,
          makeBinary(
            BinaryOp.MulI32,
            makeLocalGet(otherSlot, ValType.I32),
            makeI32Const(3),
          ),
        ),
      ),
    );
  }
  // Wrap in a loop so RemoveUnusedBrs/RemoveUnusedNames have something to chew on
  return makeBlock([
    makeLoop("$L0", makeBlock(body)),
  ]);
}

function buildStressModule(numFunctions: number, chunksPerFn: number): WasmModule {
  const builder = new ModuleBuilder();
  builder.addMemory("$mem", 1);
  for (let f = 0; f < numFunctions; f++) {
    const locals = Array.from({ length: 8 }, () => ({ type: ValType.I32 }));
    const body = buildStressFunction(chunksPerFn);
    builder.addFunction(`$f${f}`, [], [], body, locals);
  }
  builder.addExport("f0", "$f0", "function");
  return builder.build();
}

// ---------------------------------------------------------------------------
// Timing utilities
// ---------------------------------------------------------------------------

interface Sample {
  passName: string;
  source: string;
  numExprs: number;
  totalMs: number;
  iterations: number;
}

function timeIt(label: string, iterations: number, fn: () => void): number {
  // Warmup
  for (let i = 0; i < 3; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = performance.now();
  void label;
  return t1 - t0;
}

// ---------------------------------------------------------------------------
// Main profiling loop
// ---------------------------------------------------------------------------

const PASS_NAMES = [
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
] as const;

const OPTS: PassOptions = {
  optimizeLevel: 2,
  shrinkLevel: 0,
  debugInfo: false,
  closedWorld: false,
  passArgs: {},
  partialInliningIfs: 0,
};

function runPassOnce(passName: string, mod: WasmModule): void {
  const pass: Pass = createPass(passName);
  pass.run(mod, OPTS);
}

async function main(): Promise<void> {
  console.log("# Phase 10 profiling — per-pass timing on real + synthetic corpus");
  console.log();

  // Real corpus
  const real = await loadRealCorpus();
  console.log(`## Real corpus: ${real.length} modules`);
  console.log(
    `   total exprs: ${real.reduce((a, b) => a + b.numExprs, 0)}, ` +
      `total bytes: ${real.reduce((a, b) => a + b.bytes.byteLength, 0)}`,
  );
  console.log();

  // Synthetic stress modules — three sizes for scaling analysis
  const synth: { name: string; mod: WasmModule; numExprs: number; bytes: Uint8Array }[] = [];
  for (
    const [label, nf, nc] of [
      ["synth-small", 4, 50] as const,
      ["synth-medium", 8, 200] as const,
      ["synth-large", 16, 400] as const,
    ]
  ) {
    const mod = buildStressModule(nf, nc);
    const bytes = encodeWasm(mod);
    synth.push({
      name: label,
      mod,
      numExprs: countExprs(mod),
      bytes,
    });
  }
  console.log("## Synthetic stress modules:");
  for (const s of synth) {
    console.log(`   ${s.name}: exprs=${s.numExprs}, bytes=${s.bytes.byteLength}`);
  }
  console.log();

  // ---------------------------------------------------------------------------
  // Run profiling
  // ---------------------------------------------------------------------------
  const samples: Sample[] = [];

  // Iterations per (pass, module) — adjust to keep total run-time under control
  const ITERS_REAL = 50;
  const ITERS_SYNTH = 20;

  // Concatenate "all real corpus together" as one batched workload, plus
  // each synth tier individually.
  type Workload = { name: string; numExprs: number; modBytes: Uint8Array; iters: number };
  const workloads: Workload[] = [];

  // For real corpus: pick top-N by expression count as our "real" workload,
  // and represent total work as the sum of (per-module passes).
  const topReal = [...real].sort((a, b) => b.numExprs - a.numExprs).slice(0, 10);
  for (const r of topReal) {
    workloads.push({
      name: `real:${r.source}`,
      numExprs: r.numExprs,
      modBytes: r.bytes,
      iters: ITERS_REAL,
    });
  }
  for (const s of synth) {
    workloads.push({
      name: s.name,
      numExprs: s.numExprs,
      modBytes: s.bytes,
      iters: ITERS_SYNTH,
    });
  }

  console.log("## Per-pass timing");
  console.log("# pass,source,exprs,iters,total_ms,ns_per_expr,ns_per_call");
  for (const wl of workloads) {
    for (const passName of PASS_NAMES) {
      // Clone module per iteration so each pass sees a fresh tree
      const t = timeIt(passName, wl.iters, () => {
        const fresh = parseWasm(wl.modBytes);
        runPassOnce(passName, fresh);
      });
      // Subtract parse time so we isolate pass time
      const tParse = timeIt(`parse:${wl.name}`, wl.iters, () => {
        parseWasm(wl.modBytes);
      });
      const passOnlyMs = Math.max(0, t - tParse);
      const nsPerExpr = (passOnlyMs * 1e6) / (wl.iters * wl.numExprs);
      const nsPerCall = (passOnlyMs * 1e6) / wl.iters;
      samples.push({
        passName,
        source: wl.name,
        numExprs: wl.numExprs,
        totalMs: passOnlyMs,
        iterations: wl.iters,
      });
      console.log(
        `${passName},${wl.name},${wl.numExprs},${wl.iters},${passOnlyMs.toFixed(2)},` +
          `${nsPerExpr.toFixed(1)},${nsPerCall.toFixed(0)}`,
      );
    }
    // Also time encoder + parser on this module
    const fresh = parseWasm(wl.modBytes);
    const tEnc = timeIt("encode", wl.iters, () => {
      encodeWasm(fresh);
    });
    const tPar = timeIt("parse", wl.iters, () => {
      parseWasm(wl.modBytes);
    });
    const nsPerExprEnc = (tEnc * 1e6) / (wl.iters * wl.numExprs);
    const nsPerExprPar = (tPar * 1e6) / (wl.iters * wl.numExprs);
    console.log(
      `__encoder,${wl.name},${wl.numExprs},${wl.iters},${tEnc.toFixed(2)},` +
        `${nsPerExprEnc.toFixed(1)},${(tEnc * 1e6 / wl.iters).toFixed(0)}`,
    );
    console.log(
      `__parser,${wl.name},${wl.numExprs},${wl.iters},${tPar.toFixed(2)},` +
        `${nsPerExprPar.toFixed(1)},${(tPar * 1e6 / wl.iters).toFixed(0)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Aggregate: pass × source — compute average ns/expr across all sources
  // ---------------------------------------------------------------------------
  console.log();
  console.log("## Aggregate — ns per IR node, per pass");
  console.log("(weighted by total expressions × iterations)");
  console.log("pass,total_work_exprs,total_ms,avg_ns_per_expr,avg_ms_per_call_on_synth-large");
  const synthLarge = synth[synth.length - 1];

  for (const passName of PASS_NAMES) {
    const passSamples = samples.filter((s) => s.passName === passName);
    const totalWork = passSamples.reduce((a, b) => a + b.numExprs * b.iterations, 0);
    const totalMs = passSamples.reduce((a, b) => a + b.totalMs, 0);
    const nsPerExpr = (totalMs * 1e6) / totalWork;
    // Avg ms per call on synth-large for sanity
    const slSample = passSamples.find((s) => s.source === synthLarge.name);
    const slMsPerCall = slSample ? slSample.totalMs / slSample.iterations : 0;
    console.log(
      `${passName},${totalWork},${totalMs.toFixed(2)},${nsPerExpr.toFixed(1)},` +
        `${slMsPerCall.toFixed(3)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Candidate analysis — which passes break ≥50 ns/expr?
  // ---------------------------------------------------------------------------
  console.log();
  console.log("## Candidate analysis");
  console.log("# A pass is a plausible Phase 10 kernel candidate only if it averages");
  console.log("# >= 50 ns per IR node AND total ms/call is substantial enough that");
  console.log("# moving the inner loop to WASM could amortize the ~3 ns boundary tax.");
  console.log();
  for (const passName of PASS_NAMES) {
    const passSamples = samples.filter((s) => s.passName === passName);
    const totalWork = passSamples.reduce((a, b) => a + b.numExprs * b.iterations, 0);
    const totalMs = passSamples.reduce((a, b) => a + b.totalMs, 0);
    const nsPerExpr = (totalMs * 1e6) / totalWork;
    const verdict = nsPerExpr >= 50 ? "CANDIDATE" : "skip";
    console.log(
      `  ${passName.padEnd(28)} ${nsPerExpr.toFixed(1).padStart(7)} ns/node   ${verdict}`,
    );
  }

  console.log();
  console.log("## Encoder/parser baseline");
  // Re-derive from samples we collected on synth-large
  console.log("(already reported per-workload above; check synth-large rows)");
}

await main();
