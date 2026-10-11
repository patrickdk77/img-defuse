import { type Box, boxPieces, isBox, readBox, typeName } from './boxes';
import type { Contained, Run } from './context';
import { type ExifPlan, exifFindings, exifPieces, inspectExif } from './exif';
import { brotliChunks, InflateError } from './inflate';
import { hasDoctype } from './metadata';
import { copy, type Piece } from './rewrite';
import { bytesSlice, fileSlice, joinedSlice, latin1, type Slice, View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

type Findings = Array<DefuseFinding | undefined>;

/** A top-level box as the rewrite sees it. */
type Item =
  | { kind: 'keep'; box: Box }
  | { kind: 'optional'; box: Box; findings: Findings }
  | { kind: 'exif'; box: Box; skip: number; exif: ExifPlan }
  | { kind: 'gainmap'; box: Box; findings: Findings; map: number; contained?: Contained };

export interface JxlPlan {
  /** A bare codestream, which the rewrite copies as it is. */
  bare: boolean;
  items: Item[];
}

/** Reads bits least significant first, as JPEG XL stores them. */
class Bits {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) {
      const byte = this.pos >> 3;
      if (byte >= this.b.length) throw new RangeError('the image header runs past the bytes read');
      v += ((this.b[byte] >> (this.pos & 7)) & 1) * 2 ** i;
    }
    return v;
  }
  bool(): boolean {
    return this.u(1) === 1;
  }
  /** A U32 field: two bits choose one of four distributions, each a constant or [bits, offset]. */
  u32(d: Array<number | [number, number]>): number {
    const x = d[this.u(2)];
    return typeof x === 'number' ? x : this.u(x[0]) + x[1];
  }
}

/** The distributions of the image header's fields (ISO/IEC 18181-1 A.2 to A.6), as libjxl reads them. */
const DIMENSION: Array<[number, number]> = [
  [9, 1],
  [13, 1],
  [18, 1],
  [30, 1],
];
const PREVIEW_DIV8: Array<number | [number, number]> = [16, 32, [5, 1], [9, 33]];
const PREVIEW: Array<[number, number]> = [
  [6, 1],
  [8, 65],
  [10, 321],
  [12, 1345],
];
const RATIOS: Array<[number, number]> = [
  [1, 1],
  [12, 10],
  [4, 3],
  [3, 2],
  [16, 9],
  [5, 4],
  [2, 1],
];

function sizeHeader(r: Bits): { width: number; height: number } {
  const small = r.bool();
  const height = small ? (r.u(5) + 1) * 8 : r.u32(DIMENSION);
  const ratio = r.u(3);
  if (ratio) return { width: Math.floor((height * RATIOS[ratio - 1][0]) / RATIOS[ratio - 1][1]), height };
  return { width: small ? (r.u(5) + 1) * 8 : r.u32(DIMENSION), height };
}

function previewHeader(r: Bits): void {
  const div8 = r.bool();
  r.u32(div8 ? PREVIEW_DIV8 : PREVIEW);
  if (r.u(3) === 0) r.u32(div8 ? PREVIEW_DIV8 : PREVIEW);
}

/** The image size, and the channels and bytes a sample its header gives, up to the count of extra channels. */
function imageHeader(head: Uint8Array): { width: number; height: number; channels: number; bytes: number; bits: number; float: boolean } {
  const r = new Bits(head.subarray(2));
  const { width, height } = sizeHeader(r);
  // all_default: 8-bit samples and no extra channels.
  if (r.bool()) return { width, height, channels: 3, bytes: 1, bits: 8, float: false };
  if (r.bool()) {
    r.u(3);
    if (r.bool()) sizeHeader(r);
    if (r.bool()) previewHeader(r);
    if (r.bool()) {
      r.u32([100, 1000, [10, 1], [30, 1]]);
      r.u32([1, 1001, [8, 1], [10, 1]]);
      r.u32([0, [3, 0], [16, 0], [32, 0]]);
      r.bool();
    }
  }
  const float = r.bool();
  const bits = float ? r.u32([32, 16, 24, [6, 1]]) : r.u32([8, 10, 12, [6, 1]]);
  if (float) r.u(4);
  r.bool();
  const extra = r.u32([0, 1, [4, 2], [12, 1]]);
  return { width, height, channels: 3 + extra, bytes: bits <= 8 ? 1 : bits <= 16 ? 2 : 4, bits, float };
}

