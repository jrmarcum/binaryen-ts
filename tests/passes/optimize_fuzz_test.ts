/**
 * @module binaryen-ts/tests/passes/optimize_fuzz
 *
 * Differential fuzz / stress test for the full `-Oz` optimization pipeline.
 *
 * Every optimizer bug in the WT-2h…WT-2j series was a *behavioral* miscompile —
 * the output was valid wasm but computed the wrong value — and was caught only
 * by running the code, never by `WebAssembly.compile` validity. The recurring
 * offender was `LocalCSE` invalidation (three distinct bugs), with the
 * CoalesceLocals → Vacuum dangling-stack family close behind.
 *
 * This test hammers exactly those code paths: it generates many random,
 * self-contained `i32` functions deliberately packed with the hazards that
 * broke —
 *   - `local.tee K` mutations whose value a sibling operand re-reads
 *     (WT-2j: within-expression eval-order CSE),
 *   - writes to a local nested inside `if` branches that a later sibling reads
 *     (WT-2i: cross-sibling CSE invalidation),
 *   - repeated pure subexpressions over a small local pool (CSE candidates),
 *   - dead and live `local.set`s, drops, `select`, nested blocks
 *     (CoalesceLocals / Vacuum / SimplifyLocals / OptimizeInstructions).
 *
 * For each generated function it runs the REAL pipeline — build IR → encode →
 * `parseWasm` (so the binary parser is exercised) → full `-Oz` → encode — and
 * asserts (a) the optimized binary is valid and (b) it returns bit-identical
 * results to the unoptimized build on a spread of edge-case inputs. On any
 * divergence it bisects the pipeline to name the first offending pass and dumps
 * a reproducible seed + the function IR.
 *
 * Deterministic by default (seeds 1..N) so it is reproducible and CI-safe; set
 * `FUZZ_ITERS` / `FUZZ_SEED` to crank it up for ad-hoc deep fuzzing.
 *
 * @license MIT
 */

import { assert } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { createPass, PassRunner } from "../../src/passes/pass.ts";
import "../../src/passes/index.ts"; // register all built-in passes
import {
  BinaryOp,
  type Expression,
  makeBinary,
  makeBlock,
  makeDrop,
  makeI32Const,
  makeIf,
  makeLocalGet,
  makeLocalSet,
  makeLocalTee,
  makeReturn,
  makeSelect,
  makeUnary,
  UnaryOp,
} from "../../src/ir/expressions.ts";
import { ModuleBuilder, type WasmModule } from "../../src/ir/module.ts";
import { ValType } from "../../src/ir/types.ts";
import { mapExpression } from "../../src/ir/walk.ts";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic so failures are reproducible.
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Non-trapping i32 binary ops only (no div/rem — those trap on 0 / INT_MIN÷-1).
const BIN_OPS: BinaryOp[] = [
  BinaryOp.AddI32,
  BinaryOp.SubI32,
  BinaryOp.MulI32,
  BinaryOp.AndI32,
  BinaryOp.OrI32,
  BinaryOp.XorI32,
  BinaryOp.ShlI32, // shift amount is taken mod 32 — never traps
  BinaryOp.ShrSI32,
  BinaryOp.ShrUI32,
  BinaryOp.RotlI32,
  BinaryOp.RotrI32,
  BinaryOp.EqI32,
  BinaryOp.NeI32,
  BinaryOp.LtSI32,
  BinaryOp.LtUI32,
  BinaryOp.GtSI32,
  BinaryOp.GeSI32,
];
const UN_OPS: UnaryOp[] = [UnaryOp.ClzI32, UnaryOp.CtzI32, UnaryOp.PopcntI32, UnaryOp.EqzI32];
const CONSTS = [0, 1, -1, 2, 3, 7, 8, 31, 32, 100, -100, 0x7fffffff, -0x80000000, 0x55555555];

interface Gen {
  r: () => number;
  nLocals: number;
}

const pick = <T>(g: Gen, a: T[]): T => a[Math.floor(g.r() * a.length)];
const clone = (e: Expression): Expression => mapExpression(e, (x) => x);

/** A pure (no side effects) i32 expression — a valid CSE candidate. */
function genPure(g: Gen, depth: number): Expression {
  if (depth <= 0 || g.r() < 0.45) {
    return g.r() < 0.7
      ? makeLocalGet(Math.floor(g.r() * g.nLocals), ValType.I32)
      : makeI32Const(pick(g, CONSTS));
  }
  if (g.r() < 0.25) return makeUnary(pick(g, UN_OPS), genPure(g, depth - 1));
  return makeBinary(pick(g, BIN_OPS), genPure(g, depth - 1), genPure(g, depth - 1));
}

