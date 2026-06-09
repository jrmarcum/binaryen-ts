/**
 * @module binaryen-ts/tests/api/index_test
 *
 * Tests for the high-level `createModule` / `Module` API in `src/api/index.ts`.
 *
 * @license MIT
 */

import { assert, assertThrows } from "@std/assert";
import { createModule } from "../../src/api/index.ts";
import { makeBlock, makeI32Const, makeLoop, makeNop } from "../../src/ir/expressions.ts";
import { None, ValType } from "../../src/ir/types.ts";
import "../../src/passes/index.ts"; // register built-in passes

Deno.test("toWat: unsupported expression kind throws instead of a silent (;; TODO ;) placeholder", () => {
  // The WAT serializer handles only a subset of expression kinds; `Loop` is not
  // among them. It used to emit a `(;; TODO ;)` comment — which, fed to the
  // hybrid optimizer subprocess, would silently optimize a different program.
  // It must now fail loudly.
  const mod = createModule(() => {});
  mod.ir.functions.push({
    name: "$f",
    params: [],
    results: [],
    locals: [],
    body: makeLoop("l", makeNop(), None),
  });
  assertThrows(() => mod.toWat(), Error, "unsupported expression kind");
});

Deno.test("Module.optimize honors the -O level (was hardcoded to 2)", async () => {
  // A removable `nop` followed by the real result: Vacuum (level ≥ 1) drops it,
  // so -Oz output is strictly smaller than -O0 (which now runs NO passes). Before
  // the fix, optimizeLevel was hardcoded to 2 and `-O0` produced identical bytes.
  const build = () => {
    const mod = createModule(() => {});
    mod.ir.functions.push({
      name: "$f",
      params: [],
      results: [ValType.I32],
      locals: [],
      body: makeBlock([makeNop(), makeI32Const(5)], null),
    });
    return mod;
  };
  const o0 = await build().optimize("-O0");
  const oz = await build().optimize("-Oz");
  assert(o0.length > oz.length, `expected -O0 (${o0.length}) > -Oz (${oz.length})`);
});
