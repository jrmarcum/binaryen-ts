# Cross-project architecture (binaryen-ts ↔ wabt-ts ↔ wasmtk)

These decisions were agreed between binaryen-ts and wabt-ts and must be respected in both projects.
The eventual merger target is **binaryang** (all three projects merge into one — design package
boundaries to keep that merge clean). The ecosystem roles are in [overview.md](overview.md).

## Agreed pipeline

```text
WAT / .wasm input
    ↓  wabt-ts parser         → wabt format IR (tree-shaped, post-order traversable)
    ↓  IR bridge              → binaryen optimization IR   ← the architectural join
    ↓  binaryen-ts passes     → optimized binaryen IR
    ↓  binaryen-ts encoder    → .wasm output
    ↓  wasmtime               → native execution
    ↓  canonical ABI          → component boundary (wasmtk's concern)
```

Plus the **direct path** for pure optimization (no prior wabt-ts step):
`.wasm → binaryen-ts parseWasm() → binaryen IR → passes → encoder`. Both are first-class; the bridge
path is the production route when wabt-ts tools (validate, strip) have already processed the module.
Re-serializing to binary between steps just to use the direct path is wasteful and wrong.

## The five agreed decisions

| Decision                 | Resolution                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Binary encoder ownership | binaryen-ts encoder = canonical output for **optimized** wasm; wabt-ts encoder = format tools + round-trip fidelity only                                                 |
| WAT parser front door    | wabt-ts WAT parser = front door for **all external input** (user `.wat`, wasmtk source); binaryen-ts WAT parser = internal IR construction, tests, pass development only |
| Bridge architecture      | Bridge = wabt-ts calling the binaryen-ts constructor API directly; not a separate translation layer                                                                      |
| wabt-ts IR shape         | Tree-shaped (not flat stack-machine list); post-order traversable; no parent context to resolve a child; no upward references                                            |
| binaryang merger         | All three projects eventually merge into binaryang                                                                                                                       |

## IR bridge design constraints

The bridge reduces to a single recursive post-order walk over the wabt format IR, calling binaryen
constructor functions at each node. For this to work:

- wabt-ts expression nodes must be resolvable bottom-up (children before parents)
- no node may require parent context to be constructed
- the binaryen-ts constructor API must be flat, stable, complete for all MVP opcodes

The original binaryen C API (`BinaryenConst()`, `BinaryenBinary()`, `BinaryenAddFunction()`, …)
shows the right shape; the TS constructor API inherits it intentionally: `makeI32Const`,
`makeBinary`, `makeBlock`, `ModuleBuilder.addFunction`, etc.

## Constructor API status — stable + complete for MVP

Phase 0 established it; Phases 2 (binary parser, first client to call a constructor for every MVP
opcode) and 3 (encoder, first to invert every opcode to bytes) stabilized it. All MVP factories are
present and exercised: `makeI32Const`/`makeI64Const`/`makeF32Const`/`makeF64Const`, `makeLocalGet`/
`makeLocalSet`/`makeLocalTee`, `makeGlobalGet`/`makeGlobalSet`, `makeBinary`, `makeUnary`,
`makeReturn`, `makeCall`, `makeCallIndirect`, `makeIf`, `makeBlock`, `makeLoop`, `makeBreak`,
`makeSwitch`, `makeSelect`, `makeDrop`, `makeNop`, `makeUnreachable`, `makeLoad`, `makeStore`,
`makeMemorySize`, `makeMemoryGrow`, `makeMemoryCopy`, `makeMemoryFill`, `makeRefNull`,
`makeRefFunc`, `makeRefIsNull` (+ GC/EH/SIMD/table factories from later phases).

## Handshake status with wabt-ts (all complete)

1. Module-level constructor signatures (`addFunction`/`addGlobal`/`addMemory`/`addFunctionImport`/
   `addExport`) shared for boundary validation. ✅
2. Phase 2 instruction decoder reached MVP opcode completeness. ✅
3. wabt-ts dry-run mapping wabt IR nodes → binaryen constructor calls. ✅ (tier_a/tier_b/dry_run
   test files in the sibling wabt-ts repo).
4. Both sides reviewed for structural mismatch. ✅ — **wabt-ts shipped the production bridge** as
   commit `cf44fb59` ("Phase 7: wabt-ts → binaryen-ts IR bridge") in
   `src/bridge/binaryen-bridge.ts` + `src/bridge/type-map.ts`. wabt-ts imports
   `@jrmarcum/binaryen-ts@^1.0.9/ir` + `/encoder`. The constructor API proved sufficient for the MVP
   expression kinds wabt-ts targeted plus imports/ exports/defined entities/module wiring. **Bridge
   scope expansion is now driven by wabt-ts's needs**, not by binaryen-ts's API surface.

## Working with the sibling repos

`../wabt-ts/` is the user's actual wabt-ts development repo (the cross-project IR-bridge work
happens there). Consult it when changes here affect the bridge boundary; **never write to it from
inside this repo.** Its portable memory is at `../wabt-ts/cmem/` (notably `bridge.md`, which
documents this same boundary from the wabt-ts side). wasmtk's portable memory is at
`../wasmtk/cmem/`. The `npm:binaryen` compat facade (`/compat`, see
[architecture.md](architecture.md)) is what unblocked wasmtk's migration off `npm:binaryen` — wasmtk
call sites change only the `import` statement.
</content>
