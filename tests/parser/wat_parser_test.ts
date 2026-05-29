/**
 * @module binaryen-ts/tests/parser/wat_parser
 *
 * Integration tests for the WAT → WasmModule IR parser.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";
import { parseWat } from "../../src/parser/wat-parser.ts";
import { ExpressionKind } from "../../src/ir/expressions.ts";
import { ValType } from "../../src/ir/types.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { PassRunner } from "../../src/passes/index.ts";
import "../../src/passes/index.ts";

Deno.test("parseWat — empty module", () => {
  const mod = parseWat("(module)");
  assertEquals(mod.functions.length, 0);
  assertEquals(mod.exports.length, 0);
  assertEquals(mod.imports.length, 0);
});

Deno.test("parseWat — single function, no body", () => {
  const mod = parseWat(`(module (func $f))`);
  assertEquals(mod.functions.length, 1);
  assertEquals(mod.functions[0].name, "$f");
  assertEquals(mod.functions[0].params, []);
  assertEquals(mod.functions[0].results, []);
});

Deno.test("parseWat — function with params and result", () => {
  const mod = parseWat(`(module
    (func $add (param i32 i32) (result i32)
      (i32.add (local.get 0) (local.get 1))))`);
  const fn = mod.functions[0];
  assertEquals(fn.name, "$add");
  assertEquals(fn.params, [ValType.I32, ValType.I32]);
  assertEquals(fn.results, [ValType.I32]);
  assertEquals(fn.body.kind, ExpressionKind.Binary);
});

Deno.test("parseWat — i32.const", () => {
  const mod = parseWat(`(module (func $f (result i32) (i32.const 42)))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Const);
  assertEquals((body as import("../../src/ir/expressions.ts").ConstExpr).value, { i32: 42 });
});

Deno.test("parseWat — f64.const", () => {
  const mod = parseWat(`(module (func $f (result f64) (f64.const 3.14)))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Const);
  const v = (body as import("../../src/ir/expressions.ts").ConstExpr).value as { f64: number };
  assertClose(v.f64, 3.14);
});

Deno.test("parseWat — local.get and local.set", () => {
  const mod = parseWat(`(module
    (func $f (param i32) (result i32)
      (local.get 0)))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.LocalGet);
  assertEquals((body as import("../../src/ir/expressions.ts").LocalGetExpr).index, 0);
  assertEquals((body as import("../../src/ir/expressions.ts").LocalGetExpr).type, ValType.I32);
});

Deno.test("parseWat — nop and unreachable", () => {
  const mod = parseWat(`(module (func $f (nop) (unreachable)))`);
  const fn = mod.functions[0];
  // Body is a block since there are two expressions
  assertEquals(fn.body.kind, ExpressionKind.Block);
  const block = fn.body as import("../../src/ir/expressions.ts").BlockExpr;
  assertEquals(block.children[0].kind, ExpressionKind.Nop);
  assertEquals(block.children[1].kind, ExpressionKind.Unreachable);
});

Deno.test("parseWat — if/then/else", () => {
  const mod = parseWat(`(module
    (func $f (param i32) (result i32)
      (if (result i32) (local.get 0)
        (then (i32.const 1))
        (else (i32.const 0)))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.If);
});

Deno.test("parseWat — block with label", () => {
  const mod = parseWat(`(module
    (func $f
      (block $b
        (br $b))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Block);
  const block = body as import("../../src/ir/expressions.ts").BlockExpr;
  assertEquals(block.name, "$b");
  assertEquals(block.children[0].kind, ExpressionKind.Break);
});

Deno.test("parseWat — loop", () => {
  const mod = parseWat(`(module
    (func $f
      (loop $l
        (br $l))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Loop);
});

Deno.test("parseWat — call", () => {
  const mod = parseWat(`(module
    (func $callee (result i32) (i32.const 1))
    (func $caller (result i32) (call $callee)))`);
  assertEquals(mod.functions.length, 2);
  const caller = mod.functions[1];
  assertEquals(caller.body.kind, ExpressionKind.Call);
  assertEquals((caller.body as import("../../src/ir/expressions.ts").CallExpr).target, "$callee");
});

Deno.test("parseWat — export", () => {
  const mod = parseWat(`(module
    (func $add (param i32 i32) (result i32)
      (i32.add (local.get 0) (local.get 1)))
    (export "add" (func $add)))`);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "add");
  assertEquals(mod.exports[0].value, "$add");
  // The standalone export descriptor keyword is `func`, but the IR kind must be
  // the canonical `function` (matching the binary parser / encoder / passes).
  // Regression: it used to pass `"func"` straight through.
  assertEquals(mod.exports[0].kind, "function");
});

Deno.test("parseWat — standalone (export ... (func)) encodes + survives Inlining", async () => {
  // A standalone `(export "x" (func $f))` previously produced kind `"func"`,
  // which (a) the encoder's export-section switch did not match — corrupting
  // the export section — and (b) the inliner's `usedGlobally` check did not
  // match, so it deleted the (apparently unreferenced) exported function.
  // Reported indirectly via the wasmtk team's Inlining bug report (1.2.7).
  const mod = parseWat(`(module
    (func $add (param i32 i32) (result i32)
      (i32.add (local.get 0) (local.get 1)))
    (func $caller (param i32) (result i32)
      (call $add (local.get 0) (i32.const 5)))
    (export "caller" (func $caller)))`);

  // (1) Encodes to a binary V8 accepts, and the export is callable.
  const inst0 = new WebAssembly.Instance(
    await WebAssembly.compile(encodeWasm(mod) as BufferSource),
  );
  assertEquals((inst0.exports.caller as (x: number) => number)(10), 15);

  // (2) The exported function survives the Inlining pass (was wrongly removed
  //     because its export kind didn't match the `usedGlobally` check).
  new PassRunner(mod, { optimizeLevel: 2, shrinkLevel: 2 }).add("Inlining").run();
  assert(
    mod.functions.some((f) => f.name === "$caller"),
    "exported $caller must survive Inlining",
  );
  const inst1 = new WebAssembly.Instance(
    await WebAssembly.compile(encodeWasm(mod) as BufferSource),
  );
  assertEquals((inst1.exports.caller as (x: number) => number)(10), 15);
});

Deno.test("parseWat — inline export", () => {
  const mod = parseWat(`(module
    (func $f (export "f") (result i32) (i32.const 0)))`);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "f");
});

Deno.test("parseWat — memory", () => {
  const mod = parseWat(`(module (memory $mem 1 4))`);
  assertEquals(mod.memories.length, 1);
  assertEquals(mod.memories[0].initial, 1);
  assertEquals(mod.memories[0].max, 4);
});

Deno.test("parseWat — function import", () => {
  const mod = parseWat(`(module
    (import "env" "log" (func $log (param i32))))`);
  assertEquals(mod.imports.length, 1);
  assertEquals(mod.imports[0].module, "env");
  assertEquals(mod.imports[0].base, "log");
  assertEquals(mod.imports[0].params, [ValType.I32]);
});

Deno.test("parseWat — full add module", () => {
  const src = `(module
    (func $add (export "add") (param $a i32) (param $b i32) (result i32)
      (i32.add (local.get $a) (local.get $b))))`;
  const mod = parseWat(src);
  assertEquals(mod.functions.length, 1);
  assertEquals(mod.exports.length, 1);
  assertEquals(mod.exports[0].name, "add");
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Binary);
});

Deno.test("parseWat — return expression", () => {
  const mod = parseWat(`(module (func $f (result i32) (return (i32.const 99))))`);
  const body = mod.functions[0].body;
  assertEquals(body.kind, ExpressionKind.Return);
  const ret = body as import("../../src/ir/expressions.ts").ReturnExpr;
  assertEquals(ret.value?.kind, ExpressionKind.Const);
});

Deno.test("parseWat — drop", () => {
  const mod = parseWat(`(module (func $f (drop (i32.const 1))))`);
  assertEquals(mod.functions[0].body.kind, ExpressionKind.Drop);
});

// ---------------------------------------------------------------------------
// Phase 1 — Global definitions
// ---------------------------------------------------------------------------

Deno.test("parseWat — global immutable i32 with const init", () => {
  const mod = parseWat(`(module (global $g i32 (i32.const 42)))`);
  assertEquals(mod.globals.length, 1);
  const g = mod.globals[0];
  assertEquals(g.name, "$g");
  assertEquals(g.type, ValType.I32);
  assertEquals(g.mutable, false);
  assertEquals(g.init.kind, ExpressionKind.Const);
});

Deno.test("parseWat — global mutable i64", () => {
  const mod = parseWat(`(module (global $count (mut i64) (i64.const 0)))`);
  assertEquals(mod.globals[0].mutable, true);
  assertEquals(mod.globals[0].type, ValType.I64);
});

Deno.test("parseWat — global with global.get init referencing imported global", () => {
  const mod = parseWat(`(module
    (import "env" "base" (global $base i32))
    (global $g i32 (global.get $base)))`);
  assertEquals(mod.imports.length, 1);
  assertEquals(mod.imports[0].kind, "global");
  assertEquals(mod.globals.length, 1);
  assertEquals(mod.globals[0].init.kind, ExpressionKind.GlobalGet);
});

Deno.test("parseWat — anonymous global gets synthesized name", () => {
  const mod = parseWat(`(module (global f32 (f32.const 1.5)))`);
  assertEquals(mod.globals.length, 1);
  assertEquals(mod.globals[0].name, "$__global_0");
  assertEquals(mod.globals[0].type, ValType.F32);
});

// ---------------------------------------------------------------------------
// Phase 1 — Import descriptors (global / memory / table)
// ---------------------------------------------------------------------------

Deno.test("parseWat — import global immutable", () => {
  const mod = parseWat(`(module (import "env" "g" (global $g i32)))`);
  const imp = mod.imports[0];
  assertEquals(imp.kind, "global");
  assertEquals(imp.name, "$g");
  assertEquals(imp.module, "env");
  assertEquals(imp.base, "g");
  assertEquals(imp.type, ValType.I32);
  assertEquals(imp.mutable, false);
});

Deno.test("parseWat — import global mutable", () => {
  const mod = parseWat(`(module (import "env" "c" (global $counter (mut i32))))`);
  const imp = mod.imports[0];
  assertEquals(imp.mutable, true);
});

Deno.test("parseWat — import memory with initial and max", () => {
  const mod = parseWat(`(module (import "env" "mem" (memory $m 1 10)))`);
  const imp = mod.imports[0];
  assertEquals(imp.kind, "memory");
  assertEquals(imp.name, "$m");
  assertEquals(imp.initial, 1);
  assertEquals(imp.max, 10);
});

Deno.test("parseWat — import memory with initial only (no max)", () => {
  const mod = parseWat(`(module (import "env" "mem" (memory 2)))`);
  const imp = mod.imports[0];
  assertEquals(imp.kind, "memory");
  assertEquals(imp.initial, 2);
  assertEquals(imp.max, null);
});

Deno.test("parseWat — import table funcref with limits", () => {
  const mod = parseWat(`(module (import "env" "t" (table $t 0 100 funcref)))`);
  const imp = mod.imports[0];
  assertEquals(imp.kind, "table");
  assertEquals(imp.name, "$t");
  assertEquals(imp.initial, 0);
  assertEquals(imp.max, 100);
  assertEquals(imp.type, ValType.FuncRef);
});

Deno.test("parseWat — import table without explicit max", () => {
  const mod = parseWat(`(module (import "env" "t" (table 5 externref)))`);
  const imp = mod.imports[0];
  assertEquals(imp.kind, "table");
  assertEquals(imp.initial, 5);
  assertEquals(imp.max, null);
  assertEquals(imp.type, ValType.ExternRef);
});

// ---------------------------------------------------------------------------
// Phase 1 — br_table
// ---------------------------------------------------------------------------

Deno.test("parseWat — br_table with two targets and a default", () => {
  const mod = parseWat(`(module
    (func $f (param i32)
      (block $a
        (block $b
          (block $c
            (br_table $a $b $c (local.get 0)))))))`);
  const sw = findSwitch(mod.functions[0].body) as
    | { targets: string[]; defaultTarget: string; value: unknown }
    | null;
  if (!sw) throw new Error("did not find Switch in body");
  // Targets are resolved to label names: $a/$b are the explicit targets, $c is the default.
  assertEquals(sw.targets.length, 2);
  assertEquals(sw.value, null);
});

Deno.test("parseWat — br_table with a single target (degenerate but valid)", () => {
  const mod = parseWat(`(module
    (func $f (param i32)
      (block $only
        (br_table $only $only (local.get 0)))))`);
  const sw = findSwitch(mod.functions[0].body) as
    | { targets: string[]; defaultTarget: string }
    | null;
  if (!sw) throw new Error("did not find Switch in body");
  assertEquals(sw.targets.length, 1);
  if (!sw.defaultTarget) throw new Error("missing default target");
});

// ---------------------------------------------------------------------------
// Phase 8.1a — old EH `try` with inline body (no `(do ...)` wrapper)
// ---------------------------------------------------------------------------

Deno.test("parseWat — try with inline body and catch clause", () => {
  const mod = parseWat(`(module
    (tag $e (param i32))
    (func $f (result i32)
      (try $t (result i32)
        (i32.const 1)
        (catch $e (i32.const 99)))))`);
  const body = mod.functions[0].body as { kind: ExpressionKind; catchTags?: string[] };
  assertEquals(body.kind, ExpressionKind.Try);
  assertEquals(body.catchTags, ["$e"]);
});

Deno.test("parseWat — try with inline multi-instruction body wraps into a block", () => {
  const mod = parseWat(`(module
    (tag $e)
    (func $f
      (try $t
        (nop)
        (nop)
        (catch $e))))`);
  const t = mod.functions[0].body as {
    kind: ExpressionKind;
    body: { kind: ExpressionKind; children?: unknown[] };
  };
  assertEquals(t.kind, ExpressionKind.Try);
  // Two body items → wrapped in an anonymous block
  assertEquals(t.body.kind, ExpressionKind.Block);
  assertEquals((t.body.children ?? []).length, 2);
});

Deno.test("parseWat — try inline body still accepts catch_all and delegate clauses", () => {
  const mod = parseWat(`(module
    (tag $e)
    (func $f
      (try $t
        (nop)
        (catch $e)
        (catch_all (nop)))))`);
  const t = mod.functions[0].body as { kind: ExpressionKind; catchTags: string[] };
  assertEquals(t.kind, ExpressionKind.Try);
  // catch_all is recorded with the special placeholder tag "$__catch_all"
  assertEquals(t.catchTags, ["$e", "$__catch_all"]);
});

Deno.test("parseWat — (do ...) wrapped body still works (regression)", () => {
  const mod = parseWat(`(module
    (tag $e)
    (func $f
      (try $t
        (do (nop))
        (catch $e))))`);
  const t = mod.functions[0].body as { kind: ExpressionKind; catchTags: string[] };
  assertEquals(t.kind, ExpressionKind.Try);
  assertEquals(t.catchTags, ["$e"]);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertClose(a: number, b: number, epsilon = 1e-10): void {
  if (Math.abs(a - b) > epsilon) {
    throw new Error(`Expected ${a} to be close to ${b}`);
  }
}

/** Walks an expression tree (any composite kind) looking for a Switch node. */
function findSwitch(e: unknown): unknown {
  const expr = e as { kind: ExpressionKind; children?: unknown[]; body?: unknown };
  if (expr.kind === ExpressionKind.Switch) return expr;
  if (expr.body) {
    const found = findSwitch(expr.body);
    if (found) return found;
  }
  if (expr.children) {
    for (const c of expr.children) {
      const found = findSwitch(c);
      if (found) return found;
    }
  }
  return null;
}

Deno.test("parseWat — ref.null / ref.func / ref.is_null are parsed (not nop)", () => {
  // Previously these fell through to the `nop` fallback, silently corrupting
  // any reference-types instruction in the WAT front door. Regression guard.
  const mod = parseWat(`(module
    (table $t 1 funcref)
    (func $g)
    (func $f (result i32)
      (table.set $t (i32.const 0) (ref.func $g))
      (ref.is_null (ref.null func))))`);
  const fn = mod.functions.find((f) => f.name === "$f")!;
  const body = fn.body as { kind: ExpressionKind; children?: { kind: ExpressionKind }[] };
  const children = body.children ?? [body as { kind: ExpressionKind }];

  const tableSet = children[0] as {
    kind: ExpressionKind;
    value: { kind: ExpressionKind; func?: string };
  };
  assertEquals(tableSet.kind, ExpressionKind.TableSet);
  assertEquals(tableSet.value.kind, ExpressionKind.RefFunc);
  assertEquals(tableSet.value.func, "$g");

  const isNull = children[1] as { kind: ExpressionKind; value: { kind: ExpressionKind } };
  assertEquals(isNull.kind, ExpressionKind.RefIsNull);
  assertEquals(isNull.value.kind, ExpressionKind.RefNull);
});
