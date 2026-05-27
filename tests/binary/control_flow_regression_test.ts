/**
 * @module binaryen-ts/tests/binary/control_flow_regression_test
 *
 * Regression tests for the WT-2a binary parser/encoder correctness bugs that
 * caused real-world DWARF wasm (zlib, fannkuch, cubescript, …) to fail
 * `WebAssembly.compile()` after a parse→encode round-trip. Each test crafts a
 * minimal binary exhibiting one bug, round-trips it through `parseWasm` →
 * `encodeWasm`, and asserts the output validates.
 *
 * Bugs covered:
 *  1. Imported-function naming: the parser named imports `$import${n}` but every
 *     reference site (call/export/elem/ref.func) used `$func${globalIndex}`, so
 *     the encoder's index map missed and fell back to index 0 — encoding every
 *     imported-function call against the wrong target/arity.
 *  2. Control-transfer node types: `return` / unconditional `br` / `br_table`
 *     must be `unreachable` (not the value's type / `none`), or a block ending
 *     in one is mistyped and breaks enclosing type-inference.
 *  3. Loop body wrapper block: a multi-expression loop/try_table body is wrapped
 *     in an anonymous block that must (a) NOT reuse the construct's label and
 *     (b) carry the construct's declared result type, so a result-typed loop
 *     whose body exits via a back-edge `br` still validates.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import {
  BinaryOp,
  type CallExpr,
  ExpressionKind,
  makeBinary,
  makeBreak,
  makeI32Const,
  makeReturn,
  makeSwitch,
} from "../../src/ir/expressions.ts";
import { None, Unreachable, ValType } from "../../src/ir/types.ts";

// ---------------------------------------------------------------------------
// Minimal wasm section-builder helpers (unsigned LEB128, length-prefixed)
// ---------------------------------------------------------------------------

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

/** A section: id byte + LEB128 length + body. */
function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}

