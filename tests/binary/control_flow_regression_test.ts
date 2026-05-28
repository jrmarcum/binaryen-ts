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
  type BlockExpr,
  type CallExpr,
  ExpressionKind,
  makeBinary,
  makeBreak,
  makeI32Const,
  makeIf,
  makeNop,
  makeReturn,
  makeSwitch,
} from "../../src/ir/expressions.ts";
import { None, Unreachable, ValType } from "../../src/ir/types.ts";
import { createPass, PassRunner } from "../../src/passes/pass.ts";
import "../../src/passes/index.ts"; // side-effect: register built-in passes

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

// ---------------------------------------------------------------------------
// WT-2c — bugs the behavioral-equivalence harness surfaced
// ---------------------------------------------------------------------------

Deno.test("makeIf type is the reachable arm's type (LUB), not blindly the then-arm's", () => {
  // then unreachable (ends in return), else falls through (none) -> if is none.
  // The old code took ifTrue.type (unreachable), which made DCE delete the live
  // code after such an `if` (silently breaking loops — `_fib` returned 0).
  assertEquals(makeIf(makeI32Const(1), makeReturn(makeI32Const(1)), makeNop()).type, None);
  // then concrete, else unreachable -> take the then (i32).
  assertEquals(
    makeIf(makeI32Const(1), makeI32Const(7), makeReturn(makeI32Const(1))).type,
    ValType.I32,
  );
  // both arms concrete & equal -> that type.
  assertEquals(makeIf(makeI32Const(1), makeI32Const(7), makeI32Const(8)).type, ValType.I32);
  // no else -> none (the then may be skipped).
  assertEquals(makeIf(makeI32Const(1), makeReturn(makeI32Const(1))).type, None);
});

Deno.test("regression: element segments + call_indirect survive round-trip and execute", async () => {
  // (type $t () -> i32)
  // (table 1 funcref) (elem (i32.const 0) $target)
  // (func $target (result i32) (i32.const 42))
  // (func $run (result i32) (call_indirect $t (i32.const 0)))
  // The parser previously parsed the element segment then THREW IT AWAY
  // (`void seg`), so the table was never initialized and call_indirect trapped.
  const types = section(1, vec([[0x60, 0x00, 0x01, I32]])); // type 0: () -> i32
  const funcs = section(3, vec([[0x00], [0x00]])); // 2 funcs, both type 0
  const table = section(4, vec([[0x70, 0x00, 0x01]])); // 1 table: funcref, min 1
  const exports = section(7, vec([[0x03, 0x72, 0x75, 0x6e, 0x00, 0x01]])); // "run" -> func 1
  // element segment: flags 0, offset (i32.const 0), funcs [0]
  const elem = section(9, vec([[0x00, 0x41, 0x00, 0x0b, 0x01, 0x00]]));
  const code = section(
    10,
    vec([
      [...leb(4), 0x00, 0x41, 0x2a, 0x0b], // func0: i32.const 42; end
      [...leb(7), 0x00, 0x41, 0x00, 0x11, 0x00, 0x00, 0x0b], // func1: i32.const 0; call_indirect type0 table0; end
    ]),
  );

  const mod = parseWasm(
    new Uint8Array([...MAGIC, ...[types, funcs, table, exports, elem, code].flat()]),
  );
  // The parsed module must retain the element segment.
  assertEquals(mod.elements.length, 1);

  const reencoded = encodeWasm(mod);
  const compiled = await WebAssembly.compile(reencoded as BufferSource);
  const inst = new WebAssembly.Instance(compiled);
  // The indirect call through table[0] must reach $target and return 42.
  assertEquals((inst.exports.run as () => number)(), 42);
});

