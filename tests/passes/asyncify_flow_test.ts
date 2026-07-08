/**
 * @module binaryen-ts/tests/passes/asyncify_flow_test
 *
 * Stage 3b tests for the Asyncify flow transform (`flowInstrumentFunction`),
 * which linearizes control flow and wraps state-changing calls for unwind/
 * rewind. Because the flow emits calls to the temporary intrinsics that Stage 4
 * implements (`__asyncify_get_call_index` / `_check_call_index` / `_unwind`),
 * the output is not yet runnable — so these are STRUCTURAL tests:
 *
 *  - the instrumented body starts with the rewind prelude
 *    `if (state == Rewinding) __asyncify_get_call_index()`;
 *  - each state-changing call is wrapped with an `__asyncify_check_call_index`
 *    guard and a `__asyncify_unwind` note, with a distinct call index;
 *  - the transform runs without error over if / loop / nested-call shapes.
 *
 * Behavioral (run) validation lands in Stage 4/5 once the intrinsics are real.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";

import { type CallExpr, type Expression, ExpressionKind } from "../../src/ir/expressions.ts";
import { walkExpression } from "../../src/ir/walk.ts";
import { parseWat } from "../../src/parser/wat-parser.ts";
import { buildCallResultTypes, flattenFunction } from "../../src/passes/flatten.ts";
import {
  analyzeModule,
  type FlowCtx,
  flowInstrumentFunction,
  parseAsyncifyOptions,
} from "../../src/passes/asyncify.ts";
import type { WasmFunction, WasmModule } from "../../src/ir/module.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Flatten + flow-instrument every instrumented function; return the module. */
function flowModule(wat: string, passArgs: Record<string, string> = {}): WasmModule {
  const mod = parseWat(wat);
  const opts = parseAsyncifyOptions(passArgs);
  const analysis = analyzeModule(mod, opts);
  const callResultTypes = buildCallResultTypes(mod);
  for (const func of mod.functions) {
    if (!analysis.instrumentedFuncs.has(func.name)) continue;
    flattenFunction(func, callResultTypes);
    const ctx: FlowCtx = {
      func,
      canChangeState: analysis.canChangeState,
      canIndirect: !opts.ignoreIndirect,
      addedFromList: analysis.addedFromList,
      callIndex: { n: 0 },
      fakeGlobals: new Map(),
    };
    flowInstrumentFunction(func, ctx);
  }
  return mod;
}

function fn(mod: WasmModule, name: string): WasmFunction {
  const f = mod.functions.find((x) => x.name === name);
  assert(f, `function ${name} not found`);
  return f!;
}

function countCallsTo(e: Expression, target: string): number {
  let n = 0;
  walkExpression(e, (x) => {
    if (x.kind === ExpressionKind.Call && (x as CallExpr).target === target) n++;
  });
  return n;
}

const GET_INDEX = "$__asyncify_get_call_index";
const CHECK_INDEX = "$__asyncify_check_call_index";
const UNWIND = "$__asyncify_unwind";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ONE_CALL = `(module
  (import "env" "sleep" (func $sleep))
  (memory 1)
  (func $foo (export "foo") (call $sleep))
  (func $pure (export "pure") (result i32) (i32.const 1)))`;

const TWO_CALLS = `(module
  (import "env" "sleep" (func $sleep (param i32) (result i32)))
  (memory 1)
  (func $foo (export "foo") (param $x i32) (result i32)
    (i32.add (call $sleep (local.get $x)) (call $sleep (i32.const 2)))))`;

const IF_CALL = `(module
  (import "env" "sleep" (func $sleep (result i32)))
  (memory 1)
  (func $foo (export "foo") (param $x i32) (result i32)
    (if (result i32) (i32.lt_s (local.get $x) (i32.const 5))
      (then (call $sleep))
      (else (local.get $x)))))`;

