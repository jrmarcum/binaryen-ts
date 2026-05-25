const src = await Deno.readTextFile("src/ir/expressions.ts");

const gcInterfaces = `
// ---------------------------------------------------------------------------
// GC proposal expression node types (Phase 7)
// ---------------------------------------------------------------------------

/** Discriminant for br_on variants. */
export enum BrOnOp {
  Null     = "br_on_null",
  NonNull  = "br_on_non_null",
  Cast     = "br_on_cast",
  CastFail = "br_on_cast_fail",
}

export interface RefEqExpr extends ExprBase {
  kind: ExpressionKind.RefEq;
  type: ValType.I32;
  left: Expression;
  right: Expression;
}

export interface RefI31Expr extends ExprBase {
  kind: ExpressionKind.RefI31;
  value: Expression;
}

export interface I31GetExpr extends ExprBase {
  kind: ExpressionKind.I31Get;
  type: ValType.I32;
  i31: Expression;
  /** true = i31.get_s (sign-extend). */
  signed: boolean;
}

export interface StructNewExpr extends ExprBase {
  kind: ExpressionKind.StructNew;
  typeIndex: number;
  operands: Expression[];
  defaultInit: boolean;
}

export interface StructGetExpr extends ExprBase {
  kind: ExpressionKind.StructGet;
  typeIndex: number;
  fieldIndex: number;
  ref: Expression;
  signed: boolean;
}

export interface StructSetExpr extends ExprBase {
  kind: ExpressionKind.StructSet;
  type: None;
  typeIndex: number;
  fieldIndex: number;
  ref: Expression;
  value: Expression;
}

export interface ArrayNewExpr extends ExprBase {
  kind: ExpressionKind.ArrayNew;
  typeIndex: number;
  init: Expression | null;
  length: Expression;
}

export interface ArrayNewFixedExpr extends ExprBase {
  kind: ExpressionKind.ArrayNewFixed;
  typeIndex: number;
  values: Expression[];
}

export interface ArrayNewDataExpr extends ExprBase {
  kind: ExpressionKind.ArrayNewData;
  typeIndex: number;
  dataSegment: number;
  offset: Expression;
  length: Expression;
}

export interface ArrayNewElemExpr extends ExprBase {
  kind: ExpressionKind.ArrayNewElem;
  typeIndex: number;
  elemSegment: number;
  offset: Expression;
  length: Expression;
}

export interface ArrayGetExpr extends ExprBase {
  kind: ExpressionKind.ArrayGet;
  typeIndex: number;
  ref: Expression;
  index: Expression;
  signed: boolean;
}

export interface ArraySetExpr extends ExprBase {
  kind: ExpressionKind.ArraySet;
  type: None;
  typeIndex: number;
  ref: Expression;
  index: Expression;
  value: Expression;
}

export interface ArrayLenExpr extends ExprBase {
  kind: ExpressionKind.ArrayLen;
  type: ValType.I32;
  ref: Expression;
}

export interface RefTestExpr extends ExprBase {
  kind: ExpressionKind.RefTest;
  type: ValType.I32;
  ref: Expression;
  castType: HeapType;
  nullable: boolean;
}

export interface RefCastExpr extends ExprBase {
  kind: ExpressionKind.RefCast;
  ref: Expression;
  castType: HeapType;
  nullable: boolean;
}

export interface BrOnExpr extends ExprBase {
  kind: ExpressionKind.BrOn;
  op: BrOnOp;
  label: string;
  ref: Expression;
  castType?: HeapType;
  castNullable?: boolean;
}

`;

const unionOld = "  | RefNullExpr\n  | RefIsNullExpr\n  | RefFuncExpr;";
const unionNew = `  | RefNullExpr
  | RefIsNullExpr
  | RefFuncExpr
  | RefEqExpr
  | RefI31Expr
  | I31GetExpr
  | StructNewExpr
  | StructGetExpr
  | StructSetExpr
  | ArrayNewExpr
  | ArrayNewFixedExpr
  | ArrayNewDataExpr
  | ArrayNewElemExpr
  | ArrayGetExpr
  | ArraySetExpr
  | ArrayLenExpr
  | RefTestExpr
  | RefCastExpr
  | BrOnExpr;`;

