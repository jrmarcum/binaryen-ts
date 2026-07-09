/**
 * @module binaryen-ts/tests/binary/decoder_reorder_test
 *
 * Regression: the binary decoder must NOT reorder a state-dependent value past
 * statements that mutate the state it reads.
 *
 * The binary keeps a value on the OPERAND STACK across statements and consumes
 * it later — a shape Binaryen/TinyGo emit to avoid a local. The canonical case
 * is TinyGo's goroutine trampoline, which keeps the caller's `$__stack_pointer`
 * (`global.get`) live on the stack across `global.set $sp …; call_indirect;
 * call`, then a trailing `global.set $sp` RESTORES it:
 *
 *     global.get $sp        ;; old sp — stays on the stack
 *     i32.const 42
 *     global.set $sp        ;; sp = 42   (old sp still beneath on the stack)
 *     global.set $sp        ;; sp = old sp   (restore, consumes the value)
 *     global.get $sp        ;; -> old sp
 *
 * `pop()` reconstructs the tree by taking the topmost value-producing entry,
 * skipping void statements. Taking the `global.get $sp` from BELOW the
 * intervening `global.set $sp` and placing it as the restore's operand would
 * re-evaluate `global.get $sp` AFTER sp was overwritten → `global.set (global.get)`
 * self-assign that never restores the value (in TinyGo: the shadow stack pointer
 * is left pointing at the finished goroutine's frame → every later allocation
 * corrupts memory, trapping at the linear-memory boundary). The decoder must
 * instead SPILL the value into a temp local at its original position.
 *
 * @license MIT
 */

import { assert, assertEquals } from "@std/assert";
import { parseWasm } from "../../src/binary/wasm-parser.ts";
import { encodeWasm } from "../../src/encoder/index.ts";
import type { Expression } from "../../src/ir/expressions.ts";

// Hand-assembled module (global $g mut i32 = 100):
//   (func (export "f") (result i32)
//     global.get $g   i32.const 42   global.set $g   global.set $g   global.get $g)
// The old $g is kept on the operand stack across `global.set $g (i32.const 42)`,
// then the second `global.set $g` restores it. Correct f() = 100 (the restored
// old value); the reorder bug yields 42.
const VALUE_ON_STACK = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // type: () -> i32
  0x03, 0x02, 0x01, 0x00, // func[0]: type 0
  0x06, 0x07, 0x01, 0x7f, 0x01, 0x41, 0xe4, 0x00, 0x0b, // global mut i32 = 100 (signed LEB e4 00)
  0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, // export "f" -> func 0
  0x0a, 0x0e, 0x01, 0x0c, 0x00, // code: 1 body, size 12, 0 declared locals
  0x23, 0x00, 0x41, 0x2a, 0x24, 0x00, 0x24, 0x00, 0x23, 0x00, 0x0b, // g.get; c42; g.set; g.set; g.get; end
]);

/** Collect every expression node in the tree. */
function nodes(e: Expression, out: Expression[] = []): Expression[] {
  out.push(e);
  for (const v of Object.values(e as Record<string, unknown>)) {
    if (v && typeof v === "object" && "kind" in (v as object)) nodes(v as Expression, out);
    else if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === "object" && "kind" in (x as object)) nodes(x as Expression, out);
    }
  }
  return out;
}

Deno.test("decoder does not reorder a stack-held value past a write of its state (spills instead)", () => {
  const mod = parseWasm(VALUE_ON_STACK);
  const f = mod.functions[0];
  const all = nodes(f.body);

  // The reorder bug produces `global.set $g (global.get $g)` — a self-assign that
  // reads the just-overwritten value. That must NOT appear.
  const selfAssign = all.some((n) =>
    (n as { kind: string }).kind === "global.set" &&
    ((n as { value?: { kind?: string; name?: string } }).value?.kind === "global.get") &&
    ((n as { name?: string }).name === (n as { value?: { name?: string } }).value?.name)
  );
  assert(!selfAssign, "decoder reordered the stack-held global.get into a self-assigning global.set");

  // Instead it must spill the value into a temp local (added beyond the 0 the
  // binary declared) and restore via local.get.
  assert(f.locals.length >= 1, "decoder should have added a spill local for the reordered value");
  const restoresFromLocal = all.some((n) =>
    (n as { kind: string }).kind === "global.set" &&
    (n as { value?: { kind?: string } }).value?.kind === "local.get"
  );
  assert(restoresFromLocal, "the restore should read the spilled local, not re-read the global");
});

Deno.test("the spilled decode round-trips and executes correctly (f() === 100)", async () => {
  const mod = parseWasm(VALUE_ON_STACK);
  const inst = (await WebAssembly.instantiate(encodeWasm(mod), {})).instance;
  assertEquals((inst.exports.f as () => number)(), 100);
});
