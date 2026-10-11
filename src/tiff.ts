import { type PhotoshopEdit, photoshopEdits } from './blocks';
import type { Run } from './context';
import { StopError } from './errors';
import { type Ifd, IfdError, IfdReader, typeSize } from './ifd';
import { checkIcc, hasDoctype, photoshopResources } from './metadata';
import { lengthOf, type Piece, Region } from './rewrite';
import { fileSlice } from './slice';
import { TiffRewrite, walkIfds } from './tiffedit';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageFinding } from './types';

/** Compression schemes read: none, CCITT RLE, G3 and G4, LZW, old and new JPEG, Deflate twice, PackBits, LZMA, Zstandard and WebP. */
const COMPRESSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 32773, 32946, 34925, 50000, 50001]);
/** Photometric interpretations read. Camera raw data, CFA and linear raw, is not among them. */
const PHOTOMETRICS = new Set([0, 1, 2, 3, 4, 5, 6, 8, 9, 10]);

/** Tags that describe the image's structure and how to draw it. The pointers to EXIF and GPS IFDs are here too. */
const STRUCTURE = new Set([
  254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 274, 277, 278, 279, 280, 281, 282, 283, 284, 286, 287, 290, 291, 292, 293, 296, 297, 301, 317, 318, 319, 320, 321, 322, 323, 324, 325,
  330, 332, 333, 334, 336, 338, 339, 340, 341, 342, 347, 512, 513, 514, 515, 517, 518, 519, 520, 521, 529, 530, 531, 532, 34665, 34853,
]);
/** Descriptive text: document and page names, description, make, model, software, date, artist, host and copyright. */
const TEXT = new Set([269, 270, 271, 272, 285, 305, 306, 315, 316, 33432]);
/** GeoTIFF, GDAL and PrintIM tags. */
const OTHER = new Map<number, string>([
  [33550, 'GeoTIFF'],
  [33922, 'GeoTIFF'],
  [34264, 'GeoTIFF'],
  [34735, 'GeoTIFF'],
  [34736, 'GeoTIFF'],
  [34737, 'GeoTIFF'],
  [42112, 'GDAL'],
  [42113, 'GDAL'],
  [50341, 'PrintIM'],
]);

type Kind = 'header' | 'ifd' | 'value' | 'strip' | 'tile' | 'ojpeg';

const KIND_NAMES: Record<Kind, string> = { header: 'header', ifd: 'IFD', value: 'tag value', strip: 'strip', tile: 'tile', ojpeg: 'old-style JPEG data' };

/** Byte ranges the file uses, held in typed arrays so a file with a million strips stays small. */
class Ranges {
  private starts = new Float64Array(1024);
  private ends = new Float64Array(1024);
  private kinds = new Uint8Array(1024);
  length = 0;
  private static readonly KINDS: Kind[] = ['header', 'ifd', 'value', 'strip', 'tile', 'ojpeg'];

  add(start: number, end: number, kind: Kind): void {
    if (end <= start) return;
    const k = Ranges.KINDS.indexOf(kind);
    const last = this.length - 1;
    // Strips written end to end, the usual layout, take one entry.
    if (last >= 0 && this.kinds[last] === k && this.ends[last] === start && (kind === 'strip' || kind === 'tile')) {
      this.ends[last] = end;
      return;
    }
    if (this.length === this.starts.length) {
      const grow = <T extends Float64Array | Uint8Array>(a: T, make: (n: number) => T): T => {
        const b = make(a.length * 2);
        b.set(a);
        return b;
      };
      this.starts = grow(this.starts, n => new Float64Array(n));
      this.ends = grow(this.ends, n => new Float64Array(n));
      this.kinds = grow(this.kinds, n => new Uint8Array(n));
    }
    this.starts[this.length] = start;
    this.ends[this.length] = end;
    this.kinds[this.length] = k;
    this.length++;
  }

  /** The ranges sorted by start, each as [start, end, kind]. */
  sorted(): Array<[number, number, Kind]> {
    const order = Array.from({ length: this.length }, (_, i) => i).sort((a, b) => this.starts[a] - this.starts[b] || this.ends[a] - this.ends[b]);
    return order.map(i => [this.starts[i], this.ends[i], Ranges.KINDS[this.kinds[i]]]);
  }
}

