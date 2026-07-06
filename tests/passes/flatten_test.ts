/**
 * @module binaryen-ts/tests/passes/flatten_test
 *
 * Tests for the Flatten pass (Asyncify Stage 3a prerequisite). Two layers:
 *
 *  1. **Behavioral equivalence** — the primary correctness gate. Each fixture is
 *     parsed twice; one copy is flattened. Both are encoded, instantiated, and
 *     run over sample inputs; the results must be bit-identical. (Flatten is a
 *     semantics-preserving normalization, so any divergence is a bug.)
 *  2. **Flatness invariants** — the output must actually BE flat: no
 *     `local.tee`, `if`/`loop` conditions are trivial, and the operands of
 *     value operations (calls, binaries, loads, stores) are trivial. These are
 *     exactly the properties the Asyncify flow transform relies on.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";

import { type Expression, ExpressionKind } from "../../src/ir/expressions.ts";
import { walkExpression } from "../../src/ir/walk.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { parseWat } from "../../src/parser/wat-parser.ts";
import { FlattenPass } from "../../src/passes/flatten.ts";
import type { WasmModule } from "../../src/ir/module.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Imports = WebAssembly.Imports;

function instantiate(mod: WasmModule, imports?: Imports): WebAssembly.Instance {
  const bytes = encodeWasm(mod);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), imports);
}

/** Parse `wat` twice; flatten the second; run both `fn(...args)` and compare. */
function assertEquivalent(
  wat: string,
  fn: string,
  argSets: number[][],
  imports?: Imports,
): void {
  const original = instantiate(parseWat(wat), imports);
  const flatMod = parseWat(wat);
  new FlattenPass().run(flatMod, {
    optimizeLevel: 0,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });
  const flattened = instantiate(flatMod, imports);

  const of = original.exports[fn] as (...a: number[]) => number;
  const ff = flattened.exports[fn] as (...a: number[]) => number;
  for (const args of argSets) {
    assertEquals(ff(...args), of(...args), `${fn}(${args.join(",")}) diverged after flatten`);
  }
}

const TRIVIAL = new Set<ExpressionKind>([
  ExpressionKind.Const,
  ExpressionKind.LocalGet,
  ExpressionKind.RefNull,
  ExpressionKind.RefFunc,
  ExpressionKind.Unreachable,
  ExpressionKind.Nop,
]);

/** Assert the flattened module satisfies the flat-IR invariants. */
function assertFlat(mod: WasmModule): void {
  for (const func of mod.functions) {
    walkExpression(func.body, (e: Expression) => {
      assert(e.kind !== ExpressionKind.LocalTee, "flat IR must not contain local.tee");

      if (e.kind === ExpressionKind.If) {
        assert(TRIVIAL.has(e.condition.kind), `if condition not trivial: ${e.condition.kind}`);
      }
      // Operands of value operations must be trivial.
      const checkOperands = (ops: Expression[]) => {
        for (const op of ops) {
          assert(TRIVIAL.has(op.kind), `non-trivial operand ${op.kind} under ${e.kind}`);
        }
      };
      switch (e.kind) {
        case ExpressionKind.Call:
          checkOperands(e.operands);
          break;
        case ExpressionKind.CallIndirect:
          checkOperands(e.operands);
          assert(TRIVIAL.has(e.target.kind), "call_indirect target not trivial");
          break;
        case ExpressionKind.Binary:
          checkOperands([e.left, e.right]);
          break;
        case ExpressionKind.Unary:
          checkOperands([e.value]);
          break;
        case ExpressionKind.Load:
          checkOperands([e.ptr]);
          break;
        case ExpressionKind.Store:
          checkOperands([e.ptr, e.value]);
          break;
      }
    });
  }
}

