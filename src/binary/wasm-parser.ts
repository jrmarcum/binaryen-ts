/**
 * @module binaryen-ts/binary/wasm-parser
 *
 * WASM binary format parser.
 * Converts a WebAssembly binary (Uint8Array) into a WasmModule IR tree.
 *
 * @license MIT
 */

import { BinaryReader, WasmBinaryError } from "./reader.ts";
import {
  type ElementSegment,
  type Local,
  ModuleBuilder,
  type WasmFunction,
  type WasmModule,
} from "../ir/module.ts";
import {
  BinaryOp,
  type CatchClause,
  type Expression,
  makeBinary,
  makeBlock,
  makeBreak,
  makeCall,
  makeCallIndirect,
  makeDrop,
  makeF32Const,
  makeF64Const,
  makeGlobalGet,
  makeGlobalSet,
  makeI32Const,
  makeI64Const,
  makeIf,
  makeLoad,
  makeLocalGet,
  makeLocalSet,
  makeLocalTee,
  makeLoop,
  makeMemoryCopy,
  makeMemoryFill,
  makeMemoryGrow,
  makeMemorySize,
  makeNop,
  makePop,
  makeRefFunc,
  makeRefIsNull,
  makeRefNull,
  makeRethrow,
  makeReturn,
  makeSelect,
  makeSIMDExtract,
  makeSIMDLoad,
  makeSIMDLoadStoreLane,
  makeSIMDReplace,
  makeSIMDShift,
  makeSIMDShuffle,
  makeSIMDTernary,
  makeStore,
  makeSwitch,
  makeTableGet,
  makeTableSet,
  makeThrow,
  makeThrowRef,
  makeTry,
  makeTryTable,
  makeUnary,
  makeUnreachable,
  makeV128Const,
  SIMDExtractOp,
  SIMDLoadOp,
  SIMDLoadStoreLaneOp,
  SIMDReplaceOp,
  SIMDShiftOp,
  SIMDTernaryOp,
  UnaryOp,
} from "../ir/expressions.ts";
import {
  AbstractHeapType,
  type FieldType,
  type HeapType,
  isRefType,
  type RefType,
  type StorageType,
  type TypeDef,
} from "../ir/gc-types.ts";
import {
  BrOnOp,
  makeArrayGet,
  makeArrayLen,
  makeArrayNew,
  makeArrayNewData,
  makeArrayNewDefault,
  makeArrayNewElem,
  makeArrayNewFixed,
  makeArraySet,
  makeBrOn,
  makeI31Get,
  makeRefCast,
  makeRefEq,
  makeRefI31,
  makeRefTest,
  makeStructGet,
  makeStructNew,
  makeStructNewDefault,
  makeStructSet,
} from "../ir/expressions.ts";
import { None, type Type, ValType } from "../ir/types.ts";

// ---------------------------------------------------------------------------
// Section IDs
// ---------------------------------------------------------------------------

const SECTION_CUSTOM = 0;
const SECTION_TYPE = 1;
const SECTION_IMPORT = 2;
const SECTION_FUNCTION = 3;
const SECTION_TABLE = 4;
const SECTION_MEMORY = 5;
const SECTION_GLOBAL = 6;
const SECTION_EXPORT = 7;
const SECTION_START = 8;
const SECTION_ELEMENT = 9;
const SECTION_CODE = 10;
const SECTION_DATA = 11;
const SECTION_DATA_COUNT = 12;
const SECTION_TAG = 13;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FuncType {
  params: ValType[];
  results: ValType[];
}

interface GlobalInfo {
  type: ValType;
  mutable: boolean;
}

type ControlFrameKind = "block" | "loop" | "if" | "else" | "func" | "try" | "catch" | "try_table";

interface ControlFrame {
  kind: ControlFrameKind;
  label: string;
  resultTypes: (ValType | RefType)[];
  exprs: Expression[];
  ifCondition?: Expression;
  thenExprs?: Expression[];
  // try / catch state
  tryBody?: Expression[];
  catchTags?: string[];
  catchBodies?: Expression[][];
  delegateTarget?: string | null;
  // try_table state
  tryCatches?: CatchClause[];
}

interface TagInfo {
  name: string;
  params: ValType[];
}

interface DecoderCtx {
  funcTypes: FuncType[];
  heapTypeDefs: TypeDef[];
  importedFuncCount: number;
  importedFuncTypeIndices: number[];
  funcTypeIndices: number[];
  globalInfos: GlobalInfo[];
  tableNames: string[];
  tagInfos: TagInfo[];
}

// ---------------------------------------------------------------------------
// Opcode tables
// ---------------------------------------------------------------------------

const UNARY_OPCODE: Record<number, UnaryOp> = {
  0x45: UnaryOp.EqzI32,
  0x50: UnaryOp.EqzI64,
  0x67: UnaryOp.ClzI32,
  0x68: UnaryOp.CtzI32,
  0x69: UnaryOp.PopcntI32,
  0x79: UnaryOp.ClzI64,
  0x7a: UnaryOp.CtzI64,
  0x7b: UnaryOp.PopcntI64,
  0x8b: UnaryOp.AbsF32,
  0x8c: UnaryOp.NegF32,
  0x8d: UnaryOp.CeilF32,
  0x8e: UnaryOp.FloorF32,
  0x8f: UnaryOp.TruncF32,
  0x90: UnaryOp.NearestF32,
  0x91: UnaryOp.SqrtF32,
  0x99: UnaryOp.AbsF64,
  0x9a: UnaryOp.NegF64,
  0x9b: UnaryOp.CeilF64,
  0x9c: UnaryOp.FloorF64,
  0x9d: UnaryOp.TruncF64,
  0x9e: UnaryOp.NearestF64,
  0x9f: UnaryOp.SqrtF64,
  0xa7: UnaryOp.WrapI64,
  0xa8: UnaryOp.TruncSF32ToI32,
  0xa9: UnaryOp.TruncUF32ToI32,
  0xaa: UnaryOp.TruncSF64ToI32,
  0xab: UnaryOp.TruncUF64ToI32,
  0xac: UnaryOp.ExtendSI32,
  0xad: UnaryOp.ExtendUI32,
  0xae: UnaryOp.TruncSF32ToI64,
  0xaf: UnaryOp.TruncUF32ToI64,
  0xb0: UnaryOp.TruncSF64ToI64,
  0xb1: UnaryOp.TruncUF64ToI64,
  0xb2: UnaryOp.ConvertSI32ToF32,
  0xb3: UnaryOp.ConvertUI32ToF32,
  0xb4: UnaryOp.ConvertSI64ToF32,
  0xb5: UnaryOp.ConvertUI64ToF32,
  0xb6: UnaryOp.DemoteF64,
  0xb7: UnaryOp.ConvertSI32ToF64,
  0xb8: UnaryOp.ConvertUI32ToF64,
  0xb9: UnaryOp.ConvertSI64ToF64,
  0xba: UnaryOp.ConvertUI64ToF64,
  0xbb: UnaryOp.PromoteF32,
  0xbc: UnaryOp.ReinterpretF32,
  0xbd: UnaryOp.ReinterpretF64,
  0xbe: UnaryOp.ReinterpretI32,
  0xbf: UnaryOp.ReinterpretI64,
  0xc0: UnaryOp.ExtendS8I32,
  0xc1: UnaryOp.ExtendS16I32,
  0xc2: UnaryOp.ExtendS8I64,
  0xc3: UnaryOp.ExtendS16I64,
  0xc4: UnaryOp.ExtendS32I64,
};