Deno.test("regression: LocalCSE preserves a result-typed block that exits via br", async () => {
  // (func (param i32) (result i32)
  //   (block $b (result i32)
  //     (drop (i32.add (local.get 0) (local.get 0)))   ;; CSE occurrence 1
  //     (drop (i32.add (local.get 0) (local.get 0)))   ;; CSE occurrence 2 -> candidate
  //     (br $b (i32.const 5))))                          ;; tail br: block end unreachable
  // LocalCSE rewrites the repeated add; it used to then recompute the block type
  // from the last child (the `br`, now `unreachable`), clobbering the declared
  // `i32` and producing "expected 1 for fallthru, found 0".
  const types = section(1, vec([[0x60, 0x01, I32, 0x01, I32]])); // (i32) -> (i32)
  const funcs = section(3, vec([[0x00]]));
  const addLG = [0x20, 0x00, 0x20, 0x00, 0x6a]; // local.get 0; local.get 0; i32.add
  const body = [
    0x02,
    I32, // block (result i32)
    ...addLG,
    0x1a, // drop
    ...addLG,
    0x1a, // drop
    0x41,
    0x05,
    0x0c,
    0x00, // i32.const 5; br 0 (carries the block result)
    0x0b, // end block
    0x0b, // end func
  ];
  const code = section(10, vec([[...leb(body.length + 1), 0x00, ...body]]));

  const mod = parseWasm(new Uint8Array([...MAGIC, ...[types, funcs, code].flat()]));
  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 0 }).addPass(createPass("LocalCSE")).run();

  // The body IS the `(result i32)` block (single-expression body, unwrapped).
  // Its declared type must survive LocalCSE as i32 — not be clobbered to the
  // tail `br`'s `unreachable`.
  const fnBody = mod.functions[0].body as BlockExpr;
  assert(fnBody.kind === ExpressionKind.Block, "body should be a block");
  assertEquals(fnBody.type, ValType.I32);

  // And the encoded result must validate (this is what threw before the fix).
  await WebAssembly.compile(encodeWasm(mod) as BufferSource);
});

Deno.test("regression: CoalesceLocals preserves effective sets when remapping locals", () => {
  // (func (param i32) (result i32)
  //   (local i32 i32)
  //   (local.set 1 (i32.const 7))     ;; $1 = 7
  //   (drop (local.get 1))             ;; consume $1
  //   (local.set 2 (i32.const 42))    ;; $2 = 42
  //   (local.get 2))                    ;; return $2 — expect 42
  // $1 and $2 don't interfere → CoalesceLocals merges them into one slot.
  // Before the identity-preservation fix, `mapExpression`'s unconditional
  // spread rebuilt every parent on the path of a renamed `local.get`, so
  // `effectiveSet.has(spreadCopy)` was always false in the rewrite callback
  // and every `local.set` came out as `drop` — the function returned 0 (the
  // uninitialized slot).
  const types = section(1, vec([[0x60, 0x01, I32, 0x01, I32]]));
  const funcs = section(3, vec([[0x00]]));
  const exports = section(7, vec([[0x03, 0x72, 0x75, 0x6e, 0x00, 0x00]])); // "run" -> fn 0
  const body = [
    0x01,
    0x02,
    I32, // 1 group of 2 i32 locals
    0x41,
    0x07,
    0x21,
    0x01, // i32.const 7; local.set 1
    0x20,
    0x01,
    0x1a, // local.get 1; drop
    0x41,
    0x2a,
    0x21,
    0x02, // i32.const 42; local.set 2
    0x20,
    0x02, // local.get 2
    0x0b, // end
  ];
  const code = section(10, vec([[...leb(body.length), ...body]]));

  const mod = parseWasm(new Uint8Array([...MAGIC, ...[types, funcs, exports, code].flat()]));
  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 0 })
    .addPass(createPass("CoalesceLocals"))
    .run();
  const inst = new WebAssembly.Instance(
    new WebAssembly.Module(encodeWasm(mod) as BufferSource),
  );
  const run = inst.exports.run as (n: number) => number;
  assertEquals(run(0), 42);
});

