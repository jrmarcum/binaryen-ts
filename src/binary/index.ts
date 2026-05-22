/**
 * @module binaryen-ts/binary
 *
 * WASM binary format parser (Phase 2).
 *
 * Parses a WebAssembly binary (`Uint8Array`) into a {@link WasmModule} IR tree.
 *
 * @example
 * ```ts
 * import { parseWasm } from "@jrmarcum/binaryen-ts/binary";
 *
 * const bytes = await Deno.readFile("module.wasm");
 * const mod = parseWasm(bytes, "module.wasm");
 * console.log(mod.functions.length);
 * ```
 *
 * @license MIT OR Apache-2.0
 */

export { parseWasm, WasmBinaryError } from "./wasm-parser.ts";
export { BinaryReader } from "./reader.ts";