/** Checks the codestream's signature and image header, and counts the image. */
async function codestreamHeader(run: Run, cs: Slice, loc: string): Promise<void> {
  const head = await cs.read(0, 128);
  if (head.length < 2 || head[0] !== 0xff || head[1] !== 0x0a) run.stop(D.BadHeader, 'the codestream does not start with the JPEG XL signature', loc);
  let h: ReturnType<typeof imageHeader>;
  try {
    h = imageHeader(head);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    run.stop(D.Truncated, 'the codestream ends inside its image header', loc);
  }
  if ((!h.float && h.bits > 31) || (h.float && h.bits > 32)) run.stop(D.BadHeader, `the image header gives ${h.bits}-bit ${h.float ? 'floating-point ' : ''}samples`, loc);
  run.image(h.width, h.height, h.width * h.height * h.channels * h.bytes, loc);
}

const optional = (box: Box, ...findings: Findings): Item => ({ kind: 'optional', box, findings });

/**
 * Inspects a JPEG XL file: a bare codestream, or a container whose codestream is in one jxlc box or in jxlp boxes
 * numbered in order. The codestream's frames are not read, so a bare codestream is copied as it is.
 */
export async function inspectJxl(run: Run): Promise<JxlPlan> {
  const r = run.reader;
  const size = run.size;
  const head = await r.read(0, 2);
  if (head[0] === 0xff && head[1] === 0x0a) {
    await codestreamHeader(run, fileSlice(r, 0, size), 'codestream at 0');
    return { bare: true, items: [] };
  }
  const items: Item[] = [];
  const sig = await readBox(run, 0, size, '');
  if (!isBox(sig) || sig.end !== 12) run.stop(D.BadHeader, 'the signature box is not 12 bytes', 'offset 0');
  items.push({ kind: 'keep', box: sig });
  const ft = await readBox(run, 12, size, '');
  if (!isBox(ft)) run.stop(ft.detail, ft.reason, ft.loc);
  if (ft.type !== 'ftyp') run.stop(D.BadLayout, 'the file type box does not follow the signature', ft.loc);
  const ftyp = latin1(await r.read(ft.data, Math.min(ft.end - ft.data, 4096)));
  if (ft.end - ft.data < 12 || (ft.end - ft.data) % 4 !== 0 || ftyp.slice(0, 4) !== 'jxl ') run.stop(D.BadHeader, 'the file type box does not name JPEG XL', ft.loc);
  items.push({ kind: 'keep', box: ft });

  const doctype = async (b: Box, s: Slice) => ((await hasDoctype(s.chunks())) ? run.report(C.Metadata, D.Doctype, b.loc) : undefined);
  const ranges: Array<[number, number]> = [];
  let kind: 'jxlc' | 'jxlp' | undefined;
  let first: Box | undefined;
  let complete = false;
  let level = false;
  for (let p = ft.end; p < size; ) {
    run.time();
    const b = await readBox(run, p, size, '');
    if (!isBox(b)) {
      // Readers stop once they have the codestream, so what does not read as a box after it is trailing data.
      if (!complete) run.stop(b.detail, b.reason, b.loc);
      await run.gap(p, size, 'trailing');
      break;
    }
    p = b.end;
    const n = b.end - b.data;
    // How many bytes the box can grow by before its length needs 64 bits, for a thumbnail a plugin rewrites.
    const room = 0xffffffff - (b.end - b.start);
    switch (b.type) {
      case 'jxll': {
        if (level || kind) run.stop(D.BadLayout, level ? 'a second level box' : 'the level box comes after the codestream', b.loc);
        level = true;
        const v = n === 1 ? (await r.read(b.data, 1))[0] : -1;
        if (v !== 5 && v !== 10) run.stop(D.BadHeader, 'the level box names a level other than 5 or 10', b.loc);
        items.push({ kind: 'keep', box: b });
        break;
      }
      case 'jxlc':
        if (kind) run.stop(D.BadLayout, `a jxlc box where the codestream is ${kind === 'jxlc' ? 'already whole' : 'in jxlp boxes'}`, b.loc);
        kind = 'jxlc';
        first = b;
        complete = true;
        ranges.push([b.data, n]);
        items.push({ kind: 'keep', box: b });
        break;
      case 'jxlp': {
        if (kind === 'jxlc' || complete) run.stop(D.BadLayout, kind === 'jxlc' ? 'a jxlp box where the codestream is in a jxlc box' : 'a jxlp box after the last one', b.loc);
        if (n < 4) run.stop(D.BadHeader, 'a jxlp box is shorter than its index', b.loc);
        const index = new View(await r.read(b.data, 4)).u32(0);
        if ((index & 0x7fffffff) !== ranges.length) run.stop(D.BadLayout, `jxlp box ${index & 0x7fffffff} comes where ${ranges.length} should`, b.loc);
        kind = 'jxlp';
        first ??= b;
        complete = index >= 0x80000000;
        ranges.push([b.data + 4, n - 4]);
        items.push({ kind: 'keep', box: b });
        break;
      }
      case 'Exif': {
        const offset = n >= 4 ? new View(await r.read(b.data, 4)).u32(0) : -1;
        if (offset < 0 || 4 + offset > n) {
          items.push(optional(b, run.malformed(b.loc, b.start, b.end, 'the EXIF box gives an offset past its end')));
          break;
        }
        const exif = await inspectExif(run, fileSlice(r, b.data + 4 + offset, n - 4 - offset), b.loc, b.start, b.end, room);
        items.push({ kind: 'exif', box: b, skip: 4 + offset, exif });
        break;
      }
      case 'xml ':
        items.push(optional(b, run.metadata(D.Xmp, b.loc, b.start, b.end, { bytes: n }), await doctype(b, fileSlice(r, b.data, n))));
        break;
      case 'jumb':
        items.push(optional(b, run.metadata(D.Other, b.loc, b.start, b.end, { kind: 'JUMBF, such as C2PA content credentials' })));
        break;
      case 'brob':
        items.push(await brotliBox(run, b, doctype));
        break;
      case 'jbrd':
        items.push(optional(b, run.extra(b.loc, b.start, b.end, { block: 'jbrd box', reason: 'data to rebuild the JPEG the image came from, which viewers do not use' })));
        break;
      case 'jhgm':
        items.push(await gainMap(run, b, room));
        break;
      case 'JXL ':
      case 'ftyp':
        run.stop(D.BadLayout, `a second ${b.type === 'ftyp' ? 'file type' : 'signature'} box`, b.loc);
        break;
      default:
        items.push(optional(b, run.extra(b.loc, b.start, b.end, { block: `${typeName(b.type)} box` })));
    }
  }
  if (!first) run.stop(D.BadLayout, 'the file has no codestream', 'offset 0');
  if (!complete) run.stop(D.Truncated, 'the jxlp boxes end before the last one', first.loc);
  await codestreamHeader(run, joinedSlice(r, ranges), first.loc);
  return { bare: false, items };
}