/** How an image IFD lays out its strips or tiles, for the rewrite to keep each one, cut to its rows when uncompressed. */
interface Layout {
  tiles: boolean;
  compression: number;
  /** Strips or tiles the image needs. */
  count: number;
  perPlaneCount: number;
  rowsEach: number;
  bytesPerRow: number;
  height: number;
  /** Old-style JPEG data and tables, which strips may share bytes with. */
  ojpeg: Array<[number, number]>;
}

/** What the rewrite needs of a TIFF file, keyed by the file offsets of entries and IFDs. */
export interface TiffPlan {
  /** Entries of image IFDs that a finding or a signature can remove, with those findings. */
  entries: Map<number, Array<DefuseFinding | undefined>>;
  /** EXIF, GPS and interoperability IFDs that a finding can remove, with the ranges a signature in them can sit in. */
  ifds: Map<number, { findings: Array<DefuseFinding | undefined>; ranges: Array<[number, number]> }>;
  /** Photoshop resources holding thumbnails, by their entry. */
  photoshop: Map<number, PhotoshopEdit[]>;
  layouts: Map<number, Layout>;
}

interface Item {
  offset: number;
  kind: 'image' | 'exif' | 'gps' | 'interop';
  label: string;
  /** For an image IFD: the chain index, or -1 for a SubIFD. */
  index: number;
}

export async function inspectTiff(run: Run): Promise<TiffPlan> {
  try {
    return await walk(run);
  } catch (e) {
    if (e instanceof IfdError) run.stop(e.detail, e.message);
    throw e;
  }
}

async function walk(run: Run): Promise<TiffPlan> {
  const r = run.reader;
  const size = run.size;
  const plan: TiffPlan = { entries: new Map(), ifds: new Map(), photoshop: new Map(), layouts: new Map() };
  const ifds = await IfdReader.open(fileSlice(r, 0, size));
  const ranges = new Ranges();
  ranges.add(0, ifds.headerSize, 'header');
  const visited = new Set<number>();
  const queue: Item[] = [{ offset: ifds.first, kind: 'image', label: `IFD 0 at ${ifds.first}`, index: 0 }];
  if (ifds.first === 0) run.stop(D.BadLayout, 'the file has no IFD', 'header');
  while (queue.length) {
    run.time();
    const item = queue.shift() as Item;
    if (visited.has(item.offset)) run.stop(D.Loop, `the IFD at ${item.offset} is reached twice`, item.label);
    visited.add(item.offset);
    let ifd: Ifd;
    try {
      ifd = await ifds.ifd(item.offset);
    } catch (e) {
      if (e instanceof IfdError) run.stop(e.detail, e.message, item.label);
      throw e;
    }
    run.block(ifd.entries.length + 1);
    ranges.add(ifd.start, ifd.end, 'ifd');
    for (const e of ifd.entries) if (!e.inline) ranges.add(e.at, e.at + e.size, 'value');
    const twice = ifd.duplicates.length ? run.report(C.Structure, D.Ambiguous, item.label, { reason: `tags given twice: ${[...new Set(ifd.duplicates)].join(', ')}` }) : undefined;
    const values: Array<[number, number]> = ifd.entries.filter(e => !e.inline).map(e => [e.at, e.at + e.size]);

    if (item.kind === 'exif') {
      const f = run.metadata(D.Exif, item.label, ifd.start, ifd.end, { entries: ifd.entries.length });
      for (const [a, b] of values) run.droppableRange(a, b);
      plan.ifds.set(ifd.start, { findings: [f, twice], ranges: [[ifd.start, ifd.end], ...values] });
      const interop = await ifds.number(ifd, 40965);
      if (interop) queue.push({ offset: interop, kind: 'interop', label: `interoperability IFD at ${interop}`, index: -1 });
      continue;
    }
    if (item.kind === 'gps') {
      for (const [a, b] of values) run.droppableRange(a, b);
      const f = ifd.entries.length ? run.metadata(D.Gps, item.label, ifd.start, ifd.end, { entries: ifd.entries.length }) : undefined;
      plan.ifds.set(ifd.start, { findings: [f, twice], ranges: [[ifd.start, ifd.end], ...values] });
      continue;
    }
    if (item.kind === 'interop') {
      plan.ifds.set(ifd.start, { findings: [twice], ranges: [] });
      continue;
    }

    if (ifd.next) {
      const index = item.index >= 0 ? item.index + 1 : -1;
      queue.push({ offset: ifd.next, kind: 'image', label: index >= 0 ? `IFD ${index} at ${ifd.next}` : `SubIFD at ${ifd.next}`, index });
    }
    const subIfds = ifd.byTag.get(330);
    for (const offset of subIfds ? await ifds.numbers(subIfds) : []) {
      queue.push({ offset, kind: 'image', label: `SubIFD at ${offset}`, index: -1 });
    }
    const exif = await ifds.number(ifd, 34665);
    if (exif) queue.push({ offset: exif, kind: 'exif', label: `EXIF IFD at ${exif}`, index: -1 });
    const gps = await ifds.number(ifd, 34853);
    if (gps) queue.push({ offset: gps, kind: 'gps', label: `GPS IFD at ${gps}`, index: -1 });
    await tags(run, ifd, item.label, twice, plan);
    plan.layouts.set(ifd.start, await image(run, ifds, ifd, item.label, ranges));
  }

  // Every range the file uses, checked for overlaps; the bytes between them are gaps.
  const sorted = ranges.sorted();
  let end = 0;
  let prev: [number, number, Kind] | undefined;
  for (const g of sorted) {
    const [s, e, k] = g;
    // The same value shared by two IFDs is one range. Old-style JPEG is one legacy blob: its interchange format,
    // quantization and Huffman tables, and strips or tiles all reference overlapping bytes, so any two ranges that
    // touch it may share bytes. CONTENT/OLD_JPEG already flags the file.
    const same = prev && prev[0] === s && prev[1] === e && prev[2] === k;
    const nested = prev && ((prev[2] === 'ojpeg' && (k === 'strip' || k === 'tile' || k === 'ojpeg')) || (k === 'ojpeg' && (prev[2] === 'strip' || prev[2] === 'tile')));
    if (s < end && !same && !nested) {
      run.stop(D.Overlap, `the ${KIND_NAMES[k]} at ${s} shares bytes with the ${prev ? KIND_NAMES[prev[2]] : 'range'} at ${prev?.[0] ?? 0}`, `offset ${s}`);
    }
    if (s > end) await run.gap(end, s, 'hidden');
    if (e > end) {
      end = e;
      prev = g;
    }
  }
  await run.gap(end, size, 'trailing');
  return plan;
}

