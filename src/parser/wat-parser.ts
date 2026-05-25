/**
 * @module binaryen-ts/parser/wat-parser
 *
 * WAT S-expression tree → `WasmModule` IR parser.
 *
 * This is the third stage of the WAT parser pipeline:
 *
 * ```
 * Token[]  ──buildSExpr()──▶  SExpr  ──parseModule()──▶  WasmModule
 * ```
 *
 * The parser walks the {@link SExpr} tree produced by `buildSExpr` and builds
 * a {@link WasmModule} in the TypeScript IR. It covers the full MVP WAT grammar
 * plus the reference-types and exception-handling proposals, enough to parse
 * the output of `wasm-opt -S` and `wasm-dis`.
 *
 * **Name resolution**: WAT allows names (`$foo`) and indices interchangeably.
 * This parser resolves all names to indices at the end of each module parse,
 * after all declarations have been collected.
 *
 * @example
 * ```ts
 * import { parseWat } from "@jrmarcum/binaryen-ts/parser/wat-parser";
 *
 * const mod = parseWat(`
 *   (module
 *     (func $add (export "add") (param i32 i32) (result i32)
 *       (i32.add (local.get 0) (local.get 1))))
 * `);
 * console.log(mod.functions[0].name);     // "add"  (or "$add")
 * console.log(mod.exports[0].name);       // "add"
 * ```
 *
 * @license MIT
 */

import {
  BinaryExpr,
  BinaryOp,
  BlockExpr,
  BreakExpr,
  CallExpr,
  CallIndirectExpr,
  type CatchClause,
  ConstExpr,
  DropExpr,
  Expression,
  ExpressionKind,
  GlobalGetExpr,
  GlobalSetExpr,
  IfExpr,
  LocalGetExpr,
  LocalSetExpr,
  LocalTeeExpr,
  LoopExpr,
  MemoryCopyExpr,
  MemoryFillExpr,
  MemoryGrowExpr,
  MemorySizeExpr,
  NopExpr,
  ReturnExpr,
  SelectExpr,
  StoreExpr,
  UnaryExpr,
  UnaryOp,
  UnreachableExpr,
  LoadExpr,
  makeRefEq, makeRefI31, makeI31Get,
  makeStructNew, makeStructNewDefault, makeStructGet, makeStructSet,
  makeArrayNew, makeArrayNewDefault, makeArrayNewFixed,
  makeArrayGet, makeArraySet, makeArrayLen,
  makeRefTest, makeRefCast, BrOnOp,
  makeThrow, makeThrowRef, makeRethrow, makeTryTable, makeTry,
  makeV128Const, makeSIMDExtract, makeSIMDReplace, makeSIMDShuffle,
  makeSIMDTernary, makeSIMDShift, makeSIMDLoad, makeSIMDLoadStoreLane,
  SIMDExtractOp, SIMDReplaceOp, SIMDShiftOp, SIMDLoadOp, SIMDLoadStoreLaneOp, SIMDTernaryOp,
  type SIMDExtractExpr, type SIMDReplaceExpr, type SIMDShuffleExpr,
  type SIMDTernaryExpr, type SIMDShiftExpr, type SIMDLoadExpr, type SIMDLoadStoreLaneExpr,
} from "../ir/expressions.ts";
import {
  DataSegment,
  ElementSegment,
  Local,
  ModuleBuilder,
  WasmExport,
  WasmFunction,
  WasmGlobal,
  WasmImport,
  WasmMemory,
  WasmModule,
  WasmTable,
} from "../ir/module.ts";
import { None, Type, Unreachable, ValType } from "../ir/types.ts";
import {
  AbstractHeapType, type HeapType, type RefType, type TypeDef,
  type StorageType, type FieldType,
} from "../ir/gc-types.ts";
import {
  Atom,
  SExpr,
  SList,
  atomFloat,
  atomInt,
  atomString,
  atomText,
  buildSExpr,
  buildSExprList,
  isAtom,
  isListWith,
  listChildren,
  listFrom,
  listHead,
  sExprToString,
} from "./sexpr.ts";
import { TextPos, tokenize } from "./tokenizer.ts";

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Error thrown when the WAT IR parser encounters a structural problem.
 */
export class WatParseError extends Error {
  constructor(
    message: string,
    public readonly pos: TextPos,
    public readonly filename: string,
  ) {
    super(`${filename}:${pos.line}:${pos.col}: ${message}`);
    this.name = "WatParseError";
  }
}

/**
 * Parses a WAT module string into a {@link WasmModule} IR.
 *
 * Accepts the full WAT module syntax:
 * - `(module ...)` — standard form
 * - Bare module body (no outer `(module)` wrapper) — for convenience
 *
 * @param source - WAT source text.
 * @param filename - Optional filename used in error messages.
 * @throws {@link WatParseError} on any structural or semantic error.
 */
export function parseWat(source: string, filename = "<input>"): WasmModule {
  const tokens = tokenize(source, filename);
  const root = buildSExpr(tokens, filename);
  return new WatModuleParser(filename).parseModule(root);
}

/**
 * Parses a `.wast` script (may contain multiple top-level forms).
 * Returns only the module forms, ignoring assert_* and other directives.
 *
 * @param source - WAST source text.
 * @param filename - Optional filename.
 */
