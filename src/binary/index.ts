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
 * import { readFile } from "node:fs/promises";
 *
 * const bytes = new Uint8Array(await readFile("module.wasm"));
 * const mod = parseWasm(bytes, "module.wasm");
 * console.log(mod.functions.length);
 * ```
 *
 * In the browser, source bytes via `fetch`:
 * ```ts
 * const bytes = new Uint8Array(await (await fetch("module.wasm")).arrayBuffer());
 * const mod = parseWasm(bytes);
 * ```
 *
 * @license MIT OR Apache-2.0
 */

export { parseWasm, WasmBinaryError } from "./wasm-parser.ts";
export { BinaryReader } from "./reader.ts";
