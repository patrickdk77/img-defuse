import { type Ifd, type IfdEntry, type IfdReader, typeSize } from './ifd';
import { bytes, type Piece, Region, RewriteError, u16, u32, u64 } from './rewrite';

export type IfdKind = 'chain' | 'sub' | 'exif' | 'gps' | 'interop';

export interface WalkedIfd {
  ifd: Ifd;
  kind: IfdKind;
  /** The position in the main chain, 0 for the first IFD, or -1 off the main chain. */
  index: number;
  /** For a chain or SubIFD chain, the IFD before it. For any other, the IFD whose entry points at it. */
  parent?: WalkedIfd;
  /** The entry that points at it, for an IFD reached through a pointer tag. */
  via?: IfdEntry;
}

/** Tags whose values are offsets into the TIFF structure: strips, tiles, SubIFDs, old-style JPEG, and the EXIF, GPS and interoperability IFDs. */
const POINTER_TAGS = new Set([273, 324, 330, 513, 519, 520, 521, 34665, 34853, 40965]);
const IFD_POINTERS = new Map<number, IfdKind>([
  [330, 'sub'],
  [34665, 'exif'],
  [34853, 'gps'],
  [40965, 'interop'],
]);

/**
 * Walks every IFD a TIFF structure reaches, as the inspector reads them: the chain, SubIFDs when `subIfds` is set,
 * the EXIF and GPS IFDs of a chain or SubIFD, and the interoperability IFD of an EXIF IFD. Only the first copy of a
 * repeated tag is followed. The structure has been inspected, so an IFD reached twice is skipped here.
 */
export async function walkIfds(r: IfdReader, subIfds: boolean): Promise<WalkedIfd[]> {
  const out: WalkedIfd[] = [];
  const seen = new Set<number>();
  const queue: Array<{ offset: number; kind: IfdKind; index: number; parent?: WalkedIfd; via?: IfdEntry }> = [{ offset: r.first, kind: 'chain', index: 0 }];
  // The queue grows while it is read, and an array's iterator reads entries added after it started.
  for (const item of queue) {
    if (item.offset === 0 || seen.has(item.offset)) continue;
    seen.add(item.offset);
    const ifd = await r.ifd(item.offset);
    const w: WalkedIfd = { ifd, kind: item.kind, index: item.index, parent: item.parent, via: item.via };
    out.push(w);
    const image = item.kind === 'chain' || item.kind === 'sub';
    if (image && ifd.next) queue.push({ offset: ifd.next, kind: item.kind, index: item.index >= 0 ? item.index + 1 : -1, parent: w });
    for (const [tag, kind] of IFD_POINTERS) {
      const e = ifd.byTag.get(tag);
      if (!e || (kind === 'sub' && (!subIfds || !image)) || (kind === 'interop' && item.kind !== 'exif') || ((kind === 'exif' || kind === 'gps') && !image)) continue;
      const offsets = kind === 'sub' ? await r.numbers(e) : [(await r.number(ifd, tag)) ?? 0];
      for (const offset of offsets) queue.push({ offset, kind, index: -1, parent: w, via: e });
    }
  }
  return out;
}

