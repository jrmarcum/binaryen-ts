/**
 * @module binaryen-ts/tests/api/index_test
 *
 * Tests for the high-level `createModule` / `Module` API in `src/api/index.ts`.
 *
 * @license MIT
 */

import { assertThrows } from "@std/assert";
import { createModule } from "../../src/api/index.ts";
import { makeLoop, makeNop } from "../../src/ir/expressions.ts";
import { None } from "../../src/ir/types.ts";

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
