import * as fsp from 'node:fs/promises';
import type { ByteSource } from './types';

/** A source over bytes already in memory. Reads return views, not copies. */
export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: async () => bytes.length,
    read: async (offset, length) => bytes.subarray(Math.max(0, offset), Math.min(bytes.length, offset + length)),
  };
}

/** A source over a local file, read at offsets through one file handle. */
export function fileSource(filePath: string): ByteSource {
  // The pending open is shared, so concurrent first calls get one handle and close() closes it.
  let opening: Promise<fsp.FileHandle> | undefined;
  let size: number | undefined;
  const open = () => {
    opening ??= fsp.open(filePath, 'r');
    return opening;
  };
  return {
    async size() {
      if (size === undefined) size = (await (await open()).stat()).size;
      return size;
    },
    async read(offset, length) {
      const h = await open();
      const total = await this.size();
      const n = Math.max(0, Math.min(length, total - offset));
      const buf = Buffer.allocUnsafe(n);
      let done = 0;
      while (done < n) {
        const { bytesRead } = await h.read(buf, done, n - done, offset + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return done === n ? buf : buf.subarray(0, done);
    },
    async close() {
      const p = opening;
      opening = undefined;
      await p?.then(
        h => h.close(),
        () => {
          // An open that failed left nothing to close.
        },
      );
    },
  };
}

/**
 * Wraps a source so that a read returning more or fewer bytes than the source's size allows fails with code EIO. The
 * reader would otherwise take the shifted bytes for the file.
 */
export function strictSource(source: ByteSource): ByteSource {
  let size: number | undefined;
  return {
    size: async () => {
      size = await source.size();
      return size;
    },
    read: async (offset, length) => {
      const b = await source.read(offset, length);
      const want = size === undefined ? b.length : Math.max(0, Math.min(length, size - offset));
      if (b.length !== want) throw Object.assign(new Error(`The source returned ${b.length} bytes at offset ${offset} where ${want} were expected`), { code: 'EIO' });
      return b;
    },
  };
}

/** Random-access reader with a small block cache, so the parsers can ask for small overlapping windows cheaply. */
export class Reader {
  private readonly cache = new Map<number, Uint8Array>();
  private readonly order: number[] = [];
  constructor(
    readonly source: ByteSource,
    readonly size: number,
    private readonly blockSize = 65536,
    private readonly maxBlocks = 16,
  ) {}

  private async block(index: number): Promise<Uint8Array> {
    const hit = this.cache.get(index);
    if (hit) return hit;
    const data = await this.source.read(index * this.blockSize, Math.min(this.blockSize, this.size - index * this.blockSize));
    this.cache.set(index, data);
    this.order.push(index);
    if (this.order.length > this.maxBlocks) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.cache.delete(evicted);
    }
    return data;
  }

  /** Reads up to `length` bytes at `offset`; shorter only at the end of the source. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset >= this.size || length <= 0) return new Uint8Array(0);
    const end = Math.min(this.size, offset + length);
    if (end - offset > this.blockSize * 4) return this.source.read(offset, end - offset);
    const first = Math.floor(offset / this.blockSize);
    const last = Math.floor((end - 1) / this.blockSize);
    if (first === last) {
      const b = await this.block(first);
      return b.subarray(offset - first * this.blockSize, end - first * this.blockSize);
    }
    const out = new Uint8Array(end - offset);
    let pos = 0;
    for (let i = first; i <= last; i++) {
      const b = await this.block(i);
      const from = i === first ? offset - first * this.blockSize : 0;
      const to = i === last ? end - i * this.blockSize : b.length;
      out.set(b.subarray(from, to), pos);
      pos += to - from;
    }
    return out;
  }

  /** Yields the range in chunks without caching them. */
  async *chunks(offset: number, length: number, chunkSize = 262144): AsyncGenerator<Uint8Array> {
    let pos = offset;
    const end = Math.min(this.size, offset + length);
    while (pos < end) {
      const n = Math.min(chunkSize, end - pos);
      const c = await this.source.read(pos, n);
      if (c.length === 0) break;
      yield c;
      pos += c.length;
    }
  }
}
