/**
 * @module binaryen-ts/wasm-runtime
 *
 * WASM-kernel runtime — Phase 10 infrastructure.
 *
 * Provides lazy instantiation and a cached call surface for kernels embedded
 * as `Uint8Array` constants under {@link ./wasm/}. The runtime is intentionally
 * generic: a kernel is described by a `WasmKernelSpec` (bytes + export name
 * list), and {@link loadKernel} returns a typed call surface backed by a
 * cached `WebAssembly.Instance`.
 *
 * ## Why this exists
 *
 * The pass infrastructure (`src/passes/pass.ts`) documents three optimisation
 * tiers: pure TypeScript, `wasic`-compiled TypeScript, and the upstream
 * `binaryen.js` WASM. This runtime is the bridge for the middle tier — it
 * decouples kernel embedding from kernel call sites so individual passes
 * never need to know how a kernel was produced.
 *
 * ## When to use it
 *
 * WASM call overhead is roughly two orders of magnitude greater than a native
 * JS arithmetic op (~100 ns vs ~1–5 ns). A kernel only earns its boundary
 * cost when each call performs **substantial** work — large loops, table
 * lookups against module-resident data, batched operations over linear
 * memory. Single-op kernels regress.
 *
 * See `benches/wasm_dispatch_bench.ts` for the boundary-cost measurement and
 * `CLAUDE.md` § "Phase 10 — WASM kernel runtime" for the kernel-selection
 * criteria.
 *
 * @example
 * ```ts
 * import { loadKernel } from "@jrmarcum/binaryen-ts/wasm-runtime";
 * import { DEMO_BYTES } from "@jrmarcum/binaryen-ts/wasm/demo_bytes";
 *
 * const demo = await loadKernel({
 *   name: "demo",
 *   bytes: DEMO_BYTES,
 *   exports: ["add_i32", "mul_i32", "eq_i32"] as const,
 * });
 * demo.exports.add_i32(3, 4); // 7
 * ```
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Spec and result types
// ---------------------------------------------------------------------------

/**
 * Description of a WASM kernel to load via {@link loadKernel}.
 *
 * @typeParam Exports - Tuple of export names the kernel exposes; the resulting
 *   {@link WasmKernel.exports} object is keyed by these names.
 */
export interface WasmKernelSpec<Exports extends readonly string[]> {
  /**
   * Stable identifier used as the cache key. Two `loadKernel` calls with the
   * same `name` return the same instance — the underlying `WebAssembly.Module`
   * is compiled once per process.
   */
  readonly name: string;

  /** Raw WASM bytes (typically imported from an auto-generated `*_bytes.ts`). */
  readonly bytes: Uint8Array;

  /**
   * List of expected exports. The runtime validates that every name is present
   * on the instantiated module and that each export is a callable function.
   */
  readonly exports: Exports;

  /**
   * Optional imports object passed to `WebAssembly.instantiate`. Trivial
   * kernels (the demo, future pure-numeric folders) take no imports; richer
   * kernels may import a `memory` or host helpers.
   */
  readonly imports?: WebAssembly.Imports;
}

/**
 * The loaded kernel, with a typed `exports` map.
 *
 * Every name listed in `WasmKernelSpec.exports` is reflected as a callable
 * `WebAssembly.ExportValue` on this object. Unknown names are a load-time
 * error so call sites need no defensive checks.
 */
export interface WasmKernel<Exports extends readonly string[]> {
  /** Cache key matching the spec's `name`. */
  readonly name: string;

  /** The underlying WebAssembly instance — escape hatch for `memory` access. */
  readonly instance: WebAssembly.Instance;

  /**
   * Typed export map. Each property is a function whose signature is dictated
   * by the underlying WASM signature — TypeScript cannot infer arg/return
   * types from the bytes, so calls return `unknown` and require a local cast
   * at the call site (or a kernel-specific wrapper module).
   */
  readonly exports: { readonly [K in Exports[number]]: WebAssembly.ExportValue };
}

// ---------------------------------------------------------------------------
// Module + instance cache
// ---------------------------------------------------------------------------

const _moduleCache = new Map<string, WebAssembly.Module>();
const _kernelCache = new Map<string, WasmKernel<readonly string[]>>();

/**
 * Loads (or returns the cached) kernel for the given spec.
 *
 * The first call for a given `name` compiles the bytes with
 * `WebAssembly.compile`, instantiates with the supplied imports, validates
 * exports, and caches the result. Subsequent calls return the cached kernel
 * without recompiling.
 *
 * @throws If compilation fails, instantiation throws, or any expected export
 *   is missing / not callable.
 */
export async function loadKernel<Exports extends readonly string[]>(
  spec: WasmKernelSpec<Exports>,
): Promise<WasmKernel<Exports>> {
  const cached = _kernelCache.get(spec.name) as WasmKernel<Exports> | undefined;
  if (cached) return cached;

  let mod = _moduleCache.get(spec.name);
  if (!mod) {
    mod = await WebAssembly.compile(spec.bytes as BufferSource);
    _moduleCache.set(spec.name, mod);
  }

  const instance = await WebAssembly.instantiate(mod, spec.imports);
  const exportsObj = instance.exports as Record<string, WebAssembly.ExportValue>;

  const typed: Record<string, WebAssembly.ExportValue> = {};
  for (const name of spec.exports) {
    const e = exportsObj[name];
    if (e === undefined) {
      throw new WasmRuntimeError(
        `kernel "${spec.name}" missing required export "${name}"`,
      );
    }
    if (typeof e !== "function") {
      throw new WasmRuntimeError(
        `kernel "${spec.name}" export "${name}" is not a function ` +
          `(got ${typeof e})`,
      );
    }
    typed[name] = e;
  }

  const kernel: WasmKernel<Exports> = {
    name: spec.name,
    instance,
    exports: typed as WasmKernel<Exports>["exports"],
  };
  _kernelCache.set(spec.name, kernel);
  return kernel;
}

/**
 * Removes the cached compilation and instance for `name`. The next
 * {@link loadKernel} call for that name will recompile from bytes.
 *
 * Exposed for tests and for the rare case where a kernel's imports must
 * change at runtime.
 */
export function clearKernelCache(name?: string): void {
  if (name === undefined) {
    _moduleCache.clear();
    _kernelCache.clear();
    return;
  }
  _moduleCache.delete(name);
  _kernelCache.delete(name);
}

/** Returns the names of all currently cached kernels (debug/test helper). */
export function listLoadedKernels(): string[] {
  return [..._kernelCache.keys()];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a kernel cannot be loaded or fails an export check. */
export class WasmRuntimeError extends Error {
  /** Always `"WasmRuntimeError"` — identifies the error class for `instanceof`-free dispatch. */
  override readonly name = "WasmRuntimeError";
}
