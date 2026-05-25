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
 * import { readFile, writeFile } from "node:fs/promises";
 *
 * const bytes = new Uint8Array(await readFile("module.wasm"));
 * const mod = parseWasm(bytes);
 * const reencoded = encodeWasm(mod);
 * await writeFile("module.out.wasm", reencoded);
 * ```
 *
 * In the browser, source bytes via `fetch`:
 * ```ts
 * const bytes = new Uint8Array(await (await fetch("module.wasm")).arrayBuffer());
 * ```
 *
 * @license MIT
 */

export { encodeWasm, WasmEncodeError } from "./wasm-encoder.ts";