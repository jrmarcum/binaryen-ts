/**
 * @module binaryen-ts/tests/interop/binaryen_interop_test
 *
 * Tests for the Phase 0 binaryen.js in-process bridge.
 *
 * binaryen.js itself is not installed in CI (would require an npm install and
 * we're a Deno-first project), so these tests pass a hand-written mock factory
 * via {@link BinaryenInterop.create}'s `binaryen` option. The mock satisfies
 * the same interface the real binaryen.js exposes, so all bridge-side logic
 * (parse → optimize → emit → dispose lifecycle, pass-list routing, level
 * shorthand parsing, options validation, error surfaces) is exercised.
 *
 * A separate live test against the real `npm:binaryen` is documented in the
 * file but disabled by default.
 *
 * @license MIT
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BinaryenInterop,
  type BinaryenJsLib,
  type BinaryenWrappedModule,
} from "../../src/interop/binaryen-js.ts";

// ---------------------------------------------------------------------------
// Mock binaryen.js
// ---------------------------------------------------------------------------

interface MockEvent {
  type:
    | "parseText"
    | "readBinary"
    | "setOptimizeLevel"
    | "setShrinkLevel"
    | "optimize"
    | "runPasses"
    | "emitText"
    | "emitBinary"
    | "validate"
    | "dispose";
  payload?: unknown;
}

interface MockLib extends BinaryenJsLib {
  events: MockEvent[];
  optimizeLevel: number;
  shrinkLevel: number;
}

function makeMockBinaryen(): MockLib {
  const events: MockEvent[] = [];
  const lib = {
    optimizeLevel: 0,
    shrinkLevel: 0,
    events,
    parseText(text: string): BinaryenWrappedModule {
      events.push({ type: "parseText", payload: text });
      return makeMockModule(events);
    },
    readBinary(data: Uint8Array): BinaryenWrappedModule {
      events.push({ type: "readBinary", payload: data });
      return makeMockModule(events);
    },
    setOptimizeLevel(level: number): void {
      events.push({ type: "setOptimizeLevel", payload: level });
      lib.optimizeLevel = level;
    },
    setShrinkLevel(level: number): void {
      events.push({ type: "setShrinkLevel", payload: level });
      lib.shrinkLevel = level;
    },
    getOptimizeLevel(): number {
      return lib.optimizeLevel;
    },
    getShrinkLevel(): number {
      return lib.shrinkLevel;
    },
  } as MockLib;
  return lib;
}

function makeMockModule(events: MockEvent[]): BinaryenWrappedModule {
  return {
    emitText(): string {
      events.push({ type: "emitText" });
      return "(module (;optimized;))";
    },
    emitBinary(): Uint8Array {
      events.push({ type: "emitBinary" });
      // 8-byte WASM header is enough to assert binary shape.
      return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    },
    optimize(): void {
      events.push({ type: "optimize" });
    },
    runPasses(passes: string[]): void {
      events.push({ type: "runPasses", payload: passes });
    },
    validate(): number {
      events.push({ type: "validate" });
      return 1;
    },
    dispose(): void {
      events.push({ type: "dispose" });
    },
  };
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

Deno.test("BinaryenInterop.create — accepts pre-loaded binaryen instance", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  assertEquals(interop.binaryen, mock);
});

Deno.test("BinaryenInterop.create — rejects invalid pre-loaded binaryen", async () => {
  await assertRejects(
    () => BinaryenInterop.create({ binaryen: {} as unknown as BinaryenJsLib }),
    Error,
    "does not match the binaryen.js API",
  );
});

Deno.test("BinaryenInterop.create — surfaces import failure with hint", async () => {
  await assertRejects(
    () =>
      BinaryenInterop.create({
        binaryenJsPath: "./this-path-definitely-does-not-exist.js",
      }),
    Error,
    "failed to import binaryen.js",
  );
});

// ---------------------------------------------------------------------------
// optimizeWat — pass-list and level routing
// ---------------------------------------------------------------------------

Deno.test("optimizeWat — runs default pipeline when no passes given", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  const out = interop.optimizeWat("(module)");
  // Default is optimizeLevel=2, shrinkLevel=0, then ref.optimize() then emitText.
  assertEquals(out, "(module (;optimized;))");
  const types = mock.events.map((e) => e.type);
  assertEquals(types, [
    "parseText",
    "setOptimizeLevel",
    "setShrinkLevel",
    "optimize",
    "emitText",
    "dispose",
  ]);
  assertEquals(mock.optimizeLevel, 2);
  assertEquals(mock.shrinkLevel, 0);
});

Deno.test("optimizeWat — explicit pass list bypasses default optimize()", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  interop.optimizeWat("(module)", { passes: ["vacuum", "dce"] });
  const types = mock.events.map((e) => e.type);
  assert(types.includes("runPasses"));
  assertEquals(types.includes("optimize"), false);
  // The passes payload survived the call.
  const runPassesEvent = mock.events.find((e) => e.type === "runPasses");
  assertEquals(runPassesEvent?.payload, ["vacuum", "dce"]);
});

Deno.test("optimizeWat — '-Oz' shorthand maps to optimizeLevel=2, shrinkLevel=2", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  interop.optimizeWat("(module)", "-Oz");
  assertEquals(mock.optimizeLevel, 2);
  assertEquals(mock.shrinkLevel, 2);
});

Deno.test("optimizeWat — '-Os' shorthand maps to optimizeLevel=2, shrinkLevel=1", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  interop.optimizeWat("(module)", "-Os");
  assertEquals(mock.optimizeLevel, 2);
  assertEquals(mock.shrinkLevel, 1);
});

Deno.test("optimizeWat — '-O3' shorthand maps to optimizeLevel=3, shrinkLevel=0", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  interop.optimizeWat("(module)", "-O3");
  assertEquals(mock.optimizeLevel, 3);
  assertEquals(mock.shrinkLevel, 0);
});

Deno.test("optimizeWat — unknown shorthand throws", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  assertThrows(
    () => interop.optimizeWat("(module)", "-Owat"),
    Error,
    "Unknown optimization shorthand",
  );
});

Deno.test("optimizeWat — dispose runs even when emitText throws", async () => {
  const mock = makeMockBinaryen();
  // Substitute the next parseText result with a module whose emitText throws.
  const original = mock.parseText;
  mock.parseText = (text: string) => {
    const ref = original.call(mock, text);
    return {
      ...ref,
      emitText: () => {
        throw new Error("boom");
      },
    };
  };
  const interop = await BinaryenInterop.create({ binaryen: mock });
  assertThrows(() => interop.optimizeWat("(module)"), Error, "boom");
  assertEquals(mock.events.some((e) => e.type === "dispose"), true);
});

// ---------------------------------------------------------------------------
// optimizeBinary
// ---------------------------------------------------------------------------

Deno.test("optimizeBinary — round-trips through readBinary + optimize + emitBinary", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  const input = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const out = interop.optimizeBinary(input);
  // Mock returns the same 8-byte header.
  assertEquals(out, input);
  const types = mock.events.map((e) => e.type);
  assertEquals(types, [
    "readBinary",
    "setOptimizeLevel",
    "setShrinkLevel",
    "optimize",
    "emitBinary",
    "dispose",
  ]);
});

Deno.test("optimizeBinary — honors explicit passes", async () => {
  const mock = makeMockBinaryen();
  const interop = await BinaryenInterop.create({ binaryen: mock });
  interop.optimizeBinary(new Uint8Array([0]), { passes: ["dce"] });
  const types = mock.events.map((e) => e.type);
  assert(types.includes("runPasses"));
  assertEquals(types.includes("optimize"), false);
});

// ---------------------------------------------------------------------------
// Live integration (disabled by default)
//
// To run against real npm:binaryen:
//   deno test --allow-net --allow-read --allow-env=BINARYEN_LIVE \
//     tests/interop/binaryen_interop_test.ts
// and set BINARYEN_LIVE=1 in the environment.
// ---------------------------------------------------------------------------

Deno.test({
  name: "BinaryenInterop.create — live npm:binaryen end-to-end",
  ignore: Deno.env.get("BINARYEN_LIVE") !== "1",
  fn: async () => {
    const interop = await BinaryenInterop.create({ binaryenJsPath: "npm:binaryen" });
    const watIn = '(module (func (export "f") (result i32) i32.const 42))';
    const watOut = interop.optimizeWat(watIn, "-Oz");
    assert(watOut.length > 0);
    assert(watOut.includes("i32.const"));
  },
});