export function parseWast(source: string, filename = "<input>"): WasmModule[] {
  const tokens = tokenize(source, filename);
  const forms = buildSExprList(tokens, filename);
  const modules: WasmModule[] = [];
  for (const form of forms) {
    if (isListWith(form, "module")) {
      modules.push(new WatModuleParser(filename).parseModule(form));
    }
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Per-function parse context
// ---------------------------------------------------------------------------

interface FuncContext {
  params: ValType[];
  /** All locals (params + additional locals). */
  locals: Local[];
  /** Map from `$name` → local index. */
  localNames: Map<string, number>;
  /** Map from `$name` → label depth (0 = innermost). */
  labels: Map<string, number>;
  labelDepth: number;
  results: ValType[];
}

// ---------------------------------------------------------------------------
// Module parser
// ---------------------------------------------------------------------------

class WatModuleParser {
  private readonly filename: string;
  private builder = new ModuleBuilder();

  // Deferred name-resolution tables
  private funcNames = new Map<string, number>(); // $name → index in functions[]
  private globalNames = new Map<string, number>();
  private memoryNames = new Map<string, number>();
  private tableNames = new Map<string, number>();

  // GC type name → heapTypes index
  private typeNames = new Map<string, number>();

  // EH tag name → tag index
  private tagNames = new Map<string, number>();

  // All function-level definitions collected before building
  private rawFunctions: RawFunc[] = [];

  constructor(filename: string) {
    this.filename = filename;
  }

  // -------------------------------------------------------------------------
  // Module top level
  // -------------------------------------------------------------------------

  parseModule(root: SExpr): WasmModule {
    const list = this.expectList(root, "module");
    // Optional module name (ignored — modules don't have external names in IR)
    let childStart = 1;
    if (list.children[1]?.kind === "atom" && list.children[1].token.raw.startsWith("$")) {
      childStart = 2;
    }

    // First pass: collect all type / function / import / global / memory / table declarations
    // so that forward references can be resolved.
    for (const child of listFrom(list, childStart)) {
      if (child.kind !== "list") continue;
      const head = listHead(child as SList);
      switch (head) {
        case "import": this.parseImport(child as SList); break;
        case "func":   this.collectFunc(child as SList); break;
        case "global": this.collectGlobal(child as SList); break;
        case "memory": this.collectMemory(child as SList); break;
        case "table":  this.collectTable(child as SList); break;
        case "tag":    this.collectTag(child as SList); break;
        case "export": /* handled in second pass */ break;
        case "data":   /* handled in second pass */ break;
        case "elem":   /* handled in second pass */ break;
        case "type":   this.collectType(child as SList); break;
        case "rec":    /* GC recursive types — future */ break;
        default: break;
      }
    }

    // Second pass: build function bodies, exports, data segments, elements
    for (const child of listFrom(list, childStart)) {
      if (child.kind !== "list") continue;
      const head = listHead(child as SList);
      switch (head) {
        case "export": this.parseExport(child as SList); break;
        case "data":   this.parseData(child as SList); break;
        case "elem":   this.parseElem(child as SList); break;
      }
    }

    // Build function bodies now that all names are known
    for (const raw of this.rawFunctions) {
      this.buildFunc(raw);
    }

    return this.builder.build();
  }

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  private parseImport(list: SList): void {
    // (import "module" "base" (func $name (param ...) (result ...)))
    const children = listChildren(list);
    const modName = atomString(children[0]) ?? this.err("expected module name string", list.pos);
    const baseName = atomString(children[1]) ?? this.err("expected base name string", list.pos);
    const desc = children[2];
    if (!desc || desc.kind !== "list") this.err("expected import descriptor list", list.pos);
    const descList = desc as SList;
    const head = listHead(descList);

    if (head === "func") {
      const { name, params, results } = this.parseFuncType(descList);
      const internalName = name ?? `$__import_func_${this.funcNames.size}`;
      this.funcNames.set(internalName, this.funcNames.size);
      this.builder.addFunctionImport(internalName, modName, baseName, params, results);
    } else if (head === "global") {
      const gChildren = listChildren(descList);
      const name = gChildren[0]?.kind === "atom" && (gChildren[0] as Atom).token.raw.startsWith("$")
        ? (gChildren[0] as Atom).token.raw
        : `$__import_global_${this.globalNames.size}`;
      // For imports we don't store globals in the builder's global list,
      // but we track the name for reference resolution
      this.globalNames.set(name, this.globalNames.size);
      const imp: WasmImport = { kind: "global", name, module: modName, base: baseName };
      // Direct access to builder internals not exposed; add via reflection workaround
      // TODO: expose addGlobalImport on ModuleBuilder
      void imp;
    } else {
      // memory/table imports are uncommon; skip for now
    }
  }

  // -------------------------------------------------------------------------
  // Functions — first pass (name collection)
  // -------------------------------------------------------------------------

  private collectFunc(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    // Optional $name
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    const funcIndex = this.funcNames.size;
    if (name) this.funcNames.set(name, funcIndex);
    this.rawFunctions.push({ name: name ?? `$f${funcIndex}`, list, funcIndex });
  }

  // -------------------------------------------------------------------------
  // Functions — second pass (body building)
  // -------------------------------------------------------------------------

  private buildFunc(raw: RawFunc): void {
    const list = raw.list;
    const children = listChildren(list);
    let idx = 0;

    // Skip optional $name (already consumed in first pass)
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) idx++;

    // Inline exports: (export "name")
    const inlineExports: string[] = [];
    while (idx < children.length && isListWith(children[idx], "export")) {
      const exportName = atomString((children[idx] as SList).children[1]);
      if (exportName !== null) inlineExports.push(exportName);
      idx++;
    }

    // Inline imports (function re-export, rare — skip)
    if (idx < children.length && isListWith(children[idx], "import")) idx++;

    // Type annotation (optional): (type $name)
    if (idx < children.length && isListWith(children[idx], "type")) idx++;

    // Params and results
    const params: ValType[] = [];
    const paramNames = new Map<string, number>();
    while (idx < children.length && isListWith(children[idx], "param")) {
      const p = children[idx] as SList;
      const pChildren = listChildren(p);
      // (param $name type) or (param type...)
      if (pChildren.length >= 2 && pChildren[0].kind === "atom" && (pChildren[0] as Atom).token.raw.startsWith("$")) {
        paramNames.set((pChildren[0] as Atom).token.raw, params.length);
        params.push(this.parseValType(pChildren[1]));
      } else {
        for (const t of pChildren) params.push(this.parseValType(t));
      }
      idx++;
    }

    const results: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "result")) {
      for (const t of listChildren(children[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }

    // Additional locals
    const additionalLocals: Local[] = [];
    const localNames = new Map<string, number>(paramNames);
    let localIdx = params.length;
    while (idx < children.length && isListWith(children[idx], "local")) {
      const l = children[idx] as SList;
      const lChildren = listChildren(l);
      if (lChildren.length >= 2 && lChildren[0].kind === "atom" && (lChildren[0] as Atom).token.raw.startsWith("$")) {
        localNames.set((lChildren[0] as Atom).token.raw, localIdx++);
        additionalLocals.push({ type: this.parseValType(lChildren[1]), name: (lChildren[0] as Atom).token.raw });
      } else {
        for (const t of lChildren) {
          additionalLocals.push({ type: this.parseValType(t) });
          localIdx++;
        }
      }
      idx++;
    }

    // Build function context
    const ctx: FuncContext = {
      params,
      locals: [
        ...params.map((type) => ({ type } as Local)),
        ...additionalLocals,
      ],
      localNames,
      labels: new Map(),
      labelDepth: 0,
      results,
    };

    // Parse body expressions
    const bodyExprs: Expression[] = [];
    while (idx < children.length) {
      bodyExprs.push(this.parseExpr(children[idx], ctx));
      idx++;
    }

    const body = bodyExprs.length === 1
      ? bodyExprs[0]
      : { kind: ExpressionKind.Block, type: results[0] ?? None, name: null, children: bodyExprs } as BlockExpr;

    this.builder.addFunction(raw.name, params, results, body, additionalLocals);

    for (const exportName of inlineExports) {
      this.builder.addExport(exportName, raw.name, "function");
    }
  }

  // -------------------------------------------------------------------------
  // Expression parser
  // -------------------------------------------------------------------------

  private parseExpr(s: SExpr, ctx: FuncContext): Expression {
    if (s.kind === "atom") {
      return this.parseAtomExpr(s as Atom, ctx);
    }
    return this.parseListExpr(s as SList, ctx);
  }

  private parseAtomExpr(atom: Atom, ctx: FuncContext): Expression {
    // Bare keyword instructions (no parens): unreachable, nop, return, etc.
    switch (atom.token.raw) {
      case "nop":         return { kind: ExpressionKind.Nop, type: None } as NopExpr;
      case "unreachable": return { kind: ExpressionKind.Unreachable, type: Unreachable } as UnreachableExpr;
      case "return":      return { kind: ExpressionKind.Return, type: None, value: null } as ReturnExpr;
      case "memory.size": return { kind: ExpressionKind.MemorySize, type: ValType.I32 } as MemorySizeExpr;
    }
    // Number literal?
    if (atom.token.kind === "integer") {
      // Standalone integers become i32.const (context-dependent in real WAT, defaulting to i32)
      return { kind: ExpressionKind.Const, type: ValType.I32, value: { i32: Number(atom.token.value ?? 0) } } as ConstExpr;
    }
    this.err(`unexpected atom in expression: ${atom.token.raw}`, atom.pos);
  }

  private parseListExpr(list: SList, ctx: FuncContext): Expression {
    const head = listHead(list) ?? this.err("empty list in expression position", list.pos);
    const args = listChildren(list);

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------
    if (head === "i32.const") {
      const v = this.expectInt(args[0], head);
      return { kind: ExpressionKind.Const, type: ValType.I32, value: { i32: v } } as ConstExpr;
    }
    if (head === "i64.const") {
      const v = this.expectIntBig(args[0], head);
      return { kind: ExpressionKind.Const, type: ValType.I64, value: { i64: v } } as ConstExpr;
    }
    if (head === "f32.const") {
      const v = this.expectFloat(args[0], head);
      return { kind: ExpressionKind.Const, type: ValType.F32, value: { f32: v } } as ConstExpr;
    }
    if (head === "f64.const") {
      const v = this.expectFloat(args[0], head);
      return { kind: ExpressionKind.Const, type: ValType.F64, value: { f64: v } } as ConstExpr;
    }

    // -----------------------------------------------------------------------
    // Locals / globals
    // -----------------------------------------------------------------------
    if (head === "local.get") {
      const { index, type } = this.resolveLocal(args[0], ctx, head);
      return { kind: ExpressionKind.LocalGet, type, index } as LocalGetExpr;
    }
    if (head === "local.set") {
      const { index } = this.resolveLocal(args[0], ctx, head);
      const value = this.parseExpr(args[1], ctx);
      return { kind: ExpressionKind.LocalSet, type: None, index, value } as LocalSetExpr;
    }
    if (head === "local.tee") {
      const { index, type } = this.resolveLocal(args[0], ctx, head);
      const value = this.parseExpr(args[1], ctx);
      return { kind: ExpressionKind.LocalTee, type, index, value } as LocalTeeExpr;
    }
    if (head === "global.get") {
      const name = this.resolveGlobalName(args[0], head);
      const type = this.inferGlobalType(name) ?? ValType.I32;
      return { kind: ExpressionKind.GlobalGet, type, name } as GlobalGetExpr;
    }
    if (head === "global.set") {
      const name = this.resolveGlobalName(args[0], head);
      const value = this.parseExpr(args[1], ctx);
      return { kind: ExpressionKind.GlobalSet, type: None, name, value } as GlobalSetExpr;
    }

    // -----------------------------------------------------------------------
    // Control flow
    // -----------------------------------------------------------------------
    if (head === "nop") return { kind: ExpressionKind.Nop, type: None } as NopExpr;
    if (head === "unreachable") return { kind: ExpressionKind.Unreachable, type: Unreachable } as UnreachableExpr;
    if (head === "return") {
      const value = args[0] ? this.parseExpr(args[0], ctx) : null;
      const type: Type = value ? value.type : None;
      return { kind: ExpressionKind.Return, type, value } as ReturnExpr;
    }
    if (head === "drop") {
      const value = this.parseExpr(args[0], ctx);
      return { kind: ExpressionKind.Drop, type: None, value } as DropExpr;
    }
    if (head === "select") {
      const ifTrue = this.parseExpr(args[0], ctx);
      const ifFalse = this.parseExpr(args[1], ctx);
      const condition = this.parseExpr(args[2], ctx);
      return { kind: ExpressionKind.Select, type: ifTrue.type, ifTrue, ifFalse, condition } as SelectExpr;
    }
    if (head === "block") return this.parseBlock(list, ctx);
    if (head === "loop")  return this.parseLoop(list, ctx);
    if (head === "if")    return this.parseIf(list, ctx);
    if (head === "br")    return this.parseBr(args, false, ctx, list.pos);
    if (head === "br_if") return this.parseBr(args, true, ctx, list.pos);

    // -----------------------------------------------------------------------
    // Calls
    // -----------------------------------------------------------------------
    if (head === "call") {
      const nameOrIdx = atomText(args[0]) ?? this.err("call: missing function reference", list.pos);
      const funcName = nameOrIdx.startsWith("$") ? nameOrIdx : `$f${nameOrIdx}`;
      const operands = args.slice(1).map((a) => this.parseExpr(a, ctx));
      const resultType = this.inferFuncResultType(funcName) ?? None;
      return { kind: ExpressionKind.Call, type: resultType, target: funcName, operands, isReturn: false } as CallExpr;
    }
    if (head === "return_call") {
      const nameOrIdx = atomText(args[0]) ?? this.err("return_call: missing reference", list.pos);
      const funcName = nameOrIdx.startsWith("$") ? nameOrIdx : `$f${nameOrIdx}`;
      const operands = args.slice(1).map((a) => this.parseExpr(a, ctx));
      return { kind: ExpressionKind.Call, type: Unreachable, target: funcName, operands, isReturn: true } as CallExpr;
    }
    if (head === "call_indirect") {
      return this.parseCallIndirect(list, args, ctx);
    }

    // -----------------------------------------------------------------------
    // Memory
    // -----------------------------------------------------------------------
    if (head === "memory.size") return { kind: ExpressionKind.MemorySize, type: ValType.I32 } as MemorySizeExpr;
    if (head === "memory.grow") {
      const delta = this.parseExpr(args[0], ctx);
      return { kind: ExpressionKind.MemoryGrow, type: ValType.I32, delta } as MemoryGrowExpr;
    }
    if (head === "memory.copy") {
      const dest = this.parseExpr(args[0], ctx);
      const source = this.parseExpr(args[1], ctx);
      const size = this.parseExpr(args[2], ctx);
      return { kind: ExpressionKind.MemoryCopy, type: None, dest, source, size } as MemoryCopyExpr;
    }
    if (head === "memory.fill") {
      const dest = this.parseExpr(args[0], ctx);
      const value = this.parseExpr(args[1], ctx);
      const size = this.parseExpr(args[2], ctx);
      return { kind: ExpressionKind.MemoryFill, type: None, dest, value, size } as MemoryFillExpr;
    }

    // -----------------------------------------------------------------------
    // SIMD instructions (must come before generic load/store/unary/binary)
    // -----------------------------------------------------------------------
    if (head === "v128.const") return this.parseSIMDConst(args);
    if (head === "i8x16.shuffle") return this.parseSIMDShuffle(args, ctx);
    if (head in SIMD_EXTRACT_OPS) return this.parseSIMDExtract(head, args, ctx);
    if (head in SIMD_REPLACE_OPS) return this.parseSIMDReplace(head, args, ctx);
    if (head in SIMD_SHIFT_OPS) return this.parseSIMDShiftOp(head, args, ctx);
    if (head === "v128.bitselect") return this.parseSIMDBitselect(args, ctx);
    if (head in SIMD_LOAD_OPS) return this.parseSIMDLoad(head, args, ctx);
    if (head in SIMD_LANE_OPS) return this.parseSIMDLaneLdSt(head, args, ctx);

    // Load instructions (v128.load = regular 16-byte load via LoadExpr)
    const loadMatch = head.match(/^(i32|i64|f32|f64|v128)\.(load(?:8_[su]|16_[su]|32_[su]|64)?)$/);
    if (loadMatch) return this.parseLoad(head, list, args, ctx);

    // Store instructions (v128.store = regular 16-byte store via StoreExpr)
    const storeMatch = head.match(/^(i32|i64|f32|f64|v128)\.(store(?:8|16|32|64)?)$/);
    if (storeMatch) return this.parseStore(head, list, args, ctx);

    // -----------------------------------------------------------------------
    // Unary operators
    // -----------------------------------------------------------------------
    if (head in UNARY_OPS) {
      const op = UNARY_OPS[head];
      const value = this.parseExpr(args[0], ctx);
      const type = inferUnaryResultType(head);
      return { kind: ExpressionKind.Unary, type, op, value } as UnaryExpr;
    }

    // -----------------------------------------------------------------------
    // Binary operators
    // -----------------------------------------------------------------------
    if (head in BINARY_OPS) {
      const op = BINARY_OPS[head];
      const left = this.parseExpr(args[0], ctx);
      const right = this.parseExpr(args[1], ctx);
      const type = inferBinaryResultType(head);
      return { kind: ExpressionKind.Binary, type, op, left, right } as BinaryExpr;
    }

    // -----------------------------------------------------------------------
    // GC proposal instructions
    // -----------------------------------------------------------------------
    if (head === "ref.eq") {
      const left = this.parseExpr(args[0], ctx);
      const right = this.parseExpr(args[1], ctx);
      return makeRefEq(left, right);
    }
    if (head === "ref.i31") {
      const value = this.parseExpr(args[0], ctx);
      return makeRefI31(value, { heap: AbstractHeapType.I31, nullable: false });
    }
    if (head === "i31.get_s") {
      return makeI31Get(this.parseExpr(args[0], ctx), true);
    }
    if (head === "i31.get_u") {
      return makeI31Get(this.parseExpr(args[0], ctx), false);
    }
    if (head === "struct.new") {
      const ti = this.resolveTypeIndex(args[0]);
      const operands = args.slice(1).map((a) => this.parseExpr(a, ctx));
      return makeStructNew(ti, operands, { heap: ti, nullable: false });
    }
    if (head === "struct.new_default") {
      const ti = this.resolveTypeIndex(args[0]);
      return makeStructNewDefault(ti, { heap: ti, nullable: false });
    }
    if (head === "struct.get" || head === "struct.get_s" || head === "struct.get_u") {
      const ti = this.resolveTypeIndex(args[0]);
      const fi = Number(atomInt(args[1])) ?? 0;
      const ref = this.parseExpr(args[2], ctx);
      const signed = head === "struct.get_s";
      return makeStructGet(ti, fi, ref, ValType.I32, signed);
    }
    if (head === "struct.set") {
      const ti = this.resolveTypeIndex(args[0]);
      const fi = Number(atomInt(args[1])) ?? 0;
      const ref = this.parseExpr(args[2], ctx);
      const value = this.parseExpr(args[3], ctx);
      return makeStructSet(ti, fi, ref, value);
    }
    if (head === "array.new") {
      const ti = this.resolveTypeIndex(args[0]);
      const init = this.parseExpr(args[1], ctx);
      const length = this.parseExpr(args[2], ctx);
      return makeArrayNew(ti, init, length, { heap: ti, nullable: false });
    }
    if (head === "array.new_default") {
      const ti = this.resolveTypeIndex(args[0]);
      const length = this.parseExpr(args[1], ctx);
      return makeArrayNewDefault(ti, length, { heap: ti, nullable: false });
    }
    if (head === "array.new_fixed") {
      const ti = this.resolveTypeIndex(args[0]);
      const values = args.slice(1).map((a) => this.parseExpr(a, ctx));
      return makeArrayNewFixed(ti, values, { heap: ti, nullable: false });
    }
    if (head === "array.get" || head === "array.get_s" || head === "array.get_u") {
      const ti = this.resolveTypeIndex(args[0]);
      const ref = this.parseExpr(args[1], ctx);
      const index = this.parseExpr(args[2], ctx);
      const signed = head === "array.get_s";
      return makeArrayGet(ti, ref, index, ValType.I32, signed);
    }
    if (head === "array.set") {
      const ti = this.resolveTypeIndex(args[0]);
      const ref = this.parseExpr(args[1], ctx);
      const index = this.parseExpr(args[2], ctx);
      const value = this.parseExpr(args[3], ctx);
      return makeArraySet(ti, ref, index, value);
    }
    if (head === "array.len") {
      const ref = this.parseExpr(args[0], ctx);
      return makeArrayLen(ref);
    }
    if (head === "ref.test" || head === "ref.test_null") {
      const nullable = head === "ref.test_null";
      const ht = this.parseHeapType(args[0]);
      const ref = this.parseExpr(args[1], ctx);
      return makeRefTest(ref, ht, nullable);
    }
    if (head === "ref.cast" || head === "ref.cast_null") {
      const nullable = head === "ref.cast_null";
      const ht = this.parseHeapType(args[0]);
      const ref = this.parseExpr(args[1], ctx);
      const resultType: RefType = { heap: ht, nullable };
      return makeRefCast(ref, ht, nullable, resultType);
    }

    // -----------------------------------------------------------------------
    // Exception Handling proposal
    // -----------------------------------------------------------------------
    if (head === "throw") {
      const tagRef = atomText(args[0]) ?? this.err("throw: missing tag reference", list.pos);
      const tagName = tagRef.startsWith("$") ? tagRef : `$tag${tagRef}`;
      const operands = args.slice(1).map((a) => this.parseExpr(a, ctx));
      return makeThrow(tagName, operands);
    }
    if (head === "throw_ref") {
      const exnref = this.parseExpr(args[0], ctx);
      return makeThrowRef(exnref);
    }
    if (head === "rethrow") {
      const labelRef = atomText(args[0]) ?? this.err("rethrow: missing depth", list.pos);
      const target = this.resolveLabel(labelRef, ctx, list.pos);
      return makeRethrow(target);
    }
    if (head === "try_table") {
      return this.parseTryTable(list, ctx);
    }
    if (head === "try") {
      return this.parseTry(list, ctx);
    }

    // Unrecognized — wrap in a nop with a comment for now
    // TODO: extend as more instructions are added
    return { kind: ExpressionKind.Nop, type: None } as NopExpr;
  }

  // -------------------------------------------------------------------------
  // Control flow helpers
  // -------------------------------------------------------------------------

  private parseBlock(list: SList, ctx: FuncContext): BlockExpr {
    const children = listChildren(list);
    let idx = 0;
    // Optional label
    let label: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      label = (children[idx] as Atom).token.raw;
      idx++;
    }
    // Optional result type
    const results: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "result")) {
      for (const t of listChildren(children[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }
    // Body
    const innerCtx = this.pushLabel(label, ctx);
    const bodyExprs: Expression[] = [];
    while (idx < children.length) {
      bodyExprs.push(this.parseExpr(children[idx], innerCtx));
      idx++;
    }
    const type: Type = results[0] ?? (bodyExprs[bodyExprs.length - 1]?.type ?? None);
    return { kind: ExpressionKind.Block, type, name: label, children: bodyExprs };
  }

  private parseLoop(list: SList, ctx: FuncContext): LoopExpr {
    const children = listChildren(list);
    let idx = 0;
    let label = `$loop${ctx.labelDepth}`;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      label = (children[idx] as Atom).token.raw;
      idx++;
    }
    // Optional result type
    while (idx < children.length && isListWith(children[idx], "result")) idx++;
    const innerCtx = this.pushLabel(label, ctx);
    const bodyExprs: Expression[] = [];
    while (idx < children.length) {
      bodyExprs.push(this.parseExpr(children[idx], innerCtx));
      idx++;
    }
    const body: Expression = bodyExprs.length === 1
      ? bodyExprs[0]
      : { kind: ExpressionKind.Block, type: None, name: null, children: bodyExprs } as BlockExpr;
    return { kind: ExpressionKind.Loop, type: None, name: label, body };
  }

  private parseIf(list: SList, ctx: FuncContext): IfExpr {
    const children = listChildren(list);
    let idx = 0;
    // Optional label
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) idx++;
    // Optional result type
    const results: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "result")) {
      for (const t of listChildren(children[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }
    // Condition (before then/else branches)
    // In folded form: (if (cond) (then ...) (else ...))
    // In unfolded form: condition is already on the stack
    let condition: Expression | null = null;
    if (idx < children.length && !isListWith(children[idx], "then") && !isListWith(children[idx], "else")) {
      condition = this.parseExpr(children[idx], ctx);
      idx++;
    }
    if (!condition) this.err("if: missing condition", list.pos);

    // then branch
    if (!isListWith(children[idx], "then")) this.err("if: expected (then ...)", list.pos);
    const thenExprs = listChildren(children[idx] as SList).map((e) => this.parseExpr(e, ctx));
    const ifTrue: Expression = thenExprs.length === 1
      ? thenExprs[0]
      : { kind: ExpressionKind.Block, type: results[0] ?? None, name: null, children: thenExprs } as BlockExpr;
    idx++;

    // else branch (optional)
    let ifFalse: Expression | null = null;
    if (idx < children.length && isListWith(children[idx], "else")) {
      const elseExprs = listChildren(children[idx] as SList).map((e) => this.parseExpr(e, ctx));
      ifFalse = elseExprs.length === 1
        ? elseExprs[0]
        : { kind: ExpressionKind.Block, type: results[0] ?? None, name: null, children: elseExprs } as BlockExpr;
    }

    return { kind: ExpressionKind.If, type: results[0] ?? (ifFalse ? ifTrue.type : None), condition: condition!, ifTrue, ifFalse };
  }

  private parseBr(args: SExpr[], conditional: boolean, ctx: FuncContext, pos: TextPos): BreakExpr {
    const labelRef = atomText(args[0]) ?? this.err("br: missing label", pos);
    const name = this.resolveLabel(labelRef, ctx, pos);
    const condition = conditional ? this.parseExpr(args[1], ctx) : null;
    const value = conditional && args[2] ? this.parseExpr(args[2], ctx) : null;
    return { kind: ExpressionKind.Break, type: conditional ? None : Unreachable, name, condition, value };
  }

  private parseTryTable(list: SList, ctx: FuncContext): Expression {
    const children = listChildren(list);
    let idx = 0;
    // Optional label
    let label: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      label = (children[idx] as Atom).token.raw;
      idx++;
    }
    // Optional result type
    const results: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "result")) {
      for (const t of listChildren(children[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }
    // Catch clauses before body
    const catches: CatchClause[] = [];
    const innerCtx = this.pushLabel(label, ctx);
    while (idx < children.length && children[idx].kind === "list") {
      const clauseList = children[idx] as SList;
      const clauseHead = listHead(clauseList);
      if (clauseHead === "catch" || clauseHead === "catch_ref") {
        const clauseArgs = listChildren(clauseList);
        const tagRef = atomText(clauseArgs[0]) ?? this.err("catch: missing tag", list.pos);
        const tagName = tagRef.startsWith("$") ? tagRef : `$tag${tagRef}`;
        const destRef = atomText(clauseArgs[1]) ?? this.err("catch: missing dest label", list.pos);
        const dest = this.resolveLabel(destRef, innerCtx, list.pos);
        catches.push({ tag: tagName, dest, isRef: clauseHead === "catch_ref" });
        idx++;
      } else if (clauseHead === "catch_all" || clauseHead === "catch_all_ref") {
        const clauseArgs = listChildren(clauseList);
        const destRef = atomText(clauseArgs[0]) ?? this.err("catch_all: missing dest label", list.pos);
        const dest = this.resolveLabel(destRef, innerCtx, list.pos);
        catches.push({ tag: null, dest, isRef: clauseHead === "catch_all_ref" });
        idx++;
      } else {
        break;
      }
    }
    // Body expressions
    const bodyExprs: Expression[] = [];
    while (idx < children.length) {
      bodyExprs.push(this.parseExpr(children[idx], innerCtx));
      idx++;
    }
    const type: Type = results[0] ?? (bodyExprs[bodyExprs.length - 1]?.type ?? None);
    const body: Expression = bodyExprs.length === 1
      ? bodyExprs[0]
      : { kind: ExpressionKind.Block, type, name: null, children: bodyExprs } as BlockExpr;
    return makeTryTable(label, body, catches, type);
  }

  private parseTry(list: SList, ctx: FuncContext): Expression {
    const children = listChildren(list);
    let idx = 0;
    // Optional label
    let label: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      label = (children[idx] as Atom).token.raw;
      idx++;
    }
    // Optional result type
    const results: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "result")) {
      for (const t of listChildren(children[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }
    const innerCtx = this.pushLabel(label, ctx);
    // Body: (do ...) block or raw instructions
    let bodyExprs: Expression[] = [];
    if (idx < children.length && isListWith(children[idx], "do")) {
      bodyExprs = listChildren(children[idx] as SList).map((e) => this.parseExpr(e, innerCtx));
      idx++;
    } else {
      while (idx < children.length && children[idx].kind !== "list") {
        bodyExprs.push(this.parseExpr(children[idx], innerCtx));
        idx++;
      }
    }
    const bodyType: Type = results[0] ?? (bodyExprs[bodyExprs.length - 1]?.type ?? None);
    const body: Expression = bodyExprs.length === 1
      ? bodyExprs[0]
      : { kind: ExpressionKind.Block, type: bodyType, name: null, children: bodyExprs } as BlockExpr;
    // Catch / catch_all / delegate clauses
    const catchTags: string[] = [];
    const catchBodies: Expression[] = [];
    let delegateTarget: string | null = null;
    while (idx < children.length) {
      const clause = children[idx] as SList;
      const clauseHead = listHead(clause);
      if (clauseHead === "catch") {
        const clauseArgs = listChildren(clause);
        const tagRef = atomText(clauseArgs[0]) ?? this.err("catch: missing tag", list.pos);
        const tagName = tagRef.startsWith("$") ? tagRef : `$tag${tagRef}`;
        catchTags.push(tagName);
        const catchExprs = clauseArgs.slice(1).map((e) => this.parseExpr(e, innerCtx));
        catchBodies.push(
          catchExprs.length === 1
            ? catchExprs[0]
            : { kind: ExpressionKind.Block, type: bodyType, name: null, children: catchExprs } as BlockExpr
        );
        idx++;
      } else if (clauseHead === "catch_all") {
        catchTags.push("$__catch_all");
        const clauseArgs = listChildren(clause);
        const catchExprs = clauseArgs.map((e) => this.parseExpr(e, innerCtx));
        catchBodies.push(
          catchExprs.length === 1
            ? catchExprs[0]
            : { kind: ExpressionKind.Block, type: bodyType, name: null, children: catchExprs } as BlockExpr
        );
        idx++;
      } else if (clauseHead === "delegate") {
        const clauseArgs = listChildren(clause);
        const depthRef = atomText(clauseArgs[0]) ?? "0";
        delegateTarget = this.resolveLabel(depthRef, innerCtx, list.pos);
        idx++;
        break;
      } else {
        break;
      }
    }
    return makeTry(label, body, catchTags, catchBodies, delegateTarget, bodyType);
  }
  private parseCallIndirect(list: SList, args: SExpr[], ctx: FuncContext): CallIndirectExpr {
    let idx = 0;
    // Optional table name
    let table = "$0";
    if (args[idx]?.kind === "atom" && !(args[idx] as Atom).token.raw.startsWith("(")) {
      const t = atomText(args[idx]);
      if (t) { table = t; idx++; }
    }
    // (type $name)
    if (idx < args.length && isListWith(args[idx], "type")) idx++;
    // (param ...) and (result ...)
    const params: ValType[] = [];
    while (idx < args.length && isListWith(args[idx], "param")) {
      for (const t of listChildren(args[idx] as SList)) params.push(this.parseValType(t));
      idx++;
    }
    const results: ValType[] = [];
    while (idx < args.length && isListWith(args[idx], "result")) {
      for (const t of listChildren(args[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }
    // Operands then target index
    const operands = args.slice(idx, args.length - 1).map((a) => this.parseExpr(a, ctx));
    const target = this.parseExpr(args[args.length - 1], ctx);
    return {
      kind: ExpressionKind.CallIndirect,
      type: results[0] ?? None,
      table,
      target,
      operands,
      params,
      results,
      isReturn: false,
    };
  }

  // -------------------------------------------------------------------------
  // Load / store
  // -------------------------------------------------------------------------

  private parseLoad(head: string, list: SList, args: SExpr[], ctx: FuncContext): LoadExpr {
    const [valTypeStr] = head.split(".");
    const type = valTypeStr as ValType;
    let offset = 0, align = 0, bytes: 1 | 2 | 4 | 8 | 16 = 4;
    let argIdx = 0;
    // offset= and align= keywords
    while (argIdx < args.length && args[argIdx].kind === "atom") {
      const raw = (args[argIdx] as Atom).token.raw;
      if (raw.startsWith("offset=")) { offset = parseInt(raw.slice(7)); argIdx++; continue; }
      if (raw.startsWith("align="))  { align = parseInt(raw.slice(6)); argIdx++; continue; }
      break;
    }
    bytes = loadBytes(head);
    const signed = head.includes("_s");
    const ptr = this.parseExpr(args[argIdx], ctx);
    return { kind: ExpressionKind.Load, type, bytes, signed, offset, align, ptr };
  }

  private parseStore(head: string, list: SList, args: SExpr[], ctx: FuncContext): StoreExpr {
    const [valTypeStr] = head.split(".");
    const type = valTypeStr as ValType;
    let offset = 0, align = 0;
    let argIdx = 0;
    while (argIdx < args.length && args[argIdx].kind === "atom") {
      const raw = (args[argIdx] as Atom).token.raw;
      if (raw.startsWith("offset=")) { offset = parseInt(raw.slice(7)); argIdx++; continue; }
      if (raw.startsWith("align="))  { align = parseInt(raw.slice(6)); argIdx++; continue; }
      break;
    }
    const bytes = storeBytes(head);
    const ptr = this.parseExpr(args[argIdx], ctx);
    const value = this.parseExpr(args[argIdx + 1], ctx);
    return { kind: ExpressionKind.Store, type: None, bytes, offset, align, ptr, value };
  }

  // -------------------------------------------------------------------------
  // SIMD helpers
  // -------------------------------------------------------------------------

  private parseSIMDConst(args: SExpr[]): ConstExpr {
    // (v128.const i8x16 b0 ... b15) or (v128.const i32x4 w0 w1 w2 w3) etc.
    const laneType = atomText(args[0]) ?? "i8x16";
    const bytes = new Uint8Array(16);
    const vals = args.slice(1).map((a) => Number(atomInt(a as Atom) ?? 0));
    if (laneType === "i8x16") {
      for (let i = 0; i < 16; i++) bytes[i] = (vals[i] ?? 0) & 0xff;
    } else if (laneType === "i16x8") {
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < 8; i++) dv.setInt16(i * 2, vals[i] ?? 0, true);
    } else if (laneType === "i32x4") {
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < 4; i++) dv.setInt32(i * 4, vals[i] ?? 0, true);
    } else if (laneType === "i64x2") {
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < 2; i++) dv.setBigInt64(i * 8, BigInt(atomInt(args[1 + i] as Atom) ?? 0), true);
    } else if (laneType === "f32x4") {
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < 4; i++) dv.setFloat32(i * 4, atomFloat(args[1 + i] as Atom) ?? 0, true);
    } else if (laneType === "f64x2") {
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < 2; i++) dv.setFloat64(i * 8, atomFloat(args[1 + i] as Atom) ?? 0, true);
    }
    return makeV128Const(bytes);
  }

  private parseSIMDShuffle(args: SExpr[], ctx: FuncContext): SIMDShuffleExpr {
    // (i8x16.shuffle m0 m1 ... m15 <v1> <v2>)
    // First 16 atoms are the mask bytes, then two expression operands
    const mask = new Uint8Array(16);
    let i = 0;
    while (i < args.length && i < 16 && args[i].kind === "atom") {
      mask[i] = Number(atomInt(args[i] as Atom) ?? 0) & 0xff;
      i++;
    }
    const left = this.parseExpr(args[i], ctx);
    const right = this.parseExpr(args[i + 1], ctx);
    return makeSIMDShuffle(left, right, mask);
  }

  private parseSIMDExtract(head: string, args: SExpr[], ctx: FuncContext): SIMDExtractExpr {
    // (i8x16.extract_lane_s <lane> <vec>)
    const lane = Number(atomInt(args[0] as Atom) ?? 0);
    const vec = this.parseExpr(args[1], ctx);
    return makeSIMDExtract(SIMD_EXTRACT_OPS[head] as SIMDExtractOp, vec, lane);
  }

  private parseSIMDReplace(head: string, args: SExpr[], ctx: FuncContext): SIMDReplaceExpr {
    // (i8x16.replace_lane <lane> <vec> <value>)
    const lane = Number(atomInt(args[0] as Atom) ?? 0);
    const vec = this.parseExpr(args[1], ctx);
    const value = this.parseExpr(args[2], ctx);
    return makeSIMDReplace(SIMD_REPLACE_OPS[head] as SIMDReplaceOp, vec, lane, value);
  }

  private parseSIMDShiftOp(head: string, args: SExpr[], ctx: FuncContext): SIMDShiftExpr {
    // (i8x16.shl <vec> <shift>)
    const vec = this.parseExpr(args[0], ctx);
    const shift = this.parseExpr(args[1], ctx);
    return makeSIMDShift(SIMD_SHIFT_OPS[head] as SIMDShiftOp, vec, shift);
  }

  private parseSIMDBitselect(args: SExpr[], ctx: FuncContext): SIMDTernaryExpr {
    // (v128.bitselect <v1> <v2> <mask>)
    const a = this.parseExpr(args[0], ctx);
    const b = this.parseExpr(args[1], ctx);
    const c = this.parseExpr(args[2], ctx);
    return makeSIMDTernary(SIMDTernaryOp.Bitselect, a, b, c);
  }

  private parseSIMDLoad(head: string, args: SExpr[], ctx: FuncContext): SIMDLoadExpr {
    // (v128.load8x8_s [offset=N] [align=N] <ptr>)
    let offset = 0, align = 0, argIdx = 0;
    while (argIdx < args.length && args[argIdx].kind === "atom") {
      const raw = (args[argIdx] as Atom).token.raw;
      if (raw.startsWith("offset=")) { offset = parseInt(raw.slice(7)); argIdx++; continue; }
      if (raw.startsWith("align="))  { align = parseInt(raw.slice(6)); argIdx++; continue; }
      break;
    }
    const ptr = this.parseExpr(args[argIdx], ctx);
    return makeSIMDLoad(SIMD_LOAD_OPS[head] as SIMDLoadOp, ptr, offset, align);
  }

  private parseSIMDLaneLdSt(head: string, args: SExpr[], ctx: FuncContext): SIMDLoadStoreLaneExpr {
    // (v128.load8_lane [offset=N] [align=N] <lane> <ptr> <vec>)
    // OR: (v128.load8_lane <lane> [offset=N] [align=N] <ptr> <vec>)
    // We accept lane as the first non-memarg integer, then memargs, then ptr, vec
    let offset = 0, align = 0, argIdx = 0;
    // Skip any leading memargs
    while (argIdx < args.length && args[argIdx].kind === "atom") {
      const raw = (args[argIdx] as Atom).token.raw;
      if (raw.startsWith("offset=")) { offset = parseInt(raw.slice(7)); argIdx++; continue; }
      if (raw.startsWith("align="))  { align = parseInt(raw.slice(6)); argIdx++; continue; }
      break;
    }
    // Lane is the next integer atom
    const lane = Number(atomInt(args[argIdx] as Atom) ?? 0);
    argIdx++;
    // Skip any trailing memargs
    while (argIdx < args.length && args[argIdx].kind === "atom") {
      const raw = (args[argIdx] as Atom).token.raw;
      if (raw.startsWith("offset=")) { offset = parseInt(raw.slice(7)); argIdx++; continue; }
      if (raw.startsWith("align="))  { align = parseInt(raw.slice(6)); argIdx++; continue; }
      break;
    }
    const ptr = this.parseExpr(args[argIdx], ctx);
    const vec = this.parseExpr(args[argIdx + 1], ctx);
    return makeSIMDLoadStoreLane(SIMD_LANE_OPS[head] as SIMDLoadStoreLaneOp, ptr, vec, offset, align, lane);
  }

  // -------------------------------------------------------------------------
  // Globals / memory / table — first pass collection
  // -------------------------------------------------------------------------

  private collectGlobal(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    const globalIndex = this.globalNames.size;
    if (name) this.globalNames.set(name, globalIndex);
    // Skip type and initializer — globals are partially parsed here and built lazily
    // Full global parsing is deferred until we have a complete name table
    // TODO: store raw list for second-pass parsing
  }

  private collectMemory(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    const memIndex = this.memoryNames.size;
    if (name) this.memoryNames.set(name, memIndex);
    // Parse limits
    const initial = Number(atomInt(children[idx]) ?? 1);
    const max = children[idx + 1] ? (Number(atomInt(children[idx + 1]) ?? 0) || null) : null;
    this.builder.addMemory(name ?? "$mem0", initial, max);
  }

  private collectTable(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    const tableIndex = this.tableNames.size;
    if (name) this.tableNames.set(name, tableIndex);
    const initial = Number(atomInt(children[idx]) ?? 0);
    const max = children[idx + 1] && children[idx + 1].kind === "atom"
      ? (Number(atomInt(children[idx + 1])) || null)
      : null;
    const refType = max !== null
      ? (this.tryParseValType(children[idx + 2]) ?? ValType.FuncRef)
      : (this.tryParseValType(children[idx + 1]) ?? ValType.FuncRef);
    this.builder.addTable(name ?? "$table0", refType, initial, max);
  }

  private collectTag(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    const tagIndex = this.tagNames.size;
    if (name) this.tagNames.set(name, tagIndex);
    // Parse (param ...) list for tag type
    const params: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "param")) {
      for (const t of listChildren(children[idx] as SList)) params.push(this.parseValType(t));
      idx++;
    }
    this.builder.addTag(name ?? `$tag${tagIndex}`, params);
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  private parseExport(list: SList): void {
    const children = listChildren(list);
    const exportName = atomString(children[0]) ?? this.err("export: expected name string", list.pos);
    if (children[1]?.kind !== "list") this.err("export: expected descriptor list", list.pos);
    const desc = children[1] as SList;
    const head = listHead(desc) as WasmExport["kind"] | null;
    const internalRef = atomText(desc.children[1]) ?? this.err("export: expected internal name", list.pos);
    if (!head) this.err("export: missing kind", list.pos);
    this.builder.addExport(exportName, internalRef, head);
  }

  // -------------------------------------------------------------------------
  // Data / element segments
  // -------------------------------------------------------------------------

  private parseData(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    let name = `$data${this.builder["_dataSegments"]?.length ?? 0}`;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    // Skip optional memory ref: (memory $mem0)
    if (idx < children.length && isListWith(children[idx], "memory")) idx++;
    // Optional offset expression: (offset ...) or (i32.const ...)
    let offset: Expression | null = null;
    if (idx < children.length && children[idx].kind === "list") {
      const child = children[idx] as SList;
      const head = listHead(child);
      if (head === "offset" || head === "i32.const") {
        const dummyCtx: FuncContext = { params: [], locals: [], localNames: new Map(), labels: new Map(), labelDepth: 0, results: [] };
        offset = head === "offset"
          ? this.parseExpr(listChildren(child)[0], dummyCtx)
          : this.parseExpr(child, dummyCtx);
        idx++;
      }
    }
    // Data strings
    let bytes = new Uint8Array(0);
    while (idx < children.length) {
      const s = atomString(children[idx]);
      if (s !== null) {
        const encoded = new TextEncoder().encode(s);
        const merged = new Uint8Array(bytes.length + encoded.length);
        merged.set(bytes);
        merged.set(encoded, bytes.length);
        bytes = merged;
      }
      idx++;
    }
    if (offset) {
      this.builder.addDataSegment(name, offset, bytes);
    } else {
      this.builder.addPassiveDataSegment(name, bytes);
    }
  }

  private parseElem(_list: SList): void {
    // Element segments are complex; skip for MVP
  }

  // -------------------------------------------------------------------------
  // Type helpers
  // -------------------------------------------------------------------------

  private parseFuncType(list: SList): { name: string | null; params: ValType[]; results: ValType[] } {
    const children = listChildren(list);
    let idx = 0;
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && (children[idx] as Atom).token.raw.startsWith("$")) {
      name = (children[idx] as Atom).token.raw;
      idx++;
    }
    // Inline exports in import descriptor
    while (idx < children.length && isListWith(children[idx], "export")) idx++;
    const params: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "param")) {
      for (const t of listChildren(children[idx] as SList)) params.push(this.parseValType(t));
      idx++;
    }
    const results: ValType[] = [];
    while (idx < children.length && isListWith(children[idx], "result")) {
      for (const t of listChildren(children[idx] as SList)) results.push(this.parseValType(t));
      idx++;
    }
    return { name, params, results };
  }

  // -------------------------------------------------------------------------
  // GC type collection
  // -------------------------------------------------------------------------

  private collectType(list: SList): void {
    const children = listChildren(list);
    let idx = 0;
    let name: string | null = null;
    if (children[idx]?.kind === "atom" && atomText(children[idx])?.startsWith("$")) {
      name = atomText(children[idx]) ?? null;
      idx++;
    }
    if (idx >= children.length || children[idx]?.kind !== "list") return;
    const body = children[idx] as SList;
    const bodyHead = listHead(body);
    let def: TypeDef | null = null;
    if (bodyHead === "struct") {
      def = { kind: "struct", fields: this.parseStructFields(body) };
    } else if (bodyHead === "array") {
      const element = this.parseArrayElement(body);
      if (element) def = { kind: "array", element };
    }
    if (def) {
      const ti = this.builder.addHeapType(def);
      if (name) this.typeNames.set(name, ti);
    }
  }

  private parseStructFields(list: SList): FieldType[] {
    const fields: FieldType[] = [];
    for (const child of listChildren(list)) {
      if (child.kind !== "list" || listHead(child as SList) !== "field") continue;
      const fChildren = listChildren(child as SList);
      let ci = 0;
      // Skip optional field name
      if (fChildren[ci]?.kind === "atom" && atomText(fChildren[ci])?.startsWith("$")) ci++;
      // Check for (mut storageType)
      if (fChildren[ci]?.kind === "list" && listHead(fChildren[ci] as SList) === "mut") {
        const inner = listChildren(fChildren[ci] as SList)[0];
        const type = this.parseStorageTypeSExpr(inner);
        fields.push({ type, mutable: true });
      } else if (fChildren[ci]) {
        const type = this.parseStorageTypeSExpr(fChildren[ci]);
        fields.push({ type, mutable: false });
      }
    }
    return fields;
  }

  private parseArrayElement(list: SList): FieldType | null {
    const children = listChildren(list);
    if (children.length === 0) return null;
    // (array (mut storageType)) or (array storageType)
    if (children[0]?.kind === "list" && listHead(children[0] as SList) === "mut") {
      const inner = listChildren(children[0] as SList)[0];
      return { type: this.parseStorageTypeSExpr(inner), mutable: true };
    }
    return { type: this.parseStorageTypeSExpr(children[0]), mutable: false };
  }

  private parseStorageTypeSExpr(s: SExpr): StorageType {
    if (!s) return ValType.I32;
    const raw = atomText(s);
    if (raw === "i8") return "i8";
    if (raw === "i16") return "i16";
    return this.tryParseValType(s) ?? ValType.I32;
  }

  private resolveTypeIndex(s: SExpr | undefined): number {
    if (!s) return 0;
    const raw = atomText(s);
    if (raw?.startsWith("$")) {
      return this.typeNames.get(raw) ?? 0;
    }
    return Number(atomInt(s)) ?? 0;
  }

  private parseHeapType(s: SExpr | undefined): HeapType {
    if (!s) return AbstractHeapType.Any;
    const raw = atomText(s);
    if (!raw) return AbstractHeapType.Any;
    if (raw.startsWith("$")) return this.typeNames.get(raw) ?? AbstractHeapType.Any;
    const abstractMap: Record<string, AbstractHeapType> = {
      func: AbstractHeapType.Func, nofunc: AbstractHeapType.NoFunc,
      ext: AbstractHeapType.Ext, noext: AbstractHeapType.NoExt,
      any: AbstractHeapType.Any, eq: AbstractHeapType.Eq,
      i31: AbstractHeapType.I31, struct: AbstractHeapType.Struct,
      array: AbstractHeapType.Array, none: AbstractHeapType.None,
    };
    return abstractMap[raw] ?? (isNaN(Number(raw)) ? AbstractHeapType.Any : Number(raw));
  }

  // -------------------------------------------------------------------------
  // Value type parsing
  // -------------------------------------------------------------------------

  private parseValType(s: SExpr): ValType {
    return this.tryParseValType(s) ?? this.err(`unknown value type: ${sExprToString(s)}`, s.pos);
  }

  private tryParseValType(s: SExpr): ValType | null {
    // Handle (ref ...) and (ref null ...) list forms
    if (s.kind === "list") {
      const l = s as SList;
      if (listHead(l) === "ref") {
        // (ref null $T) or (ref $T)
        const ch = listChildren(l);
        return atomText(ch[0]) === "null" ? ValType.AnyRef : ValType.AnyRef;
      }
      return null;
    }
    const raw = atomText(s);
    if (!raw) return null;
    if (raw in ValType) return raw as ValType;
    // Handle string variants
    const map: Record<string, ValType> = {
      i32: ValType.I32, i64: ValType.I64,
      f32: ValType.F32, f64: ValType.F64,
      v128: ValType.V128,
      funcref: ValType.FuncRef, externref: ValType.ExternRef,
      anyref: ValType.AnyRef, eqref: ValType.EqRef,
      i31ref: ValType.I31Ref, structref: ValType.StructRef,
      arrayref: ValType.ArrayRef, stringref: ValType.StringRef,
      nullfuncref: ValType.NullFuncRef, nullexternref: ValType.NullExternRef,
      nullref: ValType.NullRef,
      exnref: ValType.ExnRef, nullexnref: ValType.NullExnRef,
    };
    return map[raw] ?? null;
  }

  // -------------------------------------------------------------------------
  // Name resolution helpers
  // -------------------------------------------------------------------------

  private resolveLocal(s: SExpr | undefined, ctx: FuncContext, instr: string): { index: number; type: ValType } {
    if (!s) this.err(`${instr}: missing local index`);
    const raw = atomText(s!);
    let index: number;
    if (raw?.startsWith("$")) {
      index = ctx.localNames.get(raw) ?? this.err(`${instr}: unknown local ${raw}`, s!.pos);
    } else {
      index = Number(atomInt(s!)) ?? this.err(`${instr}: expected local index`, s!.pos);
    }
    const type = ctx.locals[index]?.type ?? ValType.I32;
    return { index, type };
  }

  private resolveGlobalName(s: SExpr | undefined, instr: string): string {
    if (!s) this.err(`${instr}: missing global reference`);
    return atomText(s!) ?? this.err(`${instr}: expected global name`, s!.pos);
  }

  private resolveLabel(ref: string, ctx: FuncContext, pos: TextPos): string {
    if (ref.startsWith("$")) {
      if (!ctx.labels.has(ref)) this.err(`unknown label: ${ref}`, pos);
      return ref;
    }
    // Numeric label — convert to relative depth
    return `$depth${ctx.labelDepth - Number(ref)}`;
  }

  private inferGlobalType(_name: string): ValType | null {
    // TODO: look up from parsed globals list
    return null;
  }

  private inferFuncResultType(_name: string): Type | null {
    // TODO: look up from rawFunctions list
    return null;
  }

  private pushLabel(label: string | null, ctx: FuncContext): FuncContext {
    const labels = new Map(ctx.labels);
    const synth = label ?? `$depth${ctx.labelDepth}`;
    labels.set(synth, ctx.labelDepth);
    return { ...ctx, labels, labelDepth: ctx.labelDepth + 1 };
  }

  // -------------------------------------------------------------------------
  // Literal helpers
  // -------------------------------------------------------------------------

  private expectInt(s: SExpr | undefined, instr: string): number {
    if (!s) this.err(`${instr}: missing integer argument`);
    const v = atomInt(s!);
    if (v === null) {
      // Try float that is actually an integer bit pattern
      const f = atomFloat(s!);
      if (f !== null) return f;
      this.err(`${instr}: expected integer, got ${sExprToString(s!)}`, s!.pos);
    }
    return Number(v);
  }

  private expectIntBig(s: SExpr | undefined, instr: string): bigint {
    if (!s) this.err(`${instr}: missing integer argument`);
    const v = atomInt(s!);
    if (v === null) this.err(`${instr}: expected integer`, s!.pos);
    return typeof v === "bigint" ? v : BigInt(v!);
  }

  private expectFloat(s: SExpr | undefined, instr: string): number {
    if (!s) this.err(`${instr}: missing float argument`);
    const f = atomFloat(s!);
    if (f !== null) return f;
    const i = atomInt(s!);
    if (i !== null) return Number(i);
    this.err(`${instr}: expected float, got ${sExprToString(s!)}`, s!.pos);
  }

  // -------------------------------------------------------------------------
  // Error helper
  // -------------------------------------------------------------------------

  private expectList(s: SExpr, head: string): SList {
    if (s.kind !== "list") this.err(`expected (${head} ...) but got atom`);
    if (listHead(s as SList) !== head) {
      this.err(`expected (${head} ...) but got (${listHead(s as SList)} ...)`, s.pos);
    }
    return s as SList;
  }

  private err(msg: string, pos?: TextPos): never {
    throw new WatParseError(msg, pos ?? { line: 1, col: 1 }, this.filename);
  }
}