const BINARY_OPCODE: Record<number, BinaryOp> = {
  0x46: BinaryOp.EqI32,
  0x47: BinaryOp.NeI32,
  0x48: BinaryOp.LtSI32,
  0x49: BinaryOp.LtUI32,
  0x4a: BinaryOp.GtSI32,
  0x4b: BinaryOp.GtUI32,
  0x4c: BinaryOp.LeSI32,
  0x4d: BinaryOp.LeUI32,
  0x4e: BinaryOp.GeSI32,
  0x4f: BinaryOp.GeUI32,
  0x51: BinaryOp.EqI64,
  0x52: BinaryOp.NeI64,
  0x53: BinaryOp.LtSI64,
  0x54: BinaryOp.LtUI64,
  0x55: BinaryOp.GtSI64,
  0x56: BinaryOp.GtUI64,
  0x57: BinaryOp.LeSI64,
  0x58: BinaryOp.LeUI64,
  0x59: BinaryOp.GeSI64,
  0x5a: BinaryOp.GeUI64,
  0x5b: BinaryOp.EqF32,
  0x5c: BinaryOp.NeF32,
  0x5d: BinaryOp.LtF32,
  0x5e: BinaryOp.GtF32,
  0x5f: BinaryOp.LeF32,
  0x60: BinaryOp.GeF32,
  0x61: BinaryOp.EqF64,
  0x62: BinaryOp.NeF64,
  0x63: BinaryOp.LtF64,
  0x64: BinaryOp.GtF64,
  0x65: BinaryOp.LeF64,
  0x66: BinaryOp.GeF64,
  0x6a: BinaryOp.AddI32,
  0x6b: BinaryOp.SubI32,
  0x6c: BinaryOp.MulI32,
  0x6d: BinaryOp.DivSI32,
  0x6e: BinaryOp.DivUI32,
  0x6f: BinaryOp.RemSI32,
  0x70: BinaryOp.RemUI32,
  0x71: BinaryOp.AndI32,
  0x72: BinaryOp.OrI32,
  0x73: BinaryOp.XorI32,
  0x74: BinaryOp.ShlI32,
  0x75: BinaryOp.ShrSI32,
  0x76: BinaryOp.ShrUI32,
  0x77: BinaryOp.RotlI32,
  0x78: BinaryOp.RotrI32,
  0x7c: BinaryOp.AddI64,
  0x7d: BinaryOp.SubI64,
  0x7e: BinaryOp.MulI64,
  0x7f: BinaryOp.DivSI64,
  0x80: BinaryOp.DivUI64,
  0x81: BinaryOp.RemSI64,
  0x82: BinaryOp.RemUI64,
  0x83: BinaryOp.AndI64,
  0x84: BinaryOp.OrI64,
  0x85: BinaryOp.XorI64,
  0x86: BinaryOp.ShlI64,
  0x87: BinaryOp.ShrSI64,
  0x88: BinaryOp.ShrUI64,
  0x89: BinaryOp.RotlI64,
  0x8a: BinaryOp.RotrI64,
  0x92: BinaryOp.AddF32,
  0x93: BinaryOp.SubF32,
  0x94: BinaryOp.MulF32,
  0x95: BinaryOp.DivF32,
  0x96: BinaryOp.MinF32,
  0x97: BinaryOp.MaxF32,
  0x98: BinaryOp.CopySignF32,
  0xa0: BinaryOp.AddF64,
  0xa1: BinaryOp.SubF64,
  0xa2: BinaryOp.MulF64,
  0xa3: BinaryOp.DivF64,
  0xa4: BinaryOp.MinF64,
  0xa5: BinaryOp.MaxF64,
  0xa6: BinaryOp.CopySignF64,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a heap type from a SLEB128-encoded signed integer. */
function readHeapType(r: BinaryReader): HeapType {
  const v = r.readI32(); // heap types encoded as signed LEB128
  switch (v) {
    case -0x10:
      return AbstractHeapType.Func;
    case -0x0d:
      return AbstractHeapType.NoFunc;
    case -0x11:
      return AbstractHeapType.Ext;
    case -0x0e:
      return AbstractHeapType.NoExt;
    case -0x12:
      return AbstractHeapType.Any;
    case -0x13:
      return AbstractHeapType.Eq;
    case -0x14:
      return AbstractHeapType.I31;
    case -0x15:
      return AbstractHeapType.Struct;
    case -0x16:
      return AbstractHeapType.Array;
    case -0x0f:
      return AbstractHeapType.None;
    case -0x17:
      return AbstractHeapType.Exn;
    case -0x0c:
      return AbstractHeapType.NoExn;
    default:
      if (v >= 0) return v; // type index
      return AbstractHeapType.Any; // fallback for unknown abstract types
  }
}

/** Read a value type or reference type from the binary stream. */
function readValueType(r: BinaryReader): ValType | RefType {
  const b = r.readU8();
  switch (b) {
    case 0x7f:
      return ValType.I32;
    case 0x7e:
      return ValType.I64;
    case 0x7d:
      return ValType.F32;
    case 0x7c:
      return ValType.F64;
    case 0x7b:
      return ValType.V128;
    // Abstract nullable reference types (shorthand encodings)
    case 0x70:
      return ValType.FuncRef;
    case 0x6f:
      return ValType.ExternRef;
    case 0x6e:
      return ValType.AnyRef;
    case 0x6d:
      return ValType.EqRef;
    case 0x6c:
      return ValType.I31Ref;
    case 0x6b:
      return ValType.StructRef;
    case 0x6a:
      return ValType.ArrayRef;
    case 0x73:
      return ValType.NullFuncRef;
    case 0x72:
      return ValType.NullExternRef;
    case 0x71:
      return ValType.NullRef;
    case 0x69:
      return ValType.ExnRef;
    case 0x74:
      return ValType.NullExnRef;
    // Typed reference: (ref null $T) = 0x63, (ref $T) = 0x64
    case 0x63:
      return { heap: readHeapType(r), nullable: true };
    case 0x64:
      return { heap: readHeapType(r), nullable: false };
    default:
      r.error(`unknown valtype byte 0x${b.toString(16)}`);
  }
}

/** Legacy shim — returns ValType for positions that still use ValType. */
function readValTypeByte(r: BinaryReader): ValType {
  const t = readValueType(r);
  if (typeof t === "string") return t as ValType;
  // ref type in a legacy position — map to nearest abstract ValType
  return ValType.AnyRef;
}

function readBlockType(r: BinaryReader): (ValType | RefType)[] {
  const b = r.peekU8();
  if (b === 0x40) {
    r.readU8();
    return [];
  }
  // Any value type byte (MVP + GC + EH ref types)
  if (
    b === 0x7f || b === 0x7e || b === 0x7d || b === 0x7c || b === 0x7b ||
    b === 0x70 || b === 0x6f || b === 0x6e || b === 0x6d || b === 0x6c ||
    b === 0x6b || b === 0x6a || b === 0x73 || b === 0x72 || b === 0x71 ||
    b === 0x69 || b === 0x74 ||
    b === 0x63 || b === 0x64
  ) {
    return [readValueType(r)];
  }
  // type index (multi-value) — read as signed LEB128
  r.readI32();
  return [];
}

function readMemArg(r: BinaryReader): { align: number; offset: number } {
  const align = r.readU32();
  const offset = r.readU32();
  return { align, offset };
}

function resolveLabel(frames: ControlFrame[], depth: number): string {
  const idx = frames.length - 1 - depth;
  if (idx < 0) return `$label${depth}`;
  return frames[idx].label;
}

/**
 * Returns the number of values a branch to `depth` consumes from the operand
 * stack. For `loop`, MVP semantics: branching jumps to the loop entry and
 * consumes no inputs (multi-value loops with inputs are post-MVP). For all
 * other frames (`block` / `if` / `try` / `try_table` / `func`), consumes the
 * target's result-type arity.
 *
 * @internal
 */
function _branchValueArity(frames: ControlFrame[], depth: number): number {
  const idx = frames.length - 1 - depth;
  if (idx < 0) return 0;
  const target = frames[idx];
  if (target.kind === "loop") return 0;
  return target.resultTypes.length;
}

function sealFrame(frame: ControlFrame, resultType: Type): Expression {
  if (frame.exprs.length === 0) return makeNop();
  if (frame.exprs.length === 1) return frame.exprs[0];
  // The wrapper block is an artificial container for a multi-expression body;
  // it must be ANONYMOUS. Callers (`loop`, `try_table`) re-apply `frame.label`
  // to the enclosing construct (`makeLoop(frame.label, body, ...)`), so reusing
  // it here too produced two nested constructs with the same label —
  // `(loop $L (block $L ...))`. The encoder resolves a branch by innermost
  // matching label, so a loop back-edge `br $L` then targeted the wrapper block
  // (a forward exit) instead of the loop (a continue), silently changing
  // control flow and leaving the loop's declared result value unproduced.
  const blk = makeBlock(frame.exprs, null);
  // The wrapper IS the construct's body, so it must carry the construct's
  // declared result type — NOT the type `makeBlock` infers from the last child.
  // When the body exits via a back-edge `br` (last child unreachable), inference
  // would type the wrapper `unreachable`, which the encoder can only emit as a
  // void blocktype; the void wrapper then "absorbs" the unreachability and
  // yields 0 values to the enclosing result-typed loop, tripping the validator
  // ("expected 1 elements for fallthru, found 0"). Stamping the declared type
  // makes the encoder emit `(block (result T) ... br)`, which validates
  // polymorphically and yields T. Mirrors the `block`-frame handling below.
  blk.type = resultType;
  return blk;
}

// ---------------------------------------------------------------------------
// Main parser class
// ---------------------------------------------------------------------------

class WasmParser {
  private readonly r: BinaryReader;
  private readonly builder = new ModuleBuilder();
  private funcTypes: FuncType[] = [];
  private heapTypeDefs: TypeDef[] = [];
  private importedFuncCount = 0;
  private importedFuncTypeIndices: number[] = [];
  private funcTypeIndices: number[] = [];
  private globalInfos: GlobalInfo[] = [];
  private tableNames: string[] = [];
  private tagInfos: TagInfo[] = [];

  constructor(bytes: Uint8Array) {
    this.r = new BinaryReader(bytes);
  }

  parse(): WasmModule {
    this.readHeader();
    this.readSections();
    const mod = this.builder.build();
    return {
      ...mod,
      heapTypes: this.heapTypeDefs,
      hasGC: this.heapTypeDefs.length > 0,
      tags: this.tagInfos.map((t, i) => ({ name: `$tag${i}`, params: t.params })),
      hasExceptionHandling: this.tagInfos.length > 0 || mod.hasExceptionHandling,
    };
  }

  private readHeader(): void {
    const magic = this.r.readU32Fixed();
    if (magic !== 0x6d736100) this.r.error("invalid WASM magic");
    const version = this.r.readU32Fixed();
    if (version !== 1) this.r.error(`unsupported WASM version ${version}`);
  }

  private readSections(): void {
    while (!this.r.eof) {
      const id = this.r.readU8();
      const size = this.r.readU32();
      const start = this.r.position;
      const end = start + size;

      switch (id) {
        case SECTION_TYPE:
          this.readTypeSection();
          break;
        case SECTION_IMPORT:
          this.readImportSection();
          break;
        case SECTION_FUNCTION:
          this.readFunctionSection();
          break;
        case SECTION_TABLE:
          this.readTableSection();
          break;
        case SECTION_MEMORY:
          this.readMemorySection();
          break;
        case SECTION_GLOBAL:
          this.readGlobalSection();
          break;
        case SECTION_EXPORT:
          this.readExportSection();
          break;
        case SECTION_START:
          this.r.readU32();
          break; // start func index -- skip
        case SECTION_ELEMENT:
          this.readElementSection(end);
          break;
        case SECTION_CODE:
          this.readCodeSection();
          break;
        case SECTION_DATA:
          this.readDataSection();
          break;
        case SECTION_DATA_COUNT:
          this.r.readU32();
          break;
        case SECTION_TAG:
          this.readTagSection();
          break;
        case SECTION_CUSTOM:
          this.readCustomSection(start, end);
          break;
        default:
          this.r.seek(end);
          break;
      }

      if (this.r.position !== end) this.r.seek(end);
    }
  }

  private readTypeSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      this.readTypeDef();
    }
  }

  private readStorageType(): StorageType {
    const b = this.r.peekU8();
    if (b === 0x78) {
      this.r.readU8();
      return "i8";
    }
    if (b === 0x77) {
      this.r.readU8();
      return "i16";
    }
    return readValueType(this.r);
  }

  private readFieldType(): FieldType {
    const type = this.readStorageType();
    const mutable = this.r.readU8() !== 0;
    return { type, mutable };
  }

  private readTypeDef(): void {
    let tag = this.r.readU8();
    // Sub / SubFinal wrappers: skip supertype list, read inner type
    if (tag === 0x50 || tag === 0x4f) {
      const n = this.r.readU32();
      for (let i = 0; i < n; i++) this.r.readU32(); // supertype indices
      tag = this.r.readU8(); // actual type form
    }
    // Rec group: read count then delegate to inner readTypeDef calls
    if (tag === 0x4e) {
      const n = this.r.readU32();
      for (let i = 0; i < n; i++) this.readTypeDef();
      return; // rec group itself doesn't produce a single TypeDef entry
    }
    if (tag === 0x60) { // func type
      const paramCount = this.r.readU32();
      const params: (ValType | RefType)[] = [];
      for (let j = 0; j < paramCount; j++) params.push(readValueType(this.r));
      const resultCount = this.r.readU32();
      const results: (ValType | RefType)[] = [];
      for (let j = 0; j < resultCount; j++) results.push(readValueType(this.r));
      const def: TypeDef = { kind: "func", params, results };
      this.heapTypeDefs.push(def);
      // Keep legacy funcTypes array in sync (map RefType params to AnyRef for compat)
      const p2 = params.map((t) => isRefType(t) ? ValType.AnyRef : t as ValType);
      const r2 = results.map((t) => isRefType(t) ? ValType.AnyRef : t as ValType);
      this.funcTypes.push({ params: p2, results: r2 });
      return;
    }
    if (tag === 0x5f) { // struct type
      const fieldCount = this.r.readU32();
      const fields: FieldType[] = [];
      for (let j = 0; j < fieldCount; j++) fields.push(this.readFieldType());
      this.heapTypeDefs.push({ kind: "struct", fields });
      this.funcTypes.push({ params: [], results: [] }); // placeholder to keep indices aligned
      return;
    }
    if (tag === 0x5e) { // array type
      const element = this.readFieldType();
      this.heapTypeDefs.push({ kind: "array", element });
      this.funcTypes.push({ params: [], results: [] }); // placeholder
      return;
    }
    // Unknown type form — skip gracefully via error (will be caught by caller)
    this.r.error(`unknown type form tag 0x${tag.toString(16)}`);
  }

  private readImportSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      const modLen = this.r.readU32();
      const module = this.r.readUTF8(modLen);
      const baseLen = this.r.readU32();
      const base = this.r.readUTF8(baseLen);
      const kind = this.r.readU8();
      switch (kind) {
        case 0x00: { // function
          const typeIdx = this.r.readU32();
          const ft = this.funcTypes[typeIdx];
          // Imported functions occupy the low end of the single function index
          // space (global indices 0..importedFuncCount-1), so they MUST share
          // the `$func${globalIndex}` naming used by every reference site —
          // calls (0x10/0x12), exports, element segments, and ref.func all emit
          // `$func${idx}`. Naming imports `$import${n}` instead left those
          // references dangling: the encoder's funcIndex map keyed imports by
          // their (mismatched) name, so `funcIndex.get("$func1")` missed and
          // fell back to `?? 0`, encoding every imported-function call as index
          // 0 (wrong target, wrong arity → "call need N got M").
          const name = `$func${this.importedFuncCount}`;
          this.builder.addFunctionImport(name, module, base, ft.params, ft.results);
          this.importedFuncTypeIndices.push(typeIdx);
          this.importedFuncCount++;
          break;
        }
        case 0x01: { // table
          const elemType = readValTypeByte(this.r);
          const hasMax = this.r.readU8();
          const initial = this.r.readU32();
          const max = hasMax ? this.r.readU32() : null;
          const tname = `$table${this.tableNames.length}`;
          this.tableNames.push(tname);
          this.builder.addTableImport(tname, module, base, elemType, initial, max);
          break;
        }
        case 0x02: { // memory
          const flags = this.r.readU8();
          const shared = (flags & 0x02) !== 0;
          const is64 = (flags & 0x04) !== 0;
          const hasMax = (flags & 0x01) !== 0;
          const initial = this.r.readU32();
          const max = hasMax ? this.r.readU32() : null;
          this.builder.addMemoryImport("mem0", module, base, initial, max, shared, is64);
          break;
        }
        case 0x03: { // global
          const type = readValTypeByte(this.r);
          const mutable = this.r.readU8() !== 0;
          const gname = `$global${this.globalInfos.length}`;
          this.globalInfos.push({ type, mutable });
          this.builder.addGlobalImport(gname, module, base, type, mutable);
          break;
        }
        default:
          this.r.error(`unknown import kind 0x${kind.toString(16)}`);
      }
    }
  }

  private readFunctionSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      this.funcTypeIndices.push(this.r.readU32());
    }
  }

  private readTableSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      const elemType = readValTypeByte(this.r);
      const hasMax = this.r.readU8();
      const initial = this.r.readU32();
      const max = hasMax ? this.r.readU32() : null;
      const name = `$table${this.tableNames.length}`;
      this.tableNames.push(name);
      this.builder.addTable(name, elemType, initial, max);
    }
  }

  private readMemorySection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      const flags = this.r.readU8();
      const shared = (flags & 0x02) !== 0;
      const is64 = (flags & 0x04) !== 0;
      const hasMax = (flags & 0x01) !== 0;
      const initial = this.r.readU32();
      const max = hasMax ? this.r.readU32() : null;
      this.builder.addMemory(`mem${i}`, initial, max, shared, is64);
    }
  }

  private readGlobalSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      const type = readValTypeByte(this.r);
      const mutable = this.r.readU8() !== 0;
      const init = this.readInitExpr(type);
      const name = `$global${this.globalInfos.length}`;
      this.globalInfos.push({ type, mutable });
      this.builder.addGlobal(name, type, mutable, init);
    }
  }

  private readExportSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      const nameLen = this.r.readU32();
      const name = this.r.readUTF8(nameLen);
      const kind = this.r.readU8();
      const index = this.r.readU32();
      switch (kind) {
        case 0x00: { // function
          const funcName = `$func${index}`;
          this.builder.addExport(name, funcName, "function");
          break;
        }
        case 0x01: { // table
          const tname = this.tableNames[index] ?? `$table${index}`;
          this.builder.addExport(name, tname, "table");
          break;
        }
        case 0x02: // memory
          this.builder.addExport(name, "mem0", "memory");
          break;
        case 0x03: { // global
          this.builder.addExport(name, `$global${index}`, "global");
          break;
        }
        case 0x04: { // tag (EH proposal)
          // Tags are named `$tag${n}` consistently with `readTagSection`. Note
          // that the export section is parsed BEFORE the tag section in normal
          // wasm modules, so the actual `tagInfos[index]` may not yet exist;
          // we use the canonical name regardless, matching what the tag-section
          // reader will assign. Without this case, every `(export ... (tag ...))`
          // was silently dropped, which broke wasic-emitted modules that
          // export `__exn_tag` (and reproduced as "tag export stripped" in the
          // wasmtk team's bug report against v1.2.2).
          this.builder.addExport(name, `$tag${index}`, "tag");
          break;
        }
        default:
          break;
      }
    }
  }

  private readElementSection(end: number): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      if (this.r.position >= end) break;
      // Element-segment flags bitfield (reference-types proposal):
      //   bit 0 — passive/declarative (clear ⇒ active)
      //   bit 1 — when active: explicit table index; when bit 0 set: declarative
      //   bit 2 — element list is a vec(expr) of reftype, not vec(funcidx)
      // The eight resulting forms (0..7) differ in which fields are present:
      //   tableidx?  offset(expr)?  elemkind/reftype-byte?  then the vector.
      // The legacy active form (flag 0) and the active funcref-expr form
      // (flag 4) are the only two with NO kind/reftype byte. wabt with
      // reference-types enabled emits flag 4 for `(elem (offset) func $a $b)`,
      // which the old `segKind === 0`-only reader silently dropped — leaving
      // the table unpopulated so every `call_indirect` trapped.
      const flags = this.r.readU32();
      if ((flags & 1) !== 0) {
        // Passive (bit 0) / declarative (bit 0+1) element segment. Our IR and
        // encoder model only ACTIVE table initializers; these forms used to be
        // parsed-and-discarded, silently losing the segment — a passive segment
        // a `table.init` would consume, or a declarative `ref.func`
        // forward-declaration whose loss makes a re-encoded `ref.func` invalid
        // ("undeclared function reference"). Fail loudly rather than drop data.
        this.r.error(
          `unsupported element segment flags 0x${flags.toString(16)}: only active ` +
            `table-initializer segments are supported`,
        );
      }
      const hasTableIndex = (flags & 2) !== 0;
      const useExpressions = (flags & 4) !== 0;

      let tableIdx = 0;
      if (hasTableIndex) tableIdx = this.r.readU32();

      const offset = this.readInitExpr(ValType.I32);

      // A 1-byte elemkind (non-expr forms) or reftype (expr forms) precedes the
      // vector for every flag except 0 and 4. We only support funcref tables,
      // so the byte is read and discarded.
      if (flags !== 0 && flags !== 4) this.r.readU8();

      const numElems = this.r.readU32();
      const funcs: string[] = [];
      for (let j = 0; j < numElems; j++) {
        funcs.push(useExpressions ? this.readElemExprFuncName() : `$func${this.r.readU32()}`);
      }

      const tname = this.tableNames[tableIdx] ?? this.tableNames[0] ?? "$table0";
      const seg: ElementSegment = { name: `$elem${i}`, table: tname, offset, data: funcs };
      this.builder.addElement(seg);
    }
  }

  /**
   * Read one element-list expression (flag-4/5/6/7 forms) and return the
   * referenced function name.
   */
  private readElemExprFuncName(): string {
    const opcode = this.r.readU8();
    if (opcode === 0xd2) {
      // ref.func <funcidx>
      const name = `$func${this.r.readU32()}`;
      this.r.readU8(); // 0x0b end
      return name;
    }
    if (opcode === 0xd0) {
      // ref.null <heaptype>. Our element model (`data: string[]`) cannot
      // represent an empty (null) table slot. Silently omitting it shifted
      // every later entry down one table index, so `call_indirect` reached the
      // wrong function (or trapped). Fail loudly until null slots are
      // representable.
      this.r.error(
        "unsupported element segment: a ref.null entry cannot be represented in the table model",
      );
    }
    return this.r.error(
      `unsupported element-segment expression opcode 0x${opcode.toString(16)}`,
    );
  }

  private readCodeSection(): void {
    const count = this.r.readU32();
    const ctx: DecoderCtx = {
      funcTypes: this.funcTypes,
      heapTypeDefs: this.heapTypeDefs,
      importedFuncCount: this.importedFuncCount,
      importedFuncTypeIndices: this.importedFuncTypeIndices,
      funcTypeIndices: this.funcTypeIndices,
      globalInfos: this.globalInfos,
      tableNames: this.tableNames,
      tagInfos: this.tagInfos,
    };
    for (let i = 0; i < count; i++) {
      const bodySize = this.r.readU32();
      const bodyStart = this.r.position;
      const bodyEnd = bodyStart + bodySize;
      const funcIdx = this.importedFuncCount + i;
      const typeIdx = this.funcTypeIndices[i];
      const ft = this.funcTypes[typeIdx];
      const bodyReader = this.r.slice(bodyStart, bodyEnd);
      const fn = this.decodeFunction(bodyReader, ft, funcIdx, ctx);
      this.builder.addFunction(
        fn.name,
        fn.params,
        fn.results,
        fn.body,
        fn.locals.slice(fn.params.length),
        fn.bodyFrameLabel,
      );
      this.r.seek(bodyEnd);
    }
  }

  private readDataSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      const segKind = this.r.readU32();
      if (segKind === 0) {
        const offset = this.readInitExpr(ValType.I32);
        const dataLen = this.r.readU32();
        const data = this.r.readBytes(dataLen);
        this.builder.addDataSegment(`$data${i}`, offset, data);
      } else if (segKind === 1) {
        // passive
        const dataLen = this.r.readU32();
        const data = this.r.readBytes(dataLen);
        this.builder.addPassiveDataSegment(`$data${i}`, data);
      } else {
        // active with explicit memory index (kind=2)
        this.r.readU32(); // memory index
        const offset = this.readInitExpr(ValType.I32);
        const dataLen = this.r.readU32();
        const data = this.r.readBytes(dataLen);
        this.builder.addDataSegment(`$data${i}`, offset, data);
      }
    }
  }

  private readTagSection(): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      this.r.readU8(); // reserved attribute byte (must be 0)
      const typeIdx = this.r.readU32();
      const ft = this.funcTypes[typeIdx] ?? { params: [], results: [] };
      this.tagInfos.push({ name: `$tag${this.tagInfos.length}`, params: ft.params });
    }
  }

  private readCustomSection(_start: number, end: number): void {
    if (this.r.position >= end) return;
    const nameLen = this.r.readU32();
    if (this.r.position + nameLen > end) {
      this.r.seek(end);
      return;
    }
    const name = this.r.readUTF8(nameLen);
    if (name === "name") {
      this.readNameSection(end);
    } else {
      this.r.seek(end);
    }
  }

  private readNameSection(end: number): void {
    // Skip name section -- names are already assigned internally
    this.r.seek(end);
  }

  private readInitExpr(_expectedType: ValType): Expression {
    const opcode = this.r.readU8();
    let expr: Expression;
    switch (opcode) {
      case 0x41:
        expr = makeI32Const(this.r.readI32());
        break;
      case 0x42:
        expr = makeI64Const(this.r.readI64());
        break;
      case 0x43:
        expr = makeF32Const(this.r.readF32());
        break;
      case 0x44:
        expr = makeF64Const(this.r.readF64());
        break;
      case 0x23: { // global.get
        const idx = this.r.readU32();
        const gi = this.globalInfos[idx];
        expr = makeGlobalGet(`$global${idx}`, gi?.type ?? ValType.I32);
        break;
      }
      case 0xd0: { // ref.null
        const ht = this.r.readU8();
        const vt = ht === 0x70 ? ValType.FuncRef : ValType.ExternRef;
        expr = makeRefNull(vt);
        break;
      }
      case 0xd2: { // ref.func
        const idx = this.r.readU32();
        expr = makeRefFunc(`$func${idx}`);
        break;
      }
      default:
        expr = makeI32Const(0);
        break;
    }
    this.r.readU8(); // 0x0b end
    return expr;
  }

  private decodeFunction(
    r: BinaryReader,
    ft: FuncType,
    funcIdx: number,
    ctx: DecoderCtx,
  ): WasmFunction {
    // Read locals
    const locals: Local[] = ft.params.map((t) => ({ type: t }));
    const localGroupCount = r.readU32();
    for (let i = 0; i < localGroupCount; i++) {
      const n = r.readU32();
      const t = readValTypeByte(r);
      for (let j = 0; j < n; j++) locals.push({ type: t });
    }

    const frames: ControlFrame[] = [];
    let labelIdx = 0;

    const freshLabel = (): string => `$l${funcIdx}_${labelIdx++}`;

    frames.push({
      kind: "func",
      label: freshLabel(),
      resultTypes: ft.results,
      exprs: [],
    });

    const push = (e: Expression): void => {
      frames[frames.length - 1].exprs.push(e);
    };

    const pop = (): Expression => {
      const exprs = frames[frames.length - 1].exprs;
      // The operand stack and the statement list share one array. A value
      // consumer must pop the topmost *value-producing* expression — not a
      // `none`-typed statement (nop / local.set / store / void call) that the
      // producer happens to sit beneath. wasic emits exactly this shape in
      // catch handlers: `catch $tag; nop; nop; local.set N` binds a tag param,
      // where the `nop`s carry no stack value and the real value is the catch's
      // `Pop`. Grabbing the `nop` as the operand produces `local.set(nop)`,
      // which CoalesceLocals rewrites to `drop(nop)` and Vacuum then deletes —
      // silently dropping the consumption of a real stack value and leaving the
      // catch's pushed params dangling at the function tail. Skipping `none`
      // statements (leaving them in place so their side effects are preserved)
      // lets the consumer reach the real `Pop`. In well-formed straight-line
      // code values are always on top, so this is a no-op there.
      for (let i = exprs.length - 1; i >= 0; i--) {
        if (exprs[i].type !== None) {
          return exprs.splice(i, 1)[0];
        }
      }
      return makeNop();
    };

    const popN = (n: number): Expression[] => {
      const result: Expression[] = [];
      for (let i = 0; i < n; i++) result.unshift(pop());
      return result;
    };

    // Push a call that may return multiple (tuple) results. The binary pushes
    // N values onto the operand stack, but the IR models the call as a single
    // node — so for N > 1 results each of the OTHER N-1 values needs its own
    // value-typed representative or the consumers that pop them (a `local.set`
    // per result, in the wasic spill pattern) grab a `nop`/void statement
    // instead. That mirrors the catch-param defect (WT-2h): `local.set(nop)`
    // becomes `drop(nop)` under CoalesceLocals and Vacuum then deletes the
    // consumption, dangling the value at the function tail. Seed N-1 typed
    // `Pop`s BELOW the call node (so the call — which carries the operands and
    // must encode first — is consumed first, emitting the actual `call`
    // opcode; each later consumer then pops a `Pop`, which encodes to nothing
    // and survives optimization as `drop(pop)`). `results[i]` types the Pop
    // for the value the i-th later consumer pops.
    const pushMultiValueCall = (call: Expression, results: ValType[]): void => {
      for (let i = 0; i < results.length - 1; i++) push(makePop(results[i]));
      push(call);
    };

    decode: while (!r.eof) {
      const op = r.readU8();
      switch (op) {
        case 0x00:
          push(makeUnreachable());
          break;
        case 0x01:
          push(makeNop());
          break;

        case 0x02: { // block
          const rts = readBlockType(r);
          frames.push({ kind: "block", label: freshLabel(), resultTypes: rts, exprs: [] });
          break;
        }
        case 0x03: { // loop
          const rts = readBlockType(r);
          frames.push({ kind: "loop", label: freshLabel(), resultTypes: rts, exprs: [] });
          break;
        }
        case 0x04: { // if
          const rts = readBlockType(r);
          const cond = pop();
          frames.push({
            kind: "if",
            label: freshLabel(),
            resultTypes: rts,
            exprs: [],
            ifCondition: cond,
            thenExprs: [],
          });
          break;
        }
        case 0x05: { // else
          const frame = frames[frames.length - 1];
          if (frame.kind === "if") {
            frame.thenExprs = frame.exprs;
            frame.exprs = [];
            frame.kind = "else" as ControlFrameKind;
          }
          break;
        }

        case 0x06: { // try (old EH)
          const rts = readBlockType(r);
          frames.push({
            kind: "try",
            label: freshLabel(),
            resultTypes: rts,
            exprs: [],
            catchTags: [],
            catchBodies: [],
            delegateTarget: null,
          });
          break;
        }
        case 0x07: { // catch $tag (old EH)
          const tagIdx = r.readU32();
          const tagName = ctx.tagInfos[tagIdx]?.name ?? `$tag${tagIdx}`;
          const tagParams = ctx.tagInfos[tagIdx]?.params ?? [];
          const frame = frames[frames.length - 1];
          if (frame.kind === "try" || frame.kind === "catch") {
            // save current body
            if (frame.kind === "try") {
              frame.tryBody = frame.exprs;
            } else {
              frame.catchBodies!.push(frame.exprs);
            }
            // `catch $tag` pushes the tag's params onto the catch region's
            // operand stack. Seed the new body with one `Pop` per param (in
            // param order, so the last param is on top and consumed first) —
            // one I32 Pop is wrong for multi-param or non-I32 tags, and the
            // body's binding instructions (`local.set`, `drop`, ...) must each
            // consume a real `Pop` so the consumption survives optimization.
            frame.exprs = tagParams.map((p) => makePop(p));
            frame.catchTags!.push(tagName);
            frame.kind = "catch" as ControlFrameKind;
          }
          break;
        }
        case 0x08: { // throw $tag
          const tagIdx = r.readU32();
          const tagName = ctx.tagInfos[tagIdx]?.name ?? `$tag${tagIdx}`;
          const tagParams = ctx.tagInfos[tagIdx]?.params ?? [];
          const operands = popN(tagParams.length);
          push(makeThrow(tagName, operands));
          break;
        }
        case 0x09: { // rethrow $depth (old EH)
          const depth = r.readU32();
          push(makeRethrow(resolveLabel(frames, depth)));
          break;
        }
        case 0x0a: { // throw_ref (new EH)
          push(makeThrowRef(pop()));
          break;
        }

        case 0x0b: { // end
          if (frames[frames.length - 1].kind === "func") {
            break decode; // leave func frame on stack for body assembly
          }
          const frame = frames.pop()!;
          const rts = frame.resultTypes;
          const resultType: Type = rts.length === 0 ? None : rts.length === 1 ? rts[0] : rts;
          if (frame.kind === "if" || frame.kind === "else") {
            const cond = frame.ifCondition!;
            // Pivot on whether the `else` opcode (0x05) was seen for this frame:
            //   * `"if"`   — no else; `frame.exprs` IS the then-arm body, and
            //                there is no else arm.
            //   * `"else"` — else seen; `frame.thenExprs` was snapshotted by
            //                the else handler, and `frame.exprs` is the else-arm.
            // The previous unified `thenBlock = frame.thenExprs ?? []` path
            // silently put a single-arm `if`'s body in the ELSE arm (because
            // `frame.thenExprs` only ever got assigned in the else handler), so
            // a round-tripped `(if cond (then BODY))` ran BODY when cond was
            // FALSE — the wasmtk team reported four real test failures driven
            // by this on wasic-emitted single-arm ifs (break conditions, bounds
            // checks, null guards).
            const thenExprs = frame.kind === "if" ? frame.exprs : (frame.thenExprs ?? []);
            const elseExprs = frame.kind === "if" ? [] : frame.exprs;
            const thenExpr = thenExprs.length === 1 ? thenExprs[0] : makeBlock(thenExprs, null);
            const elseExpr = elseExprs.length > 0
              ? (elseExprs.length === 1 ? elseExprs[0] : makeBlock(elseExprs, null))
              : null;
            // Pass `frame.label` so a `br` that targets this `if` (resolved to
            // this label at decode time) round-trips to the correct branch
            // depth on encode. Without it the encoder pushed an empty label and
            // the branch silently resolved to the wrong (innermost) frame.
            const ifExpr = makeIf(cond, thenExpr, elseExpr, frame.label);
            void resultType;
            push(ifExpr);
          } else if (frame.kind === "loop") {
            const body = sealFrame(frame, resultType);
            push(makeLoop(frame.label, body, resultType));
          } else if (frame.kind === "try" || frame.kind === "catch") {
            const tryBodyExprs = frame.kind === "try" ? frame.exprs : (frame.tryBody ?? []);
            const tryBody = tryBodyExprs.length === 1
              ? tryBodyExprs[0]
              : makeBlock(tryBodyExprs, null);
            const allCatchBodies = [...(frame.catchBodies ?? [])];
            if (frame.kind === "catch") allCatchBodies.push(frame.exprs);
            const catchBodyExprs = allCatchBodies.map((ce) =>
              ce.length === 1 ? ce[0] : makeBlock(ce, null)
            );
            push(
              makeTry(
                frame.label,
                tryBody,
                frame.catchTags ?? [],
                catchBodyExprs,
                null,
                resultType,
              ),
            );
          } else if (frame.kind === "try_table") {
            const body = sealFrame(frame, resultType);
            push(makeTryTable(frame.label, body, frame.tryCatches ?? [], resultType));
          } else {
            // block (only remaining kind here — func/if/else/loop/try*
            // were handled above).
            //
            // `makeBlock` infers `.type` from the last child, which is wrong
            // when the body exits via `br` (last child is the Break, whose
            // own type is always `None`). We trust the frame's declared
            // result type instead — it came from the `0x02 RESULTTYPE` byte.
            if (frame.exprs.length === 0 && !frame.label) {
              push(makeNop());
            } else {
              const blk = makeBlock(frame.exprs, frame.label);
              blk.type = resultType;
              push(blk);
            }
          }
          break;
        }

        case 0x0c: { // br
          const depth = r.readU32();
          // A br consumes the target block's result values from the operand
          // stack. For a `loop`, branching jumps to the loop entry (and in
          // MVP loops have no inputs, so nothing is consumed). For
          // `block`/`if`/`try`/etc., it consumes the target's result types.
          // Our BreakExpr.value is single-valued; multi-value branches are
          // not yet representable in IR and fall through as value-less
          // (preserves existing behavior on those, fixes the common case).
          const value = _branchValueArity(frames, depth) === 1 ? pop() : null;
          push(makeBreak(resolveLabel(frames, depth), null, value));
          break;
        }
        case 0x0d: { // br_if
          const depth = r.readU32();
          // br_if stack order: ..., value, condition. Pop condition first.
          const cond = pop();
          const value = _branchValueArity(frames, depth) === 1 ? pop() : null;
          push(makeBreak(resolveLabel(frames, depth), cond, value));
          break;
        }
        case 0x0e: { // br_table
          const n = r.readU32();
          const depths: number[] = [];
          for (let i = 0; i <= n; i++) depths.push(r.readU32());
          const defaultDepth = depths.pop()!;
          // br_table stack order: ..., value, index. Pop index first, then
          // value if any target has results (all targets must share arity).
          const cond = pop();
          const value = _branchValueArity(frames, defaultDepth) === 1 ? pop() : null;
          const targets = depths.map((d) => resolveLabel(frames, d));
          const defaultTarget = resolveLabel(frames, defaultDepth);
          push(makeSwitch(targets, defaultTarget, cond, value));
          break;
        }
        case 0x0f: { // return
          const hasVal = ft.results.length > 0;
          push(makeReturn(hasVal ? pop() : null));
          break;
        }
        case 0x10: { // call
          const fidx = r.readU32();
          const typeIdx = fidx < ctx.importedFuncCount
            ? ctx.importedFuncTypeIndices[fidx]
            : ctx.funcTypeIndices[fidx - ctx.importedFuncCount];
          const cft = typeIdx !== undefined ? ctx.funcTypes[typeIdx] : { params: [], results: [] };
          const operands = popN(cft.params.length);
          const resultType: Type = cft.results.length === 0
            ? None
            : cft.results.length === 1
            ? cft.results[0]
            : cft.results;
          pushMultiValueCall(makeCall(`$func${fidx}`, operands, resultType), cft.results);
          break;
        }
        case 0x11: { // call_indirect
          const typeIdx = r.readU32();
          r.readU32(); // table index
          const cft = ctx.funcTypes[typeIdx] ?? { params: [], results: [] };
          const target = pop();
          const operands = popN(cft.params.length);
          const tableName = ctx.tableNames[0] ?? "$table0";
          pushMultiValueCall(
            makeCallIndirect(tableName, target, operands, cft.params, cft.results),
            cft.results,
          );
          break;
        }
        case 0x12: { // return_call (tail-call proposal)
          const fidx = r.readU32();
          const typeIdx = fidx < ctx.importedFuncCount
            ? ctx.importedFuncTypeIndices[fidx]
            : ctx.funcTypeIndices[fidx - ctx.importedFuncCount];
          const cft = typeIdx !== undefined ? ctx.funcTypes[typeIdx] : { params: [], results: [] };
          const operands = popN(cft.params.length);
          const resultType: Type = cft.results.length === 0
            ? None
            : cft.results.length === 1
            ? cft.results[0]
            : cft.results;
          push(makeCall(`$func${fidx}`, operands, resultType, /* isReturn */ true));
          break;
        }
        case 0x13: { // return_call_indirect (tail-call proposal)
          const typeIdx = r.readU32();
          r.readU32(); // table index
          const cft = ctx.funcTypes[typeIdx] ?? { params: [], results: [] };
          const target = pop();
          const operands = popN(cft.params.length);
          const tableName = ctx.tableNames[0] ?? "$table0";
          push(
            makeCallIndirect(
              tableName,
              target,
              operands,
              cft.params,
              cft.results,
              /* isReturn */ true,
            ),
          );
          break;
        }

        case 0x18: { // delegate $depth (old EH — ends the try without end opcode)
          const depth = r.readU32();
          const frame = frames.pop()!;
          const rts = frame.resultTypes;
          const resultType: Type = rts.length === 0 ? None : rts.length === 1 ? rts[0] : rts;
          const tryBody = frame.exprs.length === 1 ? frame.exprs[0] : makeBlock(frame.exprs, null);
          push(makeTry(frame.label, tryBody, [], [], resolveLabel(frames, depth), resultType));
          break;
        }
        case 0x19: { // catch_all (old EH)
          const frame = frames[frames.length - 1];
          if (frame.kind === "try" || frame.kind === "catch") {
            if (frame.kind === "try") {
              frame.tryBody = frame.exprs;
            } else {
              frame.catchBodies!.push(frame.exprs);
            }
            frame.exprs = [];
            frame.catchTags!.push(""); // empty string = catch_all
            frame.kind = "catch" as ControlFrameKind;
          }
          break;
        }
        case 0x1f: { // try_table blocktype (numHandlers handlers) (new EH)
          const rts = readBlockType(r);
          const numHandlers = r.readU32();
          // Read catch clause data (tag+depth pairs) before pushing frame
          const catchData: Array<{ tag: string | null; depth: number; isRef: boolean }> = [];
          for (let i = 0; i < numHandlers; i++) {
            const code = r.readU8();
            let tag: string | null = null;
            if (code === 0x00 || code === 0x01) { // catch / catch_ref
              const tidx = r.readU32();
              tag = ctx.tagInfos[tidx]?.name ?? `$tag${tidx}`;
            }
            const depth = r.readU32();
            const isRef = code === 0x01 || code === 0x03;
            catchData.push({ tag, depth, isRef });
          }
          // Push the frame first — catch dest depths are relative to this frame at depth 0
          frames.push({
            kind: "try_table",
            label: freshLabel(),
            resultTypes: rts,
            exprs: [],
            tryCatches: [],
          });
          const catches: CatchClause[] = catchData.map(({ tag, depth, isRef }) => ({
            tag,
            dest: resolveLabel(frames, depth),
            isRef,
          }));
          frames[frames.length - 1].tryCatches = catches;
          break;
        }

        case 0x1a:
          push(makeDrop(pop()));
          break; // drop
        case 0x1b: { // select
          const cond = pop();
          const b = pop();
          const a = pop();
          push(makeSelect(a, b, cond));
          break;
        }

        case 0x20: { // local.get
          const idx = r.readU32();
          push(makeLocalGet(idx, locals[idx]?.type ?? ValType.I32));
          break;
        }
        case 0x21: { // local.set
          const idx = r.readU32();
          push(makeLocalSet(idx, pop()));
          break;
        }
        case 0x22: { // local.tee
          const idx = r.readU32();
          const val = pop();
          push(makeLocalTee(idx, val, locals[idx]?.type ?? ValType.I32));
          break;
        }
        case 0x23: { // global.get
          const idx = r.readU32();
          const gi = ctx.globalInfos[idx];
          push(makeGlobalGet(`$global${idx}`, gi?.type ?? ValType.I32));
          break;
        }
        case 0x24: { // global.set
          const idx = r.readU32();
          push(makeGlobalSet(`$global${idx}`, pop()));
          break;
        }

        case 0x25: { // table.get $t
          const tidx = r.readU32();
          const table = ctx.tableNames[tidx] ?? `$table${tidx}`;
          const indexExpr = pop();
          push(makeTableGet(table, indexExpr));
          break;
        }
        case 0x26: { // table.set $t
          const tidx = r.readU32();
          const table = ctx.tableNames[tidx] ?? `$table${tidx}`;
          const value = pop();
          const indexExpr = pop();
          push(makeTableSet(table, indexExpr, value));
          break;
        }

        // Loads
        case 0x28: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(4, false, offset, align, pop(), ValType.I32));
          break;
        }
        case 0x29: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(8, false, offset, align, pop(), ValType.I64));
          break;
        }
        case 0x2a: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(4, false, offset, align, pop(), ValType.F32));
          break;
        }
        case 0x2b: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(8, false, offset, align, pop(), ValType.F64));
          break;
        }
        case 0x2c: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(1, true, offset, align, pop(), ValType.I32));
          break;
        }
        case 0x2d: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(1, false, offset, align, pop(), ValType.I32));
          break;
        }
        case 0x2e: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(2, true, offset, align, pop(), ValType.I32));
          break;
        }
        case 0x2f: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(2, false, offset, align, pop(), ValType.I32));
          break;
        }
        case 0x30: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(1, true, offset, align, pop(), ValType.I64));
          break;
        }
        case 0x31: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(1, false, offset, align, pop(), ValType.I64));
          break;
        }
        case 0x32: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(2, true, offset, align, pop(), ValType.I64));
          break;
        }
        case 0x33: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(2, false, offset, align, pop(), ValType.I64));
          break;
        }
        case 0x34: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(4, true, offset, align, pop(), ValType.I64));
          break;
        }
        case 0x35: {
          const { align, offset } = readMemArg(r);
          push(makeLoad(4, false, offset, align, pop(), ValType.I64));
          break;
        }
        // Stores
        case 0x36: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(4, offset, align, pop(), v));
          break;
        }
        case 0x37: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(8, offset, align, pop(), v));
          break;
        }
        case 0x38: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(4, offset, align, pop(), v));
          break;
        }
        case 0x39: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(8, offset, align, pop(), v));
          break;
        }
        case 0x3a: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(1, offset, align, pop(), v));
          break;
        }
        case 0x3b: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(2, offset, align, pop(), v));
          break;
        }
        case 0x3c: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(4, offset, align, pop(), v));
          break;
        }
        case 0x3d: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(1, offset, align, pop(), v));
          break;
        }
        case 0x3e: {
          const { align, offset } = readMemArg(r);
          const v = pop();
          push(makeStore(2, offset, align, pop(), v));
          break;
        }

        case 0x3f:
          r.readU8();
          push(makeMemorySize());
          break; // memory.size
        case 0x40:
          r.readU8();
          push(makeMemoryGrow(pop()));
          break; // memory.grow

        case 0x41:
          push(makeI32Const(r.readI32()));
          break;
        case 0x42:
          push(makeI64Const(r.readI64()));
          break;
        case 0x43:
          push(makeF32Const(r.readF32()));
          break;
        case 0x44:
          push(makeF64Const(r.readF64()));
          break;

        case 0xd0: { // ref.null
          const ht = r.readU8();
          push(makeRefNull(ht === 0x70 ? ValType.FuncRef : ValType.ExternRef));
          break;
        }
        case 0xd1: { // ref.is_null
          push(makeRefIsNull(pop()));
          break;
        }
        case 0xd2: { // ref.func
          push(makeRefFunc(`$func${r.readU32()}`));
          break;
        }
        case 0xd3: { // ref.eq
          const b2 = pop();
          const a2 = pop();
          push(makeRefEq(a2, b2));
          break;
        }
        case 0xd5: { // br_on_null
          const depth = r.readU32();
          const ref = pop();
          push(makeBrOn(BrOnOp.Null, resolveLabel(frames, depth), ref, ref.type));
          break;
        }
        case 0xd6: { // br_on_non_null
          const depth = r.readU32();
          const ref = pop();
          push(makeBrOn(BrOnOp.NonNull, resolveLabel(frames, depth), ref, ref.type));
          break;
        }

        case 0xfb:
          decodeGcPrefix(r, push, pop, ctx, frames);
          break;
        case 0xfc:
          decodeMiscPrefix(r, push, pop);
          break;
        case 0xfd:
          decodeSIMDPrefix(r, push, pop);
          break;

        default: {
          const unary = UNARY_OPCODE[op];
          if (unary !== undefined) {
            push(makeUnary(unary, pop()));
            break;
          }
          const binary = BINARY_OPCODE[op];
          if (binary !== undefined) {
            const rhs = pop();
            push(makeBinary(binary, pop(), rhs));
            break;
          }
          // Genuinely unknown opcode. Pushing a `nop` "to keep the stack
          // consistent" actually corrupted it (the unknown op's stack effect is
          // unknown) and silently dropped the instruction. Fail loudly so an
          // unsupported module is reported rather than miscompiled.
          r.error(`unknown opcode 0x${op.toString(16)}`);
        }
      }
    }

    const funcFrame = frames[0] ?? { exprs: [], label: undefined };
    const body = funcFrame.exprs.length === 1
      ? funcFrame.exprs[0]
      : makeBlock(funcFrame.exprs, null);

    return {
      name: `$func${funcIdx}`,
      // The function-frame label is the target of a `br` that exits the whole
      // function. It is dropped from `body` (a null-named container), so record
      // it here for the encoder to seed; otherwise such a branch mis-resolves.
      bodyFrameLabel: funcFrame.label,
      params: ft.params,
      results: ft.results,
      locals,
      body,
    };
  }
}

