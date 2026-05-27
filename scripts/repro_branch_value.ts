/**
 * @module scripts/repro_branch_value
 *
 * Hypothesis: our encoder mis-emits `br` instructions to value-typed
 * blocks, dropping the value-providing expression. This reproducer:
 * (a) builds an IR with the pattern `(block (result i32) (i32.const X) (br $L))`
 *     directly, encodes it, and tries to validate.
 * (b) also tries the same pattern via WAT parser, encoder, and validator.
 *
 * Both should produce valid wasm. If they don't, the encoder is the bug.
 * If they do, the bug is in the binary parser (since binary-parse of
 * fannkuch0_dwarf.wasm followed by encode breaks).
 *
 * Run:
 *   deno run --allow-read scripts/repro_branch_value.ts
 *
 * @license MIT
 */

import { ModuleBuilder } from "../src/ir/module.ts";
import { ValType } from "../src/ir/types.ts";
import { makeBlock, makeBreak, makeI32Const } from "../src/ir/expressions.ts";
import { encodeWasm } from "../src/encoder/wasm-encoder.ts";
import { parseWat } from "../src/parser/wat-parser.ts";
import { parseWasm } from "../src/binary/wasm-parser.ts";

async function validates(bytes: Uint8Array): Promise<{ ok: boolean; err?: string }> {
  try {
    await WebAssembly.compile(bytes as BufferSource);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// (a) Hand-built IR
// ---------------------------------------------------------------------------

console.log("## (a) hand-built IR: (block (result i32) (br $L (i32.const 42)))");

const body = makeBlock(
  [
    // makeBreak(name, condition, value) — value is 3rd arg
    makeBreak("$L", /* condition */ null, /* value */ makeI32Const(42)),
  ],
  "$L",
);
// The block needs a result type — manually set it
body.type = ValType.I32;

const mod = new ModuleBuilder()
  .addFunction("test", [], [ValType.I32], body)
  .addExport("test", "test")
  .build();

const bytes = encodeWasm(mod);
console.log(`  encoded ${bytes.byteLength} bytes`);
const v1 = await validates(bytes);
console.log(`  validates? ${v1.ok ? "YES" : "NO"} ${v1.err?.slice(0, 200) ?? ""}`);

// ---------------------------------------------------------------------------
// (a2) bytes from (a) → binary-parse → re-encode → validate
// (this is the wasmtk-relevant path)
// ---------------------------------------------------------------------------

console.log();
console.log("## (a2) BINARY round-trip of the validated bytes from (a)");
const reMod = parseWasm(bytes);
const reBytes = encodeWasm(reMod);
console.log(`  re-encoded ${reBytes.byteLength} bytes`);
const v1b = await validates(reBytes);
console.log(`  validates? ${v1b.ok ? "YES" : "NO"} ${v1b.err?.slice(0, 200) ?? ""}`);

// ---------------------------------------------------------------------------
// (b) WAT-parsed then encoded
// ---------------------------------------------------------------------------

console.log();
console.log("## (b) WAT-parsed: (block (result i32) (br $L (i32.const 42)))");

const wat = `
(module
  (func (export "test") (result i32)
    (block $L (result i32)
      (br $L (i32.const 42))
    )
  )
)
`;
const watMod = parseWat(wat);
const watBytes = encodeWasm(watMod);
console.log(`  encoded ${watBytes.byteLength} bytes`);
const v2 = await validates(watBytes);
console.log(`  validates? ${v2.ok ? "YES" : "NO"} ${v2.err?.slice(0, 200) ?? ""}`);

// ---------------------------------------------------------------------------
// (c) WAT-parsed, encoded, then re-parsed as binary, then re-encoded
// ---------------------------------------------------------------------------

console.log();
console.log("## (c) WAT → encode → binary-parse → re-encode (full round-trip)");

const rebornMod = parseWasm(watBytes);
const rebornBytes = encodeWasm(rebornMod);
console.log(`  re-encoded ${rebornBytes.byteLength} bytes`);
const v3 = await validates(rebornBytes);
console.log(`  validates? ${v3.ok ? "YES" : "NO"} ${v3.err?.slice(0, 200) ?? ""}`);

// ---------------------------------------------------------------------------
// (d) variant: value not in br but as preceding instruction (stacky form)
// ---------------------------------------------------------------------------

console.log();
console.log("## (d) stacky-form WAT: i32.const then br (value comes from stack)");

const watStacky = `
(module
  (func (export "test") (result i32)
    (block $L (result i32)
      i32.const 42
      br $L
    )
  )
)
`;
const stackyMod = parseWat(watStacky);
const stackyBytes = encodeWasm(stackyMod);
console.log(`  encoded ${stackyBytes.byteLength} bytes`);
const v4 = await validates(stackyBytes);
console.log(`  validates? ${v4.ok ? "YES" : "NO"} ${v4.err?.slice(0, 200) ?? ""}`);

console.log();
console.log("## (e) stacky form (d) → encode → binary-parse → re-encode");
const stackyReborn = parseWasm(stackyBytes);
const stackyRebornBytes = encodeWasm(stackyReborn);
const v5 = await validates(stackyRebornBytes);
console.log(`  re-encoded ${stackyRebornBytes.byteLength} bytes`);
console.log(`  validates? ${v5.ok ? "YES" : "NO"} ${v5.err?.slice(0, 200) ?? ""}`);
