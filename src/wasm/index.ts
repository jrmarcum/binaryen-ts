/**
 * @module binaryen-ts/wasm
 *
 * Embedded WASM kernels — Phase 10.
 *
 * This directory holds hand-written `.wat` source files (the canonical kernel
 * sources), their compiled `.wasm` outputs, and the auto-generated `*_bytes.ts`
 * files that embed the bytes as `Uint8Array` constants suitable for import by
 * the runtime ({@link ../wasm-runtime.ts}).
 *
 * Build: `deno run --allow-read --allow-write scripts/gen_demo_bytes.ts`
 *
 * The build pipeline is self-hosted — binaryen-ts' own Phase 1 WAT parser
 * and Phase 3 binary encoder produce the embedded bytes. No external
 * toolchain dependency.
 *
 * @license MIT OR Apache-2.0
 */

export { DEMO_BYTES } from "./demo_bytes.ts";

/**
 * Spec for the Phase 10 demo kernel — three trivial single-op i32 functions.
 *
 * Used by the boundary-cost benchmark and by `tests/wasm/runtime_test.ts` to
 * exercise the {@link ../wasm-runtime.ts | runtime} end-to-end. NOT intended
 * to be wired into any optimisation pass — the per-call boundary cost would
 * regress against the native TypeScript implementation.
 */
export const DEMO_KERNEL_EXPORTS = ["add_i32", "mul_i32", "eq_i32"] as const;
