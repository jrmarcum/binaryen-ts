/**
 * @module binaryen-ts/tests/parser/tokenizer
 *
 * Unit tests for the WAT tokenizer.
 *
 * @license MIT
 */

import { assertEquals, assertThrows } from "@std/assert";
import { tokenize, TokenKind, WatTokenizeError } from "../../src/parser/tokenizer.ts";

Deno.test("tokenize — empty input produces only EOF", () => {
  const tokens = tokenize("");
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].kind, TokenKind.EOF);
});

Deno.test("tokenize — parens", () => {
  const tokens = tokenize("()");
  assertEquals(tokens[0].kind, TokenKind.LParen);
  assertEquals(tokens[1].kind, TokenKind.RParen);
  assertEquals(tokens[2].kind, TokenKind.EOF);
});

Deno.test("tokenize — keywords", () => {
  const [module_, func_, i32_] = tokenize("module func i32");
  assertEquals(module_.kind, TokenKind.Keyword);
  assertEquals(module_.raw, "module");
  assertEquals(func_.kind, TokenKind.Keyword);
  assertEquals(i32_.kind, TokenKind.Keyword);
  assertEquals(i32_.raw, "i32");
});

Deno.test("tokenize — identifiers", () => {
  const [$add] = tokenize("$add");
  assertEquals($add.kind, TokenKind.Id);
  assertEquals($add.raw, "$add");
});

Deno.test("tokenize — decimal integers", () => {
  const [pos, neg, zero] = tokenize("42 -7 0");
  assertEquals(pos.kind, TokenKind.Integer);
  assertEquals(pos.value, 42);
  assertEquals(neg.kind, TokenKind.Integer);
  assertEquals(neg.value, -7);
  assertEquals(zero.value, 0);
});

Deno.test("tokenize — hex integers", () => {
  const [hex] = tokenize("0xff");
  assertEquals(hex.kind, TokenKind.Integer);
  assertEquals(hex.value, 255);
});

Deno.test("tokenize — float literals", () => {
  const [f1, f2] = tokenize("1.0 3.14");
  assertEquals(f1.kind, TokenKind.Float);
  assertEquals(f1.value, 1.0);
  assertEquals(f2.kind, TokenKind.Float);
  assertClose(f2.value as number, 3.14);
});

Deno.test("tokenize — special floats: inf, nan", () => {
  const [inf_, ninf, nan_] = tokenize("inf -inf nan");
  assertEquals(inf_.kind, TokenKind.Float);
  assertEquals(inf_.value, Infinity);
  assertEquals(ninf.kind, TokenKind.Float);
  assertEquals(ninf.value, -Infinity);
  assertEquals(nan_.kind, TokenKind.Float);
  assertEquals(Number.isNaN(nan_.value as number), true);
});

Deno.test("tokenize — string literals", () => {
  const [str] = tokenize('"hello world"');
  assertEquals(str.kind, TokenKind.String);
  assertEquals(str.text, "hello world");
});

Deno.test("tokenize — string escape sequences", () => {
  const [str] = tokenize('"a\\nb\\t"');
  assertEquals(str.text, "a\nb\t");
});

Deno.test("tokenize — line comments are skipped", () => {
  const tokens = tokenize(";; this is a comment\n(module)");
  assertEquals(tokens[0].kind, TokenKind.LParen);
  assertEquals(tokens[1].raw, "module");
});

Deno.test("tokenize — block comments are skipped", () => {
  const tokens = tokenize("(; block comment ;)(module)");
  assertEquals(tokens[0].kind, TokenKind.LParen);
  assertEquals(tokens[1].raw, "module");
});

Deno.test("tokenize — nested block comments", () => {
  const tokens = tokenize("(; outer (; inner ;) outer ;) nop");
  assertEquals(tokens[0].raw, "nop");
});

Deno.test("tokenize — instruction mnemonics with dots", () => {
  const [instr] = tokenize("i32.add");
  assertEquals(instr.kind, TokenKind.Keyword);
  assertEquals(instr.raw, "i32.add");
});

Deno.test("tokenize — position tracking", () => {
  const tokens = tokenize("(\n  nop\n)");
  assertEquals(tokens[0].pos, { line: 1, col: 1 });
  assertEquals(tokens[1].pos, { line: 2, col: 3 });
  assertEquals(tokens[2].pos, { line: 3, col: 1 });
});

Deno.test("tokenize — underscore separators in numbers", () => {
  const [n] = tokenize("1_000_000");
  assertEquals(n.kind, TokenKind.Integer);
  assertEquals(n.value, 1000000);
});

Deno.test("tokenize — throws on unterminated string", () => {
  assertThrows(() => tokenize('"unterminated'), WatTokenizeError);
});

Deno.test("tokenize — full module snippet", () => {
  const src = `(module
    (func $add (param i32 i32) (result i32)
      (i32.add (local.get 0) (local.get 1))))`;
  const tokens = tokenize(src);
  // Should produce tokens without throwing
  assertEquals(tokens[tokens.length - 1].kind, TokenKind.EOF);
  const keywords = tokens.filter((t) => t.kind === TokenKind.Keyword).map((t) => t.raw);
  assertEquals(keywords.includes("module"), true);
  assertEquals(keywords.includes("func"), true);
  assertEquals(keywords.includes("i32.add"), true);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertClose(a: number, b: number, epsilon = 1e-10): void {
  if (Math.abs(a - b) > epsilon) {
    throw new Error(`Expected ${a} to be close to ${b}`);
  }
}