const LOOP_CALL = `(module
  (import "env" "sleep" (func $sleep))
  (memory 1)
  (func $foo (export "foo") (param $n i32)
    (local $i i32)
    (block $done
      (loop $lp
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (call $sleep)
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp)))))`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("flow — body starts with the rewind prelude (pop call index)", () => {
  const foo = fn(flowModule(ONE_CALL), "$foo");
  assertEquals(foo.body.kind, ExpressionKind.Block);
  const first = (foo.body as { children: Expression[] }).children[0];
  assertEquals(first.kind, ExpressionKind.If);
  // its then-arm calls __asyncify_get_call_index exactly once.
  assertEquals(countCallsTo(first, GET_INDEX), 1);
});

Deno.test("flow — wraps a single state-changing call with a check + unwind", () => {
  const foo = fn(flowModule(ONE_CALL), "$foo");
  // 1 check-call-index guard, 1 unwind note, 1 rewind-prelude get-index.
  assertEquals(countCallsTo(foo.body, CHECK_INDEX), 1);
  assertEquals(countCallsTo(foo.body, UNWIND), 1);
  assertEquals(countCallsTo(foo.body, GET_INDEX), 1);
});

Deno.test("flow — each call gets a distinct index (two calls → two checks/unwinds)", () => {
  const foo = fn(flowModule(TWO_CALLS), "$foo");
  assertEquals(countCallsTo(foo.body, CHECK_INDEX), 2);
  assertEquals(countCallsTo(foo.body, UNWIND), 2);
  // The two check-call-index intrinsics receive indices 0 and 1.
  const indices: number[] = [];
  walkExpression(foo.body, (e) => {
    if (e.kind === ExpressionKind.Call && (e as CallExpr).target === CHECK_INDEX) {
      const arg = (e as CallExpr).operands[0] as { value: { i32: number } };
      indices.push(arg.value.i32);
    }
  });
  assertEquals(indices.sort(), [0, 1]);
});

Deno.test("flow — instruments a call inside an if arm (linearized)", () => {
  const foo = fn(flowModule(IF_CALL), "$foo");
  assertEquals(countCallsTo(foo.body, CHECK_INDEX), 1);
  assertEquals(countCallsTo(foo.body, UNWIND), 1);
  // The state global is consulted (rewinding/normal checks) — many state reads.
  let stateReads = 0;
  walkExpression(foo.body, (e) => {
    if (
      e.kind === ExpressionKind.GlobalGet && (e as { name: string }).name === "$__asyncify_state"
    ) {
      stateReads++;
    }
  });
  assert(stateReads >= 3, "expected several __asyncify_state checks after linearization");
});

Deno.test("flow — instruments a call inside a loop", () => {
  const foo = fn(flowModule(LOOP_CALL), "$foo");
  assertEquals(countCallsTo(foo.body, CHECK_INDEX), 1);
  assertEquals(countCallsTo(foo.body, UNWIND), 1);
  assertEquals(countCallsTo(foo.body, GET_INDEX), 1);
  // The loop survives the transform.
  let loops = 0;
  walkExpression(foo.body, (e) => {
    if (e.kind === ExpressionKind.Loop) loops++;
  });
  assertEquals(loops, 1);
});

Deno.test("flow — leaves non-instrumented (pure) functions untouched", () => {
  const mod = flowModule(ONE_CALL);
  const pure = fn(mod, "$pure");
  // pure was never flattened/flowed; its body is the original const.
  assertEquals(countCallsTo(pure.body, CHECK_INDEX), 0);
  assertEquals(countCallsTo(pure.body, GET_INDEX), 0);
});

Deno.test("flow — a state-changing local.set defers via a fake global", () => {
  // TWO_CALLS stores each call result; the deferred set uses a fake global.
  const mod = flowModule(TWO_CALLS);
  const foo = fn(mod, "$foo");
  let fakeSets = 0;
  walkExpression(foo.body, (e) => {
    if (
      e.kind === ExpressionKind.GlobalSet &&
      (e as { name: string }).name.startsWith("$asyncify_fake_call_global_")
    ) {
      fakeSets++;
    }
  });
  assert(fakeSets >= 2, "expected fake-global sets for the two call results");
});
