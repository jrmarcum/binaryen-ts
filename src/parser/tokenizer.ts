/**
 * @module binaryen-ts/parser/tokenizer
 *
 * WAT (WebAssembly Text format) lexer / tokenizer.
 *
 * Converts a raw WAT source string into a flat array of {@link Token} objects.
 * This is the first stage of the two-phase WAT parser pipeline:
 *
 * ```
 * source string  ──tokenize()──▶  Token[]  ──buildSExpr()──▶  SExpr  ──parseModule()──▶  WasmModule
 * ```
 *
 * **WAT character classes** (from the WebAssembly spec §6.3.1):
 * - Whitespace: space, tab, newline, carriage return
 * - Line comments: `;;` through end of line
 * - Block comments: `(;` ... `;)` (nestable)
 * - Integers: optional sign + decimal or `0x` hex digits with `_` separators
 * - Floats: decimal/hex float or special `nan`, `inf`, `-inf`, `nan:0x...`
 * - Strings: `"..."` with escape sequences `\n`, `\t`, `\\`, `\"`, `\uXXXX`
 * - Ids: `$` followed by idchars
 * - Keywords: sequences of idchars not starting with `$`
 *
 * @example
 * ```ts
 * import { tokenize } from "@jrmarcum/binaryen-ts/parser/tokenizer";
 *
 * const tokens = tokenize(`(module (func $add (param i32 i32) (result i32)
 *   (i32.add (local.get 0) (local.get 1))))`);
 * ```
 *
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/** Discriminant for each WAT token kind. */
export enum TokenKind {
  /** `(` */
  LParen = "(",
  /** `)` */
  RParen = ")",
  /** An integer literal: `42`, `-7`, `0xff`, `+0x1_f`. */
  Integer = "integer",
  /** A float literal: `1.0`, `nan`, `inf`, `-inf`, `nan:0x7fc00000`. */
  Float = "float",
  /** A quoted string literal: `"hello\n"`. */
  String = "string",
  /** An identifier: `$add`, `$0`. */
  Id = "id",
  /**
   * A keyword or instruction mnemonic: `module`, `func`, `i32.add`,
   * `local.get`, `memory`, etc.
   */
  Keyword = "keyword",
  /** End of input. */
  EOF = "eof",
}

/** Source position (1-based line and column). */
export interface TextPos {
  line: number;
  col: number;
}

/** A single WAT token. */
export interface Token {
  kind: TokenKind;
  /** Raw text of the token as it appears in the source. */
  raw: string;
  /**
   * Decoded value for integer and float tokens (as a number or bigint).
   * `undefined` for other token kinds.
   */
  value?: number | bigint;
  /**
   * Decoded string content (escape sequences resolved) for string tokens.
   * `undefined` for other token kinds.
   */
  text?: string;
  pos: TextPos;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenizes a WAT source string into a flat array of {@link Token} objects.
 *
 * Block comments (`(; ... ;)`) are nestable per the WAT spec.
 * Line comments (`;;`) extend to end of line.
 * Both comment forms are silently consumed — no comment tokens are produced.
 *
 * @param source - The raw WAT text.
 * @param filename - Optional filename for error messages.
 * @throws {@link WatTokenizeError} on invalid input.
 */
export function tokenize(source: string, filename = "<input>"): Token[] {
  const t = new Tokenizer(source, filename);
  return t.tokenizeAll();
}

/** Error thrown when the tokenizer encounters invalid input. */
export class WatTokenizeError extends Error {
  constructor(
    message: string,
    public readonly pos: TextPos,
    public readonly filename: string,
  ) {
    super(`${filename}:${pos.line}:${pos.col}: ${message}`);
    this.name = "WatTokenizeError";
  }
}

// ---------------------------------------------------------------------------
// Internal Tokenizer class
// ---------------------------------------------------------------------------

class Tokenizer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly src: string;
  private readonly filename: string;

  constructor(src: string, filename: string) {
    this.src = src;
    this.filename = filename;
  }

  tokenizeAll(): Token[] {
    const tokens: Token[] = [];
    this.skipWhitespaceAndComments();
    while (this.pos < this.src.length) {
      tokens.push(this.nextToken());
      this.skipWhitespaceAndComments();
    }
    tokens.push({ kind: TokenKind.EOF, raw: "", pos: this.currentPos() });
    return tokens;
  }