/** An i32 expression that MAY mutate locals (local.tee) — the eval-order hazard. */
function genExpr(g: Gen, depth: number): Expression {
  if (depth <= 0 || g.r() < 0.35) {
    return g.r() < 0.7
      ? makeLocalGet(Math.floor(g.r() * g.nLocals), ValType.I32)
      : makeI32Const(pick(g, CONSTS));
  }
  const choice = g.r();
  if (choice < 0.18) {
    // Eval-order hazard (the WT-2j shape): `binop( binop(lg K, tee K(v)), lg K )`.
    // `lg K` appears twice → CSE candidate; the FIRST read (before the tee) is
    // tee'd capturing the OLD value, the LAST read (after the tee) must NOT be
    // rewritten to that stale tee. A correct pass keeps them distinct.
    const k = Math.floor(g.r() * g.nLocals);
    const inner = makeBinary(
      pick(g, BIN_OPS),
      makeLocalGet(k, ValType.I32),
      makeLocalTee(k, genExpr(g, depth - 1), ValType.I32),
    );
    return makeBinary(pick(g, BIN_OPS), inner, makeLocalGet(k, ValType.I32));
  }
  if (choice < 0.30) {
    // local.tee — write a local mid-expression, yield the value.
    return makeLocalTee(Math.floor(g.r() * g.nLocals), genExpr(g, depth - 1), ValType.I32);
  }
  if (choice < 0.42) {
    // Twin: a pure subexpr duplicated → guaranteed CSE candidate, often around a tee.
    const e = genPure(g, depth - 1);
    return makeBinary(pick(g, BIN_OPS), e, clone(e));
  }
  if (choice < 0.55) {
    return makeUnary(pick(g, UN_OPS), genExpr(g, depth - 1));
  }
  if (choice < 0.70) {
    return makeSelect(
      genExpr(g, depth - 1),
      genExpr(g, depth - 1),
      genExpr(g, depth - 1),
    );
  }
  return makeBinary(pick(g, BIN_OPS), genExpr(g, depth - 1), genExpr(g, depth - 1));
}

/** A void statement: local.set / if(then,else with nested writes) / drop / block. */
function genStmt(g: Gen, depth: number): Expression {
  const choice = g.r();
  if (choice < 0.15 && depth > 0) {
    // Cross-sibling hazard (the WT-2i shape): read K, conditionally write K
    // inside an `if`, then read K again. `lg K` is a CSE candidate spanning the
    // `if`; the second read must see the post-`if` value, so the block-level
    // invalidation must recurse into the `if` branch.
    const k = Math.floor(g.r() * g.nLocals);
    const a = Math.floor(g.r() * g.nLocals);
    const b = Math.floor(g.r() * g.nLocals);
    const write = makeLocalSet(k, genExpr(g, 2));
    const branch = g.r() < 0.5
      ? makeIf(genExpr(g, 2), makeBlock([write], null), null)
      : makeIf(genExpr(g, 2), makeBlock([genStmt(g, depth - 1)], null), makeBlock([write], null));
    return makeBlock([
      makeLocalSet(a, makeLocalGet(k, ValType.I32)),
      branch,
      makeLocalSet(b, makeLocalGet(k, ValType.I32)),
    ], null);
  }
  if (depth <= 0 || choice < 0.50) {
    return makeLocalSet(Math.floor(g.r() * g.nLocals), genExpr(g, 3));
  }
  if (choice < 0.80) {
    const cond = genExpr(g, 2);
    const nThen = 1 + Math.floor(g.r() * 3);
    const thenB = makeBlock(Array.from({ length: nThen }, () => genStmt(g, depth - 1)), null);
    if (g.r() < 0.5) {
      const nElse = 1 + Math.floor(g.r() * 3);
      const elseB = makeBlock(Array.from({ length: nElse }, () => genStmt(g, depth - 1)), null);
      return makeIf(cond, thenB, elseB);
    }
    return makeIf(cond, thenB, null);
  }
  if (choice < 0.90) return makeDrop(genExpr(g, 3));
  const n = 1 + Math.floor(g.r() * 3);
  return makeBlock(Array.from({ length: n }, () => genStmt(g, depth - 1)), null);
}

function buildModule(seed: number): { mod: WasmModule; nParams: number; ir: string } {
  const g: Gen = { r: rng(seed), nLocals: 0 };
  const nParams = 2 + Math.floor(g.r() * 3); // 2..4
  const nVars = 2 + Math.floor(g.r() * 4); // 2..5
  g.nLocals = nParams + nVars;
  const nStmts = 3 + Math.floor(g.r() * 7); // 3..9
  const body = makeBlock(
    [
      ...Array.from({ length: nStmts }, () => genStmt(g, 3)),
      makeReturn(genExpr(g, 4)),
    ],
    null,
  );
  const mod = new ModuleBuilder()
    .addFunction(
      "f",
      Array.from({ length: nParams }, () => ValType.I32),
      [ValType.I32],
      body,
      Array.from({ length: nVars }, () => ({ type: ValType.I32 })),
    )
    .addExport("f", "f")
    .build();
  return { mod, nParams, ir: irToString(body) };
}

