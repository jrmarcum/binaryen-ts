/**
 * @module binaryen-ts/tests/binary/eh_test
 *
 * Tests for Phase 8 EH proposal support in the binary parser and encoder.
 *
 * Covers:
 * - Tag section decoding (id=13)
 * - `throw` instruction decoding (0x08)
 * - `throw_ref` instruction decoding (0x0a)
 * - `try_table` decoding (0x1f) with catch clauses
 * - Round-trip: encode ↔ parse identity for EH modules
 *
 * @license MIT
 */

import { assertEquals } from "jsr:@std/assert";
import { parseWasm } from "../../src/binary/index.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import { ExpressionKind } from "../../src/ir/expressions.ts";
import type { ThrowExpr, TryTableExpr, ThrowRefExpr } from "../../src/ir/expressions.ts";
import { ValType } from "../../src/ir/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function module(...sections: number[][]): Uint8Array {
  const bytes: number[] = [...WASM_HEADER];
  for (const s of sections) bytes.push(...s);
  return new Uint8Array(bytes);
}

function section(id: number, ...content: number[]): number[] {
  return [id, content.length, ...content];
}

// ---------------------------------------------------------------------------
// Test binary 1: throw instruction
//
// (module
//   (type (func (param i32)))   ; type 0 — tag function type
//   (tag (type 0))              ; tag 0
//   (func (type 0)              ; func 0 — takes i32, throws it
//     local.get 0
//     throw 0
//     unreachable
//   )
// )
// ---------------------------------------------------------------------------

const THROW_MODULE = module(
  // Type section: 1 type — func (i32) -> ()
  section(0x01, 0x01, 0x60, 0x01, 0x7f, 0x00),
  // Function section: 1 function, type 0
  section(0x03, 0x01, 0x00),
  // Tag section (id=13): 1 tag, attribute=0, type_idx=0
  section(0x0d, 0x01, 0x00, 0x00),
  // Code section: func body [local.get 0, throw 0, unreachable, end]
  section(
    0x0a,
    0x01,              // 1 function
    0x07,              // body size = 7
    0x00,              // 0 local groups
    0x20, 0x00,        // local.get 0
    0x08, 0x00,        // throw tag_idx=0
    0x00,              // unreachable
    0x0b,              // end
  ),
);

// ---------------------------------------------------------------------------
// Test binary 2: try_table with catch clause
//
// (module
//   (type (func (param i32)))    ; type 0 — tag func type: (i32) -> ()
//   (type (func (result i32)))   ; type 1 — function result type: () -> i32
//   (tag (type 0))               ; tag 0
//   (func (type 1)               ; func 0 — catches tag 0 and returns the i32
//     block $b (result i32)
//       try_table (result i32) (catch 0 1)  ; catch tag 0, dest depth=1 (=$b)
//         i32.const 42
//         throw 0
//       end
//       i32.const 99              ; fallthrough value
//     end
//   )
// )
// ---------------------------------------------------------------------------

const TRY_TABLE_MODULE = module(
  // Type section: 2 types
  section(
    0x01,
    0x02,
    0x60, 0x01, 0x7f, 0x00,  // type 0: func (i32) -> ()
    0x60, 0x00, 0x01, 0x7f,  // type 1: func () -> (i32)
  ),
  // Function section: 1 function, type 1
  section(0x03, 0x01, 0x01),
  // Tag section: 1 tag, attribute=0, type_idx=0
  section(0x0d, 0x01, 0x00, 0x00),
  // Code section
  section(
    0x0a,
    0x01,                    // 1 function
    0x11,                    // body size = 17
    0x00,                    // 0 local groups
    0x02, 0x7f,              // block (result i32)
    0x1f, 0x7f,              // try_table (result i32)
    0x01,                    // 1 catch clause
    0x00, 0x00, 0x01,        // catch, tag_idx=0, dest_depth=1 (outer block)
    0x41, 0x2a,              // i32.const 42
    0x08, 0x00,              // throw 0
    0x0b,                    // end try_table
    0x41, 0x63,              // i32.const 99
    0x0b,                    // end block
  ),
);

// ---------------------------------------------------------------------------
// Test binary 3: throw_ref
//
// (module
//   (type (func (result i32)))    ; type 0
//   (type (func))                 ; type 1 — catch_all_ref func type
//   (tag (type 1))                ; tag 0 (no params)
//   (func (type 0) (result i32)
//     block $b (result i32)
//       try_table (result i32) (catch_all_ref 0)  ; catch all into depth 0 ($b?)
//         i32.const 42
//       end
//       drop                 ; discard try_table result if no throw
//       i32.const 0
//     end
//   )
// )
//
// Simpler: a function that has a try_table (catch_all 0) block.
// catch_all has no tag and pushes the exnref if isRef=true.
// catch_all (not ref) simply branches to the dest.
//
// For throw_ref test: we test that 0x0a (throw_ref) is decoded as ThrowRefExpr
// in a simple context: local.get 0 (type exnref), throw_ref
// ---------------------------------------------------------------------------

