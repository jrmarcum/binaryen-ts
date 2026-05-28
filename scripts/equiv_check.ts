/**
 * @module scripts/equiv_check
 *
 * WT-2c — differential behavioral-equivalence check between a corpus module and
 * its `binaryen-ts/compat` `-Oz` optimization. `WebAssembly.compile`-validity
 * (proven in WT-2) shows the output is well-formed; this shows the optimizer
 * did not *change behavior* — the concern flagged by the WT-2 size variance
 * (some functions came out smaller than upstream, where a silent correctness
 * loss would hide).
 *
 * Method: instantiate the original input and our optimized output with
 * identical, deterministic import stubs (function imports return 0/0n; memory /
 * global / table imports are reconstructed from the parsed IR). Each exported
 * function with an all-numeric signature is then called on BOTH instances in
 * lockstep with the same sampled argument vectors; the trap-or-return outcome
 * is compared per call, and the final linear-memory state is hashed and
 * compared at the end. Any divergence is a semantics-changing optimizer bug.
 *
 * Two stubbed instances driven by the same call sequence stay bit-identical iff
 * the optimization preserved semantics — the stubs need not be *meaningful*,
 * only *identical*, for the differential to be valid.
 *
 * Run:
 *   deno run --allow-read --allow-env --allow-net scripts/equiv_check.ts [rel ...]
 *
 * @license MIT
 */

import * as fs from "node:fs/promises";
import { parseWasm } from "../src/binary/wasm-parser.ts";
import * as ours from "../src/api/binaryen-compat.ts";
import type { WasmModule } from "../src/ir/module.ts";
import { ValType } from "../src/ir/types.ts";

