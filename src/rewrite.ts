import { crc32 } from './crc32';
import type { Reader } from './io';
import type { ByteSink, ByteSource } from './types';

/** An output position, set when the pieces holding it are laid out. */
export class Mark {
  at = -1;
}

/**
 * A run of output bytes: a range of the input, bytes made here, a plugin's output, bytes made once every position is
 * known, a mark that records its position, or the start and end of a span whose CRC-32 follows it.
 */
export type Piece =
  | { kind: 'copy'; start: number; length: number }
  | { kind: 'bytes'; data: Uint8Array }
  | { kind: 'source'; source: ByteSource; length: number }
  | { kind: 'lazy'; length: number; make: () => Uint8Array | Promise<Uint8Array> }
  | { kind: 'mark'; mark: Mark }
  | { kind: 'crcStart' }
  | { kind: 'crcEnd' };

export const copy = (start: number, length: number): Piece => ({ kind: 'copy', start, length });
export const bytes = (data: Uint8Array): Piece => ({ kind: 'bytes', data });
export const lazy = (length: number, make: () => Uint8Array | Promise<Uint8Array>): Piece => ({ kind: 'lazy', length, make });
export const mark = (m: Mark): Piece => ({ kind: 'mark', mark: m });
/** emit() writes the CRC-32 of the bytes between crcStart and crcEnd, big-endian, at crcEnd. */
export const crcStart: Piece = { kind: 'crcStart' };
export const crcEnd: Piece = { kind: 'crcEnd' };

export function pieceLength(p: Piece): number {
  switch (p.kind) {
    case 'copy':
    case 'source':
    case 'lazy':
      return p.length;
    case 'bytes':
      return p.data.length;
    case 'crcEnd':
      return 4;
    default:
      return 0;
  }
}

export const lengthOf = (pieces: Piece[]): number => pieces.reduce((t, p) => t + pieceLength(p), 0);

/** Big- and little-endian integers as bytes. */
export function u16(n: number, little = false): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, little);
  return b;
}
export function u32(n: number, little = false): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, little);
  return b;
}
export function u64(n: number, little = false): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), little);
  return b;
}
export const ascii = (s: string): Uint8Array => Buffer.from(s, 'latin1');

/** Gives every mark its output position, counting from `base`. Returns the total length. */
export function layout(pieces: Piece[], base = 0): number {
  let at = base;
  for (const p of pieces) {
    if (p.kind === 'mark') p.mark.at = at;
    at += pieceLength(p);
  }
  return at - base;
}

/** A piece's bytes did not come out at the length its layout gave it. Only a bug here can cause it. */
export class RewriteError extends Error {}

/**
 * Writes the pieces to the sink in order. It reads copies from `reader` in chunks and gathers small pieces into larger
 * writes. It makes each lazy piece when it reaches it, so layout() must have placed the marks first.
 */
export async function emit(pieces: Piece[], reader: Reader, sink: ByteSink, time: () => void): Promise<number> {
  const parts: Uint8Array[] = [];
  let pending = 0;
  let written = 0;
  let crc: number | undefined;
  const flush = async () => {
    if (!pending) return;
    const b = Buffer.concat(parts, pending);
    parts.length = 0;
    pending = 0;
    await sink.write(b);
  };
  const put = async (b: Uint8Array) => {
    if (crc !== undefined) crc = crc32(b, crc);
    written += b.length;
    if (b.length >= 65536) {
      await flush();
      await sink.write(b);
      return;
    }
    parts.push(b);
    pending += b.length;
    if (pending >= 65536) await flush();
  };
  for (const p of pieces) {
    switch (p.kind) {
      case 'copy': {
        let done = 0;
        for await (const c of reader.chunks(p.start, p.length)) {
          time();
          await put(c);
          done += c.length;
        }
        if (done !== p.length) throw new RewriteError(`a copy of ${p.length} bytes at ${p.start} gave ${done}`);
        break;
      }
      case 'bytes':
        await put(p.data);
        break;
      case 'source': {
        const chunk = 262144;
        for (let at = 0; at < p.length; at += chunk) {
          time();
          const want = Math.min(chunk, p.length - at);
          const b = await p.source.read(at, want);
          if (b.length !== want) throw Object.assign(new Error(`The source returned ${b.length} bytes at offset ${at} where ${want} were expected`), { code: 'EIO' });
          await put(b);
        }
        break;
      }
      case 'lazy': {
        const b = await p.make();
        if (b.length !== p.length) throw new RewriteError(`a piece laid out at ${p.length} bytes holds ${b.length}`);
        await put(b);
        break;
      }
      case 'crcStart':
        crc = 0;
        break;
      case 'crcEnd': {
        const value = crc ?? 0;
        crc = undefined;
        await put(u32(value));
        break;
      }
      default:
        break;
    }
  }
  await flush();
  return written;
}