  // -------------------------------------------------------------------------
  // Whitespace and comment skipping
  // -------------------------------------------------------------------------

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\r") {
        this.advance();
      } else if (c === "\n") {
        this.advanceNewline();
      } else if (this.startsWith(";;")) {
        this.skipLineComment();
      } else if (this.startsWith("(;")) {
        this.skipBlockComment();
      } else {
        break;
      }
    }
  }

  private skipLineComment(): void {
    // Consume until newline (but not the newline itself — handled next iter)
    while (this.pos < this.src.length && this.src[this.pos] !== "\n") {
      this.advance();
    }
  }

  private skipBlockComment(): void {
    // `(;` already confirmed
    this.advance();
    this.advance(); // consume `(` `;`
    let depth = 1;
    while (this.pos < this.src.length && depth > 0) {
      if (this.startsWith("(;")) {
        this.advance();
        this.advance();
        depth++;
      } else if (this.startsWith(";)")) {
        this.advance();
        this.advance();
        depth--;
      } else if (this.src[this.pos] === "\n") {
        this.advanceNewline();
      } else {
        this.advance();
      }
    }
    if (depth > 0) {
      this.err("unterminated block comment");
    }
  }

  // -------------------------------------------------------------------------
  // Token dispatch
  // -------------------------------------------------------------------------

  private nextToken(): Token {
    const pos = this.currentPos();
    const c = this.src[this.pos];

    if (c === "(") {
      this.advance();
      return { kind: TokenKind.LParen, raw: "(", pos };
    }
    if (c === ")") {
      this.advance();
      return { kind: TokenKind.RParen, raw: ")", pos };
    }
    if (c === '"') {
      return this.readString(pos);
    }
    if (c === "$") {
      return this.readId(pos);
    }
    // Number or keyword starting with sign
    if (c === "+" || c === "-") {
      const next = this.src[this.pos + 1];
      if (next !== undefined && (isDigit(next) || next === "0")) {
        return this.readNumber(pos);
      }
      // +inf, -inf, +nan, -nan start with sign followed by letter
      if (next === "i" || next === "n") {
        return this.readKeywordOrSpecialFloat(pos);
      }
    }
    if (isDigit(c)) {
      return this.readNumber(pos);
    }
    if (isIdChar(c)) {
      return this.readKeywordOrSpecialFloat(pos);
    }

    this.err(`unexpected character: ${JSON.stringify(c)}`);
  }

  // -------------------------------------------------------------------------
  // String tokens
  // -------------------------------------------------------------------------

  private readString(pos: TextPos): Token {
    const start = this.pos; // absolute index of the opening `"`
    this.advance(); // consume opening `"`
    let text = "";
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      if (this.src[this.pos] === "\n") {
        this.err("unterminated string literal (newline inside string)");
      }
      if (this.src[this.pos] === "\\") {
        this.advance();
        text += this.readEscape(pos);
      } else {
        text += this.src[this.pos];
        this.advance();
      }
    }
    if (this.pos >= this.src.length) {
      this.err("unterminated string literal");
    }
    this.advance(); // consume closing `"`
    // Slice from the absolute start index. `pos.col` is a 1-based column WITHIN
    // the current line, not an index into `src`, so it only coincided with the
    // real offset on line 1 — strings on later lines got a corrupted `raw`.
    const raw = this.src.slice(start, this.pos);
    return { kind: TokenKind.String, raw, text, pos };
  }

  private readEscape(_pos: TextPos): string {
    const c = this.src[this.pos];
    this.advance();
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      case "u": {
        if (this.src[this.pos] !== "{") this.err("expected { after \\u");
        this.advance();
        let hex = "";
        while (this.pos < this.src.length && this.src[this.pos] !== "}") {
          hex += this.src[this.pos];
          this.advance();
        }
        if (this.pos >= this.src.length) this.err("unterminated \\u{...}");
        this.advance(); // consume `}`
        const cp = parseInt(hex, 16);
        if (isNaN(cp) || cp > 0x10ffff) this.err(`invalid unicode escape \\u{${hex}}`);
        return String.fromCodePoint(cp);
      }
      default:
        // Two-digit hex escape: \XX
        if (isHexDigit(c)) {
          const c2 = this.src[this.pos];
          if (!isHexDigit(c2)) this.err(`invalid hex escape \\${c}`);
          this.advance();
          return String.fromCharCode(parseInt(c + c2, 16));
        }
        this.err(`invalid escape sequence \\${c}`);
    }
  }

  // -------------------------------------------------------------------------
  // Identifier tokens (`$name`)
  // -------------------------------------------------------------------------

  private readId(pos: TextPos): Token {
    const start = this.pos;
    this.advance(); // consume `$`
    while (this.pos < this.src.length && isIdChar(this.src[this.pos])) {
      this.advance();
    }
    const raw = this.src.slice(start, this.pos);
    if (raw.length === 1) this.err("empty identifier after `$`");
    return { kind: TokenKind.Id, raw, pos };
  }

  // -------------------------------------------------------------------------
  // Number tokens (integer and float)
  // -------------------------------------------------------------------------

  private readNumber(pos: TextPos): Token {
    const start = this.pos;
    // Optional sign
    let sign = 1n;
    if (this.src[this.pos] === "+") this.advance();
    else if (this.src[this.pos] === "-") {
      sign = -1n;
      this.advance();
    }

    // Hex?
    if (this.src[this.pos] === "0" && this.src[this.pos + 1] === "x") {
      this.advance();
      this.advance(); // consume `0x`
      return this.readHexNumber(start, sign, pos);
    }

    // Decimal: read digits
    const intStart = this.pos;
    while (
      this.pos < this.src.length && (isDigit(this.src[this.pos]) || this.src[this.pos] === "_")
    ) {
      this.advance();
    }

    // Float indicators: `.`, `e`, `E`
    const isFloat = this.src[this.pos] === "." ||
      this.src[this.pos] === "e" ||
      this.src[this.pos] === "E";

    if (isFloat) {
      // Read the rest of the float
      if (this.src[this.pos] === ".") {
        this.advance();
        while (
          this.pos < this.src.length && (isDigit(this.src[this.pos]) || this.src[this.pos] === "_")
        ) {
          this.advance();
        }
      }
      if (this.src[this.pos] === "e" || this.src[this.pos] === "E") {
        this.advance();
        if (this.src[this.pos] === "+" || this.src[this.pos] === "-") this.advance();
        while (this.pos < this.src.length && isDigit(this.src[this.pos])) this.advance();
      }
      const raw = this.src.slice(start, this.pos);
      const value = parseFloat(raw.replace(/_/g, ""));
      return { kind: TokenKind.Float, raw, value, pos };
    }

    const digits = this.src.slice(intStart, this.pos).replace(/_/g, "");
    const raw = this.src.slice(start, this.pos);
    if (!digits) this.err("expected digits");
    const value = sign * BigInt(digits);
    // If it fits in a JS safe integer, store as number; otherwise keep bigint
    const n = Number(value);
    return { kind: TokenKind.Integer, raw, value: Number.isSafeInteger(n) ? n : value, pos };
  }

  private readHexNumber(start: number, sign: bigint, pos: TextPos): Token {
    const hexStart = this.pos;
    while (
      this.pos < this.src.length && (isHexDigit(this.src[this.pos]) || this.src[this.pos] === "_")
    ) {
      this.advance();
    }
    const isFloat = this.src[this.pos] === "." ||
      this.src[this.pos] === "p" ||
      this.src[this.pos] === "P";

    if (isFloat) {
      // Hex float: read fractional part and exponent
      if (this.src[this.pos] === ".") {
        this.advance();
        while (
          this.pos < this.src.length &&
          (isHexDigit(this.src[this.pos]) || this.src[this.pos] === "_")
        ) {
          this.advance();
        }
      }
      if (this.src[this.pos] === "p" || this.src[this.pos] === "P") {
        this.advance();
        if (this.src[this.pos] === "+" || this.src[this.pos] === "-") this.advance();
        while (this.pos < this.src.length && isDigit(this.src[this.pos])) this.advance();
      }
      const raw = this.src.slice(start, this.pos);
      // JavaScript can't parse hex floats natively; use DataView trick for nan patterns,
      // or fall back to parsing via a helper.
      const value = parseHexFloat(raw);
      return { kind: TokenKind.Float, raw, value, pos };
    }

    const hexDigits = this.src.slice(hexStart, this.pos).replace(/_/g, "");
    if (!hexDigits) this.err("expected hex digits after 0x");
    const raw = this.src.slice(start, this.pos);
    const value = sign * BigInt("0x" + hexDigits);
    const n = Number(value);
    return { kind: TokenKind.Integer, raw, value: Number.isSafeInteger(n) ? n : value, pos };
  }

  // -------------------------------------------------------------------------
  // Keyword tokens (and special floats: nan, inf, nan:0x...)
  // -------------------------------------------------------------------------

  private readKeywordOrSpecialFloat(pos: TextPos): Token {
    const start = this.pos;
    // Consume a sign if present (for -inf, -nan)
    let hasSuffixSign = false;
    if (this.src[this.pos] === "+" || this.src[this.pos] === "-") {
      hasSuffixSign = true;
      this.advance();
    }
    while (this.pos < this.src.length && isIdChar(this.src[this.pos])) {
      this.advance();
    }
    // Check for nan:0x payload
    if (this.src[this.pos] === ":") {
      const keyword = this.src.slice(start, this.pos);
      if (keyword === "nan" || keyword === "+nan" || keyword === "-nan") {
        this.advance(); // consume `:`
        if (!this.startsWith("0x")) this.err("expected 0x after nan:");
        this.advance();
        this.advance();
        while (
          this.pos < this.src.length &&
          (isHexDigit(this.src[this.pos]) || this.src[this.pos] === "_")
        ) {
          this.advance();
        }
        const raw = this.src.slice(start, this.pos);
        return { kind: TokenKind.Float, raw, value: NaN, pos };
      }
    }
    const raw = this.src.slice(start, this.pos);
    // Special float keywords
    if (raw === "inf" || raw === "+inf") {
      return { kind: TokenKind.Float, raw, value: Infinity, pos };
    }
    if (raw === "-inf") return { kind: TokenKind.Float, raw, value: -Infinity, pos };
    if (raw === "nan" || raw === "+nan") return { kind: TokenKind.Float, raw, value: NaN, pos };
    if (raw === "-nan") return { kind: TokenKind.Float, raw, value: NaN, pos };
    if (hasSuffixSign && raw.length === 1) this.err(`unexpected character: ${JSON.stringify(raw)}`);
    return { kind: TokenKind.Keyword, raw, pos };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private advance(): void {
    this.col++;
    this.pos++;
  }

  private advanceNewline(): void {
    this.pos++;
    this.line++;
    this.col = 1;
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private currentPos(): TextPos {
    return { line: this.line, col: this.col };
  }

  private err(msg: string): never {
    throw new WatTokenizeError(msg, this.currentPos(), this.filename);
  }
}

// ---------------------------------------------------------------------------
// Character class helpers
// ---------------------------------------------------------------------------

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHexDigit(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

/**
 * WAT identifier characters: printable ASCII except whitespace and
 * the reserved characters `(`, `)`, `"`, `;`, `,`.
 */
function isIdChar(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code < 0x21 || code > 0x7e) return false;
  // Excluded: `(` 0x28, `)` 0x29, `"` 0x22, `;` 0x3b, `,` 0x2c
  return c !== "(" && c !== ")" && c !== '"' && c !== ";" && c !== ",";
}

/**
 * Parse a WAT hex float literal like `0x1.8p+1`, `0x1p4`, or `-0xa.bp-2`.
 * Returns `NaN` for unparseable forms.
 *
 * JavaScript's `Number()` cannot parse hex floats (`Number("0x1.8p+1") === NaN`),
 * so the mantissa (integer + fractional hex digits) and the binary `p` exponent
 * are decoded by hand: value = sign · mantissa · 2^exponent.
 *
 * @internal
 */
function parseHexFloat(raw: string): number {
  const cleaned = raw.replace(/_/g, "");
  // [sign] 0x <int-hex> [ . <frac-hex> ] [ (p|P) [sign] <dec-exp> ]
  const m = cleaned.match(
    /^([+-]?)0x([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/,
  );
  if (!m) return NaN;
  const [, signStr, intHex, fracHex = "", expStr] = m;
  if (intHex === "" && fracHex === "") return NaN; // must have at least one digit
  const sign = signStr === "-" ? -1 : 1;
  const exp = expStr ? parseInt(expStr, 10) : 0;

  let mantissa = 0;
  for (const c of intHex) mantissa = mantissa * 16 + parseInt(c, 16);
  let scale = 1;
  for (const c of fracHex) {
    scale /= 16;
    mantissa += parseInt(c, 16) * scale;
  }
  return sign * mantissa * Math.pow(2, exp);
}