/**
 * Reports a Brotli-compressed box by the type it holds: EXIF, XMP or JUMBF, or an extra block. The data is
 * decompressed up to the metadata size limit. A thumbnail in compressed EXIF cannot be given to a plugin, so it takes
 * the box with it.
 */
async function brotliBox(run: Run, b: Box, doctype: (b: Box, s: Slice) => Promise<DefuseFinding | undefined>): Promise<Item> {
  const n = b.end - b.data;
  if (n < 4) return optional(b, run.malformed(b.loc, b.start, b.end, 'a brob box is shorter than the type it names'));
  const inner = latin1(await run.reader.read(b.data, 4));
  const parts: Uint8Array[] = [];
  try {
    const done = await brotliChunks(fileSlice(run.reader, b.data + 4, n - 4).chunks(), run.limits.metadataBytes, c => parts.push(c), run.deadline);
    if (done.consumed < n - 4) return optional(b, run.malformed(b.loc, b.start, b.end, 'bytes follow the Brotli data'));
  } catch (e) {
    if (!(e instanceof InflateError)) throw e;
    if (e.kind === 'over') run.limit(D.MetadataSize, `${b.loc} decompresses past ${run.limits.metadataBytes} bytes`, { limit: run.limits.metadataBytes });
    return optional(b, run.malformed(b.loc, b.start, b.end, `the Brotli data does not decompress: ${e.message}`));
  }
  const data = Buffer.concat(parts);
  switch (inner) {
    case 'Exif': {
      const offset = data.length >= 4 ? data.readUInt32BE(0) : -1;
      if (offset < 0 || 4 + offset > data.length) return optional(b, run.malformed(b.loc, b.start, b.end, 'the EXIF box gives an offset past its end'));
      const exif = await inspectExif(run, bytesSlice(data.subarray(4 + offset)), b.loc, b.start, b.end, 0, false);
      return optional(b, ...exifFindings(exif));
    }
    case 'xml ':
      return optional(b, run.metadata(D.Xmp, b.loc, b.start, b.end, { bytes: data.length }), await doctype(b, bytesSlice(data)));
    case 'jumb':
      return optional(b, run.metadata(D.Other, b.loc, b.start, b.end, { kind: 'JUMBF, such as C2PA content credentials' }));
    default:
      return optional(b, run.extra(b.loc, b.start, b.end, { block: `brob box holding ${typeName(inner)}` }));
  }
}