interface Edit {
  start: number;
  end: number;
  with: Piece[];
  length: number;
}

interface Patch {
  at: number;
  length: number;
  make: () => Uint8Array | Promise<Uint8Array>;
}

/**
 * A range of the input rewritten by edits: ranges removed, ranges replaced by other pieces, and same-length patches to
 * the bytes that stay. Once sealed, it maps any input position to where that byte lands in the output, so offsets
 * that point into the range can be written again.
 */
export class Region {
  private readonly edits: Edit[] = [];
  private readonly patches: Patch[] = [];
  private shift: number[] = [];
  private sealed = false;

  constructor(
    readonly start: number,
    readonly end: number,
  ) {}

  remove(start: number, end: number): void {
    const s = Math.max(start, this.start);
    const e = Math.min(end, this.end);
    if (e > s) this.edits.push({ start: s, end: e, with: [], length: 0 });
  }

  replace(start: number, end: number, pieces: Piece[]): void {
    this.edits.push({ start, end, with: pieces, length: lengthOf(pieces) });
  }

  /** Overwrites `length` bytes at `at` with what `make` returns once the output is laid out. */
  patch(at: number, length: number, make: () => Uint8Array | Promise<Uint8Array>): void {
    this.patches.push({ at, length, make });
  }

  /** Sorts the edits and merges removals that touch. A replacement that overlaps another edit is a bug. */
  seal(): void {
    const sorted = [...this.edits].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Edit[] = [];
    for (const e of sorted) {
      const last = merged[merged.length - 1];
      if (last && e.start <= last.end && (e.start < last.end || (!e.with.length && !last.with.length))) {
        if (e.with.length || last.with.length) throw new RewriteError(`a replacement at ${e.with.length ? e.start : last.start} overlaps another edit`);
        last.end = Math.max(last.end, e.end);
        continue;
      }
      merged.push({ ...e });
    }
    this.edits.length = 0;
    this.edits.push(...merged);
    this.shift = [0];
    for (const e of merged) this.shift.push(this.shift[this.shift.length - 1] + e.length - (e.end - e.start));
    this.patches.sort((a, b) => a.at - b.at);
    for (let i = 1; i < this.patches.length; i++) {
      if (this.patches[i].at < this.patches[i - 1].at + this.patches[i - 1].length) throw new RewriteError(`two patches overlap at ${this.patches[i].at}`);
    }
    this.sealed = true;
  }

  /** The index of the last edit that starts at or before `pos`, or -1. */
  private editAt(pos: number): number {
    let lo = 0;
    let hi = this.edits.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.edits[mid].start <= pos) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /**
   * Where the input position `pos` lands in the output, counted from the region's start. The start of a replaced range
   * maps to the start of its replacement, and the start of a removed range to where the next byte that stays goes.
   * A position inside an edited range has no place and gives undefined.
   */
  map(pos: number): number | undefined {
    if (!this.sealed) throw new RewriteError('the region is mapped before it is sealed');
    if (pos < this.start || pos > this.end) return undefined;
    const i = this.editAt(pos);
    if (i < 0) return pos - this.start;
    const e = this.edits[i];
    if (pos === e.start) return pos - this.start + this.shift[i];
    if (pos < e.end) return undefined;
    return pos - this.start + this.shift[i + 1];
  }

  /** Like map(), but undefined for a byte that does not stay, so a pointer never lands on something removed. */
  mapKept(pos: number): number | undefined {
    if (!this.sealed) throw new RewriteError('the region is mapped before it is sealed');
    const i = this.editAt(pos);
    if (i >= 0 && pos === this.edits[i].start && !this.edits[i].with.length) return undefined;
    return this.map(pos);
  }

  /** The region's length in the output. */
  get length(): number {
    return this.end - this.start + (this.shift[this.shift.length - 1] ?? 0);
  }

  pieces(): Piece[] {
    if (!this.sealed) this.seal();
    const out: Piece[] = [];
    let p = 0;
    const span = (from: number, to: number) => {
      let at = from;
      while (p < this.patches.length && this.patches[p].at < to) {
        const patch = this.patches[p++];
        if (patch.at < at || patch.at + patch.length > to) throw new RewriteError(`a patch at ${patch.at} falls in an edited range`);
        if (patch.at > at) out.push(copy(at, patch.at - at));
        out.push(lazy(patch.length, patch.make));
        at = patch.at + patch.length;
      }
      if (to > at) out.push(copy(at, to - at));
    };
    let cursor = this.start;
    for (const e of this.edits) {
      span(cursor, e.start);
      out.push(...e.with);
      cursor = e.end;
      if (p < this.patches.length && this.patches[p].at < cursor) throw new RewriteError(`a patch at ${this.patches[p].at} falls in an edited range`);
    }
    span(cursor, this.end);
    if (p < this.patches.length) throw new RewriteError(`a patch at ${this.patches[p].at} lies outside the region`);
    return out;
  }
}