/**
 * Reports the metadata and extra tags of an image IFD, and records for each entry the rewrite can remove the findings
 * that decide it. `twice` is the IFD's finding for tags given twice, which decides the copies after the first.
 */
async function tags(run: Run, ifd: Ifd, label: string, twice: ImageFinding | undefined, plan: TiffPlan): Promise<void> {
  const r = run.reader;
  const text: number[] = [];
  const extra: number[] = [];
  const other = new Map<string, number[]>();
  // Text, the other metadata kinds and extra tags get one finding per IFD, made once the whole IFD is read.
  const later: Array<{ pos: number; group: string }> = [];
  const record = (pos: number, ...findings: Array<DefuseFinding | undefined>) => plan.entries.set(pos, [...(plan.entries.get(pos) ?? []), ...findings]);
  for (const e of ifd.entries) {
    const range = (): [number, number] => (e.inline ? [0, 0] : [e.at, e.at + e.size]);
    if (ifd.byTag.get(e.tag) !== e) record(e.pos, twice);
    if (STRUCTURE.has(e.tag)) continue;
    if (TEXT.has(e.tag)) {
      text.push(e.tag);
      run.droppableRange(...range());
      later.push({ pos: e.pos, group: 'text' });
    } else if (OTHER.has(e.tag)) {
      const kind = OTHER.get(e.tag) ?? '';
      other.set(kind, [...(other.get(kind) ?? []), e.tag]);
      run.droppableRange(...range());
      later.push({ pos: e.pos, group: `other:${kind}` });
    } else if (e.tag === 700) {
      const xmp = run.metadata(D.Xmp, `${label}, tag 700`, ...range(), { bytes: e.size });
      record(e.pos, xmp, (await hasDoctype(fileSlice(r, e.at, e.size).chunks())) ? run.report(C.Metadata, D.Doctype, `${label}, tag 700`) : undefined);
    } else if (e.tag === 34675) {
      const why = await checkIcc(fileSlice(r, e.at, e.size));
      record(e.pos, why ? run.malformed(`${label}, tag 34675`, ...range(), why) : run.metadata(D.IccProfile, `${label}, tag 34675`, ...range(), { bytes: e.size }));
    } else if (e.tag === 33723) {
      record(e.pos, run.metadata(D.Iptc, `${label}, tag 33723`, ...range(), { bytes: e.size }));
    } else if (e.tag === 34377) {
      const loc = `${label}, tag 34377`;
      const block = run.metadata(D.Iptc, loc, ...range(), { bytes: e.size });
      record(e.pos, block);
      const res = await photoshopResources(fileSlice(r, e.at, e.size));
      if (typeof res === 'string') record(e.pos, run.malformed(loc, ...range(), res));
      else if (res.thumbnails.length) {
        const edits: PhotoshopEdit[] = [];
        for (const t of res.thumbnails) {
          const thumb = run.report(C.Metadata, D.Thumbnail, loc, { offset: e.at + t.offset, bytes: t.length });
          edits.push({ thumbnail: t, contained: await run.contained(loc, 'Photoshop thumbnail', e.at + t.offset, t.length, 'image/jpeg', run.keeps(block) && run.keeps(thumb)) });
        }
        plan.photoshop.set(e.pos, edits);
      }
    } else {
      extra.push(e.tag);
      run.droppableRange(...range());
      later.push({ pos: e.pos, group: 'extra' });
    }
  }
  const groups = new Map<string, ImageFinding>();
  if (text.length) groups.set('text', run.metadata(D.Text, label, 0, 0, { tags: text.join(', ') }));
  for (const [kind] of other) groups.set(`other:${kind}`, run.metadata(D.Other, label, 0, 0, { kind }));
  if (extra.length) groups.set('extra', run.report(C.Structure, D.ExtraBlock, label, { block: `tags ${extra.join(', ')}`, tags: extra.join(', ') }));
  for (const l of later) record(l.pos, groups.get(l.group));
}