Deno.test("regression: LocalCSE invalidates cache after a child that writes the cached local", () => {
  // (func (param i32) (result i32)
  //   (local i32 i32)
  //   (local.set 1 (local.get 0))                            ;; $1 = $0
  //   (local.set 1 (i32.add (local.get 1) (i32.const 1)))   ;; $1 = $1 + 1
  //   (local.set 2 (i32.add (local.get 1) (i32.const 10)))  ;; $2 = NEW $1 + 10
  //   (local.get 2))                                          ;; return $2
  // For input 5 the right answer is 5+1+10 = 16. Before the post-invalidate
  // fix, LocalCSE wrapped the first `(local.get 1)` in a tee that captured
  // the PRE-set-1 value, then substituted the second `(local.get 1)` with
  // the tee's local — silently reading the old value across the intervening
  // `local.set 1` and producing 15. (Same root cause as `_fib(7)=fib(8)=34`
  // observed in `-Oz` on the corpus.)
  const types = section(1, vec([[0x60, 0x01, I32, 0x01, I32]]));
  const funcs = section(3, vec([[0x00]]));
  const exports = section(7, vec([[0x03, 0x72, 0x75, 0x6e, 0x00, 0x00]]));
  const body = [
    0x01,
    0x02,
    I32, // 1 group of 2 i32 locals
    0x20,
    0x00,
    0x21,
    0x01, // local.get 0; local.set 1
    0x20,
    0x01,
    0x41,
    0x01,
    0x6a,
    0x21,
    0x01, // lg1; const 1; add; set 1
    0x20,
    0x01,
    0x41,
    0x0a,
    0x6a,
    0x21,
    0x02, // lg1; const 10; add; set 2
    0x20,
    0x02, // local.get 2
    0x0b, // end
  ];
  const code = section(10, vec([[...leb(body.length), ...body]]));

  const mod = parseWasm(new Uint8Array([...MAGIC, ...[types, funcs, exports, code].flat()]));
  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 0 })
    .addPass(createPass("LocalCSE"))
    .run();
  const inst = new WebAssembly.Instance(
    new WebAssembly.Module(encodeWasm(mod) as BufferSource),
  );
  const run = inst.exports.run as (n: number) => number;
  assertEquals(run(5), 16);
});

Deno.test("regression: single-arm (if cond (then BODY)) round-trips without inverting the test", () => {
  // (func (export "f") (param i32) (result i32)
  //   (if (local.get 0)
  //     (then (i32.store (i32.const 0) (i32.const 0xAA))))
  //   (i32.load (i32.const 0)))
  // Expected: f(0) = 0 (store skipped), f(1) = 0xAA (store fired).
  //
  // Before the fix, a single-arm `if` (no else opcode 0x05 seen) left
  // `frame.kind === "if"` and `frame.thenExprs === []`; the end-of-frame
  // handler then unified the two cases with `thenBlock = frame.thenExprs ?? []`
  // — which put the BODY (accumulated in `frame.exprs`) in the ELSE arm. The
  // round-tripped module evaluated the store when cond was FALSE — inverting
  // every wasic-emitted break condition, bounds check, and null guard.
  // (Reported by the wasmtk team as the root cause of 4 phase-11/12/13 test
  // failures.)
  const types = section(1, vec([[0x60, 0x01, I32, 0x01, I32]])); // (i32)->(i32)
  const funcs = section(3, vec([[0x00]]));
  const mems = section(5, vec([[0x00, 0x01]])); // 1 memory, no max, initial 1 page
  const exportsSec = section(
    7,
    vec([
      [0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00], // "memory" -> mem 0
      [0x01, 0x66, 0x00, 0x00], // "f" -> func 0
    ]),
  );
  const body = [
    0x00, // 0 local groups
    0x20,
    0x00, // local.get 0
    0x04,
    0x40, // if, blocktype void
    0x41,
    0x00, // i32.const 0   (store address)
    0x41,
    0xaa,
    0x01, // i32.const 0xAA (170, signed LEB128)
    0x36,
    0x02,
    0x00, // i32.store align=2 offset=0
    0x0b, // end if (no else opcode — single-arm if)
    0x41,
    0x00, // i32.const 0
    0x28,
    0x02,
    0x00, // i32.load align=2 offset=0
    0x0b, // end func
  ];
  const code = section(10, vec([[...leb(body.length), ...body]]));

  const orig = new Uint8Array([
    ...MAGIC,
    ...[types, funcs, mems, exportsSec, code].flat(),
  ]);

  // The round-tripped output must validate AND behave identically to the
  // original on both cond=0 and cond=1.
  const reEncoded = encodeWasm(parseWasm(orig));

  const origInst = new WebAssembly.Instance(new WebAssembly.Module(orig as BufferSource));
  const rtInst = new WebAssembly.Instance(new WebAssembly.Module(reEncoded as BufferSource));
  const origF = origInst.exports.f as (cond: number) => number;
  const rtF = rtInst.exports.f as (cond: number) => number;

  // Sanity-check the original behaves as the spec says.
  assertEquals(origF(0), 0, "original: cond=0 should skip the store");
  assertEquals(origF(1), 0xaa, "original: cond=1 should fire the store");

  // The round-tripped module must agree on BOTH branches.
  assertEquals(rtF(0), 0, "round-trip: cond=0 must skip the store (not invert)");
  assertEquals(rtF(1), 0xaa, "round-trip: cond=1 must fire the store");
});

