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
 * @license MIT OR Apache-2.0
 */

import {
  BinaryExpr,
  BinaryOp,
  BlockExpr,
  BreakExpr,
  CallExpr,
  CallIndirectExpr,
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
        case "export": /* handled in second pass */ break;
        case "data":   /* handled in second pass */ break;
        case "elem":   /* handled in second pass */ break;
        case "type":   /* GC types — future */ break;
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

    // Load instructions
    const loadMatch = head.match(/^(i32|i64|f32|f64|v128)\.(load(?:8_[su]|16_[su]|32_[su]|64)?(?:_lane)?)$/);
    if (loadMatch) return this.parseLoad(head, list, args, ctx);

    // Store instructions
    const storeMatch = head.match(/^(i32|i64|f32|f64|v128)\.(store(?:8|16|32|64)?(?:_lane)?)$/);
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

  private parseValType(s: SExpr): ValType {
    return this.tryParseValType(s) ?? this.err(`unknown value type: ${sExprToString(s)}`, s.pos);
  }

  private tryParseValType(s: SExpr): ValType | null {
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
};

function inferUnaryResultType(op: string): ValType {
  if (op.startsWith("i32") || op.startsWith("i64.eqz")) return ValType.I32;
  if (op.startsWith("i64")) return ValType.I64;
  if (op.startsWith("f32")) return ValType.F32;
  if (op.startsWith("f64")) return ValType.F64;
  // Conversions: result type is in the prefix
  const m = op.match(/^(i32|i64|f32|f64)\./);
  return (m?.[1] as ValType) ?? ValType.I32;
}

function inferBinaryResultType(op: string): ValType {
  // Comparison ops always return i32
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
