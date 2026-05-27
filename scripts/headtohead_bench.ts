// deno-lint-ignore-file no-import-prefix -- diagnostic script: intentionally
// imports upstream binaryen via npm: specifier for head-to-head comparison.

/**
 * @module scripts/headtohead_bench
 *
 * Head-to-head bench: npm:binaryen (upstream Emscripten-built C++) vs
 * @jrmarcum/binaryen-ts/compat (this repo's TypeScript implementation) on
 * the wasmtk -Oz workload.
 *
 * For each corpus file, replicates the exact wasic.ts call sequence:
 *   const m = binaryen.readBinary(bytes);
 *   m.setFeatures(binaryen.Features.All);
 *   binaryen.setShrinkLevel(2);
 *   binaryen.setOptimizeLevel(2);
 *   m.optimize();
 *   const out = m.emitBinary();
 *   m.dispose();
 *
 * Measures: wall time, output byte size, output validity (re-instantiate via
 * WebAssembly.compile), and reports the ratio binaryen-ts vs upstream.
 *
 * Verdict ladder:
 * - within ~2×    → migration viable, no perf work required
 * - 2-5×          → migration viable with caveat; targeted opt valuable
 * - 5-20×         → migration possible for non-perf-critical paths
 * - 20×+          → migration blocked on perf; significant pipeline work needed
 *
 * Run (requires npm:binaryen to be cached on first call):
 *   deno run --allow-read --allow-env --allow-net --allow-write --allow-ffi \
 *     scripts/headtohead_bench.ts
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

// Upstream binaryen (Emscripten-built C++ via npm:binaryen)
import upstream from "npm:binaryen@^116.0.0";

// Our TypeScript implementation via the compat facade
import * as ours from "../src/api/binaryen-compat.ts";
import { BinaryReader } from "../src/binary/reader.ts";

/**
 * Byte size of the `code` section (id 10) of a wasm binary, and the total bytes
 * occupied by custom sections (id 0). The total-size comparison is dominated by
 * DWARF `.debug_*` custom sections, which our parse→encode round-trip drops
 * entirely (the IR models only execution-relevant structure). Comparing the
 * `code` section instead is the apples-to-apples measure of optimizer output
 * quality; `customBytes` quantifies the debug payload that explains the rest of
 * the total-size gap.
 */
function sectionSizes(bytes: Uint8Array): { code: number; customBytes: number } {
  const r = new BinaryReader(bytes);
  r.skip(8); // magic + version
  let code = 0;
  let customBytes = 0;
  while (!r.eof) {
    const id = r.readU8();
    const size = r.readU32();
    const bodyStart = r.position;
    if (id === 10) code = size;
    else if (id === 0) customBytes += size;
    r.seek(bodyStart + size);
  }
  return { code, customBytes };
}

