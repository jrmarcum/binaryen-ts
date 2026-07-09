/**
 * @module binaryen-ts/tests/passes/asyncify_analyzer_test
 *
 * Stage 2 tests for the Asyncify ModuleAnalyzer: the whole-program analysis
 * that decides which functions can change the unwind/rewind state and must be
 * instrumented. Two layers:
 *
 *  1. Unit tests on hand-built modules (precise control of the call graph).
 *  2. A **differential** harness that parses a WAT string, runs our
 *     `analyzeModule`, and compares the instrument set against what the real
 *     `wasm-opt --asyncify --pass-arg=asyncify-verbose` (Binaryen v130) reports
 *     — the authoritative oracle for the ABI TinyGo depends on. The harness
 *     skips gracefully if `wasm-opt` is not on PATH.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";

import { parseWat } from "../../src/parser/wat-parser.ts";
import {
  analyzeModule,
  parseAsyncifyOptions,
  resolveAsyncifyImports,
} from "../../src/passes/asyncify.ts";

// ---------------------------------------------------------------------------
// Differential harness
// ---------------------------------------------------------------------------

async function haveWasmOpt(): Promise<boolean> {
  try {
    const p = new Deno.Command("wasm-opt", { args: ["--version"], stdout: "null", stderr: "null" });
    return (await p.output()).success;
  } catch {
    return false;
  }
}

/** Our analyzer's instrument set for `wat` under `passArgs` (names sans `$`). */
function ourInstrumentSet(wat: string, passArgs: Record<string, string>): Set<string> {
  const mod = parseWat(wat);
  const { instrumentedFuncs } = analyzeModule(mod, parseAsyncifyOptions(passArgs));
  return new Set([...instrumentedFuncs].map((n) => (n.startsWith("$") ? n.slice(1) : n)));
}

/**
 * The reference instrument set from `wasm-opt --asyncify --pass-arg=asyncify-verbose`.
 * Verbose prints one line per state-changing function; imported functions are
 * reported as "is an import ..." and are NOT instrumented.
 */
async function wasmOptInstrumentSet(
  wat: string,
  passArgs: Record<string, string>,
): Promise<Set<string>> {
  const inFile = await Deno.makeTempFile({ suffix: ".wat" });
  const outFile = await Deno.makeTempFile({ suffix: ".wat" });
  try {
    await Deno.writeTextFile(inFile, wat);
    const args = [inFile, "--asyncify", "--pass-arg=asyncify-verbose", "-S", "-o", outFile];
    for (const [k, v] of Object.entries(passArgs)) {
      args.push(v === "" ? `--pass-arg=${k}` : `--pass-arg=${k}@${v}`);
    }
    const out = await new Deno.Command("wasm-opt", { args, stdout: "piped", stderr: "piped" })
      .output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    const set = new Set<string>();
    for (const line of text.split("\n")) {
      const m = line.match(/^\[asyncify\]\s+(\S+)\s+can change the state/);
      if (m && !line.includes("is an import")) set.add(m[1]);
    }
    return set;
  } finally {
    await Deno.remove(inFile).catch(() => {});
    await Deno.remove(outFile).catch(() => {});
  }
}

async function assertMatchesOracle(
  name: string,
  wat: string,
  passArgs: Record<string, string> = {},
): Promise<void> {
  const ours = ourInstrumentSet(wat, passArgs);
  const ref = await wasmOptInstrumentSet(wat, passArgs);
  assertEquals(
    [...ours].sort(),
    [...ref].sort(),
    `${name}: instrument set differs from wasm-opt oracle`,
  );
}

// ---------------------------------------------------------------------------
// WAT fixtures
// ---------------------------------------------------------------------------

const IMPORT_CALL = `(module
  (import "env" "sleep" (func $sleep))
  (memory 1)
  (func $foo (call $sleep))
  (func $pure (result i32) (i32.const 1)))`;

const TRANSITIVE = `(module
  (import "env" "sleep" (func $sleep))
  (memory 1)
  (func $a (call $b))
  (func $b (call $sleep))
  (func $c (result i32) (i32.const 0)))`;

const INDIRECT = `(module
  (memory 1)
  (table 1 funcref)
  (type $v (func))
  (func $foo (call_indirect (type $v) (i32.const 0)))
  (func $pure (result i32) (i32.const 1)))`;

const TWO_IMPORTS = `(module
  (import "env" "sleep" (func $sleep))
  (import "env" "log" (func $log))
  (memory 1)
  (func $foo (call $sleep))
  (func $bar (call $log)))`;

