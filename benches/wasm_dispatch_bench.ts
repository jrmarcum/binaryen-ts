/**
 * @module binaryen-ts/benches/wasm_dispatch_bench
 *
 * Phase 10 — WASM call-boundary cost measurement.
 *
 * Measures the per-call dispatch cost of moving a single i32 op from native
 * TypeScript into a WASM kernel. The result is what determines whether any
 * given pass kernel is worth porting:
 *
 *   `(native_per_op + savings_from_wasm_codegen) × ops_per_call`
 *   must exceed
 *   `wasm_call_overhead`.
 *
 * For single-op kernels (the demo: `add_i32`, `mul_i32`, `eq_i32`) the WASM
 * call overhead dominates and the port REGRESSES vs native JS. This benchmark
 * documents that fact so the result is not accidentally re-discovered when a
 * future contributor proposes "let's just run constant folding in WASM".
 *
 * A kernel is plausibly worth porting only when each call does enough work
 * to amortize the boundary tax — see {@link ../CLAUDE.md} § "Phase 10 — WASM
 * kernel runtime" for the selection criteria.
 *
 * Run:
 *   deno bench --allow-read benches/wasm_dispatch_bench.ts
 *
 * @license MIT
 */

import { DEMO_BYTES, DEMO_KERNEL_EXPORTS } from "../src/wasm/index.ts";
import { loadKernel } from "../src/wasm-runtime.ts";

const kernel = await loadKernel({
  name: "demo-bench",
  bytes: DEMO_BYTES,
  exports: DEMO_KERNEL_EXPORTS,
});
const wasmAdd = kernel.exports.add_i32 as (a: number, b: number) => number;
const wasmMul = kernel.exports.mul_i32 as (a: number, b: number) => number;
const wasmEq = kernel.exports.eq_i32 as (a: number, b: number) => number;

// ---------------------------------------------------------------------------
// Group: single-op dispatch — measures the boundary tax.
// Expect WASM variants to be ~20–100× slower than native at the per-call level.
// ---------------------------------------------------------------------------

Deno.bench({
  name: "single-op add :: native JS  (a + b) | 0",
  group: "single-op",
  baseline: true,
  fn: () => {
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc = (acc + i) | 0;
    if (acc === -1) throw new Error("optimizer escaped the loop");
  },
});

Deno.bench({
  name: "single-op add :: WASM add_i32(a, b)",
  group: "single-op",
  fn: () => {
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc = wasmAdd(acc, i);
    if (acc === -1) throw new Error("optimizer escaped the loop");
  },
});

Deno.bench({
  name: "single-op mul :: native JS  Math.imul(a, b)",
  group: "single-op",
  fn: () => {
    let acc = 1;
    for (let i = 1; i < 1000; i++) acc = Math.imul(acc, i) | 0;
    if (acc === Number.MIN_SAFE_INTEGER) throw new Error("optimizer escaped");
  },
});

Deno.bench({
  name: "single-op mul :: WASM mul_i32(a, b)",
  group: "single-op",
  fn: () => {
    let acc = 1;
    for (let i = 1; i < 1000; i++) acc = wasmMul(acc, i);
    if (acc === Number.MIN_SAFE_INTEGER) throw new Error("optimizer escaped");
  },
});

Deno.bench({
  name: "single-op eq  :: native JS  a === b ? 1 : 0",
  group: "single-op",
  fn: () => {
    let hits = 0;
    for (let i = 0; i < 1000; i++) hits += i === (i & 0x3FF) ? 1 : 0;
    if (hits < 0) throw new Error("optimizer escaped");
  },
});

Deno.bench({
  name: "single-op eq  :: WASM eq_i32(a, b)",
  group: "single-op",
  fn: () => {
    let hits = 0;
    for (let i = 0; i < 1000; i++) hits += wasmEq(i, i & 0x3FF);
    if (hits < 0) throw new Error("optimizer escaped");
  },
});

// ---------------------------------------------------------------------------
// Group: instantiation — measures the one-time setup cost.
// Cache hits should be effectively free; the cold path pays for compile +
// instantiate.
// ---------------------------------------------------------------------------

Deno.bench({
  name: "loadKernel — cache hit (warm)",
  group: "instantiation",
  baseline: true,
  fn: async () => {
    await loadKernel({
      name: "demo-bench",
      bytes: DEMO_BYTES,
      exports: DEMO_KERNEL_EXPORTS,
    });
  },
});
