;; demo.wat — Phase 10 trivial WASM-compiled kernel
;;
;; This module is the demonstration payload for the binaryen-ts WASM-runtime
;; integration path. It is intentionally trivial: each export is a single-op
;; i32 function used to measure call-boundary cost between native TypeScript
;; passes and WASM-resident pass logic.
;;
;; Future, real kernels (i32 constant folding, etc.) will follow this same
;; pattern but expose larger work units that amortize the WASM call overhead.
;;
;; Build:
;;   deno run --allow-read --allow-write scripts/gen_demo_bytes.ts
;; The build script uses binaryen-ts' own Phase 1 WAT parser and Phase 3 binary
;; encoder — no external toolchain required.
(module
  (func $add_i32 (export "add_i32") (param $a i32) (param $b i32) (result i32)
    (i32.add (local.get $a) (local.get $b)))

  (func $mul_i32 (export "mul_i32") (param $a i32) (param $b i32) (result i32)
    (i32.mul (local.get $a) (local.get $b)))

  (func $eq_i32 (export "eq_i32") (param $a i32) (param $b i32) (result i32)
    (i32.eq (local.get $a) (local.get $b)))
)