// ---------------------------------------------------------------------------
// Unit tests (no external tool)
// ---------------------------------------------------------------------------

Deno.test("analyzeModule — import caller is instrumented, pure function is not", () => {
  const s = ourInstrumentSet(IMPORT_CALL, {});
  assertEquals(s, new Set(["foo"]));
});

Deno.test("analyzeModule — state change propagates transitively up the call graph", () => {
  const s = ourInstrumentSet(TRANSITIVE, {});
  assertEquals(s, new Set(["a", "b"]));
});

Deno.test("analyzeModule — indirect calls change state by default", () => {
  assertEquals(ourInstrumentSet(INDIRECT, {}), new Set(["foo"]));
});

Deno.test("analyzeModule — asyncify-ignore-indirect drops indirect-only functions", () => {
  assertEquals(ourInstrumentSet(INDIRECT, { "asyncify-ignore-indirect": "" }), new Set());
});

Deno.test("analyzeModule — asyncify-ignore-imports makes imports non-state-changing", () => {
  assertEquals(ourInstrumentSet(IMPORT_CALL, { "asyncify-ignore-imports": "" }), new Set());
});

Deno.test("analyzeModule — asyncify-imports restricts to the listed imports", () => {
  const s = ourInstrumentSet(TWO_IMPORTS, { "asyncify-imports": "env.sleep" });
  assertEquals(s, new Set(["foo"]));
});

Deno.test("analyzeModule — remove-list forces a function out of the set", () => {
  // $a calls $b calls import; removing $b stops propagation so only $b is
  // dropped AND $a no longer reaches a state-change → set is empty.
  const s = ourInstrumentSet(TRANSITIVE, { "asyncify-removelist": "$b" });
  assertEquals(s, new Set());
});

Deno.test("analyzeModule — only-list restricts to exactly the listed functions", () => {
  const s = ourInstrumentSet(TRANSITIVE, { "asyncify-onlylist": "$a" });
  assertEquals(s, new Set(["a"]));
});

Deno.test("resolveAsyncifyImports — in-wasm asyncify.* import mode: topMost excluded, callers instrumented", () => {
  // `$park` calls asyncify.start_unwind (top of the runtime — must NOT be
  // instrumented); `$worker`/`$main` transitively call it and MUST be.
  const wat = `(module
    (import "asyncify" "start_unwind" (func $su (param i32)))
    (memory 1)
    (func $park (call $su (i32.const 0)))
    (func $worker (call $park))
    (func $main (call $worker)))`;
  const mod = parseWat(wat);
  const importMode = resolveAsyncifyImports(mod);
  assert(importMode, "should detect the in-wasm asyncify-import mode");
  assert(
    !mod.imports.some((i) => i.kind === "function" && i.module === "asyncify"),
    "the asyncify.* import must be removed",
  );
  const res = analyzeModule(mod, parseAsyncifyOptions({}));
  assert(!res.instrumentedFuncs.has("$park"), "park (topMost runtime) must NOT be instrumented");
  assert(res.instrumentedFuncs.has("$worker"), "worker (calls park) must be instrumented");
  assert(res.instrumentedFuncs.has("$main"), "main (transitive) must be instrumented");
});

Deno.test("resolveAsyncifyImports — returns false and no-ops when there are no asyncify imports", () => {
  const mod = parseWat(TRANSITIVE);
  assert(!resolveAsyncifyImports(mod), "no asyncify imports → host-driven mode");
});

// ---------------------------------------------------------------------------
// Differential tests vs real wasm-opt (skipped if the tool is absent)
// ---------------------------------------------------------------------------

Deno.test("differential vs wasm-opt --asyncify (verbose)", async (t) => {
  if (!await haveWasmOpt()) {
    console.warn("  (skipped — wasm-opt not on PATH)");
    return;
  }
  await t.step("import call", () => assertMatchesOracle("import call", IMPORT_CALL));
  await t.step("transitive", () => assertMatchesOracle("transitive", TRANSITIVE));
  await t.step("indirect (default)", () => assertMatchesOracle("indirect", INDIRECT));
  await t.step(
    "ignore-indirect",
    () => assertMatchesOracle("ignore-indirect", INDIRECT, { "asyncify-ignore-indirect": "" }),
  );
  await t.step(
    "ignore-imports",
    () => assertMatchesOracle("ignore-imports", IMPORT_CALL, { "asyncify-ignore-imports": "" }),
  );
  await t.step(
    "imports list",
    () => assertMatchesOracle("imports list", TWO_IMPORTS, { "asyncify-imports": "env.sleep" }),
  );
});
