import type { Reader } from './io';

/**
 * A run of bytes the parsers read as one: a range of the file, several ranges joined, such as a JPEG ICC profile split
 * over APP2 segments, or bytes already in memory.
 */
export interface Slice {
  readonly size: number;
  /** The file offset of the slice's first byte, when the slice is one range of the file. */
  readonly base?: number;
  /** Reads up to `length` bytes at `offset`; shorter only at the end of the slice. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Yields the slice in chunks. */
  chunks(): AsyncGenerator<Uint8Array>;
}

export function fileSlice(reader: Reader, start: number, length: number): Slice {
  const size = Math.max(0, Math.min(length, reader.size - start));
  return {
    size,
    base: start,
    read: (offset, n) => (offset >= size || n <= 0 ? Promise.resolve(new Uint8Array(0)) : reader.read(start + offset, Math.min(n, size - offset))),
    chunks: () => reader.chunks(start, size),
  };
}

/** Ranges of the file, each [start, length], read as one run of bytes. */
export function joinedSlice(reader: Reader, ranges: Array<[number, number]>): Slice {
  const parts = ranges.map(([s, n]) => fileSlice(reader, s, n));
  const size = parts.reduce((t, p) => t + p.size, 0);
  return {
    size,
    async read(offset, n) {
      const end = Math.min(size, offset + n);
      if (offset >= end) return new Uint8Array(0);
      const out = new Uint8Array(end - offset);
      let at = 0;
      let pos = 0;
      for (const p of parts) {
        const from = Math.max(offset, at);
        const to = Math.min(end, at + p.size);
        if (from < to) {
          out.set(await p.read(from - at, to - from), pos);
          pos += to - from;
        }
        at += p.size;
        if (at >= end) break;
      }
      return out;
    },
    async *chunks() {
      for (const p of parts) yield* p.chunks();
    },
  };
}

export function bytesSlice(bytes: Uint8Array): Slice {
  return {
    size: bytes.length,
    read: async (offset, n) => bytes.subarray(Math.max(0, offset), Math.min(bytes.length, offset + n)),
    async *chunks() {
      yield bytes;
    },
  };
}

/** Big- or little-endian reads from bytes already in hand. */
export class View {
  private readonly dv: DataView;
  constructor(
    readonly b: Uint8Array,
    readonly little = false,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get length(): number {
    return this.b.length;
  }
  u8(at: number): number {
    return this.b[at];
  }
  u16(at: number): number {
    return this.dv.getUint16(at, this.little);
  }
  i16(at: number): number {
    return this.dv.getInt16(at, this.little);
  }
  u24(at: number): number {
    return this.little ? this.b[at] | (this.b[at + 1] << 8) | (this.b[at + 2] << 16) : (this.b[at] << 16) | (this.b[at + 1] << 8) | this.b[at + 2];
  }
  u32(at: number): number {
    return this.dv.getUint32(at, this.little);
  }
  i32(at: number): number {
    return this.dv.getInt32(at, this.little);
  }
  /** An 8-byte value, or undefined when it is past what a JavaScript number holds exactly. */
  u64(at: number): number | undefined {
    const v = this.dv.getBigUint64(at, this.little);
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(v);
  }
  ascii(at: number, n: number): string {
    return Buffer.from(this.b.subarray(at, at + n)).toString('latin1');
  }
}

/** The bytes as Latin-1 text, which maps each byte to one character. */
export const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');

/** True when every byte is zero. */
export function allZero(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}