/** Checks an image IFD's size, samples, compression, and strips or tiles. */
async function image(run: Run, ifds: IfdReader, ifd: Ifd, label: string, ranges: Ranges): Promise<Layout> {
  const num = (tag: number, fallback?: number) => ifds.number(ifd, tag, fallback);
  const width = await num(256);
  const height = await num(257);
  if (!width || !height) run.stop(D.BadHeader, `the image is ${width ?? 'missing a width'} x ${height ?? 'missing a height'}`, label);
  const w = width ?? 0;
  const h = height ?? 0;
  const samples = (await num(277, 1)) ?? 1;
  const bpsEntry = ifd.byTag.get(258);
  const bpsList = bpsEntry ? await ifds.numbers(bpsEntry) : [1];
  if (samples < 1 || (bpsList.length !== samples && bpsList.length !== 1)) run.stop(D.BadHeader, `${samples} samples per pixel with ${bpsList.length} bit depths`, label);
  const bps = bpsList[0];
  if (bps < 1 || bps > 64 || bpsList.some(b => b !== bps)) run.stop(D.BadHeader, 'the bits per sample differ between samples or fall outside 1 to 64', label);
  const compression = (await num(259, 1)) ?? 1;
  if (!COMPRESSIONS.has(compression)) throw unsupported(`TIFF compression ${compression}`, label);
  if (compression === 6) run.report(C.Content, D.OldJpeg, label);
  const photometric = await num(262);
  if (photometric === undefined) run.report(C.Structure, D.Ambiguous, label, { reason: 'the photometric interpretation is missing, so readers guess it' });
  else if (!PHOTOMETRICS.has(photometric)) throw unsupported(`TIFF photometric interpretation ${photometric}`, label);
  const planar = (await num(284, 1)) ?? 1;
  if (planar !== 1 && planar !== 2) run.stop(D.BadHeader, `the planar configuration is ${planar}`, label);
  if (photometric === 3) {
    const map = ifd.byTag.get(320);
    if (!map || map.count !== 3 * 2 ** bps) run.stop(D.BadHeader, `a palette image's color map does not hold 3 x 2^${bps} entries`, label);
  }
  const perPlane = planar === 1 ? samples : 1;
  const planes = planar === 1 ? 1 : samples;
  const rowBytes = Math.ceil((w * bps * perPlane) / 8);
  run.image(w, h, rowBytes * h * planes, label);

  const strips = ifd.byTag.has(273);
  const tiles = ifd.byTag.has(324) || ifd.byTag.has(322);
  if (strips && tiles) run.report(C.Structure, D.Ambiguous, label, { reason: 'the image has both strips and tiles' });
  if (!strips && !tiles) run.stop(D.BadLayout, 'the image has neither strips nor tiles', label);
  let rowsEach: number;
  let bytesPerRow: number;
  let perPlaneCount: number;
  const kind: Kind = tiles ? 'tile' : 'strip';
  if (tiles) {
    const tw = (await num(322)) ?? 0;
    const th = (await num(323)) ?? 0;
    if (tw <= 0 || th <= 0) run.stop(D.BadHeader, `the tiles are ${tw} x ${th}`, label);
    perPlaneCount = Math.ceil(w / tw) * Math.ceil(h / th);
    rowsEach = th;
    bytesPerRow = Math.ceil((tw * bps * perPlane) / 8);
  } else {
    const rps = (await num(278, 0xffffffff)) ?? 0xffffffff;
    if (rps === 0) run.stop(D.BadHeader, 'the rows per strip is 0', label);
    rowsEach = Math.min(rps, h);
    perPlaneCount = Math.ceil(h / rowsEach);
    bytesPerRow = rowBytes;
  }
  const count = perPlaneCount * planes;
  const offsetsEntry = ifd.byTag.get(tiles ? 324 : 273);
  const countsEntry = ifd.byTag.get(tiles ? 325 : 279);
  if (!offsetsEntry || !countsEntry) return run.stop(D.BadLayout, `the image has no ${tiles ? 'tile' : 'strip'} byte counts`, label);
  // The two arrays must agree with each other and cover at least the grid. Some writers list more (over-specified
  // tiles), which readers take from the arrays; fewer than the grid needs is a truncated image.
  if (offsetsEntry.count !== countsEntry.count) run.stop(D.BadLayout, `the image lists ${offsetsEntry.count} ${kind} offsets and ${countsEntry.count} byte counts`, label);
  if (offsetsEntry.count < count) run.stop(D.BadLayout, `the image needs ${count} ${kind}s and lists only ${offsetsEntry.count}`, label);
  const listed = offsetsEntry.count;
  run.block(listed);
  const offsets = await ifds.numbers(offsetsEntry);
  const counts = await ifds.numbers(countsEntry);
  for (let i = 0; i < listed; i++) {
    if ((i & 4095) === 0) run.time();
    const n = counts[i];
    if (n === 0) continue;
    const at = offsets[i];
    if (at + n > run.size) run.stop(D.Truncated, `${kind} ${i} runs past the end of the file`, label);
    if (compression === 1 && i < count) {
      // A strip at the bottom holds the rows that are left. A tile always holds its full size.
      const rows = tiles ? rowsEach : Math.min(rowsEach, h - (i % perPlaneCount) * rowsEach);
      const want = rows * bytesPerRow;
      if (n < want) run.stop(D.BadData, `uncompressed ${kind} ${i} holds ${n} bytes for ${want}`, label);
      ranges.add(at, at + want, kind);
    } else ranges.add(at, at + n, kind);
  }
  const ojpeg: Array<[number, number]> = [];
  const old = (from: number, to: number) => {
    ranges.add(from, to, 'ojpeg');
    ojpeg.push([from, to]);
  };
  const jpegAt = await num(513);
  const jpegLength = await num(514);
  if (jpegAt !== undefined && jpegLength !== undefined && jpegLength > 0) {
    if (jpegAt + jpegLength > run.size) run.stop(D.Truncated, 'the old-style JPEG data runs past the end of the file', label);
    old(jpegAt, jpegAt + jpegLength);
  }
  // Old-style JPEG stores its quantization tables (tag 519, 64 bytes each) and its Huffman tables (tags 520 and 521,
  // 16 count bytes then that many values) in regions these tags point at. They are image structure, not gaps.
  if (compression === 6) {
    const quant = ifd.byTag.get(519);
    if (quant) for (const at of await ifds.numbers(quant)) if (at > 0 && at + 64 <= run.size) old(at, at + 64);
    for (const tag of [520, 521]) {
      const entry = ifd.byTag.get(tag);
      if (!entry) continue;
      for (const at of await ifds.numbers(entry)) {
        if (at <= 0 || at + 16 > run.size) continue;
        const bits = await run.reader.read(at, 16);
        let total = 16;
        for (const b of bits) total += b;
        if (at + total <= run.size) old(at, at + total);
      }
    }
  }
  return { tiles, compression, count, perPlaneCount, rowsEach, bytesPerRow, height: h, ojpeg };
}