/**
 * Reports a gain map box as a secondary image: a version, its metadata, a colour encoding and an ICC profile, each
 * after its size, then a bare JPEG XL codestream, which goes to the file plugins.
 */
async function gainMap(run: Run, b: Box, room: number): Promise<Item> {
  const n = b.end - b.data;
  const head = new View(await run.reader.read(b.data, Math.min(n, 3)));
  let at = 3 + (head.length === 3 ? head.u16(1) : n);
  const colour = at < n ? (await run.reader.read(b.data + at, 1))[0] : 0;
  at += 1 + colour;
  const icc = at + 4 <= n ? new View(await run.reader.read(b.data + at, 4)).u32(0) : 0;
  at += 4 + icc;
  if (head.length < 3 || head.u8(0) !== 0 || at >= n) return optional(b, run.malformed(b.loc, b.start, b.end, 'the gain map box does not hold its parts'));
  const finding = run.metadata(D.SecondaryImage, b.loc, b.start, b.end, { kind: 'gain map', bytes: n - at });
  const contained = await run.contained(b.loc, 'gain map', b.data + at, n - at, 'image/jxl', run.keeps(finding), n - at + room);
  return { kind: 'gainmap', box: b, findings: [finding], map: b.data + at, contained };
}

/**
 * The JPEG XL as the rewrite writes it: every box its findings keep, EXIF without what goes, and a gain map a plugin
 * rewrote. A bare codestream is copied as it is.
 */
export async function jxlPieces(run: Run, plan: JxlPlan): Promise<Piece[]> {
  if (plan.bare) return [copy(0, run.size)];
  const out: Piece[] = [];
  for (const it of plan.items) {
    run.time();
    const b = it.box;
    const whole = () => out.push(copy(b.start, b.end - b.start));
    switch (it.kind) {
      case 'keep':
        whole();
        break;
      case 'optional':
        if (!run.drops(it.findings, b.start, b.end)) whole();
        break;
      case 'exif': {
        const tiff = await exifPieces(run, it.exif, [], b.start, b.end);
        if (tiff) out.push(...boxPieces('Exif', [copy(b.data, it.skip), ...tiff]));
        break;
      }
      case 'gainmap': {
        const c = it.contained;
        if (!c || c.decision === 'drop' || run.drops(it.findings, b.start, b.end)) break;
        if (c.decision === 'keep') whole();
        else if (c.replacement) out.push(...boxPieces('jhgm', [copy(b.data, it.map - b.data), { kind: 'source', source: run.replacementSource(c), length: c.replacement.length }]));
        break;
      }
      default:
        break;
    }
  }
  return out;
}
