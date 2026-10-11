import { type Slice, View } from './slice';
import { ImageDetail as D } from './types';

/** Bytes per value of each TIFF field type. 13 is IFD, 16 to 18 are BigTIFF's LONG8, SLONG8 and IFD8. */
const TYPE_SIZES = new Map<number, number>([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [6, 1],
  [7, 1],
  [8, 2],
  [9, 4],
  [10, 8],
  [11, 4],
  [12, 8],
  [13, 4],
  [16, 8],
  [17, 8],
  [18, 8],
]);

/** A refusal from the IFD reader. A TIFF file stops the run on it; an EXIF block reports itself malformed. */
export class IfdError extends Error {
  constructor(
    readonly detail: D,
    message: string,
  ) {
    super(message);
  }
}

const bad = (detail: D, message: string): never => {
  throw new IfdError(detail, message);
};

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Bytes of value. */
  size: number;
  /** Where the value starts, in the slice. */
  at: number;
  /** The value sits inside the entry, not elsewhere in the file. */
  inline: boolean;
}

export interface Ifd {
  /** Where the IFD starts and ends, in the slice. */
  start: number;
  end: number;
  entries: IfdEntry[];
  byTag: Map<number, IfdEntry>;
  /** Tags given more than once. The first copy is in byTag. */
  duplicates: number[];
  /** The next IFD's offset, 0 at the end of the chain. */
  next: number;
}

/** Reads IFDs and their values from a TIFF structure: a TIFF file, or the EXIF block inside another format. */
export class IfdReader {
  private constructor(
    readonly slice: Slice,
    readonly little: boolean,
    readonly big: boolean,
    /** The first IFD's offset. */
    readonly first: number,
  ) {}

  /** Reads the TIFF header at the start of the slice. */
  static async open(slice: Slice): Promise<IfdReader> {
    if (slice.size < 8) bad(D.Truncated, 'the TIFF header is cut short');
    const h = await slice.read(0, Math.min(16, slice.size));
    const order = String.fromCharCode(h[0], h[1]);
    if (order !== 'II' && order !== 'MM') bad(D.BadHeader, 'the TIFF header has no byte order mark');
    const little = order === 'II';
    const v = new View(h, little);
    const magic = v.u16(2);
    if (magic === 42) return new IfdReader(slice, little, false, v.u32(4));
    if (magic !== 43) return bad(D.BadHeader, `the TIFF header has the version ${magic}`);
    if (h.length < 16) bad(D.Truncated, 'the BigTIFF header is cut short');
    if (v.u16(4) !== 8 || v.u16(6) !== 0) bad(D.BadHeader, 'the BigTIFF header has an offset size other than 8');
    const first = v.u64(8);
    if (first === undefined) return bad(D.BadHeader, 'the first IFD offset is beyond any file this reader can hold');
    return new IfdReader(slice, little, true, first);
  }

  /** The header's length. */
  get headerSize(): number {
    return this.big ? 16 : 8;
  }

  private u64(v: View, at: number, what: string): number {
    const n = v.u64(at);
    if (n === undefined) bad(D.BadHeader, `${what} is beyond any file this reader can hold`);
    return n ?? 0;
  }

  async ifd(offset: number): Promise<Ifd> {
    const countSize = this.big ? 8 : 2;
    const entrySize = this.big ? 20 : 12;
    const nextSize = this.big ? 8 : 4;
    if (offset < this.headerSize || offset + countSize > this.slice.size) bad(D.Truncated, `an IFD at ${offset} lies outside the file`);
    const cv = new View(await this.slice.read(offset, countSize), this.little);
    const count = this.big ? this.u64(cv, 0, 'an IFD entry count') : cv.u16(0);
    if (count > 65535) bad(D.BadLayout, `an IFD at ${offset} has ${count} entries`);
    const end = offset + countSize + count * entrySize + nextSize;
    if (end > this.slice.size) bad(D.Truncated, `the IFD at ${offset} runs past the end`);
    const v = new View(await this.slice.read(offset + countSize, count * entrySize + nextSize), this.little);
    const entries: IfdEntry[] = [];
    const byTag = new Map<number, IfdEntry>();
    const duplicates: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = i * entrySize;
      const tag = v.u16(e);
      const type = v.u16(e + 2);
      const n = this.big ? this.u64(v, e + 4, 'a value count') : v.u32(e + 4);
      // A type of 0 (TIFF_NOTYPE) carries no value. libtiff treats such an entry as undefined and leaves it unread
      // rather than failing; CR2 files and single-strip OJPEG TIFFs pad their IFDs with these. Skip it.
      if (type === 0) continue;
      const unit = TYPE_SIZES.get(type);
      if (unit === undefined || (type >= 16 && !this.big)) return bad(D.BadLayout, `tag ${tag} has the type ${type}, which TIFF does not define`);
      if (n > this.slice.size) bad(D.Truncated, `tag ${tag} holds more values than the file has bytes`);
      const size = n * unit;
      const inlineSize = this.big ? 8 : 4;
      const valueField = offset + countSize + e + (this.big ? 12 : 8);
      let at = valueField;
      const inline = size <= inlineSize;
      if (!inline) {
        at = this.big ? this.u64(v, e + 12, 'a value offset') : v.u32(e + 8);
        if (at + size > this.slice.size) bad(D.Truncated, `the value of tag ${tag} lies outside the file`);
      }
      const entry: IfdEntry = { tag, type, count: n, size, at, inline };
      entries.push(entry);
      if (byTag.has(tag)) duplicates.push(tag);
      else byTag.set(tag, entry);
    }
    const next = this.big ? this.u64(v, count * entrySize, 'the next IFD offset') : v.u32(count * entrySize);
    return { start: offset, end, entries, byTag, duplicates, next };
  }

  /** The values of an integer entry: BYTE, SHORT, LONG, IFD, their signed forms, and BigTIFF's 8-byte ones. */
  async numbers(e: IfdEntry): Promise<number[]> {
    const unit = TYPE_SIZES.get(e.type) ?? 1;
    if (![1, 3, 4, 6, 8, 9, 13, 16, 17, 18].includes(e.type)) bad(D.BadHeader, `tag ${e.tag} has the type ${e.type} where a whole number belongs`);
    const v = new View(await this.slice.read(e.at, e.size), this.little);
    const out = new Array<number>(e.count);
    for (let i = 0; i < e.count; i++) {
      const p = i * unit;
      switch (e.type) {
        case 1:
          out[i] = v.u8(p);
          break;
        case 6:
          out[i] = (v.u8(p) << 24) >> 24;
          break;
        case 3:
          out[i] = v.u16(p);
          break;
        case 8:
          out[i] = v.i16(p);
          break;
        case 9:
          out[i] = v.i32(p);
          break;
        case 16:
        case 17:
        case 18:
          out[i] = this.u64(v, p, `a value of tag ${e.tag}`);
          break;
        default:
          out[i] = v.u32(p);
      }
    }
    return out;
  }

  /** The first value of an integer entry, or `fallback` when the tag is absent. */
  async number(ifd: Ifd, tag: number, fallback?: number): Promise<number | undefined> {
    const e = ifd.byTag.get(tag);
    if (!e) return fallback;
    if (e.count === 0) bad(D.BadHeader, `tag ${tag} has no value`);
    return (await this.numbers({ ...e, count: 1, size: TYPE_SIZES.get(e.type) ?? 1 }))[0];
  }
}
