import type { Contained, Run } from './context';
import { type MetafileBitmap, metafileBitmap } from './dib';
import { bytes, copy, type Piece, Region, u16, u32 } from './rewrite';
import { View } from './slice';
import { type ByteSource, ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

type Findings = Array<DefuseFinding | undefined>;

/** Record types of [MS-EMF] 2.1.1. */
const EMR_HEADER = 0x01;
const EMR_EOF = 0x0e;
const EMR_COMMENT = 0x46;
const EMR_DRAWESCAPE = 0x69;
const EMR_EXTESCAPE = 0x6a;
const EMR_NAMEDESCAPE = 0x6e;
const EMR_CREATECOLORSPACE = 0x63;
const EMR_CREATECOLORSPACEW = 0x7a;
const EMR_SETICMPROFILEA = 0x70;
const EMR_SETICMPROFILEW = 0x71;
const EMR_COLORMATCHTOTARGETW = 0x79;

/** The types [MS-EMF] 2.1.1 defines. 0x45, 0x6B and 0x75 are not among them. */
const known = (t: number) => (t >= 0x01 && t <= 0x44) || (t >= 0x46 && t <= 0x6a) || (t >= 0x6c && t <= 0x74) || (t >= 0x76 && t <= 0x7a);

/**
 * Records that hold bitmaps ([MS-EMF] 2.3.1 and 2.3.7.4, 2.3.7.5): the size of the fixed part, where the usage of the
 * source bitmap's colors sits, where its offBmi, cbBmi, offBits and cbBits fields start, the same for the mask bitmap
 * of EMR_MASKBLT and EMR_PLGBLT, and where EMR_SETDIBITSTODEVICE gives its scan line count.
 */
const BITMAPS = new Map<number, { name: string; fixed: number; usage: number; src: number; maskUsage?: number; mask?: number; scans?: number }>([
  [0x4c, { name: 'EMR_BITBLT', fixed: 100, usage: 80, src: 84 }],
  [0x4d, { name: 'EMR_STRETCHBLT', fixed: 108, usage: 80, src: 84 }],
  [0x4e, { name: 'EMR_MASKBLT', fixed: 128, usage: 80, src: 84, maskUsage: 108, mask: 112 }],
  [0x4f, { name: 'EMR_PLGBLT', fixed: 140, usage: 92, src: 96, maskUsage: 120, mask: 124 }],
  [0x50, { name: 'EMR_SETDIBITSTODEVICE', fixed: 76, usage: 64, src: 48, scans: 72 }],
  [0x51, { name: 'EMR_STRETCHDIBITS', fixed: 80, usage: 64, src: 48 }],
  [0x72, { name: 'EMR_ALPHABLEND', fixed: 108, usage: 80, src: 84 }],
  [0x74, { name: 'EMR_TRANSPARENTBLT', fixed: 108, usage: 80, src: 84 }],
  [0x5d, { name: 'EMR_CREATEMONOBRUSH', fixed: 32, usage: 12, src: 16 }],
  [0x5e, { name: 'EMR_CREATEDIBPATTERNBRUSHPT', fixed: 32, usage: 12, src: 16 }],
]);

const ESCAPES = new Map([
  [EMR_DRAWESCAPE, 'EMR_DRAWESCAPE'],
  [EMR_EXTESCAPE, 'EMR_EXTESCAPE'],
  [EMR_NAMEDESCAPE, 'EMR_NAMEDESCAPE'],
]);

/** Comment identifiers ([MS-EMF] 2.3.3) and public comment types (2.1.10). */
const COMMENT_EMFPLUS = 0x2b464d45;
const COMMENT_PUBLIC = 0x43494447;
const COMMENT_EMFSPOOL = 0x00000000;
const PUBLIC_BEGINGROUP = 0x00000002;
const PUBLIC_ENDGROUP = 0x00000003;
const PUBLIC_MULTIFORMATS = 0x40000004;
const PUBLIC_WINDOWS_METAFILE = 0x80000001;

/** EmrFormat signatures ([MS-EMF] 2.1.14), and "PDF ", which Office writes and LibreOffice draws. */
const FORMAT_TYPES = new Map([
  [0x464d4520, 'image/emf'],
  [0x46535045, 'application/postscript'],
  [0x50444620, 'application/pdf'],
]);

/** EMF+ record types ([MS-EMFPLUS] 2.1.1.1) and the object type of an image (2.1.1.21). */
const EMFPLUS_OBJECT = 0x4008;
const EMFPLUS_FIRST = 0x4001;
const EMFPLUS_LAST = 0x403a;
const OBJECT_IMAGE = 5;
/** The bytes of object data in each part of a continued object, as GDI+ splits one. */
const PART = 65004;

const LCS_SRGB = 0x73524742;

interface Rec {
  type: number;
  start: number;
  end: number;
  loc: string;
}

/** An EMF+ record inside a comment. */
interface PlusRecord {
  start: number;
  end: number;
  findings: Findings;
}

/** An EMR_COMMENT holding EMF+ records, which the rewrite can write again without some of them. */
interface PlusComment {
  rec: Rec;
  /** The EMF+ records, from after the comment identifier to the end of the comment's data. */
  contentStart: number;
  contentEnd: number;
  records: PlusRecord[];
}

/** An EMF+ image object holding a compressed bitmap or a metafile, which may span records. */
interface PlusImage {
  flags: number;
  parts: Array<{ comment: PlusComment; record: PlusRecord; dataStart: number; dataLength: number }>;
  /** Bytes of object data before the file: the image header, then the bitmap's or the metafile's. */
  headerLength: number;
  metafile: boolean;
  contained: Contained;
}

type Action =
  | { kind: 'optional'; rec: Rec; findings: Findings }
  | { kind: 'files'; rec: Rec; files: Contained[] }
  | { kind: 'colorspace'; rec: Rec; findings: Findings; typeAt: number; nameAt: number; nameLength: number };

export interface EmfPlan {
  /** After EMR_EOF. Bytes after it are trailing data. */
  end: number;
  records: number;
  description?: { findings: Findings; start: number; length: number };
  actions: Action[];
  comments: PlusComment[];
  images: PlusImage[];
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;

/** A UTF-16LE string from the file, cut at its first NUL. */
async function utf16(run: Run, at: number, length: number): Promise<string> {
  return Buffer.from(await run.reader.read(at, Math.min(length, 1024)))
    .toString('utf16le')
    .split('\0')[0];
}

async function ascii(run: Run, at: number, n: number): Promise<string> {
  return Buffer.from(await run.reader.read(at, Math.min(n, 1024)))
    .toString('latin1')
    .split('\0')[0];
}

/** The EMF+ object being read when it spans records, by its flags. */
interface Open {
  flags: number;
  total: number;
  collected: number;
  parts: PlusImage['parts'];
}

/** Reads one EMF+ image object, its data in `parts`, and hands a compressed bitmap or a metafile to the file plugins. */
async function plusImage(run: Run, plan: EmfPlan, flags: number, parts: PlusImage['parts'], loc: string): Promise<void> {
  const ranges = parts.map((p): [number, number] => [p.dataStart, p.dataLength]);
  const total = ranges.reduce((t, [, n]) => t + n, 0);
  const read = async (offset: number, n: number): Promise<View> => {
    const out = new Uint8Array(n);
    let at = 0;
    let filled = 0;
    for (const [s, len] of ranges) {
      const from = Math.max(offset, at);
      const to = Math.min(offset + n, at + len);
      if (from < to) {
        out.set(await run.reader.read(s + from - at, to - from), from - offset);
        filled += to - from;
      }
      at += len;
    }
    if (filled !== n) run.stop(D.BadData, 'an EMF+ image object is cut short', loc);
    return new View(out, true);
  };
  const head = await read(0, 8);
  const type = head.u32(4);
  let headerLength: number;
  let declared: string | undefined;
  if (type === 1) {
    const b = await read(8, 20);
    const width = b.i32(0);
    const height = b.i32(4);
    const stride = b.i32(8);
    const pixelFormat = b.u32(12);
    const bitmapType = b.u32(16);
    if (bitmapType === 0) {
      // Pixels in the object: checked for their size, and kept as they are.
      const bpp = (pixelFormat >> 8) & 0xff;
      if (width <= 0 || height <= 0 || bpp === 0 || Math.abs(stride) < Math.ceil((width * bpp) / 8)) run.stop(D.BadHeader, `an EMF+ bitmap of ${width} x ${height} with a stride of ${stride}`, loc);
      run.inner(width, height, Math.abs(stride) * height, loc);
      if (28 + Math.abs(stride) * height > total) run.stop(D.BadData, 'an EMF+ bitmap holds fewer bytes than its rows', loc);
      return;
    }
    if (bitmapType !== 1) run.stop(D.BadHeader, `an EMF+ bitmap of type ${bitmapType}`, loc);
    headerLength = 28;
  } else if (type === 2) {
    const m = await read(8, 8);
    const kind = m.u32(0);
    const size = m.u32(4);
    if (kind < 1 || kind > 5) run.stop(D.BadHeader, `an EMF+ metafile of type ${kind}`, loc);
    if (16 + size > total) run.stop(D.BadData, 'an EMF+ metafile holds fewer bytes than its size', loc);
    headerLength = 16;
    declared = kind <= 2 ? 'image/wmf' : 'image/emf';
  } else return;
  if (total <= headerLength) run.stop(D.BadData, 'an EMF+ image object holds no image', loc);
  // The file is the object data after the headers, split over the parts.
  const fileRanges: Array<[number, number]> = [];
  let skip = headerLength;
  for (const [s, len] of ranges) {
    if (skip >= len) {
      skip -= len;
      continue;
    }
    fileRanges.push([s + skip, len - skip]);
    skip = 0;
  }
  const length = total - headerLength;
  const contained = await run.contained(loc, 'EMF+ image', fileRanges[0][0], length, declared, true, 0xffffffff - run.size, { ranges: fileRanges });
  plan.images.push({ flags, parts, headerLength, metafile: type === 2, contained });
}

/** Walks the EMF+ records of a comment, [start, end) of the file. */
async function plusRecords(run: Run, plan: EmfPlan, comment: PlusComment, open: { current?: Open }): Promise<void> {
  const r = run.reader;
  let q = comment.contentStart;
  const end = comment.contentEnd;
  while (q < end) {
    run.time();
    const loc = `${comment.rec.loc}, EMF+ record at ${q}`;
    // Readers stop where no EMF+ record fits, and GDI+ leaves four bytes there.
    if (end - q < 12) return;
    const v = new View(await r.read(q, 12), true);
    const type = v.u16(0);
    const flags = v.u16(2);
    const size = v.u32(4);
    const dataSize = v.u32(8);
    if (size < 12 || size % 4 !== 0 || q + size > end) run.stop(D.BadHeader, `an EMF+ record of ${size} bytes`, loc);
    if (dataSize > size - 12) run.stop(D.BadHeader, `an EMF+ record of ${size} bytes gives ${dataSize} bytes of data`, loc);
    run.block();
    const rec: PlusRecord = { start: q, end: q + size, findings: [] };
    comment.records.push(rec);
    const o = open.current;
    if (type < EMFPLUS_FIRST || type > EMFPLUS_LAST) {
      run.droppableRange(rec.start, rec.end);
      rec.findings.push(run.report(C.Structure, D.ExtraBlock, loc, { block: `EMF+ record of type 0x${type.toString(16)}` }));
    } else if (type === EMFPLUS_OBJECT && (flags & 0x8000) !== 0) {
      // One part of an object continued over several records: each holds the total size first ([MS-EMFPLUS] 2.3.5.1).
      if (dataSize < 4) run.stop(D.BadHeader, 'a continued EMF+ object has no room for its total size', loc);
      const total = new View(await r.read(q + 12, 4), true).u32(0);
      const part = { comment, record: rec, dataStart: q + 16, dataLength: dataSize - 4 };
      if (o && (o.flags !== flags || o.total !== total)) run.stop(D.BadData, 'a continued EMF+ object ends before its total size', loc);
      const cur = o ?? { flags, total, collected: 0, parts: [] };
      cur.parts.push(part);
      cur.collected += part.dataLength;
      open.current = cur;
      if (cur.collected > total) run.stop(D.BadData, 'a continued EMF+ object holds more than its total size', loc);
      if (cur.collected === total) {
        open.current = undefined;
        if (((flags >> 8) & 0x7f) === OBJECT_IMAGE) await plusImage(run, plan, flags, cur.parts, loc);
      }
    } else {
      if (o) run.stop(D.BadData, 'a continued EMF+ object ends before its total size', loc);
      if (type === EMFPLUS_OBJECT && ((flags >> 8) & 0x7f) === OBJECT_IMAGE) {
        await plusImage(run, plan, flags, [{ comment, record: rec, dataStart: q + 12, dataLength: dataSize }], loc);
      }
    }
    q += size;
  }
}

/** Reads an EMR_COMMENT record: EMF+, EMFSPOOL, a public comment, or private data. */
async function commentRecord(run: Run, plan: EmfPlan, rec: Rec, open: { current?: Open }): Promise<void> {
  const r = run.reader;
  const size = rec.end - rec.start;
  const extra = (reason: string) => {
    run.droppableRange(rec.start, rec.end);
    plan.actions.push({ kind: 'optional', rec, findings: [run.report(C.Structure, D.ExtraBlock, rec.loc, { block: 'EMR_COMMENT record', reason })] });
  };
  if (size < 12) run.stop(D.BadHeader, 'an EMR_COMMENT record has no room for its data size', rec.loc);
  const dataSize = new View(await r.read(rec.start + 8, 4), true).u32(0);
  if (12 + dataSize > size) return extra('a comment whose data runs past its record');
  if (dataSize < 4) return extra('private data');
  const id = new View(await r.read(rec.start + 12, 4), true).u32(0);
  if (id === COMMENT_EMFPLUS) {
    const c: PlusComment = { rec, contentStart: rec.start + 16, contentEnd: rec.start + 12 + dataSize, records: [] };
    plan.comments.push(c);
    await plusRecords(run, plan, c, open);
    return;
  }
  // Spool records go to a printer's spooler, never to a viewer, and can carry fonts, metafiles and PostScript.
  if (id === COMMENT_EMFSPOOL) return extra('spool data, which can carry fonts, metafiles and PostScript for a printer');
  if (id !== COMMENT_PUBLIC) return extra('private data');
  if (dataSize < 8) run.stop(D.BadHeader, 'a public comment has no type', rec.loc);
  const kind = new View(await r.read(rec.start + 16, 4), true).u32(0);
  const dataEnd = rec.start + 12 + dataSize;
  switch (kind) {
    case PUBLIC_BEGINGROUP: {
      if (dataSize < 28) run.stop(D.BadHeader, 'EMR_COMMENT_BEGINGROUP is cut short', rec.loc);
      const n = new View(await r.read(rec.start + 36, 4), true).u32(0);
      if (rec.start + 40 + n * 2 > dataEnd) run.stop(D.BadHeader, 'the description of EMR_COMMENT_BEGINGROUP runs past its comment', rec.loc);
      return;
    }
    case PUBLIC_ENDGROUP:
      return;
    case PUBLIC_MULTIFORMATS: {
      if (dataSize < 28) run.stop(D.BadHeader, 'EMR_COMMENT_MULTIFORMATS is cut short', rec.loc);
      const count = new View(await r.read(rec.start + 36, 4), true).u32(0);
      if (40 + count * 16 > 12 + dataSize) run.stop(D.BadHeader, `EMR_COMMENT_MULTIFORMATS lists ${count} formats it has no room for`, rec.loc);
      const table = new View(await r.read(rec.start + 40, count * 16), true);
      const files: Contained[] = [];
      for (let i = 0; i < count; i++) {
        const signature = table.u32(i * 16);
        const n = table.u32(i * 16 + 8);
        const off = table.u32(i * 16 + 12);
        // Offsets count from the comment identifier, 12 bytes into the record.
        const start = rec.start + 12 + off;
        if (off % 4 !== 0 || off < 28 + count * 16 || start + n > dataEnd) run.stop(D.BadHeader, `format ${i} of EMR_COMMENT_MULTIFORMATS lies outside its comment`, rec.loc);
        if (n === 0) continue;
        files.push(await run.contained(`${rec.loc}, format ${i}`, 'multiformats data', start, n, FORMAT_TYPES.get(signature), true, Number.POSITIVE_INFINITY, { replaceable: false }));
      }
      // Viewers draw the records, not this comment, so the rewrite can drop it.
      run.droppableRange(rec.start, rec.end);
      plan.actions.push({ kind: 'files', rec, files });
      return;
    }
    case PUBLIC_WINDOWS_METAFILE: {
      if (dataSize < 24) run.stop(D.BadHeader, 'EMR_COMMENT_WINDOWS_METAFILE is cut short', rec.loc);
      const n = new View(await r.read(rec.start + 32, 4), true).u32(0);
      if (rec.start + 36 + n > dataEnd) run.stop(D.BadHeader, 'the metafile in EMR_COMMENT_WINDOWS_METAFILE runs past its comment', rec.loc);
      if (n === 0) return;
      // The record's checksum covers the metafile in a way [MS-EMF] does not give, so a rewritten copy cannot go in.
      const file = await run.contained(rec.loc, 'embedded metafile', rec.start + 36, n, 'image/wmf', true, Number.POSITIVE_INFINITY, { replaceable: false });
      run.droppableRange(rec.start, rec.end);
      plan.actions.push({ kind: 'files', rec, files: [file] });
      return;
    }
    default:
      return extra(`a public comment of type 0x${kind.toString(16)}`);
  }
}

/** Checks the bitmaps of a record that holds them, and hands a JPEG or PNG one to the file plugins. */
async function bitmaps(run: Run, plan: EmfPlan, rec: Rec): Promise<void> {
  const spec = BITMAPS.get(rec.type);
  if (!spec) return;
  const size = rec.end - rec.start;
  if (size < spec.fixed) run.stop(D.BadHeader, `${spec.name} is ${size} bytes, shorter than its ${spec.fixed}-byte fixed part`, rec.loc);
  const v = new View(await run.reader.read(rec.start, spec.fixed), true);
  const files: Contained[] = [];
  const one = async (usageAt: number, fieldsAt: number, which: string) => {
    const offBmi = v.u32(fieldsAt);
    const cbBmi = v.u32(fieldsAt + 4);
    const offBits = v.u32(fieldsAt + 8);
    const cbBits = v.u32(fieldsAt + 12);
    if (cbBmi === 0) return;
    const loc = `${rec.loc}, ${which} bitmap`;
    if (offBmi < spec.fixed || offBits < spec.fixed || offBmi + cbBmi > size || offBits + cbBits > size) run.stop(D.BadHeader, `the ${which} bitmap lies outside its record`, loc);
    if (offBmi < offBits + cbBits && offBits < offBmi + cbBmi) run.stop(D.Overlap, `the ${which} bitmap's header and bits share bytes`, loc);
    const b: MetafileBitmap = { bmi: rec.start + offBmi, bmiLength: cbBmi, bits: rec.start + offBits, bitsLength: cbBits, usage: v.u32(usageAt), loc };
    if (spec.scans !== undefined && which === 'source') b.scans = v.u32(spec.scans);
    const file = await metafileBitmap(run, b);
    if (file && file.bitsLength > 0) files.push(await run.contained(loc, 'bitmap', file.bits, file.bitsLength, file.declared, true, Number.POSITIVE_INFINITY, { replaceable: false }));
  };
  await one(spec.usage, spec.src, 'source');
  if (spec.mask !== undefined && spec.maskUsage !== undefined) await one(spec.maskUsage, spec.mask, 'mask');
  if (files.length) plan.actions.push({ kind: 'files', rec, files });
}

/** Reports a color space or ICM profile record that names a profile file to load. */
async function profiles(run: Run, plan: EmfPlan, rec: Rec): Promise<void> {
  const size = rec.end - rec.start;
  const link = (target: string) => {
    run.droppableRange(rec.start, rec.end);
    return run.report(C.External, D.LinkedProfile, rec.loc, { target });
  };
  if (rec.type === EMR_CREATECOLORSPACE || rec.type === EMR_CREATECOLORSPACEW) {
    // A LogColorSpace or LogColorSpaceW ([MS-WMF] 2.2.2.11, 2.2.2.12) after ihCS, its file name at offset 68.
    const wide = rec.type === EMR_CREATECOLORSPACEW;
    const nameLength = wide ? 520 : 260;
    if (size < 12 + 68 + nameLength) run.stop(D.BadHeader, 'a color space record is cut short', rec.loc);
    const name = wide ? await utf16(run, rec.start + 80, nameLength) : await ascii(run, rec.start + 80, nameLength);
    if (name) plan.actions.push({ kind: 'colorspace', rec, findings: [link(name)], typeAt: rec.start + 24, nameAt: rec.start + 80, nameLength });
    return;
  }
  // EMR_SETICMPROFILEA, EMR_SETICMPROFILEW and EMR_COLORMATCHTOTARGETW: a name, then the profile when it is embedded.
  const at = rec.type === EMR_COLORMATCHTOTARGETW ? 16 : 12;
  if (size < at + 8) run.stop(D.BadHeader, 'an ICM profile record is cut short', rec.loc);
  const v = new View(await run.reader.read(rec.start + at, 8), true);
  const cbName = v.u32(0);
  const cbData = v.u32(4);
  if (at + 8 + cbName + cbData > size) run.stop(D.BadHeader, 'the profile name and data run past their record', rec.loc);
  if (cbName === 0 || cbData > 0) return;
  const name = rec.type === EMR_SETICMPROFILEA ? await ascii(run, rec.start + at + 8, cbName) : await utf16(run, rec.start + at + 8, cbName);
  if (name) plan.actions.push({ kind: 'optional', rec, findings: [link(name)] });
}

/**
 * Inspects an EMF file ([MS-EMF]): the header record and every record's type and size up to EMR_EOF, which must come
 * last, bitmaps inside records, escapes, profile files records name, and comments, EMF+ records included. The drawing
 * records are not interpreted. Bytes after EMR_EOF are trailing data.
 */
export async function inspectEmf(run: Run): Promise<EmfPlan> {
  const r = run.reader;
  const size = run.size;
  if (size < 88) run.stop(D.Truncated, 'the header record is cut short', 'header');
  const h = new View(await r.read(0, 108), true);
  const headerSize = h.u32(4);
  const hloc = 'EMR_HEADER at 0';
  if (headerSize < 88 || headerSize % 4 !== 0 || headerSize > size) run.stop(D.BadHeader, `the header record is ${headerSize} bytes`, hloc);
  const nBytes = h.u32(48);
  const nRecords = h.u32(52);
  const nDescription = h.u32(60);
  const offDescription = h.u32(64);
  // The fixed part ends where the first variable field starts, and is 88, 100 or 108 bytes ([MS-EMF] 2.3.4.2).
  let fixed = headerSize;
  if (nDescription && offDescription >= 88 && offDescription < fixed) fixed = offDescription;
  if (fixed >= 100) {
    const offPixelFormat = h.u32(92);
    if (h.u32(88) && offPixelFormat >= 88 && offPixelFormat < fixed) fixed = offPixelFormat;
  }
  if (fixed >= 100) {
    const cbPixelFormat = h.u32(88);
    const offPixelFormat = h.u32(92);
    if ((cbPixelFormat || offPixelFormat) && (cbPixelFormat !== 40 || offPixelFormat < 100 || offPixelFormat + cbPixelFormat > headerSize)) {
      run.stop(D.BadHeader, 'the pixel format descriptor lies outside the header record', hloc);
    }
    if (h.u32(96) > 1) run.stop(D.BadHeader, `bOpenGL is ${h.u32(96)}`, hloc);
  }
  const plan: EmfPlan = { end: 0, records: 0, actions: [], comments: [], images: [] };
  // Without both a length and an offset there is no description ([MS-EMF] 2.3.4.2.1).
  if (nDescription && offDescription) {
    const start = offDescription;
    const length = nDescription * 2;
    if (start < 88 || start + length > headerSize) {
      plan.description = { findings: [run.malformed(hloc, 0, 0, 'the description lies outside the header record')], start: 0, length: 0 };
    } else {
      plan.description = { findings: [run.metadata(D.Text, hloc, start, start + length, { keyword: 'description' })], start, length };
    }
  }
  // The picture's size: its frame, in 0.01 mm, at the reference device's resolution.
  const frameWidth = Math.abs(h.i32(32) - h.i32(24));
  const frameHeight = Math.abs(h.i32(36) - h.i32(28));
  const perMm = (px: number, mm: number) => (px > 0 && mm > 0 ? px / mm : 96 / 25.4);
  const width = Math.round((frameWidth / 100) * perMm(h.i32(72), h.i32(80)));
  const height = Math.round((frameHeight / 100) * perMm(h.i32(76), h.i32(84)));
  run.image(width, height, width * height * 4, hloc);

  const open: { current?: Open } = {};
  let p = 0;
  let count = 0;
  let eofStart = -1;
  for (;;) {
    run.time();
    if (p + 8 > size) run.stop(D.Truncated, 'the file ends before EMR_EOF', `offset ${p}`);
    const v = new View(await r.read(p, 8), true);
    const type = v.u32(0);
    const recSize = v.u32(4);
    const rec: Rec = { type, start: p, end: p + recSize, loc: `record ${count} at ${p}` };
    if (recSize < 8 || recSize % 4 !== 0) run.stop(D.BadHeader, `a record of ${recSize} bytes`, rec.loc);
    if (rec.end > size) run.stop(D.Truncated, 'a record runs past the end of the file', rec.loc);
    run.block();
    count++;
    if (count === 1 && type !== EMR_HEADER) run.stop(D.BadLayout, 'the file does not start with EMR_HEADER', rec.loc);
    if (count > 1 && type === EMR_HEADER) run.stop(D.BadLayout, 'a second EMR_HEADER', rec.loc);
    if (type === EMR_EOF) {
      if (open.current) run.stop(D.BadData, 'a continued EMF+ object ends before its total size', rec.loc);
      if (recSize < 20) run.stop(D.BadHeader, `EMR_EOF is ${recSize} bytes`, rec.loc);
      const e = new View(await r.read(p + 8, 8), true);
      const nPal = e.u32(0);
      const offPal = e.u32(4);
      if (nPal && (offPal < 16 || offPal + nPal * 4 > recSize - 4)) run.stop(D.BadHeader, 'the palette of EMR_EOF lies outside it', rec.loc);
      eofStart = p;
      p = rec.end;
      break;
    }
    if (count > 1) {
      if (!known(type)) {
        run.droppableRange(rec.start, rec.end);
        plan.actions.push({ kind: 'optional', rec, findings: [run.report(C.Structure, D.ExtraBlock, rec.loc, { block: `record of type ${hex(type)}` })] });
      } else if (type === EMR_COMMENT) await commentRecord(run, plan, rec, open);
      else if (ESCAPES.has(type)) {
        run.droppableRange(rec.start, rec.end);
        plan.actions.push({ kind: 'optional', rec, findings: [run.report(C.Content, D.Escape, rec.loc, { escape: ESCAPES.get(type) ?? '' })] });
      } else if (type === EMR_CREATECOLORSPACE || type === EMR_CREATECOLORSPACEW || type === EMR_SETICMPROFILEA || type === EMR_SETICMPROFILEW || type === EMR_COLORMATCHTOTARGETW) {
        await profiles(run, plan, rec);
      } else await bitmaps(run, plan, rec);
    }
    p = rec.end;
  }
  plan.end = p;
  plan.records = count;
  // A reader that trusts the header stops at nBytes or after nRecords records, before EMR_EOF, and draws less. The
  // rewrite writes both counts again, so a count that falls short is a strip finding. One that only overstates is
  // corrected with nothing to report.
  if (nBytes < eofStart) run.report(C.Structure, D.HeaderCount, hloc, { reason: `the header gives ${nBytes} bytes and the records run to ${p}` });
  else if (nRecords < count - 1) run.report(C.Structure, D.HeaderCount, hloc, { reason: `the header gives ${nRecords} records and the file holds ${count}` });
  await run.gap(p, size, 'trailing');
  return plan;
}

/** A source over [offset, offset + length) of another. */
const subSource = (s: ByteSource, offset: number, length: number): ByteSource => ({
  size: async () => length,
  read: (o, n) => s.read(offset + o, Math.min(n, length - o)),
});

const le16 = (n: number) => u16(n, true);
const le32 = (n: number) => u32(n, true);

/** The EMF+ object records for an image a plugin rewrote: one record, or parts of PART bytes as GDI+ writes them. */
async function objectRecords(run: Run, image: PlusImage): Promise<Piece[]> {
  const c = image.contained;
  if (!c.replacement) return [];
  const n = c.replacement.length;
  const source = run.replacementSource(c);
  // The headers come from the first part, which holds them all, and a metafile's size is written again.
  const first = image.parts[0];
  const header = Uint8Array.from(await run.reader.read(first.dataStart, image.headerLength));
  if (header.length !== image.headerLength) throw new Error('the EMF+ image headers span parts');
  if (image.metafile) new DataView(header.buffer).setUint32(12, n, true);
  const total = image.headerLength + n;
  const zeros = (k: number) => bytes(new Uint8Array(k));
  // The data size is the object's exact length, so a reader takes the file without the padding that aligns the record.
  if (total <= PART + 4) {
    const pad = (4 - (total % 4)) % 4;
    return [bytes(le16(EMFPLUS_OBJECT)), bytes(le16(image.flags & 0x7fff)), bytes(le32(12 + total + pad)), bytes(le32(total)), bytes(header), { kind: 'source', source, length: n }, zeros(pad)];
  }
  const out: Piece[] = [];
  for (let at = 0; at < total; at += PART) {
    const len = Math.min(PART, total - at);
    const pad = (4 - (len % 4)) % 4;
    out.push(bytes(le16(EMFPLUS_OBJECT)), bytes(le16(image.flags | 0x8000)), bytes(le32(16 + len + pad)), bytes(le32(4 + len)), bytes(le32(total)));
    // This part's bytes: some of the headers, then some of the file.
    const hs = Math.max(0, Math.min(len, image.headerLength - at));
    if (hs > 0) out.push(bytes(header.subarray(at, at + hs)));
    const fileStart = Math.max(0, at - image.headerLength);
    const fileLength = len - hs;
    if (fileLength > 0) out.push({ kind: 'source', source: subSource(source, fileStart, fileLength), length: fileLength });
    out.push(zeros(pad));
  }
  return out;
}

/**
 * The EMF as the rewrite writes it: every record up to EMR_EOF but those its findings remove, comments written again
 * without the EMF+ records that go and with the EMF+ image objects plugins rewrote, a description stripMetadata
 * blanks, color spaces that no longer name a file, and the header's byte and record counts written again.
 */
export async function emfPieces(run: Run, plan: EmfPlan): Promise<Piece[]> {
  const region = new Region(0, plan.end);
  let count = plan.records;
  const removed = new Set<number>();
  const removeRecord = (rec: Rec) => {
    if (removed.has(rec.start)) return;
    removed.add(rec.start);
    region.remove(rec.start, rec.end);
    count--;
  };
  for (const a of plan.actions) {
    run.time();
    if (a.kind === 'optional') {
      if (run.drops(a.findings, a.rec.start, a.rec.end)) removeRecord(a.rec);
    } else if (a.kind === 'files') {
      if (a.files.some(f => f.decision === 'drop') || run.drops([], a.rec.start, a.rec.end)) removeRecord(a.rec);
    } else if (run.drops(a.findings, a.rec.start, a.rec.end)) {
      // The color space stays, as sRGB, without the file name.
      region.patch(a.typeAt, 4, () => le32(LCS_SRGB));
      region.patch(a.nameAt, a.nameLength, () => new Uint8Array(a.nameLength));
    }
  }
  const d = plan.description;
  if (d && run.drops(d.findings, d.start, d.start + d.length)) {
    region.patch(60, 8, () => new Uint8Array(8));
    if (d.length) region.patch(d.start, d.length, () => new Uint8Array(d.length));
  }
  // EMF+ records that go, and image objects plugins rewrote, by the comment that holds them.
  const gone = new Set<number>();
  const inserted = new Map<number, PlusImage>();
  for (const c of plan.comments) for (const rec of c.records) if (run.drops(rec.findings, rec.start, rec.end)) gone.add(rec.start);
  for (const image of plan.images) {
    const decision = image.contained.decision;
    if (decision === 'keep') continue;
    for (const p of image.parts) gone.add(p.record.start);
    if (decision === 'replace') inserted.set(image.parts[0].record.start, image);
  }
  for (const c of plan.comments) {
    if (removed.has(c.rec.start) || !c.records.some(x => gone.has(x.start))) continue;
    const local = new Region(c.contentStart, c.contentEnd);
    for (const x of c.records) {
      if (!gone.has(x.start)) continue;
      const image = inserted.get(x.start);
      if (image) local.replace(x.start, x.end, await objectRecords(run, image));
      else local.remove(x.start, x.end);
    }
    const content = local.pieces();
    if (local.length === 0) {
      removeRecord(c.rec);
      continue;
    }
    const pad = (4 - (local.length % 4)) % 4;
    region.replace(c.rec.start, c.rec.end, [
      bytes(le32(EMR_COMMENT)),
      bytes(le32(16 + local.length + pad)),
      bytes(le32(4 + local.length)),
      bytes(le32(COMMENT_EMFPLUS)),
      ...content,
      ...(pad ? [bytes(new Uint8Array(pad))] : []),
    ]);
  }
  region.patch(48, 8, () => Buffer.concat([le32(region.length), le32(count)]));
  const pieces = region.pieces();
  return pieces.length ? pieces : [copy(0, plan.end)];
}