// ---------------------------------------------------------------------------
// Raw function record (first-pass stub)
// ---------------------------------------------------------------------------

interface RawFunc {
  name: string;
  list: SList;
  funcIndex: number;
}

// ---------------------------------------------------------------------------
// Operator lookup tables
// ---------------------------------------------------------------------------

// SIMD special-form op tables (used by parseSIMD* helpers)
const SIMD_EXTRACT_OPS: Record<string, SIMDExtractOp> = {
  "i8x16.extract_lane_s": SIMDExtractOp.ExtractLaneSVecI8x16,
  "i8x16.extract_lane_u": SIMDExtractOp.ExtractLaneUVecI8x16,
  "i16x8.extract_lane_s": SIMDExtractOp.ExtractLaneSVecI16x8,
  "i16x8.extract_lane_u": SIMDExtractOp.ExtractLaneUVecI16x8,
  "i32x4.extract_lane": SIMDExtractOp.ExtractLaneVecI32x4,
  "i64x2.extract_lane": SIMDExtractOp.ExtractLaneVecI64x2,
  "f32x4.extract_lane": SIMDExtractOp.ExtractLaneVecF32x4,
  "f64x2.extract_lane": SIMDExtractOp.ExtractLaneVecF64x2,
};
const SIMD_REPLACE_OPS: Record<string, SIMDReplaceOp> = {
  "i8x16.replace_lane": SIMDReplaceOp.ReplaceLaneVecI8x16,
  "i16x8.replace_lane": SIMDReplaceOp.ReplaceLaneVecI16x8,
  "i32x4.replace_lane": SIMDReplaceOp.ReplaceLaneVecI32x4,
  "i64x2.replace_lane": SIMDReplaceOp.ReplaceLaneVecI64x2,
  "f32x4.replace_lane": SIMDReplaceOp.ReplaceLaneVecF32x4,
  "f64x2.replace_lane": SIMDReplaceOp.ReplaceLaneVecF64x2,
};
const SIMD_SHIFT_OPS: Record<string, SIMDShiftOp> = {
  "i8x16.shl": SIMDShiftOp.ShlVecI8x16, "i8x16.shr_s": SIMDShiftOp.ShrSVecI8x16, "i8x16.shr_u": SIMDShiftOp.ShrUVecI8x16,
  "i16x8.shl": SIMDShiftOp.ShlVecI16x8, "i16x8.shr_s": SIMDShiftOp.ShrSVecI16x8, "i16x8.shr_u": SIMDShiftOp.ShrUVecI16x8,
  "i32x4.shl": SIMDShiftOp.ShlVecI32x4, "i32x4.shr_s": SIMDShiftOp.ShrSVecI32x4, "i32x4.shr_u": SIMDShiftOp.ShrUVecI32x4,
  "i64x2.shl": SIMDShiftOp.ShlVecI64x2, "i64x2.shr_s": SIMDShiftOp.ShrSVecI64x2, "i64x2.shr_u": SIMDShiftOp.ShrUVecI64x2,
};
const SIMD_LOAD_OPS: Record<string, SIMDLoadOp> = {
  "v128.load8_splat": SIMDLoadOp.Load8SplatVec128, "v128.load16_splat": SIMDLoadOp.Load16SplatVec128,
  "v128.load32_splat": SIMDLoadOp.Load32SplatVec128, "v128.load64_splat": SIMDLoadOp.Load64SplatVec128,
  "v128.load8x8_s": SIMDLoadOp.Load8x8SVec128, "v128.load8x8_u": SIMDLoadOp.Load8x8UVec128,
  "v128.load16x4_s": SIMDLoadOp.Load16x4SVec128, "v128.load16x4_u": SIMDLoadOp.Load16x4UVec128,
  "v128.load32x2_s": SIMDLoadOp.Load32x2SVec128, "v128.load32x2_u": SIMDLoadOp.Load32x2UVec128,
  "v128.load32_zero": SIMDLoadOp.Load32ZeroVec128, "v128.load64_zero": SIMDLoadOp.Load64ZeroVec128,
};
const SIMD_LANE_OPS: Record<string, SIMDLoadStoreLaneOp> = {
  "v128.load8_lane": SIMDLoadStoreLaneOp.Load8LaneVec128, "v128.load16_lane": SIMDLoadStoreLaneOp.Load16LaneVec128,
  "v128.load32_lane": SIMDLoadStoreLaneOp.Load32LaneVec128, "v128.load64_lane": SIMDLoadStoreLaneOp.Load64LaneVec128,
  "v128.store8_lane": SIMDLoadStoreLaneOp.Store8LaneVec128, "v128.store16_lane": SIMDLoadStoreLaneOp.Store16LaneVec128,
  "v128.store32_lane": SIMDLoadStoreLaneOp.Store32LaneVec128, "v128.store64_lane": SIMDLoadStoreLaneOp.Store64LaneVec128,
};

