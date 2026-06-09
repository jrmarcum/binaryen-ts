/**
 * @module binaryen-ts/binary/reader
 *
 * Low-level binary reader for WebAssembly binary format.
 * Provides LEB128, raw scalar, and byte-slice reads over a `Uint8Array`.
 *
 * @license MIT
 */

/** Thrown when the binary data is malformed or truncated. */
export class WasmBinaryError extends Error {
  /**
   * Creates a binary-error with an optional byte offset.
   *
   * @param message - Human-readable description of the failure.
   * @param offset - Byte offset within the WASM input where the failure was
   *   detected, or `undefined` if not available. When provided, the offset is
   *   appended to the message in hex form.
   */
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

  /**
   * Creates a reader over a byte slice.
   *
   * @param bytes - The raw WebAssembly binary data.
   * @param startOffset - Initial cursor position (defaults to 0).
   */
  constructor(bytes: Uint8Array, startOffset = 0) {
    this.bytes = bytes;
    this.pos = startOffset;
  }

  /** Current cursor position (byte offset within the input). */
  get position(): number {
    return this.pos;
  }

  /** Total length of the input in bytes. */
  get length(): number {
    return this.bytes.length;
  }

  /** Number of bytes remaining from the current cursor to the end. */
  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  /** `true` when the cursor has reached the end of the input. */
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

  /** Read one byte as an unsigned 8-bit integer. */
  readU8(): number {
    this.checkBounds(1);
    return this.bytes[this.pos++];
  }

  /** Read four bytes as a little-endian fixed-width unsigned 32-bit integer. */
  readU32Fixed(): number {
    this.checkBounds(4);
    const v = this.bytes[this.pos] |
      (this.bytes[this.pos + 1] << 8) |
      (this.bytes[this.pos + 2] << 16) |
      (this.bytes[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  /** Read four bytes as a little-endian IEEE-754 single-precision float. */
  readF32(): number {
    this.checkBounds(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
    const val = view.getFloat32(0, true);
    this.pos += 4;
    return val;
  }

  /** Read eight bytes as a little-endian IEEE-754 double-precision float. */
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
      // On the 5th byte (shift 28) only the low 4 value bits (result bits
      // 28..31) are valid; bits 4..6 (0x70) would set result bits 32..34 and
      // overflow u32. The `shift >= 35` guard below only catches a 6th byte, so
      // a single junk 5th byte previously slipped through and `>>> 0` masked it.
      if (shift === 28 && (byte & 0x70) !== 0) {
        this.error("LEB128 u32 overflow (final byte sets bits beyond 32)");
      }
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
      // On the 10th byte (shift 63) only bit 0 (result bit 63) is valid; bits
      // 1..6 (0x7e) would set result bits 64..69 and overflow u64.
      if (shift === 63n && (byte & 0x7en) !== 0n) {
        this.error("LEB128 u64 overflow (final byte sets bits beyond 64)");
      }
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
      if (shift > 35) {
        this.error("LEB128 i32 overflow");
        break;
      }
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
      if (shift > 70n) {
        this.error("LEB128 i64 overflow");
        break;
      }
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

  /** Throw a {@link WasmBinaryError} stamped with the current cursor offset. */
  error(msg: string): never {
    throw new WasmBinaryError(msg, this.pos);
  }

  /** @internal — throws if reading `n` more bytes would exceed the buffer. */
  private checkBounds(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new WasmBinaryError(
        `unexpected end of binary (need ${n} bytes, ${this.remaining} remaining)`,
        this.pos,
      );
    }
  }
}