// A module with a function that does: (local.get 0) (throw_ref)
// where local 0 is of type exnref (0x69)
const THROW_REF_MODULE = module(
  // Type section: 1 type — func (exnref) -> ()
  section(0x01, 0x01,
    0x60, 0x01, 0x69, 0x00,  // type 0: func (exnref=0x69) -> ()
  ),
  // Function section: 1 function, type 0
  section(0x03, 0x01, 0x00),
  // Code section
  section(
    0x0a,
    0x01,              // 1 function
    0x05,              // body size = 5
    0x00,              // 0 local groups
    0x20, 0x00,        // local.get 0
    0x0a,              // throw_ref
    0x0b,              // end
  ),
);

// ---------------------------------------------------------------------------
// Tests — binary parser: tag section
// ---------------------------------------------------------------------------

Deno.test("EH parser: tag section decoded — tag count and params", () => {
  const mod = parseWasm(THROW_MODULE);
  assertEquals(mod.tags.length, 1);
  assertEquals(mod.tags[0].params, [ValType.I32]);
});

Deno.test("EH parser: hasExceptionHandling flag set when tag section present", () => {
  const mod = parseWasm(THROW_MODULE);
  assertEquals(mod.hasExceptionHandling, true);
});

// ---------------------------------------------------------------------------
// Tests — binary parser: throw instruction
// ---------------------------------------------------------------------------

Deno.test("EH parser: throw decoded as ThrowExpr", () => {
  const mod = parseWasm(THROW_MODULE);
  assertEquals(mod.functions.length, 1);
  // Function body has [local.get, throw, unreachable]; body is a block
  const body = mod.functions[0].body;
  // Find the throw expression (in block children)
  let throwExpr: ThrowExpr | undefined;
  if (body.kind === ExpressionKind.Block) {
    throwExpr = body.children.find((c) => c.kind === ExpressionKind.Throw) as ThrowExpr | undefined;
  } else if (body.kind === ExpressionKind.Throw) {
    throwExpr = body as ThrowExpr;
  }
  assertEquals(throwExpr !== undefined, true, "throw expression not found");
  assertEquals(throwExpr!.kind, ExpressionKind.Throw);
  assertEquals(throwExpr!.operands.length, 1);
  assertEquals(throwExpr!.operands[0].kind, ExpressionKind.LocalGet);
});

Deno.test("EH parser: throw tag name resolved from tag section", () => {
  const mod = parseWasm(THROW_MODULE);
  const tag0 = mod.tags[0].name;
  const body = mod.functions[0].body;
  let throwExpr: ThrowExpr | undefined;
  if (body.kind === ExpressionKind.Block) {
    throwExpr = body.children.find((c) => c.kind === ExpressionKind.Throw) as ThrowExpr | undefined;
  } else if (body.kind === ExpressionKind.Throw) {
    throwExpr = body as ThrowExpr;
  }
  assertEquals(throwExpr!.tag, tag0);
});

// ---------------------------------------------------------------------------
// Tests — binary parser: try_table
// ---------------------------------------------------------------------------

Deno.test("EH parser: try_table decoded as TryTableExpr", () => {
  const mod = parseWasm(TRY_TABLE_MODULE);
  assertEquals(mod.functions.length, 1);
  // Find the try_table node (nested in a block)
  const body = mod.functions[0].body;
  let ttExpr: TryTableExpr | undefined;
  const findTryTable = (e: { kind: unknown; children?: unknown[]; body?: unknown }): TryTableExpr | undefined => {
    if (e.kind === ExpressionKind.TryTable) return e as TryTableExpr;
    if (e.kind === ExpressionKind.Block) {
      for (const c of (e.children ?? []) as typeof e[]) {
        const found = findTryTable(c as { kind: unknown; children?: unknown[]; body?: unknown });
        if (found) return found;
      }
    }
    return undefined;
  };
  ttExpr = findTryTable(body as { kind: unknown; children?: unknown[]; body?: unknown });
  assertEquals(ttExpr !== undefined, true, "try_table expression not found");
  assertEquals(ttExpr!.kind, ExpressionKind.TryTable);
  assertEquals(ttExpr!.catches.length, 1);
  assertEquals(ttExpr!.catches[0].isRef, false);
  assertEquals(ttExpr!.catches[0].tag !== null, true);
});