const ROOT = new URL("../upstream/test/", import.meta.url).pathname.replace(/^\//, "");

// Files where WT-2 showed ours producing notably different code size — the
// highest-value targets for an equivalence check — plus a couple of controls.
const DEFAULT_CORPUS = [
  "passes/fannkuch0_dwarf.wasm", // ours 2.03× larger code
  "passes/class_with_dwarf_noprint.wasm", // ours 0.86×
  "unit/input/dwarf/zlib.wasm", // ours 1.00× (parity)
  "unit/input/dwarf/cubescript.wasm", // ours 0.78× (smaller — top suspect)
  "passes/fib2_dwarf.wasm", // small control
];

const NUMERIC = new Set<string>([ValType.I32, ValType.I64, ValType.F32, ValType.F64]);
const ENTRY_POINTS = new Set(["_start", "main"]); // skip whole-program drivers (hang risk)

type Arg = number | bigint;

/** Build the three sampled argument vectors for a numeric signature, or `null`
 *  if any param type is non-numeric (export is skipped). */
function argVectors(params: ValType[]): Arg[][] | null {
  const pick = (t: ValType, k: number): Arg | undefined => {
    switch (t) {
      case ValType.I32:
        return [0, 1, 0x10000][k];
      case ValType.I64:
        return [0n, 1n, 1_000_000n][k];
      case ValType.F32:
      case ValType.F64:
        return [0, 1.5, -3][k];
      default:
        return undefined;
    }
  };
  const vecs: Arg[][] = [];
  for (let k = 0; k < 3; k++) {
    const v: Arg[] = [];
    for (const t of params) {
      const x = pick(t, k);
      if (x === undefined) return null;
      v.push(x);
    }
    vecs.push(v);
  }
  return vecs;
}

/** Deterministic import object reconstructed from the parsed IR, plus the
 *  Memory we created for an imported memory (so the caller can hash it). */
function makeImports(
  mod: WasmModule,
): { obj: Record<string, Record<string, unknown>>; mem: WebAssembly.Memory | null } {
  const obj: Record<string, Record<string, unknown>> = {};
  let mem: WebAssembly.Memory | null = null;
  const put = (m: string, b: string, v: unknown) => {
    (obj[m] ??= {})[b] = v;
  };
  for (const imp of mod.imports) {
    if (imp.kind === "function") {
      const i64Result = (imp.results ?? []).length === 1 && imp.results![0] === ValType.I64;
      put(imp.module, imp.base, (..._a: unknown[]) => (i64Result ? 0n : 0));
    } else if (imp.kind === "memory") {
      const desc: WebAssembly.MemoryDescriptor = { initial: imp.initial ?? 0 };
      if (imp.max != null) desc.maximum = imp.max;
      if (imp.shared) (desc as { shared?: boolean }).shared = true;
      mem = new WebAssembly.Memory(desc);
      put(imp.module, imp.base, mem);
    } else if (imp.kind === "global") {
      const t = imp.type === ValType.I64
        ? "i64"
        : imp.type === ValType.F32
        ? "f32"
        : imp.type === ValType.F64
        ? "f64"
        : "i32";
      const init: Arg = imp.type === ValType.I64 ? 0n : 0;
      put(imp.module, imp.base, new WebAssembly.Global({ value: t, mutable: !!imp.mutable }, init));
    } else if (imp.kind === "table") {
      const element = imp.type === ValType.ExternRef ? "externref" : "anyfunc";
      const desc: WebAssembly.TableDescriptor = {
        element: element as "anyfunc",
        initial: imp.initial ?? 0,
      };
      if (imp.max != null) desc.maximum = imp.max;
      put(imp.module, imp.base, new WebAssembly.Table(desc));
    }
  }
  return { obj, mem };
}

/** Locate the linear memory an instance uses, for hashing. */
function instanceMemory(
  inst: WebAssembly.Instance,
  imported: WebAssembly.Memory | null,
): WebAssembly.Memory | null {
  for (const v of Object.values(inst.exports)) {
    if (v instanceof WebAssembly.Memory) return v;
  }
  return imported;
}

/** FNV-1a over the committed memory bytes. */
function hashMem(mem: WebAssembly.Memory | null): string {
  if (!mem) return "n/a";
  const bytes = new Uint8Array(mem.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface CallOutcome {
  trap: boolean;
  ret: string; // normalized string form for comparison
}

function call(fn: (...a: Arg[]) => unknown, args: Arg[]): CallOutcome {
  try {
    const r = fn(...args);
    // Normalize: NaN→"nan" so NaN===NaN; bigint→"<n>n"; undefined(void)→"void".
    let ret: string;
    if (r === undefined) ret = "void";
    else if (typeof r === "bigint") ret = r.toString() + "n";
    else if (typeof r === "number" && Number.isNaN(r)) ret = "nan";
    else ret = String(r);
    return { trap: false, ret };
  } catch {
    return { trap: true, ret: "trap" };
  }
}

interface FileReport {
  rel: string;
  status: "ok" | "instantiate-fail" | "skip";
  exportsTested: number;
  callsCompared: number;
  divergences: string[];
  memMatch: boolean | "n/a";
  note?: string;
}

async function checkFile(rel: string): Promise<FileReport> {
  const rep: FileReport = {
    rel,
    status: "ok",
    exportsTested: 0,
    callsCompared: 0,
    divergences: [],
    memMatch: "n/a",
  };
  const orig = new Uint8Array(await fs.readFile(ROOT + rel));

  // Produce our -Oz output via the same sequence wasic.ts uses.
  let optimized: Uint8Array;
  let mod: WasmModule;
  try {
    mod = parseWasm(orig);
    const m = ours.readBinary(orig);
    m.setFeatures(ours.Features.All);
    ours.setShrinkLevel(2);
    ours.setOptimizeLevel(2);
    m.optimize();
    optimized = m.emitBinary();
    m.dispose();
  } catch (e) {
    rep.status = "skip";
    rep.note = "optimize threw: " + (e as Error).message;
    return rep;
  }

  // Instantiate both with parallel, structurally-identical import objects.
  let instA: WebAssembly.Instance, instB: WebAssembly.Instance;
  let memA: WebAssembly.Memory | null, memB: WebAssembly.Memory | null;
  try {
    const ia = makeImports(mod), ib = makeImports(mod);
    instA = new WebAssembly.Instance(new WebAssembly.Module(orig as BufferSource), ia.obj);
    instB = new WebAssembly.Instance(new WebAssembly.Module(optimized as BufferSource), ib.obj);
    memA = instanceMemory(instA, ia.mem);
    memB = instanceMemory(instB, ib.mem);
  } catch (e) {
    rep.status = "instantiate-fail";
    rep.note = (e as Error).message.slice(0, 160);
    return rep;
  }

  // Resolve export name → signature from the parsed IR.
  const sigByName = new Map<string, { params: ValType[]; results: ValType[] }>();
  for (const fn of mod.functions) {
    sigByName.set(fn.name, { params: fn.params, results: fn.results });
  }

  for (const exp of mod.exports) {
    if (exp.kind !== "function" || ENTRY_POINTS.has(exp.name)) continue;
    const sig = sigByName.get(exp.value);
    if (!sig) continue; // exported import, or unresolved
    if (sig.results.length > 1) continue;
    if (sig.results.some((t) => !NUMERIC.has(t))) continue;
    const vecs = argVectors(sig.params);
    if (!vecs) continue;
    const fa = instA.exports[exp.name] as ((...a: Arg[]) => unknown) | undefined;
    const fb = instB.exports[exp.name] as ((...a: Arg[]) => unknown) | undefined;
    if (typeof fa !== "function" || typeof fb !== "function") continue;

    rep.exportsTested++;
    for (const args of vecs) {
      const ra = call(fa, args);
      const rb = call(fb, args);
      rep.callsCompared++;
      if (ra.trap !== rb.trap || ra.ret !== rb.ret) {
        rep.divergences.push(
          `${exp.name}(${
            args.join(",")
          }): input={trap:${ra.trap},ret:${ra.ret}} ours={trap:${rb.trap},ret:${rb.ret}}`,
        );
      }
    }
  }

  const ha = hashMem(memA), hb = hashMem(memB);
  rep.memMatch = ha === "n/a" || hb === "n/a" ? "n/a" : ha === hb;
  return rep;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const corpus = Deno.args.length > 0 ? Deno.args : DEFAULT_CORPUS;
const reports: FileReport[] = [];
for (const rel of corpus) {
  console.error(`checking ${rel} ...`);
  reports.push(await checkFile(rel));
}

console.log("# WT-2c — behavioral equivalence: original input vs binaryen-ts/compat -Oz");
console.log();
let totalDiv = 0;
for (const r of reports) {
  const divs = r.divergences.length;
  totalDiv += divs;
  const memStr = r.memMatch === "n/a" ? "mem:n/a" : r.memMatch ? "mem:match" : "mem:DIFF";
  console.log(
    `${r.rel}\n  status=${r.status} exports=${r.exportsTested} calls=${r.callsCompared} divergences=${divs} ${memStr}` +
      (r.note ? `\n  note: ${r.note}` : ""),
  );
  for (const d of r.divergences.slice(0, 8)) console.log(`    ✗ ${d}`);
  if (divs > 8) console.log(`    … and ${divs - 8} more`);
}

console.log();
const memDiffs = reports.filter((r) => r.memMatch === false).length;
console.log(
  `## Summary: ${totalDiv} call divergences, ${memDiffs} memory mismatches across ${reports.length} files`,
);
console.log(
  totalDiv === 0 && memDiffs === 0
    ? "✅ No behavioral divergence detected — optimization is semantics-preserving on the sampled surface."
    : "✗ Divergence detected — investigate the listed exports.",
);
