/**
 * @module binaryen-ts/tests/parser/sexpr
 *
 * Unit tests for the S-expression builder.
 *
 * @license MIT
 */

import { assertEquals, assertThrows } from "@std/assert";
import { tokenize } from "../../src/parser/tokenizer.ts";
import {
  atomString,
  atomText,
  buildSExpr,
  buildSExprList,
  isListWith,
  listChildren,
  listHead,
  type SExpr,
  sExprToString,
  WatSExprError,
} from "../../src/parser/sexpr.ts";

function parse(src: string): SExpr {
  return buildSExpr(tokenize(src));
}

Deno.test("buildSExpr — atom", () => {
  const s = parse("nop");
  assertEquals(s.kind, "atom");
  assertEquals(atomText(s), "nop");
});

Deno.test("buildSExpr — empty list", () => {
  const s = parse("()");
  assertEquals(s.kind, "list");
  assertEquals((s as import("../../src/parser/sexpr.ts").SList).children.length, 0);
});

Deno.test("buildSExpr — single-element list", () => {
  const s = parse("(nop)");
  assertEquals(s.kind, "list");
  assertEquals(listHead(s as import("../../src/parser/sexpr.ts").SList), "nop");
});

Deno.test("buildSExpr — nested list", () => {
  const s = parse(`(module (func $f))`);
  assertEquals(s.kind, "list");
  assertEquals(listHead(s as import("../../src/parser/sexpr.ts").SList), "module");
  const children = listChildren(s as import("../../src/parser/sexpr.ts").SList);
  assertEquals(children.length, 1);
  assertEquals(isListWith(children[0], "func"), true);
});

Deno.test("buildSExpr — string atom", () => {
  const s = parse(`"hello"`);
  assertEquals(atomString(s), "hello");
});

Deno.test("buildSExpr — throws on unmatched open paren", () => {
  assertThrows(() => parse("(module"), WatSExprError);
});

Deno.test("buildSExpr — throws on unexpected close paren", () => {
  assertThrows(() => parse(")"), WatSExprError);
});

Deno.test("buildSExpr — throws on extra tokens after top-level form", () => {
  assertThrows(() => parse("nop nop"), WatSExprError);
});

Deno.test("buildSExprList — multiple top-level forms", () => {
  const forms = buildSExprList(tokenize("(module) (assert_return)"));
  assertEquals(forms.length, 2);
  assertEquals(listHead(forms[0] as import("../../src/parser/sexpr.ts").SList), "module");
  assertEquals(listHead(forms[1] as import("../../src/parser/sexpr.ts").SList), "assert_return");
});

Deno.test("sExprToString — round-trips an atom", () => {
  const s = parse("nop");
  assertEquals(sExprToString(s), "nop");
});

Deno.test("sExprToString — round-trips a list", () => {
  const s = parse("(i32.add (local.get 0) (local.get 1))");
  assertEquals(sExprToString(s), "(i32.add (local.get 0) (local.get 1))");
});
