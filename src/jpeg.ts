import { type PhotoshopEdit, photoshopEdits } from './blocks';
import type { Contained, Run } from './context';
import { StopError } from './errors';
import { type ExifPlan, exifPieces, inspectExif } from './exif';
import { IfdError, IfdReader } from './ifd';
import { checkIcc, hasDoctype, photoshopResources } from './metadata';
import { bytes, copy, lazy, lengthOf, Mark, mark, type Piece, Region, RewriteError, u16 } from './rewrite';
import { fileSlice, joinedSlice, latin1, View } from './slice';
import { TiffRewrite, walkIfds } from './tiffedit';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageFinding } from './types';

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXTENSION_ID = 'http://ns.adobe.com/xmp/extension/\0';

/** Frame types read: baseline, extended, progressive and lossless, each with Huffman or arithmetic coding. */
const SOF = new Map<number, { progressive: boolean; lossless: boolean; precisions: number[] }>([
  [0xc0, { progressive: false, lossless: false, precisions: [8] }],
  [0xc1, { progressive: false, lossless: false, precisions: [8, 12] }],
  [0xc2, { progressive: true, lossless: false, precisions: [8, 12] }],
  [0xc3, { progressive: false, lossless: true, precisions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] }],
  [0xc9, { progressive: false, lossless: false, precisions: [8, 12] }],
  [0xca, { progressive: true, lossless: false, precisions: [8, 12] }],
  [0xcb, { progressive: false, lossless: true, precisions: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] }],
]);
const HIERARCHICAL = new Set([0xc5, 0xc6, 0xc7, 0xcd, 0xce, 0xcf, 0xde, 0xdf]);

const NAMES = new Map([
  [0xc4, 'DHT'],
  [0xcc, 'DAC'],
  [0xd8, 'SOI'],
  [0xd9, 'EOI'],
  [0xda, 'SOS'],
  [0xdb, 'DQT'],
  [0xdc, 'DNL'],
  [0xdd, 'DRI'],
  [0xfe, 'COM'],
]);

const markerName = (m: number): string => {
  if (m >= 0xe0 && m <= 0xef) return `APP${m - 0xe0}`;
  if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return `SOF${m - 0xc0}`;
  return NAMES.get(m) ?? `marker 0xFF${m.toString(16).toUpperCase().padStart(2, '0')}`;
};

interface Frame {
  progressive: boolean;
  lossless: boolean;
  precision: number;
  components: Map<number, number>;
}

interface Segment {
  marker: number;
  /** The first FF before the marker, fill bytes included. */
  start: number;
  /** The marker code itself, after its FF. */
  code: number;
  /** The payload, after the length field. */
  data: number;
  end: number;
  loc: string;
}

/** Findings that decide together for several segments, such as the pieces of one ICC profile. */
interface Group {
  findings: Array<DefuseFinding | undefined>;
}

/**
 * A part of the JPEG as the rewrite sees it. keep: a segment written as it is. scan: a scan header and its
 * entropy-coded data. segment: one its findings, a group's findings, or a signature in it can remove, with what the
 * rewrite needs to edit it.
 */
type Item =
  | { kind: 'keep'; seg: Segment }
  | { kind: 'scan'; seg: Segment; dataEnd: number }
  | {
      kind: 'segment';
      seg: Segment;
      findings: Array<DefuseFinding | undefined>;
      group?: Group;
      exif?: ExifPlan;
      jfifThumbnail?: ImageFinding;
      jfxx?: Contained;
      photoshop?: PhotoshopEdit[];
      mpf?: boolean;
    };

interface MpfImage {
  /** The image's place in the MP entry list, 0 being the primary image. */
  entry: number;
  start: number;
  end: number;
  finding: ImageFinding;
  contained: Contained;
}

export interface JpegPlan {
  items: Item[];
  mpf?: { seg: Segment; images: MpfImage[] };
}

/** The largest payload a JPEG segment can hold. */
const MAX_PAYLOAD = 65533;