/**
 * The TIFF as the rewrite writes it. Entries, EXIF and GPS IFDs that a finding or a signature removes go, and so do
 * Photoshop thumbnails that go. Every byte no kept IFD, value, strip, tile or old-style JPEG range covers is removed,
 * which takes gaps and trailing data with it, and uncompressed strips are cut to their rows. Every offset is then
 * written for where its target lands.
 */
export async function tiffPieces(run: Run, plan: TiffPlan): Promise<Piece[]> {
  const r = await IfdReader.open(fileSlice(run.reader, 0, run.size));
  const ifds = await walkIfds(r, true);
  const t = new TiffRewrite(r, 0, ifds);
  for (const w of ifds) {
    run.time();
    const decided = plan.ifds.get(w.ifd.start);
    if (w.kind !== 'chain' && w.kind !== 'sub') {
      if (decided && (decided.findings.some(f => f !== undefined && !run.keeps(f)) || decided.ranges.some(([a, b]) => run.drops([], a, b)))) t.dropIfd(w);
      continue;
    }
    for (const e of w.ifd.entries) {
      const findings = plan.entries.get(e.pos);
      if (findings && run.drops(findings, e.inline ? 0 : e.at, e.inline ? 0 : e.at + e.size)) {
        t.dropEntry(e);
        continue;
      }
      const edits = plan.photoshop.get(e.pos);
      if (!edits) continue;
      const region = new Region(e.at, e.at + e.size);
      if (!photoshopEdits(run, region, e.at, edits)) continue;
      // A value whose type is wider than a byte cannot change length by a thumbnail's bytes, so it goes instead.
      if (typeSize(e.type) !== 1) t.dropEntry(e);
      else {
        const pieces = region.pieces();
        t.replaceValue(e, pieces, lengthOf(pieces));
      }
    }
    const layout = plan.layouts.get(w.ifd.start);
    if (!layout) continue;
    const offsetsEntry = w.ifd.byTag.get(layout.tiles ? 324 : 273);
    const countsEntry = w.ifd.byTag.get(layout.tiles ? 325 : 279);
    if (!offsetsEntry || !countsEntry) continue;
    const offsets = await r.numbers(offsetsEntry);
    const counts = await r.numbers(countsEntry);
    // Strips written end to end, the usual layout, are kept as one range.
    let from = -1;
    let to = -1;
    for (let i = 0; i < offsets.length; i++) {
      const n = counts[i];
      if (!n) continue;
      const at = offsets[i];
      let keep = n;
      if (layout.compression === 1 && i < layout.count) {
        const rows = layout.tiles ? layout.rowsEach : Math.min(layout.rowsEach, layout.height - (i % layout.perPlaneCount) * layout.rowsEach);
        keep = Math.min(n, rows * layout.bytesPerRow);
        if (keep < n) t.setValue(countsEntry, i, keep);
      }
      if (at === to) to = at + keep;
      else {
        if (to > from) t.keepRange(from, to);
        from = at;
        to = at + keep;
      }
    }
    if (to > from) t.keepRange(from, to);
    for (const [a, b] of layout.ojpeg) t.keepRange(a, b);
  }
  return t.pieces(true);
}

function unsupported(what: string, loc: string): Error {
  return new StopError(C.Format, D.Unsupported, `${what} is not read by this version`, { format: what }, loc);
}