const ROOT = new URL("../upstream/test", import.meta.url).pathname.replace(/^\//, "");

// Picked corpus subset: a mix of sizes from the parseable-after-LEB128-fix set.
// Selected for a representative range of small/medium/large + variety of shapes
// (DWARF-laden, EH-using, plain compute).
const CORPUS: { label: string; rel: string }[] = [
  { label: "tiny", rel: "passes/dce_vacuum_remove-unused-names.wasm" },
  { label: "small-dwarf", rel: "passes/fib2_dwarf.wasm" },
  { label: "small-eh", rel: "passes/dwarf_with_exceptions.wasm" },
  { label: "medium-fk0", rel: "passes/fannkuch0_dwarf.wasm" },
  { label: "medium-class", rel: "passes/class_with_dwarf_noprint.wasm" },
  { label: "large-zlib", rel: "unit/input/dwarf/zlib.wasm" },
  { label: "large-cube", rel: "unit/input/dwarf/cubescript.wasm" },
];

interface Result {
  label: string;
  inputBytes: number;
  inputCustomBytes: number;
  upstreamMs: number;
  upstreamOutBytes: number;
  upstreamCodeBytes: number;
  upstreamValid: boolean;
  upstreamValidErr?: string;
  oursMs: number;
  oursOutBytes: number;
  oursCodeBytes: number;
  oursValid: boolean;
  oursValidErr?: string;
  oursErr?: string;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function runUpstream(bytes: Uint8Array): { ms: number; out: Uint8Array } {
  // upstream's typing isn't easy here — use as-any pattern same as wasic.ts does.
  const u = upstream as unknown as Record<string, unknown>;
  const t0 = performance.now();
  const mod = (u["readBinary"] as (b: Uint8Array) => unknown)(bytes);
  const m = mod as Record<string, unknown>;
  const features = (u["Features"] as Record<string, number>)["All"];
  (m["setFeatures"] as (n: number) => void)(features);
  (u["setShrinkLevel"] as (n: number) => void)(2);
  (u["setOptimizeLevel"] as (n: number) => void)(2);
  (m["optimize"] as () => void)();
  const out = (m["emitBinary"] as () => Uint8Array)();
  (m["dispose"] as () => void)();
  const t1 = performance.now();
  return { ms: t1 - t0, out };
}

function runOurs(bytes: Uint8Array): { ms: number; out: Uint8Array } {
  const t0 = performance.now();
  const mod = ours.readBinary(bytes);
  mod.setFeatures(ours.Features.All);
  ours.setShrinkLevel(2);
  ours.setOptimizeLevel(2);
  mod.optimize();
  const out = mod.emitBinary();
  mod.dispose();
  const t1 = performance.now();
  return { ms: t1 - t0, out };
}

async function validates(bytes: Uint8Array): Promise<{ ok: boolean; err?: string }> {
  try {
    await WebAssembly.compile(bytes as BufferSource);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function bench(label: string, rel: string): Promise<Result> {
  const file = path.join(ROOT, rel.replace(/\//g, path.sep));
  const buf = await fs.readFile(file);
  const bytes = new Uint8Array(buf);

  // Warmup each path once (JIT, lazy initialization).
  try {
    runUpstream(bytes);
  } catch { /* warmup error is reported on the timed run */ }
  try {
    runOurs(bytes);
  } catch { /* same */ }

  // Time a single iteration per path. For large modules this is ~seconds;
  // multiple iterations would add cost without changing the verdict ladder.
  let upstreamMs = 0;
  let upstreamOut: Uint8Array;
  let upstreamValid = false;
  let upstreamValidErr: string | undefined;
  try {
    const r = runUpstream(bytes);
    upstreamMs = r.ms;
    upstreamOut = r.out;
    const v = await validates(upstreamOut);
    upstreamValid = v.ok;
    upstreamValidErr = v.err;
  } catch (e) {
    return {
      label,
      inputBytes: bytes.byteLength,
      inputCustomBytes: sectionSizes(bytes).customBytes,
      upstreamMs: NaN,
      upstreamOutBytes: 0,
      upstreamCodeBytes: 0,
      upstreamValid: false,
      oursMs: NaN,
      oursOutBytes: 0,
      oursCodeBytes: 0,
      oursValid: false,
      oursErr: "upstream: " + (e instanceof Error ? e.message : String(e)),
    };
  }

  let oursMs = 0;
  let oursOut: Uint8Array;
  let oursValid = false;
  let oursValidErr: string | undefined;
  let oursErr: string | undefined;
  try {
    const r = runOurs(bytes);
    oursMs = r.ms;
    oursOut = r.out;
    const v = await validates(oursOut);
    oursValid = v.ok;
    oursValidErr = v.err;
  } catch (e) {
    oursMs = NaN;
    oursOut = new Uint8Array(0);
    oursErr = "ours: " + (e instanceof Error ? e.message : String(e));
  }

  return {
    label,
    inputBytes: bytes.byteLength,
    inputCustomBytes: sectionSizes(bytes).customBytes,
    upstreamMs,
    upstreamOutBytes: upstreamOut.byteLength,
    upstreamCodeBytes: sectionSizes(upstreamOut).code,
    upstreamValid,
    upstreamValidErr,
    oursMs,
    oursOutBytes: oursOut.byteLength,
    oursCodeBytes: oursOut.byteLength > 0 ? sectionSizes(oursOut).code : 0,
    oursValid,
    oursValidErr,
    oursErr,
  };
}

const results: Result[] = [];
for (const c of CORPUS) {
  console.error(`benching ${c.label} (${c.rel})...`);
  results.push(await bench(c.label, c.rel));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("# Head-to-head: npm:binaryen vs @jrmarcum/binaryen-ts/compat");
console.log("# Workload: wasic-style -Oz optimization");
console.log("#");
console.log("# NOTE on size: our parse→encode pipeline drops custom sections (DWARF .debug_*,");
console.log("# name, producers); upstream preserves them. So total-out size is NOT an");
console.log("# apples-to-apples optimizer comparison — `code_ratio` (code-section size, ours");
console.log("# vs upstream) is the fair metric; `cust_drop` is the input custom-section bytes");
console.log("# we elide (the bulk of the total-size delta on DWARF-laden modules).");
console.log();
console.log(
  "label             | input_b   | cust_drop | up_ms   | up_code  | ours_ms | ours_code | both_ok | time_ratio | code_ratio",
);
console.log(
  "----------------- | --------- | --------- | ------- | -------- | ------- | --------- | ------- | ---------- | ----------",
);
for (const r of results) {
  const timeRatio = Number.isFinite(r.upstreamMs) && Number.isFinite(r.oursMs) && r.upstreamMs > 0
    ? r.oursMs / r.upstreamMs
    : NaN;
  const codeRatio = r.upstreamCodeBytes > 0 ? r.oursCodeBytes / r.upstreamCodeBytes : NaN;
  console.log(
    [
      r.label.padEnd(17),
      r.inputBytes.toString().padStart(9),
      r.inputCustomBytes.toString().padStart(9),
      r.upstreamMs.toFixed(1).padStart(7),
      r.upstreamCodeBytes.toString().padStart(8),
      r.oursMs.toFixed(1).padStart(7),
      r.oursCodeBytes.toString().padStart(9),
      `${r.upstreamValid && r.oursValid}`.padStart(7),
      (Number.isFinite(timeRatio) ? timeRatio.toFixed(1) + "×" : "n/a").padStart(10),
      (Number.isFinite(codeRatio) ? codeRatio.toFixed(2) + "×" : "n/a").padStart(10),
    ].join(" | "),
  );
  if (r.oursErr) console.log(`  err:  ${r.oursErr.slice(0, 200)}`);
  if (r.oursValidErr) console.log(`  ours-validate-err: ${r.oursValidErr.slice(0, 200)}`);
  if (r.upstreamValidErr) {
    console.log(`  upstream-validate-err: ${r.upstreamValidErr.slice(0, 200)}`);
  }
}

console.log();
console.log("## Aggregate");
const okBoth = results.filter((r) =>
  Number.isFinite(r.upstreamMs) && Number.isFinite(r.oursMs) && r.upstreamMs > 0
);
if (okBoth.length > 0) {
  const totalUp = okBoth.reduce((a, b) => a + b.upstreamMs, 0);
  const totalUs = okBoth.reduce((a, b) => a + b.oursMs, 0);
  console.log(`  total upstream:    ${totalUp.toFixed(1)} ms`);
  console.log(`  total ours:        ${totalUs.toFixed(1)} ms`);
  console.log(`  overall time:      ${(totalUs / totalUp).toFixed(2)}× (ours/upstream)`);
  const upCode = okBoth.reduce((a, b) => a + b.upstreamCodeBytes, 0);
  const usCode = okBoth.reduce((a, b) => a + b.oursCodeBytes, 0);
  console.log(`  total code bytes:  upstream ${upCode}, ours ${usCode}`);
  console.log(`  overall code size: ${(usCode / upCode).toFixed(2)}× (ours/upstream; ~1 = parity)`);
  const validatedBoth = okBoth.filter((r) => r.upstreamValid && r.oursValid).length;
  console.log(`  both validate:     ${validatedBoth}/${okBoth.length}`);
}
const failedOurs = results.filter((r) => r.oursErr);
if (failedOurs.length > 0) {
  console.log();
  console.log(`  ours errored on:`);
  for (const r of failedOurs) console.log(`    ${r.label}: ${r.oursErr?.slice(0, 100)}`);
}