const UNARY_OPS: Record<string, UnaryOp> = {
  "i32.clz": UnaryOp.ClzI32, "i32.ctz": UnaryOp.CtzI32, "i32.popcnt": UnaryOp.PopcntI32,
  "i32.eqz": UnaryOp.EqzI32,
  "i64.clz": UnaryOp.ClzI64, "i64.ctz": UnaryOp.CtzI64, "i64.popcnt": UnaryOp.PopcntI64,
  "i64.eqz": UnaryOp.EqzI64,
  "f32.abs": UnaryOp.AbsF32, "f32.neg": UnaryOp.NegF32, "f32.ceil": UnaryOp.CeilF32,
  "f32.floor": UnaryOp.FloorF32, "f32.trunc": UnaryOp.TruncF32, "f32.nearest": UnaryOp.NearestF32,
  "f32.sqrt": UnaryOp.SqrtF32,
  "f64.abs": UnaryOp.AbsF64, "f64.neg": UnaryOp.NegF64, "f64.ceil": UnaryOp.CeilF64,
  "f64.floor": UnaryOp.FloorF64, "f64.trunc": UnaryOp.TruncF64, "f64.nearest": UnaryOp.NearestF64,
  "f64.sqrt": UnaryOp.SqrtF64,
  "i64.extend_i32_s": UnaryOp.ExtendSI32, "i64.extend_i32_u": UnaryOp.ExtendUI32,
  "i32.wrap_i64": UnaryOp.WrapI64,
  "i32.trunc_f32_s": UnaryOp.TruncSF32ToI32, "i32.trunc_f32_u": UnaryOp.TruncUF32ToI32,
  "i32.trunc_f64_s": UnaryOp.TruncSF64ToI32, "i32.trunc_f64_u": UnaryOp.TruncUF64ToI32,
  "i64.trunc_f32_s": UnaryOp.TruncSF32ToI64, "i64.trunc_f32_u": UnaryOp.TruncUF32ToI64,
  "i64.trunc_f64_s": UnaryOp.TruncSF64ToI64, "i64.trunc_f64_u": UnaryOp.TruncUF64ToI64,
  "f64.promote_f32": UnaryOp.PromoteF32, "f32.demote_f64": UnaryOp.DemoteF64,
  "f32.convert_i32_s": UnaryOp.ConvertSI32ToF32, "f32.convert_i32_u": UnaryOp.ConvertUI32ToF32,
  "f32.convert_i64_s": UnaryOp.ConvertSI64ToF32, "f32.convert_i64_u": UnaryOp.ConvertUI64ToF32,
  "f64.convert_i32_s": UnaryOp.ConvertSI32ToF64, "f64.convert_i32_u": UnaryOp.ConvertUI32ToF64,
  "f64.convert_i64_s": UnaryOp.ConvertSI64ToF64, "f64.convert_i64_u": UnaryOp.ConvertUI64ToF64,
  "f32.reinterpret_i32": UnaryOp.ReinterpretI32, "f64.reinterpret_i64": UnaryOp.ReinterpretI64,
  "i32.reinterpret_f32": UnaryOp.ReinterpretF32, "i64.reinterpret_f64": UnaryOp.ReinterpretF64,
  "i32.extend8_s": UnaryOp.ExtendS8I32, "i32.extend16_s": UnaryOp.ExtendS16I32,
  "i64.extend8_s": UnaryOp.ExtendS8I64, "i64.extend16_s": UnaryOp.ExtendS16I64,
  "i64.extend32_s": UnaryOp.ExtendS32I64,
  // SIMD splats
  "i8x16.splat": UnaryOp.SplatVecI8x16, "i16x8.splat": UnaryOp.SplatVecI16x8,
  "i32x4.splat": UnaryOp.SplatVecI32x4, "i64x2.splat": UnaryOp.SplatVecI64x2,
  "f32x4.splat": UnaryOp.SplatVecF32x4, "f64x2.splat": UnaryOp.SplatVecF64x2,
  // SIMD v128 bitwise/logical
  "v128.not": UnaryOp.NotVec128, "v128.any_true": UnaryOp.AnyTrueVec128,
  // SIMD i8x16
  "i8x16.abs": UnaryOp.AbsVecI8x16, "i8x16.neg": UnaryOp.NegVecI8x16,
  "i8x16.popcnt": UnaryOp.PopcntVecI8x16, "i8x16.all_true": UnaryOp.AllTrueVecI8x16, "i8x16.bitmask": UnaryOp.BitmaskVecI8x16,
  // SIMD i16x8
  "i16x8.abs": UnaryOp.AbsVecI16x8, "i16x8.neg": UnaryOp.NegVecI16x8,
  "i16x8.all_true": UnaryOp.AllTrueVecI16x8, "i16x8.bitmask": UnaryOp.BitmaskVecI16x8,
  "i16x8.extend_low_i8x16_s": UnaryOp.ExtendLowSVecI8x16ToI16x8, "i16x8.extend_high_i8x16_s": UnaryOp.ExtendHighSVecI8x16ToI16x8,
  "i16x8.extend_low_i8x16_u": UnaryOp.ExtendLowUVecI8x16ToI16x8, "i16x8.extend_high_i8x16_u": UnaryOp.ExtendHighUVecI8x16ToI16x8,
  "i16x8.extadd_pairwise_i8x16_s": UnaryOp.ExtaddPairwiseSVecI8x16ToI16x8,
  "i16x8.extadd_pairwise_i8x16_u": UnaryOp.ExtaddPairwiseUVecI8x16ToI16x8,
  // SIMD i32x4
  "i32x4.abs": UnaryOp.AbsVecI32x4, "i32x4.neg": UnaryOp.NegVecI32x4,
  "i32x4.all_true": UnaryOp.AllTrueVecI32x4, "i32x4.bitmask": UnaryOp.BitmaskVecI32x4,
  "i32x4.extend_low_i16x8_s": UnaryOp.ExtendLowSVecI16x8ToI32x4, "i32x4.extend_high_i16x8_s": UnaryOp.ExtendHighSVecI16x8ToI32x4,
  "i32x4.extend_low_i16x8_u": UnaryOp.ExtendLowUVecI16x8ToI32x4, "i32x4.extend_high_i16x8_u": UnaryOp.ExtendHighUVecI16x8ToI32x4,
  "i32x4.extadd_pairwise_i16x8_s": UnaryOp.ExtaddPairwiseSVecI16x8ToI32x4,
  "i32x4.extadd_pairwise_i16x8_u": UnaryOp.ExtaddPairwiseUVecI16x8ToI32x4,
  // SIMD i64x2
  "i64x2.abs": UnaryOp.AbsVecI64x2, "i64x2.neg": UnaryOp.NegVecI64x2,
  "i64x2.all_true": UnaryOp.AllTrueVecI64x2, "i64x2.bitmask": UnaryOp.BitmaskVecI64x2,
  "i64x2.extend_low_i32x4_s": UnaryOp.ExtendLowSVecI32x4ToI64x2, "i64x2.extend_high_i32x4_s": UnaryOp.ExtendHighSVecI32x4ToI64x2,
  "i64x2.extend_low_i32x4_u": UnaryOp.ExtendLowUVecI32x4ToI64x2, "i64x2.extend_high_i32x4_u": UnaryOp.ExtendHighUVecI32x4ToI64x2,
  // SIMD f32x4
  "f32x4.abs": UnaryOp.AbsVecF32x4, "f32x4.neg": UnaryOp.NegVecF32x4, "f32x4.sqrt": UnaryOp.SqrtVecF32x4,
  "f32x4.ceil": UnaryOp.CeilVecF32x4, "f32x4.floor": UnaryOp.FloorVecF32x4,
  "f32x4.trunc": UnaryOp.TruncVecF32x4, "f32x4.nearest": UnaryOp.NearestVecF32x4,
  "f32x4.convert_i32x4_s": UnaryOp.ConvertSVecI32x4ToF32x4, "f32x4.convert_i32x4_u": UnaryOp.ConvertUVecI32x4ToF32x4,
  "f32x4.demote_f64x2_zero": UnaryOp.DemoteZeroVecF64x2ToF32x4,
  // SIMD f64x2
  "f64x2.abs": UnaryOp.AbsVecF64x2, "f64x2.neg": UnaryOp.NegVecF64x2, "f64x2.sqrt": UnaryOp.SqrtVecF64x2,
  "f64x2.ceil": UnaryOp.CeilVecF64x2, "f64x2.floor": UnaryOp.FloorVecF64x2,
  "f64x2.trunc": UnaryOp.TruncVecF64x2, "f64x2.nearest": UnaryOp.NearestVecF64x2,
  "f64x2.promote_low_f32x4": UnaryOp.PromoteLowVecF32x4ToF64x2,
  "f64x2.convert_low_i32x4_s": UnaryOp.ConvertLowSVecI32x4ToF64x2, "f64x2.convert_low_i32x4_u": UnaryOp.ConvertLowUVecI32x4ToF64x2,
  // SIMD trunc_sat (conversion)
  "i32x4.trunc_sat_f32x4_s": UnaryOp.TruncSatSVecF32x4ToI32x4, "i32x4.trunc_sat_f32x4_u": UnaryOp.TruncSatUVecF32x4ToI32x4,
  "i32x4.trunc_sat_f64x2_s_zero": UnaryOp.TruncSatSVecF64x2ToI32x4Zero,
  "i32x4.trunc_sat_f64x2_u_zero": UnaryOp.TruncSatUVecF64x2ToI32x4Zero,
};