/** A Buffer view of bytes, for indexOf. */
const buf = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export async function inspectJpeg(run: Run): Promise<JpegPlan> {
  const r = run.reader;
  const size = run.size;
  let pos = 2;
  let frame: Frame | undefined;
  const qtables = new Set<number>();
  let interval = 0;
  let scans = 0;
  let exifCount = 0;
  const icc: Array<{ seq: number; count: number; start: number; length: number; segment: Segment }> = [];
  const extended: Segment[] = [];
  let mpf: Segment | undefined;
  const items: Item[] = [];
  const iccGroup: Group = { findings: [] };
  const xmpGroup: Group = { findings: [] };
  let mpfItem: Item | undefined;

  /**
   * Finds the next marker from `p`: bytes before it other than fill are hidden data. Returns the marker, the offset of
   * its first FF, and the offset of the marker code after any fill bytes.
   */
  const nextMarker = async (p: number): Promise<{ marker: number; at: number; code: number }> => {
    let at = p;
    for (;;) {
      run.time();
      if (at >= size) run.stop(D.Truncated, 'the JPEG ends before EOI', `offset ${p}`);
      const window = await r.read(at, Math.min(65536, size - at));
      const ff = buf(window).indexOf(0xff);
      if (ff < 0) {
        at += window.length;
        continue;
      }
      let q = at + ff;
      // Skip fill bytes.
      let b = 0xff;
      while (b === 0xff) {
        q++;
        if (q >= size) run.stop(D.Truncated, 'the JPEG ends before EOI', `offset ${p}`);
        b = (await r.read(q, 1))[0];
      }
      if (b === 0x00) {
        // FF 00 outside a scan is not a marker.
        at = q + 1;
        continue;
      }
      await run.gap(p, at + ff, 'hidden');
      return { marker: b, at: at + ff, code: q };
    }
  };

  /** Reads entropy-coded data from `p` to the first marker that is not a restart marker. Returns the offset of that marker's first FF. */
  const scanData = async (p: number, loc: string): Promise<number> => {
    let afterFf = false;
    let ffStart = -1;
    let restart = 0;
    let base = p;
    for await (const chunk of r.chunks(p, size - p)) {
      run.time();
      const b = buf(chunk);
      let i = 0;
      while (i < b.length) {
        if (!afterFf) {
          const j = b.indexOf(0xff, i);
          if (j < 0) break;
          ffStart = base + j;
          afterFf = true;
          i = j + 1;
          continue;
        }
        const x = b[i];
        if (x === 0xff) {
          i++;
          continue;
        }
        afterFf = false;
        i++;
        if (x === 0x00) continue;
        if (x >= 0xd0 && x <= 0xd7) {
          if (interval === 0) run.stop(D.BadData, 'a restart marker appears without a restart interval', loc);
          if (x - 0xd0 !== restart % 8) run.stop(D.BadData, `restart marker ${x - 0xd0} appears where ${restart % 8} belongs`, loc);
          restart++;
          continue;
        }
        return ffStart;
      }
      base += chunk.length;
    }
    return run.stop(D.Truncated, 'the JPEG ends inside a scan', loc);
  };

  for (;;) {
    const { marker, at, code } = await nextMarker(pos);
    const name = markerName(marker);
    const loc = `${name} segment at ${at}`;
    run.block();
    if (marker === 0xd9) {
      if (!frame || scans === 0) run.stop(D.BadLayout, 'the JPEG ends before any image data', loc);
      pos = code + 1;
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) run.stop(D.BadLayout, `${name} outside image data`, loc);
    if (HIERARCHICAL.has(marker)) throw unsupported('hierarchical JPEG', loc);
    if (marker === 0xf7 || marker === 0xf8) throw unsupported('JPEG-LS', loc);
    if (code + 3 > size) run.stop(D.Truncated, `${name} is cut short`, loc);
    const length = new View(await r.read(code + 1, 2)).u16(0);
    if (length < 2) run.stop(D.BadLayout, `${name} has the length ${length}`, loc);
    const seg: Segment = { marker, start: at, code, data: code + 3, end: code + 1 + length, loc };
    if (seg.end > size) run.stop(D.Truncated, `${name} runs past the end of the file`, loc);
    const n = length - 2;
    pos = seg.end;

    if (SOF.has(marker)) {
      if (frame) run.stop(D.BadLayout, 'the JPEG has a second frame header', loc);
      const kind = SOF.get(marker) ?? { progressive: false, lossless: false, precisions: [8] };
      const v = new View(await r.read(seg.data, n));
      if (n < 6) run.stop(D.BadHeader, 'the frame header is cut short', loc);
      const precision = v.u8(0);
      const height = v.u16(1);
      const width = v.u16(3);
      const count = v.u8(5);
      if (n !== 6 + 3 * count) run.stop(D.BadHeader, 'the frame header length does not match its components', loc);
      if (!kind.precisions.includes(precision)) run.stop(D.BadHeader, `a ${name} frame has the precision ${precision}`, loc);
      if (height === 0) run.stop(D.BadHeader, 'the frame height is 0, which needs a DNL marker', loc);
      if (width === 0) run.stop(D.BadHeader, 'the frame width is 0', loc);
      if (count < 1 || count > 4) run.stop(D.BadHeader, `the frame has ${count} components`, loc);
      const components = new Map<number, number>();
      for (let i = 0; i < count; i++) {
        const id = v.u8(6 + i * 3);
        const hv = v.u8(7 + i * 3);
        const tq = v.u8(8 + i * 3);
        if (components.has(id)) run.stop(D.BadHeader, `component ${id} appears twice`, loc);
        if (hv >> 4 < 1 || hv >> 4 > 4 || (hv & 15) < 1 || (hv & 15) > 4) run.stop(D.BadHeader, `component ${id} has a sampling factor outside 1 to 4`, loc);
        if (tq > 3) run.stop(D.BadHeader, `component ${id} names quantization table ${tq}`, loc);
        components.set(id, tq);
      }
      frame = { progressive: kind.progressive, lossless: kind.lossless, precision, components };
      run.image(width, height, width * height * count * (precision > 8 ? 2 : 1), loc);
      items.push({ kind: 'keep', seg });
      continue;
    }
    switch (marker) {
      case 0xdb: {
        const v = new View(await r.read(seg.data, n));
        let p = 0;
        while (p < n) {
          const pq = v.u8(p) >> 4;
          const tq = v.u8(p) & 15;
          if (pq > 1 || tq > 3) run.stop(D.BadHeader, `a quantization table has precision ${pq} and id ${tq}`, loc);
          p += 1 + (pq ? 128 : 64);
          if (p > n) run.stop(D.BadHeader, 'a quantization table runs past its segment', loc);
          qtables.add(tq);
        }
        items.push({ kind: 'keep', seg });
        break;
      }
      case 0xc4: {
        const v = new View(await r.read(seg.data, n));
        let p = 0;
        while (p < n) {
          if (p + 17 > n) run.stop(D.BadHeader, 'a Huffman table runs past its segment', loc);
          const tc = v.u8(p) >> 4;
          const th = v.u8(p) & 15;
          if (tc > 1 || th > 3) run.stop(D.BadHeader, `a Huffman table has class ${tc} and id ${th}`, loc);
          let total = 0;
          let nextCode = 0;
          for (let l = 1; l <= 16; l++) {
            const count = v.u8(p + l);
            total += count;
            nextCode += count;
            // No code may be all ones, so the codes of each length must fit below 2^length.
            if (nextCode >= 2 ** l && count > 0) run.stop(D.BadHeader, 'a Huffman table holds more codes than its code lengths allow', loc);
            nextCode *= 2;
          }
          if (total > 256) run.stop(D.BadHeader, 'a Huffman table holds more than 256 symbols', loc);
          p += 17 + total;
          if (p > n) run.stop(D.BadHeader, 'a Huffman table runs past its segment', loc);
        }
        items.push({ kind: 'keep', seg });
        break;
      }
      case 0xdd: {
        if (n !== 2) run.stop(D.BadHeader, 'DRI is not 4 bytes', loc);
        interval = new View(await r.read(seg.data, 2)).u16(0);
        items.push({ kind: 'keep', seg });
        break;
      }
      case 0xcc:
        if (n % 2 !== 0) run.stop(D.BadHeader, 'DAC does not split into conditioning entries', loc);
        items.push({ kind: 'keep', seg });
        break;
      case 0xdc:
        run.stop(D.BadLayout, 'DNL appears, but the frame gives its height', loc);
        break;
      case 0xda: {
        if (!frame) run.stop(D.BadLayout, 'a scan comes before the frame header', loc);
        const f = frame as Frame;
        scans++;
        if (scans > run.limits.scans) run.limit(D.Scans, `more than ${run.limits.scans} scans`, { limit: run.limits.scans });
        const v = new View(await r.read(seg.data, n));
        const ns = n > 0 ? v.u8(0) : 0;
        if (ns < 1 || ns > 4 || n !== 4 + 2 * ns) run.stop(D.BadHeader, `the scan header names ${ns} components`, loc);
        const ss = v.u8(1 + ns * 2);
        const se = v.u8(2 + ns * 2);
        const ah = v.u8(3 + ns * 2) >> 4;
        const al = v.u8(3 + ns * 2) & 15;
        // The entropy tables the scan decodes with, as libjpeg picks them: a progressive DC refinement scan needs none.
        const usesDc = f.lossless || !f.progressive || (ss === 0 && ah === 0);
        const usesAc = !f.lossless && (!f.progressive || ss > 0);
        const inScan = new Set<number>();
        for (let i = 0; i < ns; i++) {
          const id = v.u8(1 + i * 2);
          const tq = f.components.get(id);
          if (tq === undefined || inScan.has(id)) run.stop(D.BadHeader, `the scan names component ${id} that the frame lacks, or twice`, loc);
          inScan.add(id);
          if (!qtables.has(tq ?? 0) && !f.lossless) run.stop(D.BadLayout, `quantization table ${tq} is used before it is defined`, loc);
          const td = v.u8(2 + i * 2) >> 4;
          const ta = v.u8(2 + i * 2) & 15;
          if ((usesDc && td > 3) || (usesAc && ta > 3)) run.stop(D.BadHeader, `the scan names ${usesDc && td > 3 ? `DC table ${td}` : `AC table ${ta}`}, where a JPEG has tables 0 to 3`, loc);
        }
        // A refinement scan adds one bit, so its Al is Ah - 1. libjpeg refuses any other pair.
        if (f.progressive && (ss > se || se > 63 || (ss === 0 && se !== 0) || (ss > 0 && ns !== 1) || ah > 13 || al > 13 || (ah !== 0 && al !== ah - 1)))
          run.stop(D.BadHeader, 'a progressive scan has parameters outside their range', loc);
        if (f.lossless && (ss < 1 || ss > 7 || se !== 0 || ah !== 0 || al >= f.precision)) run.stop(D.BadHeader, 'a lossless scan has parameters outside their range', loc);
        pos = await scanData(seg.end, loc);
        items.push({ kind: 'scan', seg, dataEnd: pos });
        break;
      }
      case 0xfe:
        items.push({ kind: 'segment', seg, findings: [run.metadata(D.Comment, loc, seg.start, seg.end, { bytes: n })] });
        break;
      default:
        if (marker >= 0xe0 && marker <= 0xef) {
          items.push(await app(seg, n));
          break;
        }
        run.stop(D.BadLayout, `${name} is not a marker JPEG defines here`, loc);
    }
  }

  /** Reports an APP segment by its identifier, and returns it as the rewrite sees it. */
  async function app(seg: Segment, n: number): Promise<Item> {
    const head = await r.read(seg.data, Math.min(n, 64));
    const id = latin1(head);
    const segment = (...findings: Array<DefuseFinding | undefined>): Item => ({ kind: 'segment', seg, findings });
    const extra = (reason: string) => segment(run.extra(seg.loc, seg.start, seg.end, { block: `${markerName(seg.marker)} segment`, reason }));
    const malformed = (why: string) => segment(run.malformed(seg.loc, seg.start, seg.end, why));
    // How many bytes the segment can grow by before it is too long for its length field.
    const room = MAX_PAYLOAD - n;
    switch (seg.marker) {
      case 0xe0:
        if (id.startsWith('JFIF\0')) {
          const v = new View(head);
          if (n < 14 || n < 14 + 3 * v.u8(12) * v.u8(13)) return malformed('the JFIF header is shorter than its thumbnail');
          if (v.u8(12) * v.u8(13) > 0) {
            return { kind: 'segment', seg, findings: [], jfifThumbnail: run.metadata(D.Thumbnail, seg.loc, seg.data + 14, seg.end, { format: 'raw' }) };
          }
          return { kind: 'keep', seg };
        }
        if (id.startsWith('JFXX\0') && n >= 6) {
          const code = head[5];
          if (code === 0x10) {
            const thumb = run.metadata(D.Thumbnail, seg.loc, seg.start, seg.end, { offset: seg.data + 6, bytes: n - 6 });
            const jfxx = await run.contained(seg.loc, 'JFXX thumbnail', seg.data + 6, n - 6, 'image/jpeg', run.keeps(thumb), n - 6 + room);
            return { kind: 'segment', seg, findings: [thumb], jfxx };
          }
          if (code === 0x11 || code === 0x13) return segment(run.metadata(D.Thumbnail, seg.loc, seg.start, seg.end, { format: 'raw' }));
          return malformed(`JFXX has the extension code ${code}`);
        }
        return extra('an APP0 segment other than JFIF');
      case 0xe1:
        if (id.startsWith('Exif\0')) {
          exifCount++;
          const second = exifCount > 1 ? run.report(C.Structure, D.Ambiguous, seg.loc, { reason: 'a second EXIF segment' }) : undefined;
          const exif = await inspectExif(run, fileSlice(r, seg.data + 6, n - 6), seg.loc, seg.start, seg.end, room);
          return { kind: 'segment', seg, findings: [second], exif };
        }
        if (id.startsWith(XMP_ID)) {
          const xmp = run.metadata(D.Xmp, seg.loc, seg.start, seg.end, { bytes: n - XMP_ID.length });
          const doctype = (await hasDoctype(fileSlice(r, seg.data + XMP_ID.length, n - XMP_ID.length).chunks())) ? run.report(C.Metadata, D.Doctype, seg.loc) : undefined;
          return segment(xmp, doctype);
        }
        if (id.startsWith(XMP_EXTENSION_ID)) {
          // A GUID, the full length and this piece's offset precede the data.
          if (n < XMP_EXTENSION_ID.length + 40) return malformed('an extended XMP segment is cut short');
          extended.push(seg);
          return { kind: 'segment', seg, findings: [run.metadata(D.Xmp, seg.loc, seg.start, seg.end, { bytes: n - XMP_EXTENSION_ID.length - 40, extended: 'yes' })], group: xmpGroup };
        }
        return extra('an APP1 segment other than EXIF or XMP');
      case 0xe2:
        if (id.startsWith('ICC_PROFILE\0') && n >= 14) {
          icc.push({ seq: head[12], count: head[13], start: seg.data + 14, length: n - 14, segment: seg });
          run.droppableRange(seg.start, seg.end);
          return { kind: 'segment', seg, findings: [], group: iccGroup };
        }
        if (id.startsWith('MPF\0')) {
          if (mpf) return segment(run.report(C.Structure, D.Ambiguous, seg.loc, { reason: 'a second MPF segment' }));
          mpf = seg;
          mpfItem = { kind: 'segment', seg, findings: [], mpf: true };
          return mpfItem;
        }
        if (id.startsWith('FPXR')) return segment(run.metadata(D.Other, seg.loc, seg.start, seg.end, { kind: 'FlashPix' }));
        return extra('an APP2 segment other than ICC, MPF or FlashPix');
      case 0xeb:
        if (id.startsWith('JP')) return segment(run.metadata(D.Other, seg.loc, seg.start, seg.end, { kind: 'JUMBF, such as C2PA content credentials' }));
        return extra('an APP11 segment other than JUMBF');
      case 0xec:
        if (id.startsWith('Ducky') || id.startsWith('[picture info]')) return segment(run.metadata(D.Other, seg.loc, seg.start, seg.end, { kind: id.startsWith('Ducky') ? 'Ducky' : 'picture info' }));
        return extra('an APP12 segment other than Ducky or picture info');
      case 0xed:
        if (id.startsWith('Photoshop 3.0\0')) {
          const block = run.metadata(D.Iptc, seg.loc, seg.start, seg.end, { bytes: n });
          const res = await photoshopResources(fileSlice(r, seg.data + 14, n - 14));
          if (typeof res === 'string') return segment(block, run.malformed(seg.loc, seg.start, seg.end, res));
          const photoshop: PhotoshopEdit[] = [];
          for (const t of res.thumbnails) {
            const at = seg.data + 14 + t.offset;
            const thumb = run.report(C.Metadata, D.Thumbnail, seg.loc, { offset: at, bytes: t.length });
            photoshop.push({ thumbnail: t, contained: await run.contained(seg.loc, 'Photoshop thumbnail', at, t.length, 'image/jpeg', run.keeps(block) && run.keeps(thumb), t.length + room) });
          }
          return { kind: 'segment', seg, findings: [block], photoshop };
        }
        return extra('an APP13 segment other than Photoshop resources');
      case 0xee:
        if (id.startsWith('Adobe') && n >= 12) return { kind: 'keep', seg };
        return extra('an APP14 segment other than Adobe');
      default:
        return extra(`an ${markerName(seg.marker)} segment`);
    }
  }

  // The ICC profile, split over APP2 segments numbered 1 to n.
  if (icc.length) {
    const first = icc[0].segment;
    const count = icc[0].count;
    const seqs = icc.map(c => c.seq).sort((a, b) => a - b);
    const ordered = count > 0 && icc.length === count && icc.every(c => c.count === count) && seqs.every((s, i) => s === i + 1);
    if (!ordered) iccGroup.findings.push(run.malformed(first.loc, first.start, first.end, 'the ICC profile chunks do not number 1 to n'));
    else {
      const parts = [...icc].sort((a, b) => a.seq - b.seq);
      const why = await checkIcc(
        joinedSlice(
          r,
          parts.map(part => [part.start, part.length]),
        ),
      );
      if (why) iccGroup.findings.push(run.malformed(first.loc, first.start, first.end, why));
      else iccGroup.findings.push(run.metadata(D.IccProfile, first.loc, first.start, first.end, { bytes: parts.reduce((t, part) => t + part.length, 0), segments: parts.length }));
    }
  }
  if (extended.length) {
    const skip = XMP_EXTENSION_ID.length + 40;
    if (
      await hasDoctype(
        joinedSlice(
          r,
          extended.map(s => [s.data + skip, s.end - s.data - skip]),
        ).chunks(),
      )
    )
      xmpGroup.findings.push(run.report(C.Metadata, D.Doctype, extended[0].loc));
  }

  // After EOI: the images an MPF index names, then gaps and trailing data.
  const eoiEnd = pos;
  const plan: JpegPlan = { items };
  if (mpf && mpfItem?.kind === 'segment') {
    const found = await mpfImages(run, mpf, eoiEnd);
    mpfItem.findings.push(...found.findings);
    plan.mpf = { seg: mpf, images: found.images };
  }
  let cursor = eoiEnd;
  for (const img of [...(plan.mpf?.images ?? [])].sort((a, b) => a.start - b.start)) {
    await run.gap(cursor, img.start, 'hidden');
    cursor = img.end;
  }
  await run.gap(cursor, size, 'trailing');
  return plan;
}

