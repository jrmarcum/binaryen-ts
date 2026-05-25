/**
 * @module binaryen-ts/tests/wasm/runtime_test
 *
 * Tests for the Phase 10 WASM-kernel runtime.
 *
 * Coverage:
 * - End-to-end load + call against the dogfood-built `demo.wasm`
 * - Call-result parity with native TypeScript (the kernel exists only so we
 *   can prove the runtime works against bytes binaryen-ts compiled itself)
 * - Cache hit identity (second load returns the same instance object)
 * - `clearKernelCache` invalidation
 * - Missing-export error path
 *
 * @license MIT
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert";

import { DEMO_BYTES, DEMO_KERNEL_EXPORTS } from "../../src/wasm/index.ts";
import {
  clearKernelCache,
  listLoadedKernels,
  loadKernel,
  WasmRuntimeError,
} from "../../src/wasm-runtime.ts";

const KERNEL_NAME = "demo-runtime-test";

function freshSpec(): {
  name: string;
  bytes: Uint8Array;
  exports: typeof DEMO_KERNEL_EXPORTS;
} {
  return { name: KERNEL_NAME, bytes: DEMO_BYTES, exports: DEMO_KERNEL_EXPORTS };
}

Deno.test("wasm-runtime: loads demo kernel and call results match native", async () => {
  clearKernelCache(KERNEL_NAME);
  const kernel = await loadKernel(freshSpec());

  const add = kernel.exports.add_i32 as (a: number, b: number) => number;
  const mul = kernel.exports.mul_i32 as (a: number, b: number) => number;
  const eq = kernel.exports.eq_i32 as (a: number, b: number) => number;

  assertEquals(add(3, 4), 7);
  assertEquals(add(-1, 1), 0);
  assertEquals(mul(6, 7), 42);
  assertEquals(eq(5, 5), 1);
  assertEquals(eq(5, 6), 0);

  clearKernelCache(KERNEL_NAME);
});

Deno.test("wasm-runtime: second loadKernel returns cached instance", async () => {
  clearKernelCache(KERNEL_NAME);
  const a = await loadKernel(freshSpec());
  const b = await loadKernel(freshSpec());
  assertStrictEquals(a, b, "cached loadKernel must return the same object");
  assertStrictEquals(a.instance, b.instance, "underlying instance must be reused");
  clearKernelCache(KERNEL_NAME);
});

Deno.test("wasm-runtime: clearKernelCache reinstantiates", async () => {
  clearKernelCache(KERNEL_NAME);
  const first = await loadKernel(freshSpec());
  clearKernelCache(KERNEL_NAME);
  const second = await loadKernel(freshSpec());
  assertNotEquals(
    first.instance,
    second.instance,
    "clearKernelCache must drop the instance",
  );
  clearKernelCache(KERNEL_NAME);
});

Deno.test("wasm-runtime: missing export throws WasmRuntimeError", async () => {
  clearKernelCache(KERNEL_NAME);
  await assertRejects(
    () =>
      loadKernel({
        name: KERNEL_NAME,
        bytes: DEMO_BYTES,
        exports: ["add_i32", "this_export_does_not_exist"] as const,
      }),
    WasmRuntimeError,
    "missing required export",
  );
  clearKernelCache(KERNEL_NAME);
});

Deno.test("wasm-runtime: listLoadedKernels reports cached names", async () => {
  clearKernelCache();
  assertEquals(listLoadedKernels(), []);
  await loadKernel(freshSpec());
  assert(listLoadedKernels().includes(KERNEL_NAME));
  clearKernelCache(KERNEL_NAME);
  assert(!listLoadedKernels().includes(KERNEL_NAME));
});