const gcFactories = `
/** Creates a ref.eq expression. */
export function makeRefEq(left: Expression, right: Expression): RefEqExpr {
  return { kind: ExpressionKind.RefEq, type: ValType.I32, left, right };
}

/** Creates a ref.i31 expression. */
export function makeRefI31(value: Expression, resultType: Type): RefI31Expr {
  return { kind: ExpressionKind.RefI31, type: resultType, value };
}

/** Creates an i31.get_s or i31.get_u expression. */
export function makeI31Get(i31: Expression, signed: boolean): I31GetExpr {
  return { kind: ExpressionKind.I31Get, type: ValType.I32, i31, signed };
}

/** Creates a struct.new expression. */
export function makeStructNew(typeIndex: number, operands: Expression[], resultType: Type): StructNewExpr {
  return { kind: ExpressionKind.StructNew, type: resultType, typeIndex, operands, defaultInit: false };
}

/** Creates a struct.new_default expression. */
export function makeStructNewDefault(typeIndex: number, resultType: Type): StructNewExpr {
  return { kind: ExpressionKind.StructNew, type: resultType, typeIndex, operands: [], defaultInit: true };
}

/** Creates a struct.get expression. */
export function makeStructGet(typeIndex: number, fieldIndex: number, ref: Expression, resultType: Type, signed = false): StructGetExpr {
  return { kind: ExpressionKind.StructGet, type: resultType, typeIndex, fieldIndex, ref, signed };
}

/** Creates a struct.set expression. */
export function makeStructSet(typeIndex: number, fieldIndex: number, ref: Expression, value: Expression): StructSetExpr {
  return { kind: ExpressionKind.StructSet, type: None, typeIndex, fieldIndex, ref, value };
}

/** Creates an array.new expression. */
export function makeArrayNew(typeIndex: number, init: Expression, length: Expression, resultType: Type): ArrayNewExpr {
  return { kind: ExpressionKind.ArrayNew, type: resultType, typeIndex, init, length };
}

/** Creates an array.new_default expression. */
export function makeArrayNewDefault(typeIndex: number, length: Expression, resultType: Type): ArrayNewExpr {
  return { kind: ExpressionKind.ArrayNew, type: resultType, typeIndex, init: null, length };
}

/** Creates an array.new_fixed expression. */
export function makeArrayNewFixed(typeIndex: number, values: Expression[], resultType: Type): ArrayNewFixedExpr {
  return { kind: ExpressionKind.ArrayNewFixed, type: resultType, typeIndex, values };
}

/** Creates an array.new_data expression. */
export function makeArrayNewData(typeIndex: number, dataSegment: number, offset: Expression, length: Expression, resultType: Type): ArrayNewDataExpr {
  return { kind: ExpressionKind.ArrayNewData, type: resultType, typeIndex, dataSegment, offset, length };
}

/** Creates an array.new_elem expression. */
export function makeArrayNewElem(typeIndex: number, elemSegment: number, offset: Expression, length: Expression, resultType: Type): ArrayNewElemExpr {
  return { kind: ExpressionKind.ArrayNewElem, type: resultType, typeIndex, elemSegment, offset, length };
}

/** Creates an array.get expression. */
export function makeArrayGet(typeIndex: number, ref: Expression, index: Expression, resultType: Type, signed = false): ArrayGetExpr {
  return { kind: ExpressionKind.ArrayGet, type: resultType, typeIndex, ref, index, signed };
}

/** Creates an array.set expression. */
export function makeArraySet(typeIndex: number, ref: Expression, index: Expression, value: Expression): ArraySetExpr {
  return { kind: ExpressionKind.ArraySet, type: None, typeIndex, ref, index, value };
}

/** Creates an array.len expression. */
export function makeArrayLen(ref: Expression): ArrayLenExpr {
  return { kind: ExpressionKind.ArrayLen, type: ValType.I32, ref };
}

/** Creates a ref.test or ref.test null expression. */
export function makeRefTest(ref: Expression, castType: HeapType, nullable: boolean): RefTestExpr {
  return { kind: ExpressionKind.RefTest, type: ValType.I32, ref, castType, nullable };
}

/** Creates a ref.cast or ref.cast null expression. */
export function makeRefCast(ref: Expression, castType: HeapType, nullable: boolean, resultType: Type): RefCastExpr {
  return { kind: ExpressionKind.RefCast, type: resultType, ref, castType, nullable };
}

/** Creates a br_on_null, br_on_non_null, br_on_cast, or br_on_cast_fail expression. */
export function makeBrOn(
  op: BrOnOp, label: string, ref: Expression, resultType: Type,
  castType?: HeapType, castNullable?: boolean,
): BrOnExpr {
  return { kind: ExpressionKind.BrOn, type: resultType, op, label, ref, castType, castNullable };
}

`;

let p = src;
const unionMarker = "// ---------------------------------------------------------------------------\n// Top-level Expression union";
p = p.replace(unionMarker, gcInterfaces + unionMarker);
p = p.replace(unionOld, unionNew);
const helperMarker = "// ---------------------------------------------------------------------------\n// Internal type inference helpers";
p = p.replace(helperMarker, gcFactories + helperMarker);

if (p === src) {
  console.error("NO SUBSTITUTIONS MADE — check line endings");
  Deno.exit(1);
}
await Deno.writeTextFile("src/ir/expressions.ts", p);
console.log("done");