function unsupported(what: string, loc: string): Error {
  return new StopError(C.Format, D.Unsupported, `${what} is not read by this version`, { format: what }, loc);
}

/**
 * Reads the MPF index and reports the images it names after EOI. Returns the index's findings and the images, or no
 * images when the index is malformed.
 */
async function mpfImages(run: Run, seg: Segment, eoiEnd: number): Promise<{ findings: ImageFinding[]; images: MpfImage[] }> {
  const r = run.reader;
  const base = seg.data + 4;
  const index = run.metadata(D.Other, seg.loc, seg.start, seg.end, { kind: 'multi-picture index' });
  const found: Array<{ entry: number; start: number; end: number }> = [];
  try {
    const ifds = await IfdReader.open(fileSlice(r, base, seg.end - base));
    const ifd = await ifds.ifd(ifds.first);
    const entries = ifd.byTag.get(0xb002);
    if (!entries || entries.size % 16 !== 0) throw new IfdError(D.BadLayout, 'the MPF index has no image list');
    const v = new View(await ifds.slice.read(entries.at, entries.size), ifds.little);
    for (let i = 1; i < entries.size / 16; i++) {
      const length = v.u32(i * 16 + 4);
      const offset = v.u32(i * 16 + 8);
      const start = base + offset;
      if (length === 0 || offset === 0 || start < eoiEnd || start + length > run.size) throw new IfdError(D.Truncated, 'an MPF image lies outside the data after EOI');
      found.push({ entry: i, start, end: start + length });
    }
    const sorted = [...found].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) throw new IfdError(D.Overlap, 'two MPF images overlap');
    // The rewrite writes every offset of the index's IFD chain again, so each IFD in it must read.
    const seen = new Set([ifds.first]);
    for (let next = ifd.next; next; ) {
      if (seen.has(next)) throw new IfdError(D.Loop, `the IFD at ${next} is reached twice`);
      seen.add(next);
      next = (await ifds.ifd(next)).next;
    }
  } catch (e) {
    if (!(e instanceof IfdError)) throw e;
    return { findings: [index, run.malformed(seg.loc, seg.start, seg.end, `MPF: ${e.message}`)], images: [] };
  }
  const images: MpfImage[] = [];
  for (const img of [...found].sort((a, b) => a.start - b.start)) {
    const loc = `secondary image at ${img.start}`;
    const f = run.metadata(D.SecondaryImage, loc, img.start, img.end, { offset: img.start, bytes: img.end - img.start });
    images.push({ ...img, finding: f, contained: await run.contained(loc, 'secondary image', img.start, img.end - img.start, 'image/jpeg', run.keeps(index) && run.keeps(f)) });
  }
  return { findings: [index], images };
}

