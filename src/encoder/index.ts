/**
 * @module binaryen-ts/encoder
 *
 * WASM binary encoder (Phase 3).
 *
 * Serializes a {@link WasmModule} IR tree into a WebAssembly binary (`Uint8Array`).
 * This is the inverse operation of the Phase 2 binary parser.
 *
 * @example
 * ```ts
 * import { encodeWasm } from "@jrmarcum/binaryen-ts/encoder";
 * import { parseWasm } from "@jrmarcum/binaryen-ts/binary";
 *
 * const bytes = await Deno.readFile("module.wasm");
 * const mod = parseWasm(bytes);
 * const reencoded = encodeWasm(mod);
 * await Deno.writeFile("module.out.wasm", reencoded);
 * ```
 *
 * @license MIT OR Apache-2.0
 */

export { encodeWasm, WasmEncodeError } from "./wasm-encoder.ts";