function flattenParsed(wat: string): WasmModule {
  const mod = parseWat(wat);
  new FlattenPass().run(mod, {
    optimizeLevel: 0,
    shrinkLevel: 0,
    debugInfo: false,
    closedWorld: false,
    passArgs: {},
    partialInliningIfs: 0,
  });
  return mod;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARITH = `(module
  (func (export "f") (param $x i32) (param $y i32) (result i32)
    (i32.sub (i32.mul (i32.add (local.get $x) (local.get $y)) (i32.const 2)) (local.get $x))))`;

const IFELSE = `(module
  (func (export "f") (param $x i32) (result i32)
    (if (result i32) (i32.lt_s (local.get $x) (i32.const 10))
      (then (i32.mul (local.get $x) (i32.const 2)))
      (else (i32.add (local.get $x) (i32.const 100))))))`;

const LOOP_SUM = `(module
  (func (export "f") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $done
      (loop $lp
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $acc (i32.add (local.get $acc) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp)))
    (local.get $acc)))`;

const NESTED_CALLS = `(module
  (func $g (param $x i32) (result i32) (i32.add (local.get $x) (i32.const 1)))
  (func (export "f") (param $x i32) (result i32)
    (i32.mul (call $g (call $g (local.get $x))) (call $g (local.get $x)))))`;

const FACTORIAL = `(module
  (func $fac (export "f") (param $n i32) (result i32)
    (if (result i32) (i32.lt_s (local.get $n) (i32.const 2))
      (then (i32.const 1))
      (else (i32.mul (local.get $n) (call $fac (i32.sub (local.get $n) (i32.const 1))))))))`;

const IMPORT_CALL = `(module
  (import "env" "dbl" (func $dbl (param i32) (result i32)))
  (func (export "f") (param $x i32) (result i32)
    (i32.add (call $dbl (local.get $x)) (call $dbl (i32.add (local.get $x) (i32.const 1))))))`;

const VOID_STORE = `(module
  (memory 1)
  (func (export "f") (param $x i32) (result i32)
    (i32.store (i32.const 0) (i32.add (local.get $x) (i32.const 7)))
    (i32.load (i32.const 0))))`;

// ---------------------------------------------------------------------------
// Behavioral equivalence
// ---------------------------------------------------------------------------

Deno.test("flatten preserves semantics — arithmetic", () => {
  assertEquivalent(ARITH, "f", [[3, 4], [0, 0], [-5, 9], [100, -100]]);
});

Deno.test("flatten preserves semantics — if/else", () => {
  assertEquivalent(IFELSE, "f", [[3], [10], [11], [-1], [9]]);
});

Deno.test("flatten preserves semantics — loop (sum 0..n)", () => {
  assertEquivalent(LOOP_SUM, "f", [[0], [1], [5], [10], [100]]);
});

Deno.test("flatten preserves semantics — nested defined-function calls", () => {
  assertEquivalent(NESTED_CALLS, "f", [[0], [5], [-3], [42]]);
});

Deno.test("flatten preserves semantics — recursion (factorial)", () => {
  assertEquivalent(FACTORIAL, "f", [[0], [1], [5], [7], [10]]);
});

Deno.test("flatten preserves semantics — import calls with eval order", () => {
  const imports = { env: { dbl: (x: number) => x * 2 } };
  assertEquivalent(IMPORT_CALL, "f", [[3], [0], [-4]], imports);
});

Deno.test("flatten preserves semantics — void store then load", () => {
  assertEquivalent(VOID_STORE, "f", [[3], [0], [35]]);
});

// ---------------------------------------------------------------------------
// Flatness invariants
// ---------------------------------------------------------------------------

Deno.test("flatten output is flat — no local.tee, trivial conditions & operands", () => {
  for (const wat of [ARITH, IFELSE, LOOP_SUM, NESTED_CALLS, FACTORIAL, IMPORT_CALL, VOID_STORE]) {
    assertFlat(flattenParsed(wat));
  }
});

Deno.test("flatten hoists every call to a standalone statement operand set", () => {
  // The Asyncify-critical property: no call is nested inside another value
  // expression — each call's operands are trivial (checked by assertFlat), so a
  // call only ever appears as the RHS of a local.set / drop / return.
  const mod = flattenParsed(NESTED_CALLS);
  assertFlat(mod);
  let calls = 0;
  for (const f of mod.functions) {
    walkExpression(f.body, (e) => {
      if (e.kind === ExpressionKind.Call) calls++;
    });
  }
  assert(calls >= 3, "expected the 3 nested calls to survive flattening");
});
