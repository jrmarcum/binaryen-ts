/**
 * @module binaryen-ts/binary/reader
 *
 * Low-level binary reader for WebAssembly binary format.
 * Provides LEB128, raw scalar, and byte-slice reads over a `Uint8Array`.
 *
 * @license MIT OR Apache-2.0
 */

/** Thrown when the binary data is malformed or truncated. */
export class WasmBinaryError extends Error {
  constructor(message: string, public readonly offset?: number) {
    super(offset !== undefined ? `${message} (at offset 0x${offset.toString(16)})` : message);
    this.name = "WasmBinaryError";
  }
}

/**
 * Cursor-based reader over a `Uint8Array` of WebAssembly binary data.
 *
 * All multi-byte integers use little-endian byte order.
 * LEB128 integers follow the WASM spec encoding.
 */
export class BinaryReader {
  private readonly bytes: Uint8Array;
  private pos: number;

  constructor(bytes: Uint8Array, startOffset = 0) {
    this.bytes = bytes;
    this.pos = startOffset;
  }

  get position(): number {
    return this.pos;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  /** Create a sub-reader covering bytes [start, end). */
  slice(start: number, end: number): BinaryReader {
    return new BinaryReader(this.bytes.subarray(start, end));
  }

  // ---------------------------------------------------------------------------
  // Raw reads
  // ---------------------------------------------------------------------------

  readU8(): number {
    this.checkBounds(1);
    return this.bytes[this.pos++];
  }

  readU16(): number {
    this.checkBounds(2);
    const v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8);
    this.pos += 2;
    return v >>> 0;
  }

  readU32Fixed(): number {
    this.checkBounds(4);
    const v =
      this.bytes[this.pos] |
      (this.bytes[this.pos + 1] << 8) |
      (this.bytes[this.pos + 2] << 16) |
      (this.bytes[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  readF32(): number {
    this.checkBounds(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
    const val = view.getFloat32(0, true);
    this.pos += 4;
    return val;
  }

  readF64(): number {
    this.checkBounds(8);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
    const val = view.getFloat64(0, true);
    this.pos += 8;
    return val;
  }

  /** Read `n` raw bytes and return a copy. */
  readBytes(n: number): Uint8Array {
    this.checkBounds(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read a UTF-8 string of exactly `n` bytes. */
  readUTF8(n: number): string {
    const bytes = this.readBytes(n);
    return new TextDecoder().decode(bytes);
  }

  // ---------------------------------------------------------------------------
  // LEB128
  // ---------------------------------------------------------------------------

  /** Unsigned LEB128 -- 32-bit (returns JS number). */
  readU32(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = this.readU8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift >= 35) this.error("LEB128 u32 overflow");
    }
    return result >>> 0;
  }

  /** Unsigned LEB128 -- 64-bit (returns BigInt). */
  readU64(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      const byte = BigInt(this.readU8());
      result |= (byte & 0x7fn) << shift;
      if ((byte & 0x80n) === 0n) break;
      shift += 7n;
      if (shift >= 70n) this.error("LEB128 u64 overflow");
    }
    return result;
  }

  /** Signed LEB128 -- 32-bit (returns JS number). */
  readI32(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = this.readU8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (shift >= 35) { this.error("LEB128 i32 overflow"); break; }
    } while (byte & 0x80);
    if (shift < 32 && (byte & 0x40)) result |= -(1 << shift);
    return result | 0;
  }

  /** Signed LEB128 -- 64-bit (returns BigInt). */
  readI64(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte = 0n;
    do {
      byte = BigInt(this.readU8());
      result |= (byte & 0x7fn) << shift;
      shift += 7n;
      if (shift >= 70n) { this.error("LEB128 i64 overflow"); break; }
    } while (byte & 0x80n);
    if (shift < 64n && (byte & 0x40n)) result |= -(1n << shift);
    return BigInt.asIntN(64, result);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Peek at the next byte without advancing. */
  peekU8(): number {
    this.checkBounds(1);
    return this.bytes[this.pos];
  }

  /** Skip `n` bytes. */
  skip(n: number): void {
    this.checkBounds(n);
    this.pos += n;
  }

  /** Seek to an absolute position. */
  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.length) {
      this.error(`seek out of bounds: ${pos}`);
    }
    this.pos = pos;
  }

  error(msg: string): never {
    throw new WasmBinaryError(msg, this.pos);
  }

  private checkBounds(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new WasmBinaryError(
        `unexpected end of binary (need ${n} bytes, ${this.remaining} remaining)`,
        this.pos,
      );
    }
  }
}
