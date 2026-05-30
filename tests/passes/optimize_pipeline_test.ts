/**
 * @module binaryen-ts/tests/passes/optimize_pipeline
 *
 * Full `-Oz` pipeline regression tests on a real wasic-emitted module
 * (46_TemplateEscapes), guarding two bugs in the same dangling-stack family as
 * WT-2h:
 *
 * 1. **Multi-value (tuple) call returns left dangling values.** A `call` whose
 *    function type returns N > 1 results is one IR node, but the binary consumes
 *    the N stack values with N separate instructions (the wasic spill pattern is
 *    `call; local.set; local.set`). The decoder modelled only the first
 *    consumer; the others got a `nop`, which `CoalesceLocals` turned into
 *    `drop(nop)` and the second `Vacuum` deleted — dangling the extra results at
 *    the function tail ("expected 0 elements for fallthru, found N"). Fixed by
 *    seeding N-1 typed `Pop`s alongside the call node in the binary parser.
 *
 * 2. **LocalCSE substituted a `local.get` across a write nested in an `if`.**
 *    `_invalidate` only inspected each block child's top-level kind, so a
 *    `local.set 1` inside an `if` branch did not evict a cached `local.get 1`
 *    entry; a later sibling read was then rewritten to the stale (entry-time)
 *    tee. In wasic's itoa this overwrote the `-` sign of negative integers
 *    (`-1` printed as `1`). Fixed by walking the whole child subtree in
 *    `_invalidate`.
 *
 * The fixture is the byte-for-byte `wabt-ts/compat@1.2.9` output of `wasic` on
 * `46_TemplateEscapes.ts` (sha256
 * 200bcda18c784b948172abac0885e49db6b7024af3f5393b9ff0d07ae352156d). It both
 * exercises a `(i32,i32)` string-returning helper (bug 1) and formats numbers
 * via itoa (bug 2).
 *
 * @license MIT
 */

import { assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { PassRunner } from "../../src/passes/pass.ts";
import "../../src/passes/index.ts"; // side-effect: register all built-in passes
import {
  BinaryOp,
  makeBinary,
  makeBlock,
  makeI32Const,
  makeIf,
  makeLocalGet,
  makeLocalSet,
  makeReturn,
} from "../../src/ir/expressions.ts";
import { ModuleBuilder } from "../../src/ir/module.ts";
import { ValType } from "../../src/ir/types.ts";

// wabt-ts/compat@1.2.9 wasic output for 46_TemplateEscapes.ts (1543 bytes).
const FIXTURE_B64 =
  "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";

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const RAW = decodeB64(FIXTURE_B64);

function optimizeOz(bytes: Uint8Array): Uint8Array {
  const mod = parseWasm(bytes);
  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 })
    .addDefaultOptimizationPasses()
    .run();
  return encodeWasm(mod);
}

/** Instantiate a WASI module with deterministic stubs, run `_start`, capture fd_write bytes. */
async function runWasi(bytes: Uint8Array): Promise<{ trap: boolean; out: number[] }> {
  const writes: number[] = [];
  let mem: WebAssembly.Memory | undefined;
  const imports = {
    wasi_snapshot_preview1: {
      proc_exit: () => {
        throw { __exit: true };
      },
      fd_write: (_fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
        const dv = new DataView(mem!.buffer);
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          for (const b of new Uint8Array(mem!.buffer, ptr, len)) writes.push(b);
          total += len;
        }
        dv.setUint32(nwritten, total, true);
        return 0;
      },
    },
  };
  let trap = false;
  try {
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, imports);
    mem = instance.exports.memory as WebAssembly.Memory;
    (instance.exports._start as () => void)();
  } catch (e) {
    if (!(e && (e as { __exit?: boolean }).__exit)) trap = true;
  }
  return { trap, out: writes };
}

Deno.test("optimize pipeline: wasic 46_TemplateEscapes survives full -Oz (multi-value + LocalCSE)", async () => {
  // Raw input is valid.
  await WebAssembly.compile(RAW as BufferSource);

  // Full -Oz output must compile — guards the multi-value-call dangling-stack
  // fallthru ("expected 0 elements for fallthru, found N").
  const opt = optimizeOz(RAW);
  await WebAssembly.compile(opt as BufferSource);

  // And must behave identically — guards the LocalCSE stale-substitution
  // miscompile (the itoa `-` sign). Same fd_write byte stream, no new trap.
  const a = await runWasi(RAW);
  const b = await runWasi(opt);
  assertEquals(b.trap, a.trap, "optimized output trapped where raw did not");
  assertEquals(
    new TextDecoder().decode(new Uint8Array(b.out)),
    new TextDecoder().decode(new Uint8Array(a.out)),
    "optimized output diverged from raw",
  );
});

Deno.test("LocalCSE: a local.get is not substituted across a write nested in an if", async () => {
  // f(cond, x):
  //   l2 = x                       ;; lg(x=1) occurrence #1 — CSE tee candidate
  //   if (cond) { x = x + 100 }    ;; writes local 1 from INSIDE an `if`
  //   l3 = x                       ;; lg(x=1) occurrence #2 — must read the MODIFIED x
  //   return l3
  // With the pre-fix `_invalidate` (top-level kind only), the `if` did not
  // evict the cached `lg:1` entry, so `l3 = x` was rewritten to read the
  // entry-time tee (the pre-`if` value). f(1, 5) then returned 5 instead of 105.
  const mod = new ModuleBuilder()
    .addFunction(
      "f",
      [ValType.I32, ValType.I32],
      [ValType.I32],
      makeBlock([
        makeLocalSet(2, makeLocalGet(1, ValType.I32)),
        makeIf(
          makeLocalGet(0, ValType.I32),
          makeLocalSet(
            1,
            makeBinary(BinaryOp.AddI32, makeLocalGet(1, ValType.I32), makeI32Const(100)),
          ),
          null,
        ),
        makeLocalSet(3, makeLocalGet(1, ValType.I32)),
        makeReturn(makeLocalGet(3, ValType.I32)),
      ], null),
      [{ type: ValType.I32 }, { type: ValType.I32 }],
    )
    .addExport("f", "f")
    .build();

  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 }).add("LocalCSE").run();

  const { instance } = await WebAssembly.instantiate(encodeWasm(mod) as BufferSource);
  const f = instance.exports.f as (cond: number, x: number) => number;
  assertEquals(f(1, 5), 105, "post-if read of local 1 must see the modified value");
  assertEquals(f(0, 5), 5, "when the if does not run, local 1 is unchanged");
});