/** A segment of `marker` holding the payload, with its length field. */
function segmentPieces(marker: number, payload: Piece[]): Piece[] {
  const n = lengthOf(payload);
  if (n > MAX_PAYLOAD) throw new RewriteError(`a segment would hold ${n} bytes, more than its length field allows`);
  return [bytes(Uint8Array.of(0xff, marker)), bytes(u16(n + 2)), ...payload];
}

/** A segment as it is, without the fill bytes before it. */
const whole = (seg: Segment): Piece[] => [bytes(Uint8Array.of(0xff)), copy(seg.code, seg.end - seg.code)];

/**
 * The MPF index's TIFF structure for the images the rewrite keeps, in their entry order: the primary image, then each
 * kept secondary image with its new size and its offset from `header`, the mark at the structure's start. Dependent
 * image numbers follow the new order, and the image count and unique ID list match it.
 */
async function mpfPieces(run: Run, seg: Segment, kept: Array<{ img: MpfImage; at: Mark }>, header: Mark, primaryEnd: Mark): Promise<Piece[]> {
  const base = seg.data + 4;
  const r = await IfdReader.open(fileSlice(run.reader, base, seg.end - base));
  const ifds = await walkIfds(r, false);
  const t = new TiffRewrite(r, base, ifds);
  const ifd0 = ifds[0].ifd;
  const list = ifd0.byTag.get(0xb002);
  if (!list) throw new RewriteError('the MPF index has no image list');
  const total = list.size / 16;
  const order: Array<{ entry: number; img?: MpfImage; at?: Mark }> = [{ entry: 0 }, ...[...kept].sort((a, b) => a.img.entry - b.img.entry).map(k => ({ entry: k.img.entry, img: k.img, at: k.at }))];
  const renumbered = new Map(order.map((o, i) => [o.entry + 1, i + 1]));
  const original = Uint8Array.from(await r.slice.read(list.at, list.size));
  const little = r.little;
  t.replaceValue(
    list,
    [
      lazy(16 * order.length, () => {
        const src = new DataView(original.buffer);
        const b = new Uint8Array(16 * order.length);
        const v = new DataView(b.buffer);
        for (let i = 0; i < order.length; i++) {
          const o = order[i];
          const from = o.entry * 16;
          const size = o.img ? (o.img.contained.decision === 'replace' && o.img.contained.replacement ? o.img.contained.replacement.length : o.img.end - o.img.start) : primaryEnd.at;
          v.setUint32(i * 16, src.getUint32(from, little), little);
          v.setUint32(i * 16 + 4, size, little);
          v.setUint32(i * 16 + 8, o.at ? o.at.at - header.at : 0, little);
          v.setUint16(i * 16 + 12, renumbered.get(src.getUint16(from + 12, little)) ?? 0, little);
          v.setUint16(i * 16 + 14, renumbered.get(src.getUint16(from + 14, little)) ?? 0, little);
        }
        return b;
      }),
    ],
    16 * order.length,
  );
  const count = ifd0.byTag.get(0xb001);
  if (count) t.setValue(count, 0, order.length);
  const uids = ifd0.byTag.get(0xb003);
  if (uids && !uids.inline && uids.size === 33 * total) {
    t.replaceValue(
      uids,
      order.map(o => copy(base + uids.at + 33 * o.entry, 33)),
      33 * order.length,
    );
  }
  return t.pieces(false);
}