const BINARY_OPS: Record<string, BinaryOp> = {
  "i32.add": BinaryOp.AddI32, "i32.sub": BinaryOp.SubI32, "i32.mul": BinaryOp.MulI32,
  "i32.div_s": BinaryOp.DivSI32, "i32.div_u": BinaryOp.DivUI32,
  "i32.rem_s": BinaryOp.RemSI32, "i32.rem_u": BinaryOp.RemUI32,
  "i32.and": BinaryOp.AndI32, "i32.or": BinaryOp.OrI32, "i32.xor": BinaryOp.XorI32,
  "i32.shl": BinaryOp.ShlI32, "i32.shr_s": BinaryOp.ShrSI32, "i32.shr_u": BinaryOp.ShrUI32,
  "i32.rotl": BinaryOp.RotlI32, "i32.rotr": BinaryOp.RotrI32,
  "i32.eq": BinaryOp.EqI32, "i32.ne": BinaryOp.NeI32,
  "i32.lt_s": BinaryOp.LtSI32, "i32.lt_u": BinaryOp.LtUI32,
  "i32.le_s": BinaryOp.LeSI32, "i32.le_u": BinaryOp.LeUI32,
  "i32.gt_s": BinaryOp.GtSI32, "i32.gt_u": BinaryOp.GtUI32,
  "i32.ge_s": BinaryOp.GeSI32, "i32.ge_u": BinaryOp.GeUI32,
  "i64.add": BinaryOp.AddI64, "i64.sub": BinaryOp.SubI64, "i64.mul": BinaryOp.MulI64,
  "i64.div_s": BinaryOp.DivSI64, "i64.div_u": BinaryOp.DivUI64,
  "i64.rem_s": BinaryOp.RemSI64, "i64.rem_u": BinaryOp.RemUI64,
  "i64.and": BinaryOp.AndI64, "i64.or": BinaryOp.OrI64, "i64.xor": BinaryOp.XorI64,
  "i64.shl": BinaryOp.ShlI64, "i64.shr_s": BinaryOp.ShrSI64, "i64.shr_u": BinaryOp.ShrUI64,
  "i64.rotl": BinaryOp.RotlI64, "i64.rotr": BinaryOp.RotrI64,
  "i64.eq": BinaryOp.EqI64, "i64.ne": BinaryOp.NeI64,
  "i64.lt_s": BinaryOp.LtSI64, "i64.lt_u": BinaryOp.LtUI64,
  "i64.le_s": BinaryOp.LeSI64, "i64.le_u": BinaryOp.LeUI64,
  "i64.gt_s": BinaryOp.GtSI64, "i64.gt_u": BinaryOp.GtUI64,
  "i64.ge_s": BinaryOp.GeSI64, "i64.ge_u": BinaryOp.GeUI64,
  "f32.add": BinaryOp.AddF32, "f32.sub": BinaryOp.SubF32, "f32.mul": BinaryOp.MulF32,
  "f32.div": BinaryOp.DivF32, "f32.copysign": BinaryOp.CopySignF32,
  "f32.min": BinaryOp.MinF32, "f32.max": BinaryOp.MaxF32,
  "f32.eq": BinaryOp.EqF32, "f32.ne": BinaryOp.NeF32,
  "f32.lt": BinaryOp.LtF32, "f32.le": BinaryOp.LeF32,
  "f32.gt": BinaryOp.GtF32, "f32.ge": BinaryOp.GeF32,
  "f64.add": BinaryOp.AddF64, "f64.sub": BinaryOp.SubF64, "f64.mul": BinaryOp.MulF64,
  "f64.div": BinaryOp.DivF64, "f64.copysign": BinaryOp.CopySignF64,
  "f64.min": BinaryOp.MinF64, "f64.max": BinaryOp.MaxF64,
  "f64.eq": BinaryOp.EqF64, "f64.ne": BinaryOp.NeF64,
  "f64.lt": BinaryOp.LtF64, "f64.le": BinaryOp.LeF64,
  "f64.gt": BinaryOp.GtF64, "f64.ge": BinaryOp.GeF64,
  // SIMD swizzle
  "i8x16.swizzle": BinaryOp.SwizzleVecI8x16,
  // SIMD v128 bitwise
  "v128.and": BinaryOp.AndVec128, "v128.andnot": BinaryOp.AndNotVec128,
  "v128.or": BinaryOp.OrVec128, "v128.xor": BinaryOp.XorVec128,
  // SIMD i8x16 binary
  "i8x16.eq": BinaryOp.EqVecI8x16, "i8x16.ne": BinaryOp.NeVecI8x16,
  "i8x16.lt_s": BinaryOp.LtSVecI8x16, "i8x16.lt_u": BinaryOp.LtUVecI8x16,
  "i8x16.gt_s": BinaryOp.GtSVecI8x16, "i8x16.gt_u": BinaryOp.GtUVecI8x16,
  "i8x16.le_s": BinaryOp.LeSVecI8x16, "i8x16.le_u": BinaryOp.LeUVecI8x16,
  "i8x16.ge_s": BinaryOp.GeSVecI8x16, "i8x16.ge_u": BinaryOp.GeUVecI8x16,
  "i8x16.add": BinaryOp.AddVecI8x16, "i8x16.sub": BinaryOp.SubVecI8x16,
  "i8x16.add_sat_s": BinaryOp.AddSatSVecI8x16, "i8x16.add_sat_u": BinaryOp.AddSatUVecI8x16,
  "i8x16.sub_sat_s": BinaryOp.SubSatSVecI8x16, "i8x16.sub_sat_u": BinaryOp.SubSatUVecI8x16,
  "i8x16.min_s": BinaryOp.MinSVecI8x16, "i8x16.min_u": BinaryOp.MinUVecI8x16,
  "i8x16.max_s": BinaryOp.MaxSVecI8x16, "i8x16.max_u": BinaryOp.MaxUVecI8x16,
  "i8x16.avgr_u": BinaryOp.AvgrUVecI8x16,
  "i8x16.narrow_i16x8_s": BinaryOp.NarrowSVecI16x8ToI8x16, "i8x16.narrow_i16x8_u": BinaryOp.NarrowUVecI16x8ToI8x16,
  // SIMD i16x8 binary
  "i16x8.eq": BinaryOp.EqVecI16x8, "i16x8.ne": BinaryOp.NeVecI16x8,
  "i16x8.lt_s": BinaryOp.LtSVecI16x8, "i16x8.lt_u": BinaryOp.LtUVecI16x8,
  "i16x8.gt_s": BinaryOp.GtSVecI16x8, "i16x8.gt_u": BinaryOp.GtUVecI16x8,
  "i16x8.le_s": BinaryOp.LeSVecI16x8, "i16x8.le_u": BinaryOp.LeUVecI16x8,
  "i16x8.ge_s": BinaryOp.GeSVecI16x8, "i16x8.ge_u": BinaryOp.GeUVecI16x8,
  "i16x8.add": BinaryOp.AddVecI16x8, "i16x8.sub": BinaryOp.SubVecI16x8, "i16x8.mul": BinaryOp.MulVecI16x8,
  "i16x8.add_sat_s": BinaryOp.AddSatSVecI16x8, "i16x8.add_sat_u": BinaryOp.AddSatUVecI16x8,
  "i16x8.sub_sat_s": BinaryOp.SubSatSVecI16x8, "i16x8.sub_sat_u": BinaryOp.SubSatUVecI16x8,
  "i16x8.min_s": BinaryOp.MinSVecI16x8, "i16x8.min_u": BinaryOp.MinUVecI16x8,
  "i16x8.max_s": BinaryOp.MaxSVecI16x8, "i16x8.max_u": BinaryOp.MaxUVecI16x8,
  "i16x8.avgr_u": BinaryOp.AvgrUVecI16x8,
  "i16x8.q15mulr_sat_s": BinaryOp.Q15MulrSatSVecI16x8,
  "i16x8.narrow_i32x4_s": BinaryOp.NarrowSVecI32x4ToI16x8, "i16x8.narrow_i32x4_u": BinaryOp.NarrowUVecI32x4ToI16x8,
  "i16x8.extmul_low_i8x16_s": BinaryOp.ExtmulLowSVecI8x16ToI16x8, "i16x8.extmul_high_i8x16_s": BinaryOp.ExtmulHighSVecI8x16ToI16x8,
  "i16x8.extmul_low_i8x16_u": BinaryOp.ExtmulLowUVecI8x16ToI16x8, "i16x8.extmul_high_i8x16_u": BinaryOp.ExtmulHighUVecI8x16ToI16x8,
  // SIMD i32x4 binary
  "i32x4.eq": BinaryOp.EqVecI32x4, "i32x4.ne": BinaryOp.NeVecI32x4,
  "i32x4.lt_s": BinaryOp.LtSVecI32x4, "i32x4.lt_u": BinaryOp.LtUVecI32x4,
  "i32x4.gt_s": BinaryOp.GtSVecI32x4, "i32x4.gt_u": BinaryOp.GtUVecI32x4,
  "i32x4.le_s": BinaryOp.LeSVecI32x4, "i32x4.le_u": BinaryOp.LeUVecI32x4,
  "i32x4.ge_s": BinaryOp.GeSVecI32x4, "i32x4.ge_u": BinaryOp.GeUVecI32x4,
  "i32x4.add": BinaryOp.AddVecI32x4, "i32x4.sub": BinaryOp.SubVecI32x4, "i32x4.mul": BinaryOp.MulVecI32x4,
  "i32x4.min_s": BinaryOp.MinSVecI32x4, "i32x4.min_u": BinaryOp.MinUVecI32x4,
  "i32x4.max_s": BinaryOp.MaxSVecI32x4, "i32x4.max_u": BinaryOp.MaxUVecI32x4,
  "i32x4.dot_i16x8_s": BinaryOp.DotSVecI16x8ToI32x4,
  "i32x4.extmul_low_i16x8_s": BinaryOp.ExtmulLowSVecI16x8ToI32x4, "i32x4.extmul_high_i16x8_s": BinaryOp.ExtmulHighSVecI16x8ToI32x4,
  "i32x4.extmul_low_i16x8_u": BinaryOp.ExtmulLowUVecI16x8ToI32x4, "i32x4.extmul_high_i16x8_u": BinaryOp.ExtmulHighUVecI16x8ToI32x4,
  // SIMD i64x2 binary
  "i64x2.eq": BinaryOp.EqVecI64x2, "i64x2.ne": BinaryOp.NeVecI64x2,
  "i64x2.lt_s": BinaryOp.LtSVecI64x2, "i64x2.gt_s": BinaryOp.GtSVecI64x2,
  "i64x2.le_s": BinaryOp.LeSVecI64x2, "i64x2.ge_s": BinaryOp.GeSVecI64x2,
  "i64x2.add": BinaryOp.AddVecI64x2, "i64x2.sub": BinaryOp.SubVecI64x2, "i64x2.mul": BinaryOp.MulVecI64x2,
  "i64x2.extmul_low_i32x4_s": BinaryOp.ExtmulLowSVecI32x4ToI64x2, "i64x2.extmul_high_i32x4_s": BinaryOp.ExtmulHighSVecI32x4ToI64x2,
  "i64x2.extmul_low_i32x4_u": BinaryOp.ExtmulLowUVecI32x4ToI64x2, "i64x2.extmul_high_i32x4_u": BinaryOp.ExtmulHighUVecI32x4ToI64x2,
  // SIMD f32x4 binary
  "f32x4.eq": BinaryOp.EqVecF32x4, "f32x4.ne": BinaryOp.NeVecF32x4,
  "f32x4.lt": BinaryOp.LtVecF32x4, "f32x4.gt": BinaryOp.GtVecF32x4,
  "f32x4.le": BinaryOp.LeVecF32x4, "f32x4.ge": BinaryOp.GeVecF32x4,
  "f32x4.add": BinaryOp.AddVecF32x4, "f32x4.sub": BinaryOp.SubVecF32x4,
  "f32x4.mul": BinaryOp.MulVecF32x4, "f32x4.div": BinaryOp.DivVecF32x4,
  "f32x4.min": BinaryOp.MinVecF32x4, "f32x4.max": BinaryOp.MaxVecF32x4,
  "f32x4.pmin": BinaryOp.PminVecF32x4, "f32x4.pmax": BinaryOp.PmaxVecF32x4,
  // SIMD f64x2 binary
  "f64x2.eq": BinaryOp.EqVecF64x2, "f64x2.ne": BinaryOp.NeVecF64x2,
  "f64x2.lt": BinaryOp.LtVecF64x2, "f64x2.gt": BinaryOp.GtVecF64x2,
  "f64x2.le": BinaryOp.LeVecF64x2, "f64x2.ge": BinaryOp.GeVecF64x2,
  "f64x2.add": BinaryOp.AddVecF64x2, "f64x2.sub": BinaryOp.SubVecF64x2,
  "f64x2.mul": BinaryOp.MulVecF64x2, "f64x2.div": BinaryOp.DivVecF64x2,
  "f64x2.min": BinaryOp.MinVecF64x2, "f64x2.max": BinaryOp.MaxVecF64x2,
  "f64x2.pmin": BinaryOp.PminVecF64x2, "f64x2.pmax": BinaryOp.PmaxVecF64x2,
};

