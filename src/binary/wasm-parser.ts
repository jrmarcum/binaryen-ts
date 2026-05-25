/**
 * @module binaryen-ts/binary/wasm-parser
 *
 * WASM binary format parser.
 * Converts a WebAssembly binary (Uint8Array) into a WasmModule IR tree.
 *
 * @license MIT OR Apache-2.0
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
  makeBinary,
  type Expression,
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
  makeRefFunc,
  makeRefIsNull,
  makeRefNull,
  makeReturn,
  makeSelect,
  makeStore,
  makeSwitch,
  makeUnary,
  makeUnreachable,
  UnaryOp,
} from "../ir/expressions.ts";
import {
  type TypeDef, type FieldType, type StorageType, type RefType,
  AbstractHeapType, type HeapType,
  isRefType,
} from "../ir/gc-types.ts";
import {
  makeRefEq, makeRefI31, makeI31Get,
  makeStructNew, makeStructNewDefault, makeStructGet, makeStructSet,
  makeArrayNew, makeArrayNewDefault, makeArrayNewFixed,
  makeArrayNewData, makeArrayNewElem,
  makeArrayGet, makeArraySet, makeArrayLen,
  makeRefTest, makeRefCast, makeBrOn, BrOnOp,
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

type ControlFrameKind = "block" | "loop" | "if" | "else" | "func";

interface ControlFrame {
  kind: ControlFrameKind;
  label: string;
  resultTypes: (ValType | RefType)[];
  exprs: Expression[];
  ifCondition?: Expression;
  thenExprs?: Expression[];
}

interface DecoderCtx {
  funcTypes: FuncType[];
  heapTypeDefs: TypeDef[];
  importedFuncCount: number;
  funcTypeIndices: number[];
  globalInfos: GlobalInfo[];
  tableNames: string[];
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
    case -0x10: return AbstractHeapType.Func;
    case -0x0d: return AbstractHeapType.NoFunc;
    case -0x11: return AbstractHeapType.Ext;
    case -0x0e: return AbstractHeapType.NoExt;
    case -0x12: return AbstractHeapType.Any;
    case -0x13: return AbstractHeapType.Eq;
    case -0x14: return AbstractHeapType.I31;
    case -0x15: return AbstractHeapType.Struct;
    case -0x16: return AbstractHeapType.Array;
    case -0x0f: return AbstractHeapType.None;
    case -0x17: return AbstractHeapType.Exn;
    case -0x0c: return AbstractHeapType.NoExn;
    default:
      if (v >= 0) return v; // type index
      return AbstractHeapType.Any; // fallback for unknown abstract types
  }
}

/** Read a value type or reference type from the binary stream. */
function readValueType(r: BinaryReader): ValType | RefType {
  const b = r.readU8();
  switch (b) {
    case 0x7f: return ValType.I32;
    case 0x7e: return ValType.I64;
    case 0x7d: return ValType.F32;
    case 0x7c: return ValType.F64;
    case 0x7b: return ValType.V128;
    // Abstract nullable reference types (shorthand encodings)
    case 0x70: return ValType.FuncRef;
    case 0x6f: return ValType.ExternRef;
    case 0x6e: return ValType.AnyRef;
    case 0x6d: return ValType.EqRef;
    case 0x6c: return ValType.I31Ref;
    case 0x6b: return ValType.StructRef;
    case 0x6a: return ValType.ArrayRef;
    case 0x73: return ValType.NullFuncRef;
    case 0x72: return ValType.NullExternRef;
    case 0x71: return ValType.NullRef;
    // Typed reference: (ref null $T) = 0x63, (ref $T) = 0x64
    case 0x63: return { heap: readHeapType(r), nullable: true };
    case 0x64: return { heap: readHeapType(r), nullable: false };
    default: r.error(`unknown valtype byte 0x${b.toString(16)}`);
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
  if (b === 0x40) { r.readU8(); return []; }
  // Any value type byte (MVP + GC ref types)
  if (b === 0x7f || b === 0x7e || b === 0x7d || b === 0x7c || b === 0x7b ||
      b === 0x70 || b === 0x6f || b === 0x6e || b === 0x6d || b === 0x6c ||
      b === 0x6b || b === 0x6a || b === 0x73 || b === 0x72 || b === 0x71 ||
      b === 0x63 || b === 0x64) {
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


function sealFrame(frame: ControlFrame): Expression {
  if (frame.exprs.length === 0) return makeNop();
  if (frame.exprs.length === 1) return frame.exprs[0];
  return makeBlock(frame.exprs, frame.label || null);
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
  private funcTypeIndices: number[] = [];
  private globalInfos: GlobalInfo[] = [];
  private tableNames: string[] = [];

  constructor(bytes: Uint8Array) {
    this.r = new BinaryReader(bytes);
  }

  parse(): WasmModule {
    this.readHeader();
    this.readSections();
    const mod = this.builder.build();
    // Attach heap type definitions collected from the type section
    return { ...mod, heapTypes: this.heapTypeDefs, hasGC: this.heapTypeDefs.length > 0 };
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
        case SECTION_TYPE:     this.readTypeSection(); break;
        case SECTION_IMPORT:   this.readImportSection(); break;
        case SECTION_FUNCTION: this.readFunctionSection(); break;
        case SECTION_TABLE:    this.readTableSection(); break;
        case SECTION_MEMORY:   this.readMemorySection(); break;
        case SECTION_GLOBAL:   this.readGlobalSection(); break;
        case SECTION_EXPORT:   this.readExportSection(); break;
        case SECTION_START:    this.r.readU32(); break; // start func index -- skip
        case SECTION_ELEMENT:  this.readElementSection(end); break;
        case SECTION_CODE:     this.readCodeSection(); break;
        case SECTION_DATA:     this.readDataSection(); break;
        case SECTION_DATA_COUNT: this.r.readU32(); break;
        case SECTION_CUSTOM:   this.readCustomSection(start, end); break;
        default:               this.r.seek(end); break;
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
    if (b === 0x78) { this.r.readU8(); return "i8"; }
    if (b === 0x77) { this.r.readU8(); return "i16"; }
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
          const name = `$import${this.importedFuncCount}`;
          this.builder.addFunctionImport(name, module, base, ft.params, ft.results);
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
        default: this.r.error(`unknown import kind 0x${kind.toString(16)}`);
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
        default: break;
      }
    }
  }

  private readElementSection(end: number): void {
    const count = this.r.readU32();
    for (let i = 0; i < count; i++) {
      if (this.r.position >= end) break;
      const segKind = this.r.readU32();
      // Simplified: only handle kind=0 (active, funcref, implicit table 0)
      if (segKind === 0) {
        const offset = this.readInitExpr(ValType.I32);
        const numElems = this.r.readU32();
        const funcs: string[] = [];
        for (let j = 0; j < numElems; j++) {
          funcs.push(`$func${this.r.readU32()}`);
        }
        const tname = this.tableNames[0] ?? "$table0";
        const seg: ElementSegment = { name: `$elem${i}`, table: tname, offset, data: funcs };
        // ModuleBuilder has no addElement yet -- store via direct access pattern below
        void seg; // suppress unused warning; element segments not yet in builder API
      } else {
        // Skip unknown element segment kinds
        this.r.seek(end);
        break;
      }
    }
  }

  private readCodeSection(): void {
    const count = this.r.readU32();
    const ctx: DecoderCtx = {
      funcTypes: this.funcTypes,
      heapTypeDefs: this.heapTypeDefs,
      importedFuncCount: this.importedFuncCount,
      funcTypeIndices: this.funcTypeIndices,
      globalInfos: this.globalInfos,
      tableNames: this.tableNames,
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
      this.builder.addFunction(fn.name, fn.params, fn.results, fn.body, fn.locals.slice(fn.params.length));
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

  private readCustomSection(_start: number, end: number): void {
    if (this.r.position >= end) return;
    const nameLen = this.r.readU32();
    if (this.r.position + nameLen > end) { this.r.seek(end); return; }
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
      case 0x41: expr = makeI32Const(this.r.readI32()); break;
      case 0x42: expr = makeI64Const(this.r.readI64()); break;
      case 0x43: expr = makeF32Const(this.r.readF32()); break;
      case 0x44: expr = makeF64Const(this.r.readF64()); break;
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
      const top = frames[frames.length - 1];
      return top.exprs.pop() ?? makeNop();
    };

    const popN = (n: number): Expression[] => {
      const result: Expression[] = [];
      for (let i = 0; i < n; i++) result.unshift(pop());
      return result;
    };

    decode: while (!r.eof) {
      const op = r.readU8();
      switch (op) {
        case 0x00: push(makeUnreachable()); break;
        case 0x01: push(makeNop()); break;

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
          frames.push({ kind: "if", label: freshLabel(), resultTypes: rts, exprs: [], ifCondition: cond, thenExprs: [] });
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
        case 0x0b: { // end
          if (frames[frames.length - 1].kind === "func") {
            break decode; // leave func frame on stack for body assembly
          }
          const frame = frames.pop()!;
          const rts = frame.resultTypes;
          const resultType: Type = rts.length === 0 ? None : rts.length === 1 ? rts[0] : rts;
          if (frame.kind === "if" || frame.kind === "else") {
            const cond = frame.ifCondition!;
            const thenBlock = frame.thenExprs ?? [];
            const elseExprs = frame.exprs;
            const thenExpr = thenBlock.length === 1 ? thenBlock[0] : makeBlock(thenBlock, null);
            const elseExpr = elseExprs.length > 0
              ? (elseExprs.length === 1 ? elseExprs[0] : makeBlock(elseExprs, null))
              : null;
            const ifExpr = makeIf(cond, thenExpr, elseExpr);
            void resultType;
            push(ifExpr);
          } else if (frame.kind === "loop") {
            const body = sealFrame(frame);
            push(makeLoop(frame.label, body, resultType));
          } else {
            const body = sealFrame(frame);
            if (frame.exprs.length > 0 || frame.label) {
              push(makeBlock(frame.kind === "block" ? [body] : frame.exprs, frame.label));
            } else {
              push(body);
            }
          }
          break;
        }

        case 0x0c: { // br
          const depth = r.readU32();
          push(makeBreak(resolveLabel(frames, depth)));
          break;
        }
        case 0x0d: { // br_if
          const depth = r.readU32();
          const cond = pop();
          push(makeBreak(resolveLabel(frames, depth), cond));
          break;
        }
        case 0x0e: { // br_table
          const n = r.readU32();
          const targets: string[] = [];
          for (let i = 0; i <= n; i++) targets.push(resolveLabel(frames, r.readU32()));
          const defaultTarget = targets.pop()!;
          const cond = pop();
          push(makeSwitch(targets, defaultTarget, cond));
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
            ? undefined
            : ctx.funcTypeIndices[fidx - ctx.importedFuncCount];
          const cft = typeIdx !== undefined ? ctx.funcTypes[typeIdx] : { params: [], results: [] };
          const operands = popN(cft.params.length);
          const resultType: Type = cft.results.length === 0 ? None
            : cft.results.length === 1 ? cft.results[0]
            : cft.results;
          push(makeCall(`$func${fidx}`, operands, resultType));
          break;
        }
        case 0x11: { // call_indirect
          const typeIdx = r.readU32();
          r.readU32(); // table index
          const cft = ctx.funcTypes[typeIdx] ?? { params: [], results: [] };
          const target = pop();
          const operands = popN(cft.params.length);
          const tableName = ctx.tableNames[0] ?? "$table0";
          push(makeCallIndirect(tableName, target, operands, cft.params, cft.results));
          break;
        }

        case 0x1a: push(makeDrop(pop())); break; // drop
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

        case 0x25: { // table.get -- stub
          r.readU32();
          pop();
          push(makeNop());
          break;
        }
        case 0x26: { // table.set -- stub
          r.readU32();
          pop(); pop();
          push(makeNop());
          break;
        }

        // Loads
        case 0x28: { const { align, offset } = readMemArg(r); push(makeLoad(4, false, offset, align, pop(), ValType.I32)); break; }
        case 0x29: { const { align, offset } = readMemArg(r); push(makeLoad(8, false, offset, align, pop(), ValType.I64)); break; }
        case 0x2a: { const { align, offset } = readMemArg(r); push(makeLoad(4, false, offset, align, pop(), ValType.F32)); break; }
        case 0x2b: { const { align, offset } = readMemArg(r); push(makeLoad(8, false, offset, align, pop(), ValType.F64)); break; }
        case 0x2c: { const { align, offset } = readMemArg(r); push(makeLoad(1, true,  offset, align, pop(), ValType.I32)); break; }
        case 0x2d: { const { align, offset } = readMemArg(r); push(makeLoad(1, false, offset, align, pop(), ValType.I32)); break; }
        case 0x2e: { const { align, offset } = readMemArg(r); push(makeLoad(2, true,  offset, align, pop(), ValType.I32)); break; }
        case 0x2f: { const { align, offset } = readMemArg(r); push(makeLoad(2, false, offset, align, pop(), ValType.I32)); break; }
        case 0x30: { const { align, offset } = readMemArg(r); push(makeLoad(1, true,  offset, align, pop(), ValType.I64)); break; }
        case 0x31: { const { align, offset } = readMemArg(r); push(makeLoad(1, false, offset, align, pop(), ValType.I64)); break; }
        case 0x32: { const { align, offset } = readMemArg(r); push(makeLoad(2, true,  offset, align, pop(), ValType.I64)); break; }
        case 0x33: { const { align, offset } = readMemArg(r); push(makeLoad(2, false, offset, align, pop(), ValType.I64)); break; }
        case 0x34: { const { align, offset } = readMemArg(r); push(makeLoad(4, true,  offset, align, pop(), ValType.I64)); break; }
        case 0x35: { const { align, offset } = readMemArg(r); push(makeLoad(4, false, offset, align, pop(), ValType.I64)); break; }
        // Stores
        case 0x36: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(4, offset, align, pop(), v)); break; }
        case 0x37: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(8, offset, align, pop(), v)); break; }
        case 0x38: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(4, offset, align, pop(), v)); break; }
        case 0x39: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(8, offset, align, pop(), v)); break; }
        case 0x3a: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(1, offset, align, pop(), v)); break; }
        case 0x3b: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(2, offset, align, pop(), v)); break; }
        case 0x3c: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(4, offset, align, pop(), v)); break; }
        case 0x3d: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(1, offset, align, pop(), v)); break; }
        case 0x3e: { const { align, offset } = readMemArg(r); const v = pop(); push(makeStore(2, offset, align, pop(), v)); break; }

        case 0x3f: r.readU8(); push(makeMemorySize()); break; // memory.size
        case 0x40: r.readU8(); push(makeMemoryGrow(pop())); break; // memory.grow

        case 0x41: push(makeI32Const(r.readI32())); break;
        case 0x42: push(makeI64Const(r.readI64())); break;
        case 0x43: push(makeF32Const(r.readF32())); break;
        case 0x44: push(makeF64Const(r.readF64())); break;

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
          const b2 = pop(); const a2 = pop();
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

        case 0xfb: decodeGcPrefix(r, push, pop, ctx, frames); break;
        case 0xfc: decodeMiscPrefix(r, push, pop); break;

        default: {
          const unary = UNARY_OPCODE[op];
          if (unary !== undefined) { push(makeUnary(unary, pop())); break; }
          const binary = BINARY_OPCODE[op];
          if (binary !== undefined) { const rhs = pop(); push(makeBinary(binary, pop(), rhs)); break; }
          // Unknown opcode -- push nop to keep stack consistent
          push(makeNop());
          break;
        }
      }
    }

    const funcFrame = frames[0] ?? { exprs: [] };
    const body = funcFrame.exprs.length === 1
      ? funcFrame.exprs[0]
      : makeBlock(funcFrame.exprs, null);

    return {
      name: `$func${funcIdx}`,
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
      const ti = r.readU32(); const fi = r.readU32();
      const ref = pop();
      const def = ctx.heapTypeDefs[ti];
      const ft = (def?.kind === "struct") ? def.fields[fi] : undefined;
      const rt: Type = ft ? (isRefType(ft.type) ? ft.type : ft.type as ValType) : ValType.I32;
      push(makeStructGet(ti, fi, ref, rt, false));
      break;
    }
    case 0x03: { // struct.get_s $T $f
      const ti = r.readU32(); const fi = r.readU32();
      push(makeStructGet(ti, fi, pop(), ValType.I32, true));
      break;
    }
    case 0x04: { // struct.get_u $T $f
      const ti = r.readU32(); const fi = r.readU32();
      push(makeStructGet(ti, fi, pop(), ValType.I32, false));
      break;
    }
    case 0x05: { // struct.set $T $f
      const ti = r.readU32(); const fi = r.readU32();
      const val = pop(); const ref = pop();
      push(makeStructSet(ti, fi, ref, val));
      break;
    }
    case 0x06: { // array.new $T
      const ti = r.readU32();
      const len = pop(); const init = pop();
      push(makeArrayNew(ti, init, len, gcRefType(ti)));
      break;
    }
    case 0x07: { // array.new_default $T
      const ti = r.readU32();
      push(makeArrayNewDefault(ti, pop(), gcRefType(ti)));
      break;
    }
    case 0x08: { // array.new_fixed $T n
      const ti = r.readU32(); const n = r.readU32();
      const vals: Expression[] = [];
      for (let i = 0; i < n; i++) vals.unshift(pop());
      push(makeArrayNewFixed(ti, vals, gcRefType(ti)));
      break;
    }
    case 0x09: { // array.new_data $T $d
      const ti = r.readU32(); const di = r.readU32();
      const len = pop(); const off = pop();
      push(makeArrayNewData(ti, di, off, len, gcRefType(ti)));
      break;
    }
    case 0x0a: { // array.new_elem $T $e
      const ti = r.readU32(); const ei = r.readU32();
      const len = pop(); const off = pop();
      push(makeArrayNewElem(ti, ei, off, len, gcRefType(ti)));
      break;
    }
    case 0x0b: { // array.get $T
      const ti = r.readU32();
      const def = ctx.heapTypeDefs[ti];
      const eft = (def?.kind === "array") ? def.element : undefined;
      const rt: Type = eft ? (isRefType(eft.type) ? eft.type : eft.type as ValType) : ValType.I32;
      const idx = pop(); const ref = pop();
      push(makeArrayGet(ti, ref, idx, rt, false));
      break;
    }
    case 0x0c: { // array.get_s $T
      const ti = r.readU32();
      const idx = pop(); const ref = pop();
      push(makeArrayGet(ti, ref, idx, ValType.I32, true));
      break;
    }
    case 0x0d: { // array.get_u $T
      const ti = r.readU32();
      const idx = pop(); const ref = pop();
      push(makeArrayGet(ti, ref, idx, ValType.I32, false));
      break;
    }
    case 0x0e: { // array.set $T
      const ti = r.readU32();
      const val = pop(); const idx = pop(); const ref = pop();
      push(makeArraySet(ti, ref, idx, val));
      break;
    }
    case 0x0f: { // array.len
      push(makeArrayLen(pop()));
      break;
    }
    case 0x10: { // array.fill $T
      const ti = r.readU32();
      const len = pop(); const val = pop(); const idx = pop(); const ref = pop();
      void ti;
      // Emit as: ref[idx..idx+len] = val — modelled as array.set for first element
      // Full array.fill IR node is available; emit nop for now (complex multi-op)
      push(makeArraySet(ti, ref, idx, val));
      void len;
      break;
    }
    case 0x11: { // array.copy $T1 $T2
      const _ti1 = r.readU32(); const _ti2 = r.readU32();
      pop(); pop(); pop(); pop(); pop();
      push(makeNop());
      break;
    }
    case 0x12: { // array.init_data $T $d
      const _ti = r.readU32(); const _di = r.readU32();
      pop(); pop(); pop(); pop();
      push(makeNop());
      break;
    }
    case 0x13: { // array.init_elem $T $e
      const _ti = r.readU32(); const _ei = r.readU32();
      pop(); pop(); pop(); pop();
      push(makeNop());
      break;
    }
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
      const _ht1 = readHeapType(r);
      const ht2 = readHeapType(r);
      const nullable = (flags & 0x02) !== 0;
      const ref = pop();
      push(makeBrOn(BrOnOp.Cast, resolveLabel(frames, depth), ref, ref.type, ht2, nullable));
      break;
    }
    case 0x19: { // br_on_cast_fail flags label $T1 $T2
      const flags = r.readU8();
      const depth = r.readU32();
      const _ht1 = readHeapType(r);
      const ht2 = readHeapType(r);
      const nullable = (flags & 0x02) !== 0;
      const ref = pop();
      push(makeBrOn(BrOnOp.CastFail, resolveLabel(frames, depth), ref, ref.type, ht2, nullable));
      break;
    }
    case 0x1a: case 0x1b: { // any.convert_extern / extern.convert_any
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
      push(makeNop());
      break;
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
    case 0: push(makeUnary(UnaryOp.TruncSF32ToI32, pop())); break; // i32.trunc_sat_f32_s
    case 1: push(makeUnary(UnaryOp.TruncUF32ToI32, pop())); break;
    case 2: push(makeUnary(UnaryOp.TruncSF64ToI32, pop())); break;
    case 3: push(makeUnary(UnaryOp.TruncUF64ToI32, pop())); break;
    case 4: push(makeUnary(UnaryOp.TruncSF32ToI64, pop())); break;
    case 5: push(makeUnary(UnaryOp.TruncUF32ToI64, pop())); break;
    case 6: push(makeUnary(UnaryOp.TruncSF64ToI64, pop())); break;
    case 7: push(makeUnary(UnaryOp.TruncUF64ToI64, pop())); break;
    case 10: { // memory.copy
      r.readU8(); r.readU8(); // dst memidx, src memidx
      const size = pop(); const src = pop(); const dst = pop();
      push(makeMemoryCopy(dst, src, size));
      break;
    }
    case 11: { // memory.fill
      r.readU8(); // memidx
      const size = pop(); const val = pop(); const dst = pop();
      push(makeMemoryFill(dst, val, size));
      break;
    }
    case 8:  { r.readU32(); r.readU8(); pop(); pop(); push(makeNop()); break; } // memory.init
    case 9:  { r.readU32(); push(makeNop()); break; } // data.drop
    case 12: { r.readU32(); r.readU32(); pop(); pop(); push(makeNop()); break; } // table.init
    case 13: { r.readU32(); push(makeNop()); break; } // elem.drop
    case 14: { r.readU32(); r.readU32(); pop(); pop(); pop(); push(makeNop()); break; } // table.copy
    case 15: { r.readU32(); push(makeNop()); break; } // table.grow (stub)
    case 16: { r.readU32(); push(makeNop()); break; } // table.size (stub)
    case 17: { r.readU32(); pop(); pop(); pop(); push(makeNop()); break; } // table.fill (stub)
    default: push(makeNop()); break;
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
