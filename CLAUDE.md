# CLAUDE.md — Project Context for Claude Code

## Project Overview

This is a personal fork of the [Binaryen](https://github.com/WebAssembly/binaryen) compiler and toolchain infrastructure library for WebAssembly, forked to `github.com/jrmarcum/binaryen-ts`.

- **Repository**: https://github.com/jrmarcum/binaryen-ts
- **Upstream**: https://github.com/WebAssembly/binaryen
- **Primary language**: C++20 (core), Python (test scripts), JavaScript (binaryen.js bindings)
- **Build system**: CMake
- **Local path**: `d:\Programs\_ProgramExamples\Example_Programs\wasmExamples\binaryen-ts`

## What Binaryen Does

Binaryen is a compiler and toolchain infrastructure library for WebAssembly. Key tools built from this repo:

- `wasm-opt` — WebAssembly optimizer (runs IR passes to reduce size/improve speed)
- `wasm-as` / `wasm-dis` — WebAssembly assembler/disassembler
- `wasm2js` — WebAssembly to JavaScript compiler
- `wasm-merge` — Merges multiple wasm files into one
- `wasm-ctor-eval` — Compile-time function evaluation
- `binaryen.js` — JavaScript/Node.js API for creating and optimizing Wasm modules

## Repository Structure

```
src/           C++ source (IR, passes, tools, JS bindings)
src/js/        JavaScript post/pre files for binaryen.js build
src/passes/    Optimization passes (CoalesceLocals, Inlining, Vacuum, etc.)
src/ir/        IR utilities and intrinsics
test/          Test suite (wast files, binaryen.js JS tests, lit tests)
test/binaryen.js/  JavaScript API tests (Node.js)
scripts/       Python test runners and automation
third_party/   Git submodules (wabt, gtest, etc.)
```

## Building

```bash
# Initialize submodules first
git submodule init
git submodule update

# Build with CMake
cmake . && make

# Build binaryen.js for Node.js (requires Emscripten)
emcmake cmake . && emmake make binaryen_js
```

Requires a C++20 compiler. On Windows use Visual Studio with CMake support.

## Testing

```bash
# Run all tests
python check.py

# Run specific test suite
python check.py --list-suites
python check.py [TEST_NAME]

# Install Python test dependencies (Python >= 3.10 required)
pip3 install -r requirements-dev.txt
```

Lit tests use `scripts/update_lit_checks.py` to auto-update CHECK lines.

## Key Files

- [src/binaryen-c.h](src/binaryen-c.h) — Public C API
- [src/binaryen-c.cpp](src/binaryen-c.cpp) — C API implementation
- [src/pass.h](src/pass.h) — Pass infrastructure
- [src/passes/](src/passes/) — All optimization passes
- [src/ir/intrinsics.h](src/ir/intrinsics.h) — Binaryen intrinsics definitions
- [src/js/binaryen.js-post.js](src/js/binaryen.js-post.js) — JS API bindings post-file

## Developer Notes

- The IR is a **tree structure** — each expression must have exactly one parent; do not reuse nodes across the tree.
- Binaryen IR has an `unreachable` type not present in the wasm spec; default text output may not be valid wasm text. Use `--generate-stack-ir --print-stack-ir` for valid wasm text output.
- Pass runner automatically fixes up non-nullable local validation after each pass (`requiresNonNullableLocalFixups()` in `pass.h`).
- All strings are interned for performance; string comparisons are pointer comparisons.
- Memory allocation uses arenas per module; no per-node manual memory management needed.
- Adding a new optimization pass: add a `.cpp` file to `src/passes/` and rebuild.

## Portability Note

All project context for Claude Code lives in this file (`CLAUDE.md`) to keep the project fully portable across machines. Do not store project-specific knowledge in machine-local Claude memory.