Deno.test("regression: tag exports + signature survive parse→encode and RemoveUnusedModuleElements", () => {
  // Mirrors the wasmtk team's bug report: an EH tag exported by name, alongside
  // multiple type-section entries of varying arity, must round-trip with its
  // export AND its `(param ...)` signature intact.
  //
  //   (module
  //     (type $a (func (param i32) (result i32)))   ;; unused
  //     (type $b (func (param f32) (result f64)))   ;; unused
  //     (type $c (func (param i32 i32)))             ;; tag signature
  //     (type $d (func))                              ;; "thrower" signature
  //     (tag $exn (export "exn") (param i32 i32))
  //     (func (export "thrower")
  //       (i32.const 1) (i32.const 2) (throw $exn)))
  //
  // Before the fix:
  //   * `readExportSection` had no `case 0x04` (tag) — the `(export "exn"
  //     (tag $exn))` was silently dropped at parse time.
  //   * `encodeExportSection` had no `case "tag"` — a programmatically-added
  //     tag export would fall through the switch and corrupt the export
  //     section bytestream.
  const types = section(
    1,
    vec([
      [0x60, 0x01, I32, 0x01, I32], // type 0 = $a: (i32) -> (i32)
      [0x60, 0x01, 0x7d, 0x01, 0x7c], // type 1 = $b: (f32) -> (f64)
      [0x60, 0x02, I32, I32, 0x00], // type 2 = $c: (i32 i32) -> ()
      [0x60, 0x00, 0x00], // type 3 = $d: () -> ()
    ]),
  );
  const funcs = section(3, vec([[0x03]])); // 1 func, type 3
  const exportsSec = section(
    7,
    vec([
      [0x03, 0x65, 0x78, 0x6e, 0x04, 0x00], // "exn" -> tag 0  (kind 0x04)
      [0x07, 0x74, 0x68, 0x72, 0x6f, 0x77, 0x65, 0x72, 0x00, 0x00], // "thrower" -> func 0
    ]),
  );
  const tagSec = section(13, vec([[0x00, 0x02]])); // 1 tag, attr=0, typeIdx=2
  const body = [
    0x00, // 0 local groups
    0x41,
    0x01, // i32.const 1
    0x41,
    0x02, // i32.const 2
    0x08,
    0x00, // throw $exn (tag 0)
    0x0b, // end func
  ];
  const code = section(10, vec([[...leb(body.length), ...body]]));

  const bytes = new Uint8Array([
    ...MAGIC,
    ...[types, funcs, exportsSec, tagSec, code].flat(),
  ]);

  // After parse, both the tag with its signature AND the tag export must
  // survive — the tag must still hold `(param i32 i32)`.
  const mod = parseWasm(bytes);
  assertEquals(mod.tags.length, 1);
  assertEquals(mod.tags[0].params, [ValType.I32, ValType.I32]);
  const tagExport = mod.exports.find((e) => e.kind === "tag");
  assert(tagExport, "tag export must survive parse");
  assertEquals(tagExport!.name, "exn");

  // RemoveUnusedModuleElements must not damage the tag.
  new PassRunner(mod, { optimizeLevel: 0, shrinkLevel: 1 })
    .addPass(createPass("RemoveUnusedModuleElements"))
    .run();
  assertEquals(mod.tags.length, 1);
  assertEquals(mod.tags[0].params, [ValType.I32, ValType.I32]);
  const tagExport2 = mod.exports.find((e) => e.kind === "tag");
  assert(tagExport2, "tag export must survive RemoveUnusedModuleElements");

  // Encode → reparse must preserve everything.
  const reEncoded = encodeWasm(mod);
  const mod2 = parseWasm(reEncoded);
  assertEquals(mod2.tags.length, 1);
  assertEquals(mod2.tags[0].params, [ValType.I32, ValType.I32]);
  const tagExport3 = mod2.exports.find((e) => e.kind === "tag");
  assert(tagExport3, "tag export must survive encode→reparse");
  assertEquals(tagExport3!.name, "exn");
});