// ---------------------------------------------------------------------------
// 0xFB prefix — GC instructions
// ---------------------------------------------------------------------------

function gcRefType(typeIndex: number): RefType {
  return { heap: typeIndex, nullable: false };
}

function decodeGcPrefix(
  r: BinaryReader,
  push: (e: Expression) => void,
  pop: () => Expression,
  ctx: DecoderCtx,
  frames: ControlFrame[],
): void {
  const sub = r.readU32();
  switch (sub) {
    case 0x00: { // struct.new $T
      const ti = r.readU32();
      const def = ctx.heapTypeDefs[ti];
      const n = (def?.kind === "struct") ? def.fields.length : 0;
      const ops: Expression[] = [];
      for (let i = 0; i < n; i++) ops.unshift(pop());
      push(makeStructNew(ti, ops, gcRefType(ti)));
      break;
    }
    case 0x01: { // struct.new_default $T
      const ti = r.readU32();
      push(makeStructNewDefault(ti, gcRefType(ti)));
      break;
    }
    case 0x02: { // struct.get $T $f
      const ti = r.readU32();
      const fi = r.readU32();
      const ref = pop();
      const def = ctx.heapTypeDefs[ti];
      const ft = (def?.kind === "struct") ? def.fields[fi] : undefined;
      const rt: Type = ft ? (isRefType(ft.type) ? ft.type : ft.type as ValType) : ValType.I32;
      push(makeStructGet(ti, fi, ref, rt, false));
      break;
    }
    case 0x03: { // struct.get_s $T $f
      const ti = r.readU32();
      const fi = r.readU32();
      push(makeStructGet(ti, fi, pop(), ValType.I32, true));
      break;
    }
    case 0x04: { // struct.get_u $T $f
      const ti = r.readU32();
      const fi = r.readU32();
      push(makeStructGet(ti, fi, pop(), ValType.I32, false));
      break;
    }
    case 0x05: { // struct.set $T $f
      const ti = r.readU32();
      const fi = r.readU32();
      const val = pop();
      const ref = pop();
      push(makeStructSet(ti, fi, ref, val));
      break;
    }
    case 0x06: { // array.new $T
      const ti = r.readU32();
      const len = pop();
      const init = pop();
      push(makeArrayNew(ti, init, len, gcRefType(ti)));
      break;
    }
    case 0x07: { // array.new_default $T
      const ti = r.readU32();
      push(makeArrayNewDefault(ti, pop(), gcRefType(ti)));
      break;
    }
    case 0x08: { // array.new_fixed $T n
      const ti = r.readU32();
      const n = r.readU32();
      const vals: Expression[] = [];
      for (let i = 0; i < n; i++) vals.unshift(pop());
      push(makeArrayNewFixed(ti, vals, gcRefType(ti)));
      break;
    }
    case 0x09: { // array.new_data $T $d
      const ti = r.readU32();
      const di = r.readU32();
      const len = pop();
      const off = pop();
      push(makeArrayNewData(ti, di, off, len, gcRefType(ti)));
      break;
    }
    case 0x0a: { // array.new_elem $T $e
      const ti = r.readU32();
      const ei = r.readU32();
      const len = pop();
      const off = pop();
      push(makeArrayNewElem(ti, ei, off, len, gcRefType(ti)));
      break;
    }
    case 0x0b: { // array.get $T
      const ti = r.readU32();
      const def = ctx.heapTypeDefs[ti];
      const eft = (def?.kind === "array") ? def.element : undefined;
      const rt: Type = eft ? (isRefType(eft.type) ? eft.type : eft.type as ValType) : ValType.I32;
      const idx = pop();
      const ref = pop();
      push(makeArrayGet(ti, ref, idx, rt, false));
      break;
    }
    case 0x0c: { // array.get_s $T
      const ti = r.readU32();
      const idx = pop();
      const ref = pop();
      push(makeArrayGet(ti, ref, idx, ValType.I32, true));
      break;
    }
    case 0x0d: { // array.get_u $T
      const ti = r.readU32();
      const idx = pop();
      const ref = pop();
      push(makeArrayGet(ti, ref, idx, ValType.I32, false));
      break;
    }
    case 0x0e: { // array.set $T
      const ti = r.readU32();
      const val = pop();
      const idx = pop();
      const ref = pop();
      push(makeArraySet(ti, ref, idx, val));
      break;
    }
    case 0x0f: { // array.len
      push(makeArrayLen(pop()));
      break;
    }
    // array.fill / array.copy / array.init_data / array.init_elem — bulk array
    // GC ops. array.fill was modelled as a single-element `array.set` (dropping
    // the length → it filled one element, not `len`), and the others as `nop`
    // (dropping the op and mis-popping operands). Both are silent miscompiles.
    // Fail loudly until there is real bulk-array IR support.
    case 0x10:
      r.error("unsupported GC opcode: array.fill (0xFB 0x10)");
      break;
    case 0x11:
      r.error("unsupported GC opcode: array.copy (0xFB 0x11)");
      break;
    case 0x12:
      r.error("unsupported GC opcode: array.init_data (0xFB 0x12)");
      break;
    case 0x13:
      r.error("unsupported GC opcode: array.init_elem (0xFB 0x13)");
      break;
    case 0x14: { // ref.test $T
      const ht = readHeapType(r);
      push(makeRefTest(pop(), ht, false));
      break;
    }
    case 0x15: { // ref.test null $T
      const ht = readHeapType(r);
      push(makeRefTest(pop(), ht, true));
      break;
    }
    case 0x16: { // ref.cast $T
      const ht = readHeapType(r);
      push(makeRefCast(pop(), ht, false, { heap: ht, nullable: false }));
      break;
    }
    case 0x17: { // ref.cast null $T
      const ht = readHeapType(r);
      push(makeRefCast(pop(), ht, true, { heap: ht, nullable: true }));
      break;
    }
    case 0x18: { // br_on_cast flags label $T1 $T2
      const flags = r.readU8();
      const depth = r.readU32();
      const ht1 = readHeapType(r); // source heap type
      const ht2 = readHeapType(r); // target (cast) heap type
      const ref = pop();
      push(makeBrOn(
        BrOnOp.Cast,
        resolveLabel(frames, depth),
        ref,
        ref.type,
        ht2,
        (flags & 0x02) !== 0,
        ht1,
        (flags & 0x01) !== 0,
      ));
      break;
    }
    case 0x19: { // br_on_cast_fail flags label $T1 $T2
      const flags = r.readU8();
      const depth = r.readU32();
      const ht1 = readHeapType(r); // source heap type
      const ht2 = readHeapType(r); // target (cast) heap type
      const ref = pop();
      push(makeBrOn(
        BrOnOp.CastFail,
        resolveLabel(frames, depth),
        ref,
        ref.type,
        ht2,
        (flags & 0x02) !== 0,
        ht1,
        (flags & 0x01) !== 0,
      ));
      break;
    }
    case 0x1a:
    case 0x1b: { // any.convert_extern / extern.convert_any
      push(pop()); // identity conversion in IR
      break;
    }
    case 0x1c: { // ref.i31
      push(makeRefI31(pop(), { heap: AbstractHeapType.I31, nullable: false }));
      break;
    }
    case 0x1d: { // i31.get_s
      push(makeI31Get(pop(), true));
      break;
    }
    case 0x1e: { // i31.get_u
      push(makeI31Get(pop(), false));
      break;
    }
    default:
      // Unimplemented GC sub-opcode. A `nop` here silently dropped the op and
      // its operands; fail loudly instead.
      r.error(`unsupported GC opcode: 0xFB 0x${sub.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// 0xFC prefix (bulk memory + saturating truncations)
// ---------------------------------------------------------------------------

function decodeMiscPrefix(
  r: BinaryReader,
  push: (e: Expression) => void,
  pop: () => Expression,
): void {
  const sub = r.readU32();
  switch (sub) {
    case 0:
      push(makeUnary(UnaryOp.TruncSF32ToI32, pop()));
      break; // i32.trunc_sat_f32_s
    case 1:
      push(makeUnary(UnaryOp.TruncUF32ToI32, pop()));
      break;
    case 2:
      push(makeUnary(UnaryOp.TruncSF64ToI32, pop()));
      break;
    case 3:
      push(makeUnary(UnaryOp.TruncUF64ToI32, pop()));
      break;
    case 4:
      push(makeUnary(UnaryOp.TruncSF32ToI64, pop()));
      break;
    case 5:
      push(makeUnary(UnaryOp.TruncUF32ToI64, pop()));
      break;
    case 6:
      push(makeUnary(UnaryOp.TruncSF64ToI64, pop()));
      break;
    case 7:
      push(makeUnary(UnaryOp.TruncUF64ToI64, pop()));
      break;
    case 10: { // memory.copy
      r.readU8();
      r.readU8(); // dst memidx, src memidx
      const size = pop();
      const src = pop();
      const dst = pop();
      push(makeMemoryCopy(dst, src, size));
      break;
    }
    case 11: { // memory.fill
      r.readU8(); // memidx
      const size = pop();
      const val = pop();
      const dst = pop();
      push(makeMemoryFill(dst, val, size));
      break;
    }
    // memory.init (8) / data.drop (9) / table.init (12) / elem.drop (13) /
    // table.copy (14) / table.grow (15) / table.size (16) / table.fill (17),
    // plus any future 0xFC sub-opcode. These were decoded to `nop`, silently
    // dropping the operation — and several popped the WRONG operand count
    // (memory.init/table.init pop 2 of 3; table.grow/size pop 0 but produce a
    // result), so re-encoding produced a valid module that omits the op or an
    // invalid one with a stack imbalance. Either way a silent miscompile. Until
    // they have real IR support, fail loudly so a consumer (e.g. wasmtk) can
    // detect the unsupported module instead of receiving garbage.
    default:
      r.error(`unsupported bulk-memory/table opcode: ${FC_SUBOP_NAME(sub)}`);
  }
}

/** Human-readable name for an unsupported 0xFC bulk-memory / table sub-opcode. */
function FC_SUBOP_NAME(sub: number): string {
  switch (sub) {
    case 8:
      return "memory.init";
    case 9:
      return "data.drop";
    case 12:
      return "table.init";
    case 13:
      return "elem.drop";
    case 14:
      return "table.copy";
    case 15:
      return "table.grow";
    case 16:
      return "table.size";
    case 17:
      return "table.fill";
    default:
      return `0xFC 0x${sub.toString(16)}`;
  }
}

// ---------------------------------------------------------------------------
// 0xFD prefix — SIMD instructions
// ---------------------------------------------------------------------------

function decodeSIMDPrefix(
  r: BinaryReader,
  push: (e: Expression) => void,
  pop: () => Expression,
): void {
  const sub = r.readU32();
  switch (sub) {
    // ---- loads ----
    case 0x00: { // v128.load (16 bytes)
      const align = r.readU32();
      const offset = r.readU32();
      push(makeLoad(16, false, offset, align, pop(), ValType.V128));
      break;
    }
    case 0x01: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load8x8SVec128, pop(), offset, align));
      break;
    }
    case 0x02: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load8x8UVec128, pop(), offset, align));
      break;
    }
    case 0x03: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load16x4SVec128, pop(), offset, align));
      break;
    }
    case 0x04: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load16x4UVec128, pop(), offset, align));
      break;
    }
    case 0x05: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load32x2SVec128, pop(), offset, align));
      break;
    }
    case 0x06: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load32x2UVec128, pop(), offset, align));
      break;
    }
    case 0x07: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load8SplatVec128, pop(), offset, align));
      break;
    }
    case 0x08: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load16SplatVec128, pop(), offset, align));
      break;
    }
    case 0x09: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load32SplatVec128, pop(), offset, align));
      break;
    }
    case 0x0a: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load64SplatVec128, pop(), offset, align));
      break;
    }
    case 0x0b: { // v128.store
      const align = r.readU32();
      const offset = r.readU32();
      const value = pop();
      const ptr = pop();
      push(makeStore(16, offset, align, ptr, value));
      break;
    }
    case 0x0c: { // v128.const — read 16 bytes
      const bytes = r.readBytes(16);
      push(makeV128Const(bytes));
      break;
    }
    case 0x0d: { // i8x16.shuffle — 16 lane-select bytes
      const mask = r.readBytes(16);
      const right = pop();
      const left = pop();
      push(makeSIMDShuffle(left, right, mask));
      break;
    }
    case 0x0e: {
      const right = pop();
      push(makeBinary(BinaryOp.SwizzleVecI8x16, pop(), right));
      break;
    }
    // ---- splats ----
    case 0x0f:
      push(makeUnary(UnaryOp.SplatVecI8x16, pop()));
      break;
    case 0x10:
      push(makeUnary(UnaryOp.SplatVecI16x8, pop()));
      break;
    case 0x11:
      push(makeUnary(UnaryOp.SplatVecI32x4, pop()));
      break;
    case 0x12:
      push(makeUnary(UnaryOp.SplatVecI64x2, pop()));
      break;
    case 0x13:
      push(makeUnary(UnaryOp.SplatVecF32x4, pop()));
      break;
    case 0x14:
      push(makeUnary(UnaryOp.SplatVecF64x2, pop()));
      break;
    // ---- extract / replace lane ----
    case 0x15: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneSVecI8x16, pop(), lane));
      break;
    }
    case 0x16: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneUVecI8x16, pop(), lane));
      break;
    }
    case 0x17: {
      const lane = r.readU8();
      const value = pop();
      push(makeSIMDReplace(SIMDReplaceOp.ReplaceLaneVecI8x16, pop(), lane, value));
      break;
    }
    case 0x18: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneSVecI16x8, pop(), lane));
      break;
    }
    case 0x19: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneUVecI16x8, pop(), lane));
      break;
    }
    case 0x1a: {
      const lane = r.readU8();
      const value = pop();
      push(makeSIMDReplace(SIMDReplaceOp.ReplaceLaneVecI16x8, pop(), lane, value));
      break;
    }
    case 0x1b: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneVecI32x4, pop(), lane));
      break;
    }
    case 0x1c: {
      const lane = r.readU8();
      const value = pop();
      push(makeSIMDReplace(SIMDReplaceOp.ReplaceLaneVecI32x4, pop(), lane, value));
      break;
    }
    case 0x1d: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneVecI64x2, pop(), lane));
      break;
    }
    case 0x1e: {
      const lane = r.readU8();
      const value = pop();
      push(makeSIMDReplace(SIMDReplaceOp.ReplaceLaneVecI64x2, pop(), lane, value));
      break;
    }
    case 0x1f: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneVecF32x4, pop(), lane));
      break;
    }
    case 0x20: {
      const lane = r.readU8();
      const value = pop();
      push(makeSIMDReplace(SIMDReplaceOp.ReplaceLaneVecF32x4, pop(), lane, value));
      break;
    }
    case 0x21: {
      const lane = r.readU8();
      push(makeSIMDExtract(SIMDExtractOp.ExtractLaneVecF64x2, pop(), lane));
      break;
    }
    case 0x22: {
      const lane = r.readU8();
      const value = pop();
      push(makeSIMDReplace(SIMDReplaceOp.ReplaceLaneVecF64x2, pop(), lane, value));
      break;
    }
    // ---- i8x16 comparisons ----
    case 0x23: {
      const r2 = pop();
      push(makeBinary(BinaryOp.EqVecI8x16, pop(), r2));
      break;
    }
    case 0x24: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NeVecI8x16, pop(), r2));
      break;
    }
    case 0x25: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtSVecI8x16, pop(), r2));
      break;
    }
    case 0x26: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtUVecI8x16, pop(), r2));
      break;
    }
    case 0x27: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtSVecI8x16, pop(), r2));
      break;
    }
    case 0x28: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtUVecI8x16, pop(), r2));
      break;
    }
    case 0x29: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeSVecI8x16, pop(), r2));
      break;
    }
    case 0x2a: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeUVecI8x16, pop(), r2));
      break;
    }
    case 0x2b: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeSVecI8x16, pop(), r2));
      break;
    }
    case 0x2c: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeUVecI8x16, pop(), r2));
      break;
    }
    // ---- i16x8 comparisons ----
    case 0x2d: {
      const r2 = pop();
      push(makeBinary(BinaryOp.EqVecI16x8, pop(), r2));
      break;
    }
    case 0x2e: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NeVecI16x8, pop(), r2));
      break;
    }
    case 0x2f: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtSVecI16x8, pop(), r2));
      break;
    }
    case 0x30: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtUVecI16x8, pop(), r2));
      break;
    }
    case 0x31: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtSVecI16x8, pop(), r2));
      break;
    }
    case 0x32: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtUVecI16x8, pop(), r2));
      break;
    }
    case 0x33: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeSVecI16x8, pop(), r2));
      break;
    }
    case 0x34: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeUVecI16x8, pop(), r2));
      break;
    }
    case 0x35: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeSVecI16x8, pop(), r2));
      break;
    }
    case 0x36: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeUVecI16x8, pop(), r2));
      break;
    }
    // ---- i32x4 comparisons ----
    case 0x37: {
      const r2 = pop();
      push(makeBinary(BinaryOp.EqVecI32x4, pop(), r2));
      break;
    }
    case 0x38: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NeVecI32x4, pop(), r2));
      break;
    }
    case 0x39: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtSVecI32x4, pop(), r2));
      break;
    }
    case 0x3a: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtUVecI32x4, pop(), r2));
      break;
    }
    case 0x3b: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtSVecI32x4, pop(), r2));
      break;
    }
    case 0x3c: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtUVecI32x4, pop(), r2));
      break;
    }
    case 0x3d: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeSVecI32x4, pop(), r2));
      break;
    }
    case 0x3e: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeUVecI32x4, pop(), r2));
      break;
    }
    case 0x3f: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeSVecI32x4, pop(), r2));
      break;
    }
    case 0x40: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeUVecI32x4, pop(), r2));
      break;
    }
    // ---- f32x4 comparisons ----
    case 0x41: {
      const r2 = pop();
      push(makeBinary(BinaryOp.EqVecF32x4, pop(), r2));
      break;
    }
    case 0x42: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NeVecF32x4, pop(), r2));
      break;
    }
    case 0x43: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtVecF32x4, pop(), r2));
      break;
    }
    case 0x44: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtVecF32x4, pop(), r2));
      break;
    }
    case 0x45: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeVecF32x4, pop(), r2));
      break;
    }
    case 0x46: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeVecF32x4, pop(), r2));
      break;
    }
    // ---- f64x2 comparisons ----
    case 0x47: {
      const r2 = pop();
      push(makeBinary(BinaryOp.EqVecF64x2, pop(), r2));
      break;
    }
    case 0x48: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NeVecF64x2, pop(), r2));
      break;
    }
    case 0x49: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtVecF64x2, pop(), r2));
      break;
    }
    case 0x4a: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtVecF64x2, pop(), r2));
      break;
    }
    case 0x4b: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeVecF64x2, pop(), r2));
      break;
    }
    case 0x4c: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeVecF64x2, pop(), r2));
      break;
    }
    // ---- v128 bitwise ----
    case 0x4d:
      push(makeUnary(UnaryOp.NotVec128, pop()));
      break;
    case 0x4e: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AndVec128, pop(), r2));
      break;
    }
    case 0x4f: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AndNotVec128, pop(), r2));
      break;
    }
    case 0x50: {
      const r2 = pop();
      push(makeBinary(BinaryOp.OrVec128, pop(), r2));
      break;
    }
    case 0x51: {
      const r2 = pop();
      push(makeBinary(BinaryOp.XorVec128, pop(), r2));
      break;
    }
    case 0x52: {
      const c2 = pop();
      const b2 = pop();
      push(makeSIMDTernary(SIMDTernaryOp.Bitselect, pop(), b2, c2));
      break;
    }
    case 0x53:
      push(makeUnary(UnaryOp.AnyTrueVec128, pop()));
      break;
    // ---- load / store lane ----
    case 0x54: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(SIMDLoadStoreLaneOp.Load8LaneVec128, pop(), vec, offset, align, lane),
      );
      break;
    }
    case 0x55: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Load16LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x56: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Load32LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x57: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Load64LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x58: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Store8LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x59: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Store16LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x5a: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Store32LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x5b: {
      const align = r.readU32();
      const offset = r.readU32();
      const lane = r.readU8();
      const vec = pop();
      push(
        makeSIMDLoadStoreLane(
          SIMDLoadStoreLaneOp.Store64LaneVec128,
          pop(),
          vec,
          offset,
          align,
          lane,
        ),
      );
      break;
    }
    case 0x5c: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load32ZeroVec128, pop(), offset, align));
      break;
    }
    case 0x5d: {
      const align = r.readU32();
      const offset = r.readU32();
      push(makeSIMDLoad(SIMDLoadOp.Load64ZeroVec128, pop(), offset, align));
      break;
    }
    // ---- float conversions ----
    case 0x5e:
      push(makeUnary(UnaryOp.DemoteZeroVecF64x2ToF32x4, pop()));
      break;
    case 0x5f:
      push(makeUnary(UnaryOp.PromoteLowVecF32x4ToF64x2, pop()));
      break;
    // ---- i8x16 unary ----
    case 0x60:
      push(makeUnary(UnaryOp.AbsVecI8x16, pop()));
      break;
    case 0x61:
      push(makeUnary(UnaryOp.NegVecI8x16, pop()));
      break;
    case 0x62:
      push(makeUnary(UnaryOp.PopcntVecI8x16, pop()));
      break;
    case 0x63:
      push(makeUnary(UnaryOp.AllTrueVecI8x16, pop()));
      break;
    case 0x64:
      push(makeUnary(UnaryOp.BitmaskVecI8x16, pop()));
      break;
    case 0x65: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NarrowSVecI16x8ToI8x16, pop(), r2));
      break;
    }
    case 0x66: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NarrowUVecI16x8ToI8x16, pop(), r2));
      break;
    }
    case 0x67:
      push(makeUnary(UnaryOp.CeilVecF32x4, pop()));
      break;
    case 0x68:
      push(makeUnary(UnaryOp.FloorVecF32x4, pop()));
      break;
    case 0x69:
      push(makeUnary(UnaryOp.TruncVecF32x4, pop()));
      break;
    case 0x6a:
      push(makeUnary(UnaryOp.NearestVecF32x4, pop()));
      break;
    case 0x6b: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShlVecI8x16, pop(), shift));
      break;
    }
    case 0x6c: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrSVecI8x16, pop(), shift));
      break;
    }
    case 0x6d: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrUVecI8x16, pop(), shift));
      break;
    }
    case 0x6e: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddVecI8x16, pop(), r2));
      break;
    }
    case 0x6f: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddSatSVecI8x16, pop(), r2));
      break;
    }
    case 0x70: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddSatUVecI8x16, pop(), r2));
      break;
    }
    case 0x71: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubVecI8x16, pop(), r2));
      break;
    }
    case 0x72: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubSatSVecI8x16, pop(), r2));
      break;
    }
    case 0x73: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubSatUVecI8x16, pop(), r2));
      break;
    }
    case 0x74:
      push(makeUnary(UnaryOp.CeilVecF64x2, pop()));
      break;
    case 0x75:
      push(makeUnary(UnaryOp.FloorVecF64x2, pop()));
      break;
    case 0x76: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinSVecI8x16, pop(), r2));
      break;
    }
    case 0x77: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinUVecI8x16, pop(), r2));
      break;
    }
    case 0x78: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxSVecI8x16, pop(), r2));
      break;
    }
    case 0x79: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxUVecI8x16, pop(), r2));
      break;
    }
    case 0x7a:
      push(makeUnary(UnaryOp.TruncVecF64x2, pop()));
      break;
    case 0x7b: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AvgrUVecI8x16, pop(), r2));
      break;
    }
    case 0x7c:
      push(makeUnary(UnaryOp.ExtaddPairwiseSVecI8x16ToI16x8, pop()));
      break;
    case 0x7d:
      push(makeUnary(UnaryOp.ExtaddPairwiseUVecI8x16ToI16x8, pop()));
      break;
    case 0x7e:
      push(makeUnary(UnaryOp.ExtaddPairwiseSVecI16x8ToI32x4, pop()));
      break;
    case 0x7f:
      push(makeUnary(UnaryOp.ExtaddPairwiseUVecI16x8ToI32x4, pop()));
      break;
    // ---- i16x8 ----
    case 0x80:
      push(makeUnary(UnaryOp.AbsVecI16x8, pop()));
      break;
    case 0x81:
      push(makeUnary(UnaryOp.NegVecI16x8, pop()));
      break;
    case 0x82: {
      const r2 = pop();
      push(makeBinary(BinaryOp.Q15MulrSatSVecI16x8, pop(), r2));
      break;
    }
    case 0x83:
      push(makeUnary(UnaryOp.AllTrueVecI16x8, pop()));
      break;
    case 0x84:
      push(makeUnary(UnaryOp.BitmaskVecI16x8, pop()));
      break;
    case 0x85: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NarrowSVecI32x4ToI16x8, pop(), r2));
      break;
    }
    case 0x86: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NarrowUVecI32x4ToI16x8, pop(), r2));
      break;
    }
    case 0x87:
      push(makeUnary(UnaryOp.ExtendLowSVecI8x16ToI16x8, pop()));
      break;
    case 0x88:
      push(makeUnary(UnaryOp.ExtendHighSVecI8x16ToI16x8, pop()));
      break;
    case 0x89:
      push(makeUnary(UnaryOp.ExtendLowUVecI8x16ToI16x8, pop()));
      break;
    case 0x8a:
      push(makeUnary(UnaryOp.ExtendHighUVecI8x16ToI16x8, pop()));
      break;
    case 0x8b: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShlVecI16x8, pop(), shift));
      break;
    }
    case 0x8c: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrSVecI16x8, pop(), shift));
      break;
    }
    case 0x8d: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrUVecI16x8, pop(), shift));
      break;
    }
    case 0x8e: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddVecI16x8, pop(), r2));
      break;
    }
    case 0x8f: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddSatSVecI16x8, pop(), r2));
      break;
    }
    case 0x90: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddSatUVecI16x8, pop(), r2));
      break;
    }
    case 0x91: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubVecI16x8, pop(), r2));
      break;
    }
    case 0x92: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubSatSVecI16x8, pop(), r2));
      break;
    }
    case 0x93: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubSatUVecI16x8, pop(), r2));
      break;
    }
    case 0x94:
      push(makeUnary(UnaryOp.NearestVecF64x2, pop()));
      break;
    case 0x95: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MulVecI16x8, pop(), r2));
      break;
    }
    case 0x96: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinSVecI16x8, pop(), r2));
      break;
    }
    case 0x97: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinUVecI16x8, pop(), r2));
      break;
    }
    case 0x98: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxSVecI16x8, pop(), r2));
      break;
    }
    case 0x99: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxUVecI16x8, pop(), r2));
      break;
    }
    case 0x9b: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AvgrUVecI16x8, pop(), r2));
      break;
    }
    case 0x9c: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulLowSVecI8x16ToI16x8, pop(), r2));
      break;
    }
    case 0x9d: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulHighSVecI8x16ToI16x8, pop(), r2));
      break;
    }
    case 0x9e: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulLowUVecI8x16ToI16x8, pop(), r2));
      break;
    }
    case 0x9f: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulHighUVecI8x16ToI16x8, pop(), r2));
      break;
    }
    // ---- i32x4 ----
    case 0xa0:
      push(makeUnary(UnaryOp.AbsVecI32x4, pop()));
      break;
    case 0xa1:
      push(makeUnary(UnaryOp.NegVecI32x4, pop()));
      break;
    case 0xa3:
      push(makeUnary(UnaryOp.AllTrueVecI32x4, pop()));
      break;
    case 0xa4:
      push(makeUnary(UnaryOp.BitmaskVecI32x4, pop()));
      break;
    case 0xa7:
      push(makeUnary(UnaryOp.ExtendLowSVecI16x8ToI32x4, pop()));
      break;
    case 0xa8:
      push(makeUnary(UnaryOp.ExtendHighSVecI16x8ToI32x4, pop()));
      break;
    case 0xa9:
      push(makeUnary(UnaryOp.ExtendLowUVecI16x8ToI32x4, pop()));
      break;
    case 0xaa:
      push(makeUnary(UnaryOp.ExtendHighUVecI16x8ToI32x4, pop()));
      break;
    case 0xab: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShlVecI32x4, pop(), shift));
      break;
    }
    case 0xac: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrSVecI32x4, pop(), shift));
      break;
    }
    case 0xad: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrUVecI32x4, pop(), shift));
      break;
    }
    case 0xae: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddVecI32x4, pop(), r2));
      break;
    }
    case 0xb1: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubVecI32x4, pop(), r2));
      break;
    }
    case 0xb5: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MulVecI32x4, pop(), r2));
      break;
    }
    case 0xb6: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinSVecI32x4, pop(), r2));
      break;
    }
    case 0xb7: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinUVecI32x4, pop(), r2));
      break;
    }
    case 0xb8: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxSVecI32x4, pop(), r2));
      break;
    }
    case 0xb9: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxUVecI32x4, pop(), r2));
      break;
    }
    case 0xba: {
      const r2 = pop();
      push(makeBinary(BinaryOp.DotSVecI16x8ToI32x4, pop(), r2));
      break;
    }
    case 0xbc: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulLowSVecI16x8ToI32x4, pop(), r2));
      break;
    }
    case 0xbd: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulHighSVecI16x8ToI32x4, pop(), r2));
      break;
    }
    case 0xbe: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulLowUVecI16x8ToI32x4, pop(), r2));
      break;
    }
    case 0xbf: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulHighUVecI16x8ToI32x4, pop(), r2));
      break;
    }
    // ---- i64x2 ----
    case 0xc0:
      push(makeUnary(UnaryOp.AbsVecI64x2, pop()));
      break;
    case 0xc1:
      push(makeUnary(UnaryOp.NegVecI64x2, pop()));
      break;
    case 0xc3:
      push(makeUnary(UnaryOp.AllTrueVecI64x2, pop()));
      break;
    case 0xc4:
      push(makeUnary(UnaryOp.BitmaskVecI64x2, pop()));
      break;
    case 0xc7:
      push(makeUnary(UnaryOp.ExtendLowSVecI32x4ToI64x2, pop()));
      break;
    case 0xc8:
      push(makeUnary(UnaryOp.ExtendHighSVecI32x4ToI64x2, pop()));
      break;
    case 0xc9:
      push(makeUnary(UnaryOp.ExtendLowUVecI32x4ToI64x2, pop()));
      break;
    case 0xca:
      push(makeUnary(UnaryOp.ExtendHighUVecI32x4ToI64x2, pop()));
      break;
    case 0xcb: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShlVecI64x2, pop(), shift));
      break;
    }
    case 0xcc: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrSVecI64x2, pop(), shift));
      break;
    }
    case 0xcd: {
      const shift = pop();
      push(makeSIMDShift(SIMDShiftOp.ShrUVecI64x2, pop(), shift));
      break;
    }
    case 0xce: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddVecI64x2, pop(), r2));
      break;
    }
    case 0xd1: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubVecI64x2, pop(), r2));
      break;
    }
    case 0xd5: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MulVecI64x2, pop(), r2));
      break;
    }
    case 0xd6: {
      const r2 = pop();
      push(makeBinary(BinaryOp.EqVecI64x2, pop(), r2));
      break;
    }
    case 0xd7: {
      const r2 = pop();
      push(makeBinary(BinaryOp.NeVecI64x2, pop(), r2));
      break;
    }
    case 0xd8: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LtSVecI64x2, pop(), r2));
      break;
    }
    case 0xd9: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GtSVecI64x2, pop(), r2));
      break;
    }
    case 0xda: {
      const r2 = pop();
      push(makeBinary(BinaryOp.LeSVecI64x2, pop(), r2));
      break;
    }
    case 0xdb: {
      const r2 = pop();
      push(makeBinary(BinaryOp.GeSVecI64x2, pop(), r2));
      break;
    }
    case 0xdc: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulLowSVecI32x4ToI64x2, pop(), r2));
      break;
    }
    case 0xdd: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulHighSVecI32x4ToI64x2, pop(), r2));
      break;
    }
    case 0xde: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulLowUVecI32x4ToI64x2, pop(), r2));
      break;
    }
    case 0xdf: {
      const r2 = pop();
      push(makeBinary(BinaryOp.ExtmulHighUVecI32x4ToI64x2, pop(), r2));
      break;
    }
    // ---- f32x4 ----
    case 0xe0:
      push(makeUnary(UnaryOp.AbsVecF32x4, pop()));
      break;
    case 0xe1:
      push(makeUnary(UnaryOp.NegVecF32x4, pop()));
      break;
    case 0xe3:
      push(makeUnary(UnaryOp.SqrtVecF32x4, pop()));
      break;
    case 0xe4: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddVecF32x4, pop(), r2));
      break;
    }
    case 0xe5: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubVecF32x4, pop(), r2));
      break;
    }
    case 0xe6: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MulVecF32x4, pop(), r2));
      break;
    }
    case 0xe7: {
      const r2 = pop();
      push(makeBinary(BinaryOp.DivVecF32x4, pop(), r2));
      break;
    }
    case 0xe8: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinVecF32x4, pop(), r2));
      break;
    }
    case 0xe9: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxVecF32x4, pop(), r2));
      break;
    }
    case 0xea: {
      const r2 = pop();
      push(makeBinary(BinaryOp.PminVecF32x4, pop(), r2));
      break;
    }
    case 0xeb: {
      const r2 = pop();
      push(makeBinary(BinaryOp.PmaxVecF32x4, pop(), r2));
      break;
    }
    // ---- f64x2 ----
    case 0xec:
      push(makeUnary(UnaryOp.AbsVecF64x2, pop()));
      break;
    case 0xed:
      push(makeUnary(UnaryOp.NegVecF64x2, pop()));
      break;
    case 0xef:
      push(makeUnary(UnaryOp.SqrtVecF64x2, pop()));
      break;
    case 0xf0: {
      const r2 = pop();
      push(makeBinary(BinaryOp.AddVecF64x2, pop(), r2));
      break;
    }
    case 0xf1: {
      const r2 = pop();
      push(makeBinary(BinaryOp.SubVecF64x2, pop(), r2));
      break;
    }
    case 0xf2: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MulVecF64x2, pop(), r2));
      break;
    }
    case 0xf3: {
      const r2 = pop();
      push(makeBinary(BinaryOp.DivVecF64x2, pop(), r2));
      break;
    }
    case 0xf4: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MinVecF64x2, pop(), r2));
      break;
    }
    case 0xf5: {
      const r2 = pop();
      push(makeBinary(BinaryOp.MaxVecF64x2, pop(), r2));
      break;
    }
    case 0xf6: {
      const r2 = pop();
      push(makeBinary(BinaryOp.PminVecF64x2, pop(), r2));
      break;
    }
    case 0xf7: {
      const r2 = pop();
      push(makeBinary(BinaryOp.PmaxVecF64x2, pop(), r2));
      break;
    }
    // ---- conversions ----
    case 0xf8:
      push(makeUnary(UnaryOp.TruncSatSVecF32x4ToI32x4, pop()));
      break;
    case 0xf9:
      push(makeUnary(UnaryOp.TruncSatUVecF32x4ToI32x4, pop()));
      break;
    case 0xfa:
      push(makeUnary(UnaryOp.ConvertSVecI32x4ToF32x4, pop()));
      break;
    case 0xfb:
      push(makeUnary(UnaryOp.ConvertUVecI32x4ToF32x4, pop()));
      break;
    case 0xfc:
      push(makeUnary(UnaryOp.TruncSatSVecF64x2ToI32x4Zero, pop()));
      break;
    case 0xfd:
      push(makeUnary(UnaryOp.TruncSatUVecF64x2ToI32x4Zero, pop()));
      break;
    case 0xfe:
      push(makeUnary(UnaryOp.ConvertLowSVecI32x4ToF64x2, pop()));
      break;
    case 0xff:
      push(makeUnary(UnaryOp.ConvertLowUVecI32x4ToF64x2, pop()));
      break;
    default:
      // Unknown or relaxed SIMD opcode — skip by emitting nop
      push(makeNop());
      break;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a WebAssembly binary into a {@link WasmModule} IR tree.
 *
 * @param bytes - The raw `.wasm` binary data.
 * @param _filename - Optional filename for error messages (not yet used).
 * @throws {@link WasmBinaryError} on malformed or truncated input.
 */
export function parseWasm(bytes: Uint8Array, _filename?: string): WasmModule {
  return new WasmParser(bytes).parse();
}

export { WasmBinaryError };