Deno.test("EH parser: try_table catch clause dest resolves to outer block label", () => {
  const mod = parseWasm(TRY_TABLE_MODULE);
  const body = mod.functions[0].body;
  const findTryTable = (e: { kind: unknown; children?: unknown[] }): TryTableExpr | undefined => {
    if (e.kind === ExpressionKind.TryTable) return e as TryTableExpr;
    for (const c of (e.children ?? []) as typeof e[]) {
      const found = findTryTable(c as { kind: unknown; children?: unknown[] });
      if (found) return found;
    }
    return undefined;
  };
  const tt = findTryTable(body as { kind: unknown; children?: unknown[] });
  const dest = tt!.catches[0].dest;
  // The dest label should be non-null and refer to an outer block
  assertEquals(typeof dest, "string");
  assertEquals(dest.startsWith("$"), true);
});

// ---------------------------------------------------------------------------
// Tests — binary parser: throw_ref
// ---------------------------------------------------------------------------

Deno.test("EH parser: exnref value type decoded in function params", () => {
  const mod = parseWasm(THROW_REF_MODULE);
  assertEquals(mod.functions.length, 1);
  assertEquals(mod.functions[0].params[0], ValType.ExnRef);
});

Deno.test("EH parser: throw_ref decoded as ThrowRefExpr", () => {
  const mod = parseWasm(THROW_REF_MODULE);
  const body = mod.functions[0].body;
  // Body is a block or the expression directly
  let trExpr: ThrowRefExpr | undefined;
  if (body.kind === ExpressionKind.ThrowRef) {
    trExpr = body as ThrowRefExpr;
  } else if (body.kind === ExpressionKind.Block) {
    trExpr = body.children.find((c) => c.kind === ExpressionKind.ThrowRef) as ThrowRefExpr | undefined;
  }
  assertEquals(trExpr !== undefined, true, "throw_ref expression not found");
  assertEquals(trExpr!.kind, ExpressionKind.ThrowRef);
  assertEquals(trExpr!.exnref.kind, ExpressionKind.LocalGet);
});

// ---------------------------------------------------------------------------
// Tests — binary encoder round-trip
// ---------------------------------------------------------------------------

Deno.test("EH encoder: throw module round-trips through encode+parse", () => {
  const mod = parseWasm(THROW_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  assertEquals(mod2.tags.length, 1);
  assertEquals(mod2.tags[0].params, [ValType.I32]);
  assertEquals(mod2.functions.length, 1);
  assertEquals(mod2.hasExceptionHandling, true);
});

Deno.test("EH encoder: throw expression preserved after round-trip", () => {
  const mod = parseWasm(THROW_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  const body = mod2.functions[0].body;
  let throwExpr: ThrowExpr | undefined;
  if (body.kind === ExpressionKind.Block) {
    throwExpr = body.children.find((c) => c.kind === ExpressionKind.Throw) as ThrowExpr | undefined;
  } else if (body.kind === ExpressionKind.Throw) {
    throwExpr = body as ThrowExpr;
  }
  assertEquals(throwExpr !== undefined, true, "throw not found after round-trip");
  assertEquals(throwExpr!.operands.length, 1);
  assertEquals(throwExpr!.operands[0].kind, ExpressionKind.LocalGet);
});

Deno.test("EH encoder: try_table module round-trips through encode+parse", () => {
  const mod = parseWasm(TRY_TABLE_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  assertEquals(mod2.tags.length, 1);
  assertEquals(mod2.functions.length, 1);
});

Deno.test("EH encoder: try_table catch clause preserved after round-trip", () => {
  const mod = parseWasm(TRY_TABLE_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  const body = mod2.functions[0].body;
  const findTryTable = (e: { kind: unknown; children?: unknown[] }): TryTableExpr | undefined => {
    if (e.kind === ExpressionKind.TryTable) return e as TryTableExpr;
    for (const c of (e.children ?? []) as typeof e[]) {
      const found = findTryTable(c as { kind: unknown; children?: unknown[] });
      if (found) return found;
    }
    return undefined;
  };
  const tt = findTryTable(body as { kind: unknown; children?: unknown[] });
  assertEquals(tt !== undefined, true, "try_table not found after round-trip");
  assertEquals(tt!.catches.length, 1);
  assertEquals(tt!.catches[0].isRef, false);
});

Deno.test("EH encoder: throw_ref module round-trips through encode+parse", () => {
  const mod = parseWasm(THROW_REF_MODULE);
  const mod2 = parseWasm(encodeWasm(mod));
  assertEquals(mod2.functions.length, 1);
  assertEquals(mod2.functions[0].params[0], ValType.ExnRef);
  const body = mod2.functions[0].body;
  let trExpr: ThrowRefExpr | undefined;
  if (body.kind === ExpressionKind.ThrowRef) {
    trExpr = body as ThrowRefExpr;
  } else if (body.kind === ExpressionKind.Block) {
    trExpr = body.children.find((c) => c.kind === ExpressionKind.ThrowRef) as ThrowRefExpr | undefined;
  }
  assertEquals(trExpr !== undefined, true, "throw_ref not found after round-trip");
  assertEquals(trExpr!.exnref.kind, ExpressionKind.LocalGet);
});