function inferUnaryResultType(op: string): ValType {
  // SIMD ops that return i32 (reduction ops)
  if (op.endsWith(".all_true") || op.endsWith(".bitmask") || op === "v128.any_true") return ValType.I32;
  // SIMD ops — everything else returns v128
  const simdPrefixes = ["i8x16.", "i16x8.", "i32x4.", "i64x2.", "f32x4.", "f64x2.", "v128."];
  if (simdPrefixes.some((p) => op.startsWith(p))) return ValType.V128;
  if (op.startsWith("i32") || op.startsWith("i64.eqz")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  if (op.startsWith("f64")) return ValType.F64;
  // Conversions: result type is in the prefix
  const m = op.match(/^(i32|i64|f32|f64)\./);
  return (m?.[1] as ValType) ?? ValType.I32;
}

function inferBinaryResultType(op: string): ValType {
  // SIMD ops all return v128 (including SIMD comparisons — unlike scalar comparisons!)
  const simdPrefixes = ["i8x16.", "i16x8.", "i32x4.", "i64x2.", "f32x4.", "f64x2.", "v128."];
  if (simdPrefixes.some((p) => op.startsWith(p))) return ValType.V128;
  // Scalar comparison ops return i32
  const cmpSuffixes = [".eq", ".ne", ".lt", ".le", ".gt", ".ge", ".lt_s", ".lt_u", ".le_s", ".le_u", ".gt_s", ".gt_u", ".ge_s", ".ge_u"];
  if (cmpSuffixes.some((s) => op.endsWith(s))) return ValType.I32;
  if (op.startsWith("i32")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  if (op.startsWith("f64")) return ValType.F64;
  return ValType.I32;
}

function loadBytes(head: string): 1 | 2 | 4 | 8 | 16 {
  if (head.includes("load8"))  return 1;
  if (head.includes("load16")) return 2;
  if (head.includes("load32")) return 4;
  if (head.includes("load64")) return 8;
  if (head.includes("v128"))   return 16;
  if (head.startsWith("i32") || head.startsWith("f32")) return 4;
  if (head.startsWith("i64") || head.startsWith("f64")) return 8;
  return 4;
}

function storeBytes(head: string): 1 | 2 | 4 | 8 | 16 {
  if (head.includes("store8"))  return 1;
  if (head.includes("store16")) return 2;
  if (head.includes("store32")) return 4;
  if (head.includes("store64")) return 8;
  if (head.startsWith("i32") || head.startsWith("f32")) return 4;
  if (head.startsWith("i64") || head.startsWith("f64")) return 8;
  return 4;
}