/** A length-prefixed vector: count + concatenated items. */
function vec(items: number[][]): number[] {
  return [items.length, ...items.flat()];
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const I32 = 0x7f;

function assembleAndValidate(sections: number[][]): Promise<WebAssembly.Module> {
  const bytes = new Uint8Array([...MAGIC, ...sections.flat()]);
  const mod = parseWasm(bytes);
  const reencoded = encodeWasm(mod);
  return WebAssembly.compile(reencoded as BufferSource);
}

// ---------------------------------------------------------------------------
// Bug 1 — imported-function call target naming
// ---------------------------------------------------------------------------

Deno.test("regression: call to imported function resolves to correct index after round-trip", async () => {
  // Two imports of DIFFERENT arity so a fallback-to-index-0 bug surfaces as an
  // arity mismatch:
  //   import #0  "e"."a"  (i32)      -> (i32)
  //   import #1  "e"."b"  (i32 i32)  -> (i32)
  // Defined function (type #1) calls import #1 with two args. Before the fix the
  // call target `$func1` missed the encoder's `$import1`-keyed map, fell back to
  // index 0 (the 1-arg import), and the output failed to validate.
  const types = section(
    1,
    vec([
      [0x60, 0x01, I32, 0x01, I32], // type 0: (i32) -> (i32)
      [0x60, 0x02, I32, I32, 0x01, I32], // type 1: (i32 i32) -> (i32)
    ]),
  );
  const imports = section(
    2,
    vec([
      [0x01, 0x65, 0x01, 0x61, 0x00, 0x00], // "e"."a" func type 0
      [0x01, 0x65, 0x01, 0x62, 0x00, 0x01], // "e"."b" func type 1
    ]),
  );
  const funcs = section(3, vec([[0x01]])); // 1 defined func, type 1
  // body: local.get 0; local.get 1; call 1 (import #1); end
  const code = section(
    10,
    vec([
      [...leb(8), 0x00, 0x20, 0x00, 0x20, 0x01, 0x10, 0x01, 0x0b],
    ]),
  );

  await assembleAndValidate([types, imports, funcs, code]);

  // Also assert the parsed call targets the import by its unified name.
  const bytes = new Uint8Array([...MAGIC, ...[types, imports, funcs, code].flat()]);
  const mod = parseWasm(bytes);
  const call = mod.functions[0].body.kind === ExpressionKind.Call
    ? mod.functions[0].body as CallExpr
    : null;
  assert(call, "function body should be a call");
  assertEquals(call!.target, "$func1");
  assertEquals(call!.operands.length, 2);
  // The import the call points at must itself be the 2-arg import.
  const target = mod.imports.find((i) => i.kind === "function" && i.name === "$func1");
  assert(target, "import named $func1 must exist (unified naming)");
});

// ---------------------------------------------------------------------------
// Bug 3 — result-typed loop whose body exits via a back-edge br
// ---------------------------------------------------------------------------

Deno.test("regression: loop (result i32) with multi-expr body exiting via back-edge br validates", async () => {
  // (func (result i32)
  //   (loop $l (result i32)        ;; multi-expr body, last is `br $l`
  //     (drop (i32.const 1))       ;; makes the body multi-expression -> wrapper
  //     (br $l)))                  ;; back-edge: loop end is unreachable
  // The function returns i32 via the loop's declared result; the loop never
  // actually falls through (infinite), so validity rests entirely on the
  // wrapper block carrying the result type and the back-edge br being
  // unreachable.
  const types = section(1, vec([[0x60, 0x00, 0x01, I32]])); // () -> (i32)
  const funcs = section(3, vec([[0x00]]));
  // body: loop (result i32) { i32.const 1; drop; br 0 } end
  const body = [
    0x03,
    I32, // loop, blocktype i32
    0x41,
    0x01, // i32.const 1
    0x1a, // drop  -> makes body multi-expression
    0x0c,
    0x00, // br 0 (back-edge to loop)
    0x0b, // end loop
    0x0b, // end func
  ];
  const code = section(10, vec([[...leb(body.length + 1), 0x00, ...body]]));

  await assembleAndValidate([types, funcs, code]);
});

// ---------------------------------------------------------------------------
// Bug 2 — void block ending in `return` inside a value-returning function
// ---------------------------------------------------------------------------

Deno.test("regression: void block ending in return inside i32 function validates", async () => {
  // (func (result i32)
  //   (block            ;; VOID block whose body exits via return
  //     (i32.const 1)
  //     (return))
  //   (i32.const 0))    ;; the real fallthrough result
  // With `makeReturn` typed as the value's type (i32), `makeBlock` inferred the
  // void block as i32; the encoder then declared an i32 blocktype, so the block
  // yielded a value the following `i32.const 0` stacked on top of — re-encode
  // produced "expected 1, found 2". Typed `unreachable`, the block correctly
  // yields nothing and the function returns the trailing const.
  const types = section(1, vec([[0x60, 0x00, 0x01, I32]])); // () -> (i32)
  const funcs = section(3, vec([[0x00]]));
  const body = [
    0x02,
    0x40, // block, blocktype void
    0x41,
    0x01, // i32.const 1
    0x0f, // return (consumes the i32 as the function result)
    0x0b, // end block
    0x41,
    0x00, // i32.const 0 (fallthrough result)
    0x0b, // end func
  ];
  const code = section(10, vec([[...leb(body.length + 1), 0x00, ...body]]));

  await assembleAndValidate([types, funcs, code]);
});

// ---------------------------------------------------------------------------
// Control-transfer node type invariants (unit-level pins for bugs 2 & 3)
// ---------------------------------------------------------------------------

Deno.test("makeReturn is always typed unreachable", () => {
  assertEquals(makeReturn(makeI32Const(1)).type, Unreachable);
  assertEquals(makeReturn(null).type, Unreachable);
});

Deno.test("makeBreak: unconditional br is unreachable; br_if follows fallthrough", () => {
  // Unconditional br always transfers control -> unreachable.
  assertEquals(makeBreak("$l").type, Unreachable);
  // Conditional br_if without value falls through with nothing -> none.
  assertEquals(makeBreak("$l", makeI32Const(1)).type, None);
  // Conditional br_if with value passes the value through on fallthrough.
  assertEquals(makeBreak("$l", makeI32Const(1), makeI32Const(2)).type, ValType.I32);
});

Deno.test("makeSwitch (br_table) is always unreachable", () => {
  assertEquals(makeSwitch(["$a", "$b"], "$d", makeI32Const(0)).type, Unreachable);
  assertEquals(
    makeSwitch(
      ["$a"],
      "$d",
      makeI32Const(0),
      makeBinary(BinaryOp.AddI32, makeI32Const(1), makeI32Const(2)),
    ).type,
    Unreachable,
  );
});