// deno-lint-ignore no-explicit-any
function irToString(e: any): string {
  if (!e) return "_";
  let r = e.kind;
  if (e.op) r += `[${e.op}]`;
  if (e.index !== undefined) r += `#${e.index}`;
  if (e.kind === "const") r += `=${e.value?.i32}`;
  const kids: string[] = [];
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (v && typeof v === "object" && v.kind) kids.push(irToString(v));
    else if (Array.isArray(v)) {
      for (const it of v) if (it && typeof it === "object" && it.kind) kids.push(irToString(it));
    }
  }
  return kids.length ? `${r}(${kids.join(",")})` : r;
}

const INPUTS = [0, 1, -1, 2, 7, -7, 31, 32, 12345, -12345, 0x7fffffff, -0x80000000];
function inputVec(g: () => number, n: number): number[] {
  return Array.from(
    { length: n },
    () => (g() < 0.6
      ? INPUTS[Math.floor(g() * INPUTS.length)]
      : (Math.floor(g() * 0xffffffff) | 0)),
  );
}

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
  "Vacuum(2)",
  "RemoveUnusedModuleElements",
];

/** Re-run only the first `n` -Oz passes on the unoptimized binary, re-encode. */
function ozPrefix(bytes: Uint8Array, n: number): Uint8Array {
  const mod = parseWasm(bytes);
  const runner = new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 });
  for (const p of PASS_NAMES.slice(0, n)) runner.addPass(createPass(p.replace("(2)", "")));
  runner.run();
  return encodeWasm(mod);
}

// ---------------------------------------------------------------------------

Deno.test("optimize fuzz: full -Oz preserves validity + behavior on random i32 functions", () => {
  const ITERS = Number(Deno.env.get("FUZZ_ITERS") ?? "350");
  const BASE = Number(Deno.env.get("FUZZ_SEED") ?? "1");

  for (let i = 0; i < ITERS; i++) {
    const seed = BASE + i;
    const { mod, nParams, ir } = buildModule(seed);
    const unopt = encodeWasm(mod);

    // The generator must always produce valid wasm — a failure here is a bug in
    // the encoder or generator, not the optimizer.
    let unoptInst: WebAssembly.Instance;
    try {
      unoptInst = new WebAssembly.Instance(new WebAssembly.Module(unopt as BufferSource));
    } catch (e) {
      throw new Error(
        `[seed ${seed}] UNOPTIMIZED build invalid: ${(e as Error).message}\nIR: ${ir}`,
      );
    }

    // Full -Oz via parse → passes → encode (exercises the binary parser too).
    const optMod = parseWasm(unopt);
    new PassRunner(optMod, { optimizeLevel: 2, shrinkLevel: 2 }).addDefaultOptimizationPasses()
      .run();
    const opt = encodeWasm(optMod);

    let optInst: WebAssembly.Instance;
    try {
      optInst = new WebAssembly.Instance(new WebAssembly.Module(opt as BufferSource));
    } catch (e) {
      // Validity miscompile (e.g. dangling-stack fallthru). Bisect to the pass.
      let firstBad = "?";
      for (let n = 1; n <= PASS_NAMES.length; n++) {
        try {
          new WebAssembly.Module(ozPrefix(unopt, n) as BufferSource);
        } catch {
          firstBad = PASS_NAMES[n - 1];
          break;
        }
      }
      throw new Error(
        `[seed ${seed}] -Oz produced INVALID wasm (first bad pass: ${firstBad}): ${
          (e as Error).message
        }\nIR: ${ir}`,
      );
    }

    const fa = unoptInst.exports.f as (...a: number[]) => number;
    const fb = optInst.exports.f as (...a: number[]) => number;

    const g = rng(seed ^ 0x9e3779b9);
    for (let t = 0; t < 12; t++) {
      const args = inputVec(g, nParams);
      const ra = fa(...args);
      const rb = fb(...args);
      if (ra !== rb) {
        // Behavioral miscompile. Bisect to the first pass that changes the result.
        let firstBad = "?";
        for (let n = 1; n <= PASS_NAMES.length; n++) {
          try {
            const inst = new WebAssembly.Instance(
              new WebAssembly.Module(ozPrefix(unopt, n) as BufferSource),
            );
            if ((inst.exports.f as (...a: number[]) => number)(...args) !== ra) {
              firstBad = PASS_NAMES[n - 1];
              break;
            }
          } catch {
            firstBad = PASS_NAMES[n - 1] + " (invalid)";
            break;
          }
        }
        throw new Error(
          `[seed ${seed}] BEHAVIORAL miscompile (first bad pass: ${firstBad})\n` +
            `  f(${args.join(", ")}) = ${ra} (unopt) vs ${rb} (-Oz)\n  IR: ${ir}`,
        );
      }
    }
  }

  assert(true);
});