/** Sorts ranges and merges those that overlap or touch. */
function merged(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The parts of `ranges` that no range in `keep` touches. */
function subtract(ranges: Array<[number, number]>, keep: Array<[number, number]>): Array<[number, number]> {
  const k = merged(keep);
  const out: Array<[number, number]> = [];
  for (const [s, e] of merged(ranges)) {
    let at = s;
    for (const [ks, ke] of k) {
      if (ke <= at) continue;
      if (ks >= e) break;
      if (ks > at) out.push([at, ks]);
      at = Math.max(at, ke);
    }
    if (at < e) out.push([at, e]);
  }
  return out;
}

/**
 * Rewrites a TIFF structure, a whole TIFF file or an EXIF or MPF block, by edits that keep every other byte where it
 * sits relative to its neighbors: IFDs and entries dropped, values replaced, data ranges removed or replaced. Every
 * offset the structure holds is then written for where its target lands, by pieces().
 */
export class TiffRewrite {
  readonly region: Region;
  private readonly droppedIfds = new Set<WalkedIfd>();
  private readonly droppedEntries = new Set<IfdEntry>();
  private readonly replacedValues = new Map<IfdEntry, { pieces: Piece[]; count: number }>();
  private readonly newValues = new Map<IfdEntry, Map<number, number>>();
  private readonly removals: Array<[number, number]> = [];
  private readonly kept: Array<[number, number]> = [];
  private readonly replacements: Array<{ start: number; end: number; pieces: Piece[] }> = [];

  /** `base` is the file offset of the structure's header. Ranges given to the methods are relative to it. */
  constructor(
    readonly r: IfdReader,
    readonly base: number,
    readonly ifds: WalkedIfd[],
  ) {
    this.region = new Region(base, base + r.slice.size);
  }

  /** Drops an IFD, the IFDs it points at, and the entry that points at it. A chain is relinked around it. */
  dropIfd(w: WalkedIfd): void {
    if (this.droppedIfds.has(w)) return;
    this.droppedIfds.add(w);
    if (w.via) this.droppedEntries.add(w.via);
    for (const child of this.ifds) if (child.parent === w && child.via) this.dropIfd(child);
  }

  isDropped(w: WalkedIfd): boolean {
    return this.droppedIfds.has(w);
  }

  dropEntry(e: IfdEntry): void {
    this.droppedEntries.add(e);
  }

  /** Replaces a value stored outside its entry. `count` is the entry's new value count. */
  replaceValue(e: IfdEntry, pieces: Piece[], count: number): void {
    if (e.inline) throw new RewriteError(`tag ${e.tag} holds its value inside its entry`);
    this.replacedValues.set(e, { pieces, count });
  }

  /** Writes new numbers for some of an integer entry's values, by index. */
  setValue(e: IfdEntry, index: number, value: number): void {
    let m = this.newValues.get(e);
    if (!m) {
      m = new Map();
      this.newValues.set(e, m);
    }
    m.set(index, value);
  }

  /** Removes data no IFD holds as a value, such as a thumbnail's bytes. */
  removeRange(start: number, end: number): void {
    this.removals.push([start, end]);
  }

  /** Keeps data no IFD holds as a value, such as strips and tiles. */
  keepRange(start: number, end: number): void {
    this.kept.push([start, end]);
  }

  /** Replaces data no IFD holds as a value, such as a thumbnail's bytes. */
  replaceRange(start: number, end: number, pieces: Piece[]): void {
    this.replacements.push({ start, end, pieces });
  }

  /**
   * The rewritten structure as pieces. With `removeUnused`, every byte that no kept IFD, value or kept range covers is
   * removed, which drops gaps and trailing bytes. Without it, only what was dropped goes, and gaps stay.
   */
  pieces(removeUnused: boolean): Piece[] {
    const r = this.r;
    const R = this.region;
    const base = this.base;
    const little = r.little;
    const keptIfds = this.ifds.filter(w => !this.droppedIfds.has(w));
    const keep: Array<[number, number]> = [[0, r.headerSize], ...this.kept];
    const edited: Array<[number, number]> = this.replacements.map(x => [x.start, x.end]);
    for (const w of keptIfds) {
      keep.push([w.ifd.start, w.ifd.end]);
      for (const e of w.ifd.entries) {
        if (e.inline || this.droppedEntries.has(e)) continue;
        if (this.replacedValues.has(e)) edited.push([e.at, e.at + e.size]);
        else keep.push([e.at, e.at + e.size]);
      }
    }
    const stays = [...keep, ...edited];
    let removals: Array<[number, number]>;
    if (removeUnused) {
      removals = subtract([[0, r.slice.size]], stays);
    } else {
      const candidates: Array<[number, number]> = [...this.removals];
      for (const w of this.ifds) {
        if (!this.droppedIfds.has(w)) continue;
        candidates.push([w.ifd.start, w.ifd.end]);
        for (const e of w.ifd.entries) if (!e.inline) candidates.push([e.at, e.at + e.size]);
      }
      for (const e of this.droppedEntries) if (!e.inline) candidates.push([e.at, e.at + e.size]);
      removals = subtract(candidates, stays);
    }
    for (const w of keptIfds) for (const e of w.ifd.entries) if (this.droppedEntries.has(e)) removals.push([e.pos, e.pos + r.entrySize]);
    // TIFF keeps IFDs and values on even offsets. A removal of odd length keeps its last byte, as a zero, so nothing
    // after it moves by an odd amount.
    for (const [s, e] of merged(removals)) {
      if ((e - s) % 2 === 0) R.remove(base + s, base + e);
      else {
        R.remove(base + s, base + e - 1);
        R.replace(base + e - 1, base + e, [bytes(new Uint8Array(1))]);
      }
    }
    for (const [e, v] of this.replacedValues) {
      if (!this.droppedEntries.has(e)) R.replace(base + e.at, base + e.at + e.size, v.pieces);
    }
    for (const x of this.replacements) R.replace(base + x.start, base + x.end, x.pieces);

    const offset = (n: number): Uint8Array => (r.big ? u64(n, little) : u32(n, little));
    const target = (pos: number, what: string): number => {
      const m = R.mapKept(base + pos);
      if (m === undefined) throw new RewriteError(`${what} points at ${pos}, which the rewrite removes`);
      return m;
    };
    R.patch(base + (r.big ? 8 : 4), r.offsetSize, () => offset(target(r.first, 'the header')));
    const byOffset = new Map(this.ifds.map(w => [w.ifd.start, w]));
    const patched = new Set<number>();
    for (const w of keptIfds) {
      const ifd = w.ifd;
      const dropped = ifd.entries.filter(e => this.droppedEntries.has(e)).length;
      if (dropped) R.patch(base + ifd.start, r.countSize, () => (r.big ? u64(ifd.declared - dropped, little) : u16(ifd.declared - dropped, little)));
      // A chain skips the IFDs it drops. Nothing reads the next pointer of an EXIF, GPS or interoperability IFD.
      let next = 0;
      if (w.kind === 'chain' || w.kind === 'sub') {
        let to = ifd.next ? byOffset.get(ifd.next) : undefined;
        while (to && this.droppedIfds.has(to)) to = to.ifd.next ? byOffset.get(to.ifd.next) : undefined;
        next = to ? to.ifd.start : 0;
      }
      const nextAt = ifd.start + r.countSize + ifd.declared * r.entrySize;
      R.patch(base + nextAt, r.offsetSize, () => offset(next ? target(next, `IFD ${ifd.start}`) : 0));
      for (const e of ifd.entries) {
        if (this.droppedEntries.has(e)) continue;
        const field = e.pos + (r.big ? 12 : 8);
        const replaced = this.replacedValues.get(e);
        if (replaced) {
          R.patch(base + e.pos + 4, r.offsetSize, () => offset(replaced.count));
          R.patch(base + field, r.offsetSize, () => offset(target(e.at, `tag ${e.tag}`)));
          continue;
        }
        if (!e.inline) R.patch(base + field, r.offsetSize, () => offset(target(e.at, `tag ${e.tag}`)));
        const values = this.newValues.get(e);
        const pointer = POINTER_TAGS.has(e.tag);
        if (!values && !pointer) continue;
        if (patched.has(e.at)) continue;
        patched.add(e.at);
        // Only the first copy of a tag was followed, so only its IFD pointers must land on something kept.
        const strict = pointer && IFD_POINTERS.has(e.tag) && ifd.byTag.get(e.tag) === e;
        const remap = (v: number, i: number): number => {
          const set = values?.get(i);
          if (set !== undefined) return set;
          if (!pointer) return v;
          if (strict) return target(v, `tag ${e.tag}`);
          return R.mapKept(base + v) ?? R.map(base + v) ?? 0;
        };
        const unit = typeSize(e.type);
        const step = Math.max(unit, Math.floor(65536 / unit) * unit);
        for (let from = 0; from < e.size; from += step) {
          const n = Math.min(step, e.size - from);
          R.patch(base + e.at + from, n, async () =>
            encodeValues(
              e.type,
              little,
              decodeValues(e.type, little, await r.slice.read(e.at + from, n)).map((v, k) => remap(v, from / unit + k)),
              e.tag,
            ),
          );
        }
      }
    }
    return R.pieces();
  }
}

/** The integers in `b`, a run of values of one TIFF type. */
function decodeValues(type: number, little: boolean, b: Uint8Array): number[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const unit = typeSize(type);
  const out: number[] = [];
  for (let p = 0; p + unit <= b.length; p += unit) {
    switch (type) {
      case 1:
        out.push(v.getUint8(p));
        break;
      case 3:
        out.push(v.getUint16(p, little));
        break;
      case 8:
        out.push(v.getInt16(p, little));
        break;
      case 9:
        out.push(v.getInt32(p, little));
        break;
      case 16:
      case 17:
      case 18:
        out.push(Number(v.getBigUint64(p, little)));
        break;
      default:
        out.push(v.getUint32(p, little));
    }
  }
  return out;
}

function encodeValues(type: number, little: boolean, values: number[], tag: number): Uint8Array {
  const unit = typeSize(type);
  const b = new Uint8Array(values.length * unit);
  const v = new DataView(b.buffer);
  for (let i = 0; i < values.length; i++) {
    const n = values[i];
    const max = unit === 1 ? 0xff : unit === 2 ? 0xffff : unit === 4 ? 0xffffffff : Number.MAX_SAFE_INTEGER;
    if (!(n >= 0 && n <= max) && type !== 8 && type !== 9) throw new RewriteError(`a value of tag ${tag} no longer fits its type`);
    switch (unit) {
      case 1:
        v.setUint8(i, n);
        break;
      case 2:
        if (type === 8) v.setInt16(i * 2, n, little);
        else v.setUint16(i * 2, n, little);
        break;
      case 8:
        v.setBigUint64(i * 8, BigInt(n), little);
        break;
      default:
        if (type === 9) v.setInt32(i * 4, n, little);
        else v.setUint32(i * 4, n, little);
    }
  }
  return b;
}

/** A TIFF structure holding one IFD with one entry, the orientation, for an EXIF block that keeps only that. */
export function orientationTiff(little: boolean, orientation: number): Uint8Array {
  const b = new Uint8Array(26);
  const v = new DataView(b.buffer);
  b[0] = little ? 0x49 : 0x4d;
  b[1] = b[0];
  v.setUint16(2, 42, little);
  v.setUint32(4, 8, little);
  v.setUint16(8, 1, little);
  v.setUint16(10, 274, little);
  v.setUint16(12, 3, little);
  v.setUint32(14, 1, little);
  v.setUint16(18, orientation, little);
  v.setUint32(22, 0, little);
  return b;
}
