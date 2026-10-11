import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import type { ByteSink, ByteSource } from './types';

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
  const strict: ByteSource = {
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
  const close = source.close;
  if (close) strict.close = () => close.call(source);
  return strict;
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

/** A source over `length` bytes of `reader` from `start`. Reads outside that range return nothing. */
export function rangeSource(reader: Reader, start: number, length: number): ByteSource {
  return {
    size: async () => length,
    read: async (offset, n) => (offset < 0 || offset >= length || n <= 0 ? new Uint8Array(0) : reader.read(start + offset, Math.min(n, length - offset))),
  };
}

/** A source over ranges of `reader`, each [start, length], read as one run of bytes. Reads outside them return nothing. */
export function rangesSource(reader: Reader, ranges: Array<[number, number]>): ByteSource {
  const length = ranges.reduce((t, [, n]) => t + n, 0);
  return {
    size: async () => length,
    async read(offset, n) {
      const end = Math.min(length, offset + n);
      if (offset < 0 || offset >= end) return new Uint8Array(0);
      const out = new Uint8Array(end - offset);
      let at = 0;
      let pos = 0;
      for (const [s, len] of ranges) {
        const from = Math.max(offset, at);
        const to = Math.min(end, at + len);
        if (from < to) {
          out.set(await reader.read(s + from - at, to - from), pos);
          pos += to - from;
        }
        at += len;
        if (at >= end) break;
      }
      return out;
    },
  };
}

/** Collects output in memory. */
export function bufferSink(): ByteSink & { result(): Uint8Array; size(): number } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    async write(chunk) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
    },
    async close() {
      // Nothing to release. The chunks stay for result().
    },
    result: () => Buffer.concat(chunks),
    size: () => size,
  };
}

/** FileHandle.write may write less than asked, for example at a file size limit; the next write then reports why. */
async function writeAll(handle: fsp.FileHandle, chunk: Uint8Array): Promise<void> {
  for (let done = 0; done < chunk.length; ) done += (await handle.write(chunk, done, chunk.length - done)).bytesWritten;
}

/** Writes to a local file. The file is created on the first write. */
export function fileSink(filePath: string): ByteSink {
  let handle: fsp.FileHandle | undefined;
  return {
    async write(chunk) {
      handle ??= await fsp.open(filePath, 'w');
      await writeAll(handle, chunk);
    },
    async close() {
      handle ??= await fsp.open(filePath, 'w');
      await handle.close();
    },
    async abort() {
      const h = handle;
      handle = undefined;
      if (!h) return;
      // A partial regular file goes. abort() never unlinks a device or pipe the caller named.
      const partial = (await h.stat().catch(() => undefined))?.isFile();
      await h.close().catch(() => {
        // abort() runs after a failure, which is the error to report.
      });
      if (partial) await fsp.rm(filePath, { force: true });
    },
  };
}

/**
 * Wraps any Node Writable, waiting for 'drain' when it applies backpressure. The stream's first error, or its
 * closing before the end, fails the pending write and every later one.
 */
export function writableSink(stream: Writable): ByteSink {
  let failure: Error | undefined;
  const pending = new Set<(e: Error) => void>();
  const fail = (e: Error) => {
    failure ??= e;
    for (const reject of pending) reject(failure);
    pending.clear();
  };
  // Node emits some errors after the write callback, and an 'error' with no listener crashes the process, so this
  // listener stays for the stream's whole life.
  stream.on('error', fail);
  stream.on('close', () => {
    if (!stream.writableFinished) fail(stream.errored ?? new Error('The output stream closed before all data was written'));
  });
  const settle = (start: (done: (err?: Error | null) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      if (failure) return reject(failure);
      if (stream.destroyed) return reject(stream.errored ?? new Error('The output stream was destroyed'));
      pending.add(reject);
      start(err => {
        pending.delete(reject);
        if (err) reject(err);
        else resolve();
      });
    });
  return {
    write: chunk => settle(done => (stream.write(chunk) ? done() : stream.once('drain', () => done()))),
    close: () => settle(done => stream.end((err?: Error | null) => done(err))),
    // The reader sees an error instead of an end, so it cannot mistake a partial output for a whole one.
    abort: async error => {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
    },
  };
}

/** A private temporary directory, removed by cleanup(). */
export class TempDir {
  // The pending mkdtemp is shared, so concurrent first calls make one directory and cleanup() removes it.
  private dir?: Promise<string>;
  private seq = 0;
  constructor(private readonly base = os.tmpdir()) {}
  async file(suffix = '.bin'): Promise<string> {
    this.dir ??= fsp.mkdtemp(path.join(this.base, 'img-defuse-'));
    return path.join(await this.dir, `${this.seq++}${suffix}`);
  }
  async cleanup(): Promise<void> {
    const dir = await this.dir?.catch(() => undefined);
    this.dir = undefined;
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** A sink that keeps small output in memory and moves to a temporary file past a threshold. */
export class SpillSink implements ByteSink {
  private chunks: Buffer[] = [];
  private size = 0;
  private filePath?: string;
  private handle?: fsp.FileHandle;
  private readonly hash = crypto.createHash('sha256');
  private hex?: string;
  spilled = false;
  constructor(
    private readonly temp: TempDir,
    private readonly threshold: number,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    this.hash.update(chunk);
    this.size += chunk.length;
    if (!this.handle && this.size <= this.threshold) {
      this.chunks.push(Buffer.from(chunk));
      return;
    }
    if (!this.handle) {
      this.filePath = await this.temp.file('.spill');
      this.handle = await fsp.open(this.filePath, 'w');
      this.spilled = true;
      for (const c of this.chunks) await writeAll(this.handle, c);
      this.chunks = [];
    }
    await writeAll(this.handle, chunk);
  }
  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }
  /** Closes the sink and deletes its temporary file, once nothing will read what it holds again. */
  async dispose(): Promise<void> {
    await this.close();
    this.chunks = [];
    const file = this.filePath;
    this.filePath = undefined;
    if (file !== undefined) await fsp.rm(file, { force: true });
  }
  get length(): number {
    return this.size;
  }
  /** The SHA-256 of what was written, in hex. */
  digest(): string {
    this.hex ??= this.hash.digest('hex');
    return this.hex;
  }
  /** A source over what was written. Call after close(). */
  source(): ByteSource {
    return this.filePath ? strictSource(fileSource(this.filePath)) : bufferSource(Buffer.concat(this.chunks));
  }
}

/**
 * Copies a whole source, calling `checkTime` before each chunk. A read that returns more or fewer bytes than it asked
 * for fails the copy, which would otherwise shift every byte after it.
 */
export async function copyToSink(source: ByteSource, sink: ByteSink, checkTime?: () => void): Promise<void> {
  const total = await source.size();
  const chunk = 262144;
  for (let pos = 0; pos < total; pos += chunk) {
    checkTime?.();
    const want = Math.min(chunk, total - pos);
    const b = await source.read(pos, want);
    if (b.length !== want) throw Object.assign(new Error(`The source returned ${b.length} bytes at offset ${pos} where ${want} were expected`), { code: 'EIO' });
    await sink.write(b);
  }
}