/**
 * The JPEG as the rewrite writes it: SOI, every segment the plan keeps with its fill bytes left out, each scan's
 * entropy-coded data unchanged, EOI, and the secondary images a kept MPF index names, with the index written again
 * for where they now sit.
 */
export async function jpegPieces(run: Run, plan: JpegPlan): Promise<Piece[]> {
  const out: Piece[] = [bytes(Uint8Array.of(0xff, 0xd8))];
  // A group goes as a whole, since an ICC profile is useless with a piece missing, and so is extended XMP.
  const groupDrops = new Map<Group, boolean>();
  for (const it of plan.items) {
    if (it.kind !== 'segment' || !it.group) continue;
    const d = run.drops([...it.group.findings, ...it.findings], it.seg.start, it.seg.end);
    groupDrops.set(it.group, groupDrops.get(it.group) === true || d);
  }
  const header = new Mark();
  const primaryEnd = new Mark();
  let secondary: Array<{ img: MpfImage; at: Mark }> = [];
  for (const it of plan.items) {
    run.time();
    if (it.kind === 'keep') {
      out.push(...whole(it.seg));
      continue;
    }
    if (it.kind === 'scan') {
      out.push(...whole(it.seg), copy(it.seg.end, it.dataEnd - it.seg.end));
      continue;
    }
    const seg = it.seg;
    if (it.exif) {
      const tiff = await exifPieces(run, it.exif, it.findings, seg.start, seg.end);
      if (tiff) out.push(...segmentPieces(seg.marker, [copy(seg.data, 6), ...tiff]));
      continue;
    }
    if (it.group ? groupDrops.get(it.group) === true : run.drops(it.findings, seg.start, seg.end)) continue;
    if (it.jfifThumbnail) {
      if (run.drops([it.jfifThumbnail], seg.data + 14, seg.end)) {
        // The JFIF header stays, as image structure, with a thumbnail of 0 x 0.
        const head = Uint8Array.from(await run.reader.read(seg.data, 14));
        head[12] = 0;
        head[13] = 0;
        out.push(...segmentPieces(seg.marker, [bytes(head)]));
      } else out.push(...whole(seg));
      continue;
    }
    if (it.jfxx) {
      const c = it.jfxx;
      if (c.decision === 'replace' && c.replacement) out.push(...segmentPieces(seg.marker, [copy(seg.data, 6), { kind: 'source', source: run.replacementSource(c), length: c.replacement.length }]));
      else if (c.decision === 'keep') out.push(...whole(seg));
      continue;
    }
    if (it.photoshop) {
      const region = new Region(seg.data + 14, seg.end);
      if (photoshopEdits(run, region, seg.data + 14, it.photoshop)) out.push(...segmentPieces(seg.marker, [copy(seg.data, 14), ...region.pieces()]));
      else out.push(...whole(seg));
      continue;
    }
    if (it.mpf && plan.mpf) {
      secondary = plan.mpf.images.filter(img => img.contained.decision !== 'drop' && !run.drops([img.finding], img.start, img.end)).map(img => ({ img, at: new Mark() }));
      out.push(...segmentPieces(seg.marker, [copy(seg.data, 4), mark(header), ...(await mpfPieces(run, plan.mpf.seg, secondary, header, primaryEnd))]));
      continue;
    }
    out.push(...whole(seg));
  }
  out.push(bytes(Uint8Array.of(0xff, 0xd9)), mark(primaryEnd));
  for (const { img, at } of secondary) {
    const c = img.contained;
    out.push(mark(at), c.decision === 'replace' && c.replacement ? { kind: 'source', source: run.replacementSource(c), length: c.replacement.length } : copy(img.start, img.end - img.start));
  }
  return out;
}
