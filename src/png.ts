import { clip, type Run } from './context';
import { crc32 } from './crc32';
import { type ExifPlan, exifPieces, inspectExif } from './exif';
import { InflateError, inflateChunks } from './inflate';
import { checkIcc, hasDoctype } from './metadata';
import { ascii, bytes, copy, crcEnd, crcStart, lengthOf, type Piece, u32 } from './rewrite';
import { allZero, bytesSlice, fileSlice, latin1, View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageFinding } from './types';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks read whole into memory up to this size. Larger ones are read in pieces. */
const SMALL = 1 << 20;

/** Channels per pixel, and the bit depths allowed, for each color type. */
const COLOR_TYPES = new Map<number, { channels: number; depths: number[] }>([
  [0, { channels: 1, depths: [1, 2, 4, 8, 16] }],
  [2, { channels: 3, depths: [8, 16] }],
  [3, { channels: 1, depths: [1, 2, 4, 8] }],
  [4, { channels: 2, depths: [8, 16] }],
  [6, { channels: 4, depths: [8, 16] }],
]);

/** Ancillary chunks a viewer uses, and where the specification places them. */
const PLACEMENT = new Map<string, 'beforePlte' | 'afterPlte' | 'beforeIdat'>([
  ['cHRM', 'beforePlte'],
  ['gAMA', 'beforePlte'],
  ['iCCP', 'beforePlte'],
  ['sRGB', 'beforePlte'],
  ['sBIT', 'beforePlte'],
  ['cICP', 'beforePlte'],
  ['mDCV', 'beforeIdat'],
  ['cLLI', 'beforeIdat'],
  ['tRNS', 'afterPlte'],
  ['bKGD', 'afterPlte'],
  ['pHYs', 'beforeIdat'],
  ['acTL', 'beforeIdat'],
]);

/** Ancillary chunks the specification allows once. */
const UNIQUE = new Set(['cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'tRNS', 'pHYs', 'tIME', 'acTL', 'eXIf', 'cICP', 'mDCV', 'cLLI']);

const FIXED_LENGTHS = new Map<string, number>([
  ['gAMA', 4],
  ['cHRM', 32],
  ['sRGB', 1],
  ['pHYs', 9],
  ['cICP', 4],
  ['mDCV', 24],
  ['cLLI', 8],
]);

interface Header {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: number;
  channels: number;
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** The rows the decoded data holds, each as its byte count without the filter byte, pass by pass for Adam7. */
function* rowsOf(h: Header, width: number, height: number): Generator<number> {
  const bits = h.depth * h.channels;
  if (h.interlace === 0) {
    const n = Math.ceil((width * bits) / 8);
    for (let y = 0; y < height; y++) yield n;
    return;
  }
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (pw === 0 || ph === 0) continue;
    const n = Math.ceil((pw * bits) / 8);
    for (let y = 0; y < ph; y++) yield n;
  }
}

/** The exact number of bytes the image data inflates to: a filter byte and the packed samples of each row. */
function decodedSize(h: Header, width: number, height: number): number {
  const bits = h.depth * h.channels;
  if (h.interlace === 0) return height * (1 + Math.ceil((width * bits) / 8));
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (pw && ph) total += ph * (1 + Math.ceil((pw * bits) / 8));
  }
  return total;
}

interface Chunk {
  type: string;
  /** File offsets of the length field, the data and the end, after the CRC. */
  start: number;
  data: number;
  length: number;
  end: number;
}

/** A frame's compressed data: the file ranges of its chunks' data, each [start, length], without fdAT sequence numbers. */
interface Stream {
  label: string;
  width: number;
  height: number;
  chunks: Chunk[];
  /** Bytes to skip at the start of each chunk's data: 4 for fdAT. */
  skip: number;
  /** Bytes of compressed data up to the end of the zlib stream, once decoded. The rewrite drops the rest. */
  consumed?: number;
}

/**
 * A chunk as the rewrite sees it. keep: written as it is. optional: written unless its findings or a signature in it
 * remove it. frame: an fcTL, written with the next sequence number. stream: an IDAT or fdAT, cut at the end of its
 * zlib stream.
 */
interface PlannedChunk {
  chunk: Chunk;
  role: 'keep' | 'optional' | 'frame' | 'stream';
  findings: Array<DefuseFinding | undefined>;
  stream?: Stream;
  exif?: { plan: ExifPlan; skip: number };
}

export interface PngPlan {
  chunks: PlannedChunk[];
}

export interface PngOptions {
  /** Put before every location, such as the icon an embedded PNG sits in. */
  prefix: string;
  /** What bytes after IEND are: trailing data for a whole file, hidden data inside an ICO entry. */
  afterEnd: 'trailing' | 'hidden';
}

/** Inspects the PNG at [start, end) of the file. */
export async function inspectPng(run: Run, start: number, end: number, o: PngOptions): Promise<{ width: number; height: number; frames: number; plan: PngPlan }> {
  const r = run.reader;
  const at = (what: string, offset: number) => `${o.prefix}${what} at ${offset}`;
  const sig = await r.read(start, 8);
  if (sig.length < 8 || !SIGNATURE.every((b, i) => sig[i] === b)) run.stop(D.BadHeader, 'the PNG signature is missing', at('signature', start));

  let pos = start + 8;
  let header: Header | undefined;
  let paletteEntries = 0;
  let sawPlte = false;
  let idatState: 'before' | 'in' | 'after' = 'before';
  const idat: Chunk[] = [];
  const seen = new Map<string, number>();
  let animation: { frames: number } | undefined;
  let sequence = 0;
  let fctls = 0;
  let frames = 0;
  let pending: Stream | undefined;
  let ended = false;
  const plan: PngPlan = { chunks: [] };
  let idatStream: Stream | undefined;

  /** Whether a chunk's CRC matches, reading its data in pieces so a large chunk costs little memory. */
  const crcMatches = async (c: Chunk): Promise<boolean> => {
    let crc = 0;
    for await (const piece of r.chunks(c.start + 4, 4 + c.length)) {
      run.time();
      crc = crc32(piece, crc);
    }
    return crc === new View(await r.read(c.data + c.length, 4)).u32(0);
  };

  const readCrc = async (c: Chunk): Promise<void> => {
    if (!(await crcMatches(c))) run.stop(D.BadChecksum, `the ${c.type} chunk's CRC does not match`, at(`${c.type} chunk`, c.start));
  };

  /** Inflates one frame's data and checks it against the size the header gives. */
  const decode = async (s: Stream): Promise<void> => {
    if (!header) return;
    const h = header;
    const expected = decodedSize(h, s.width, s.height);
    run.image(s.width, s.height, expected, s.label);
    frames++;
    // The filter byte of each row sits at nextFilter. `row` is the length of the row it starts.
    const rows = rowsOf(h, s.width, s.height);
    let row = rows.next();
    let nextFilter = row.done ? Number.POSITIVE_INFINITY : 0;
    let decoded = 0;
    let badFilter: number | undefined;
    const onData = (piece: Uint8Array) => {
      const base = decoded;
      decoded += piece.length;
      while (nextFilter < decoded && badFilter === undefined) {
        const b = piece[nextFilter - base];
        if (b > 4) badFilter = b;
        nextFilter += 1 + (row.done ? 0 : row.value);
        row = rows.next();
        if (row.done) nextFilter = Number.POSITIVE_INFINITY;
      }
    };
    let consumed = 0;
    let total = 0;
    // Chunks whose CRC has been checked. Inflation can end before the last chunk, and the rest are checked after.
    let checked = 0;
    async function* input(): AsyncGenerator<Uint8Array> {
      for (const c of s.chunks) {
        await readCrc(c);
        checked++;
        for await (const piece of r.chunks(c.data + s.skip, c.length - s.skip)) yield piece;
      }
    }
    for (const c of s.chunks) total += c.length - s.skip;
    try {
      const done = await inflateChunks(
        input(),
        expected,
        piece => {
          onData(piece);
          if (badFilter !== undefined) throw new InflateError('corrupt', `a row has the filter type ${badFilter}`);
        },
        run.deadline,
      );
      consumed = done.consumed;
      s.consumed = consumed;
      if (done.produced !== expected) run.stop(D.BadData, `the image data inflates to ${done.produced} bytes, not ${expected}`, s.label);
    } catch (e) {
      if (!(e instanceof InflateError)) throw e;
      run.stop(D.BadData, e.kind === 'over' ? `the image data inflates past ${expected} bytes` : `the image data does not inflate: ${e.message}`, s.label);
    }
    for (const c of s.chunks.slice(checked)) await readCrc(c);
    if (consumed < total) {
      // Compressed bytes past the stream's end. Zero bytes there are padding.
      let skipped = 0;
      let nonZero = false;
      const ranges: Array<[number, number]> = [];
      for (const c of s.chunks) {
        const n = c.length - s.skip;
        const from = Math.max(0, consumed - skipped);
        if (from < n) {
          ranges.push([c.data + s.skip + from, c.data + c.length]);
          for await (const piece of r.chunks(c.data + s.skip + from, n - from)) if (!allZero(piece)) nonZero = true;
        }
        skipped += n;
      }
      if (nonZero) {
        for (const [a, b] of ranges) run.droppableRange(a, b);
        run.report(C.Structure, D.HiddenData, s.label, { bytes: total - consumed, reason: 'compressed bytes after the end of the zlib stream' });
      }
    }
  };

  const finishFrame = async (): Promise<void> => {
    if (!pending) return;
    const s = pending;
    pending = undefined;
    if (!s.chunks.length) run.stop(D.BadLayout, 'an APNG frame has no fdAT data', s.label);
    await decode(s);
  };

  while (!ended) {
    run.time();
    if (pos + 8 > end) run.stop(D.Truncated, pos >= end ? 'the PNG ends before IEND' : 'a chunk header is cut short', `${o.prefix}offset ${pos}`);
    const hv = new View(await r.read(pos, 8));
    const length = hv.u32(0);
    const type = hv.ascii(4, 4);
    const c: Chunk = { type, start: pos, data: pos + 8, length, end: pos + 12 + length };
    const loc = at(`${/^[\x20-\x7e]{4}$/.test(type) ? type : 'unnamed'} chunk`, pos);
    if (length > 0x7fffffff) run.stop(D.BadLayout, 'a chunk is longer than 2^31 - 1 bytes', loc);
    if (!/^[A-Za-z]{4}$/.test(type)) run.stop(D.BadLayout, 'a chunk type is not four letters', loc);
    if (type.charCodeAt(2) >= 0x61) run.stop(D.BadLayout, `the ${type} chunk has the reserved bit set`, loc);
    if (c.end > end) run.stop(D.Truncated, `the ${type} chunk runs past the end of the file`, loc);
    run.block();
    const critical = type.charCodeAt(0) < 0x61;
    const count = (seen.get(type) ?? 0) + 1;
    seen.set(type, count);

    if (!header && type !== 'IHDR') run.stop(D.BadLayout, 'the first chunk is not IHDR', loc);
    // The IDAT run is decoded at IEND, once the walk has seen whether it is unbroken.
    if (type !== 'IDAT' && idatState === 'in') idatState = 'after';
    if (type !== 'fdAT' && type !== 'IEND' && type !== 'fcTL' && pending?.chunks.length) {
      // A frame's data ends at the first chunk that is not fdAT.
      await finishFrame();
    }
    // A chunk read whole for its value. Larger chunks are checked in pieces.
    let data: Uint8Array | undefined;
    let badCrc = false;
    const entry: PlannedChunk = { chunk: c, role: 'keep', findings: [] };
    const optional = (...findings: Array<DefuseFinding | undefined>) => {
      entry.role = 'optional';
      entry.findings.push(...findings);
    };
    if (type !== 'IDAT' && type !== 'fdAT') {
      let matches: boolean;
      if (length <= SMALL) {
        const whole = await r.read(c.start + 4, 4 + length);
        matches = crc32(whole) === new View(await r.read(c.data + length, 4)).u32(0);
        data = whole.subarray(4);
      } else {
        matches = await crcMatches(c);
      }
      if (!matches) {
        // A critical chunk with a bad CRC means the image itself is corrupt, so the run stops. An ancillary chunk
        // with a bad CRC is dropped instead, which is what libpng warns-and-skips and image-png's default
        // skip_ancillary_crc_failures do, so a stale CRC on metadata does not reject the file.
        if (critical) run.stop(D.BadChecksum, `the ${type} chunk's CRC does not match`, loc);
        optional(run.extra(loc, c.start, c.end, { block: `${type} chunk`, reason: 'its CRC does not match' }));
        badCrc = true;
      }
    }
    const extra = (reason: string) => optional(run.extra(loc, c.start, c.end, { block: `${type} chunk`, reason }));

    if (!badCrc)
      switch (type) {
        case 'IHDR': {
          if (count > 1) run.stop(D.BadLayout, 'IHDR appears twice', loc);
          if (length !== 13 || !data) run.stop(D.BadHeader, 'IHDR is not 13 bytes', loc);
          const v = new View(data ?? new Uint8Array(13));
          const width = v.u32(0);
          const height = v.u32(4);
          const depth = v.u8(8);
          const colorType = v.u8(9);
          const ct = COLOR_TYPES.get(colorType);
          if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) run.stop(D.BadHeader, `the image is ${width} x ${height}`, loc);
          if (!ct?.depths.includes(depth)) run.stop(D.BadHeader, `color type ${colorType} with bit depth ${depth}`, loc);
          if (v.u8(10) !== 0 || v.u8(11) !== 0 || v.u8(12) > 1) run.stop(D.BadHeader, 'IHDR names a compression, filter or interlace method PNG does not define', loc);
          header = { width, height, depth, colorType, interlace: v.u8(12), channels: ct?.channels ?? 1 };
          if (run.images === 0 && run.width === 0) {
            run.width = width;
            run.height = height;
          }
          break;
        }
        case 'PLTE': {
          const h = header as Header;
          if (count > 1) run.stop(D.BadLayout, 'PLTE appears twice', loc);
          if (idatState !== 'before') run.stop(D.BadLayout, 'PLTE comes after IDAT', loc);
          if (h.colorType === 0 || h.colorType === 4) run.stop(D.BadLayout, `a color type ${h.colorType} image has a palette`, loc);
          paletteEntries = length / 3;
          if (length % 3 !== 0 || paletteEntries < 1 || paletteEntries > 256 || (h.colorType === 3 && paletteEntries > 2 ** h.depth)) run.stop(D.BadHeader, `PLTE holds ${length} bytes`, loc);
          sawPlte = true;
          break;
        }
        case 'IDAT': {
          const h = header as Header;
          if (idatState === 'after') run.stop(D.BadLayout, 'IDAT chunks are not consecutive', loc);
          if (h.colorType === 3 && !sawPlte) run.stop(D.BadLayout, 'a palette image has no PLTE before IDAT', loc);
          if (idatState === 'before' && pending) {
            // The first fcTL came before IDAT, so IDAT is frame 0.
            pending = undefined;
          }
          idatState = 'in';
          idat.push(c);
          idatStream ??= { label: at('IDAT chunk', c.start), width: h.width, height: h.height, chunks: idat, skip: 0 };
          entry.role = 'stream';
          entry.stream = idatStream;
          break;
        }
        case 'IEND': {
          if (length !== 0) run.stop(D.BadHeader, 'IEND is not empty', loc);
          if (idatState === 'before') run.stop(D.BadLayout, 'the PNG has no IDAT', loc);
          await finishFrame();
          const h = header as Header;
          await decode(idatStream ?? { label: at('IDAT chunk', idat[0].start), width: h.width, height: h.height, chunks: idat, skip: 0 });
          if (animation && fctls !== animation.frames) run.stop(D.BadLayout, `acTL gives ${animation.frames} frames and the file has ${fctls}`, loc);
          ended = true;
          break;
        }
        case 'acTL':
        case 'fcTL':
        case 'fdAT': {
          const h = header as Header;
          if (type === 'acTL') {
            if (count > 1) {
              optional(run.report(C.Structure, D.Ambiguous, loc, { reason: 'acTL appears twice' }));
              break;
            }
            if (idatState !== 'before') {
              extra('acTL after IDAT');
              break;
            }
            if (length !== 8 || !data) run.stop(D.BadHeader, 'acTL is not 8 bytes', loc);
            const n = new View(data ?? new Uint8Array(8)).u32(0);
            if (n === 0) run.stop(D.BadHeader, 'acTL gives 0 frames', loc);
            animation = { frames: n };
            break;
          }
          if (!animation) {
            extra(`${type} without acTL`);
            break;
          }
          if (type === 'fcTL') {
            if (length !== 26 || !data) run.stop(D.BadHeader, 'fcTL is not 26 bytes', loc);
            const v = new View(data ?? new Uint8Array(26));
            if (v.u32(0) !== sequence) run.stop(D.BadLayout, `fcTL has the sequence number ${v.u32(0)} where ${sequence} belongs`, loc);
            sequence++;
            const fw = v.u32(4);
            const fh = v.u32(8);
            const fx = v.u32(12);
            const fy = v.u32(16);
            if (fw === 0 || fh === 0 || fx + fw > h.width || fy + fh > h.height) run.stop(D.BadLayout, 'an APNG frame lies outside the canvas', loc);
            if (v.u8(24) > 2 || v.u8(25) > 1) run.stop(D.BadHeader, 'fcTL names a dispose or blend operation APNG does not define', loc);
            if (idatState === 'before' && (fctls > 0 || fw !== h.width || fh !== h.height || fx !== 0 || fy !== 0)) run.stop(D.BadLayout, 'the fcTL before IDAT does not cover the whole canvas', loc);
            await finishFrame();
            fctls++;
            // A frame before IDAT takes IDAT as its data. Any other frame needs fdAT chunks.
            pending = { label: loc, width: fw, height: fh, chunks: [], skip: 4 };
            entry.role = 'frame';
            break;
          }
          // fdAT
          if (length < 4) run.stop(D.BadHeader, 'fdAT is shorter than its sequence number', loc);
          if (idatState === 'before' || !pending) run.stop(D.BadLayout, 'fdAT comes before its frame control chunk', loc);
          const seq = new View(await r.read(c.data, 4)).u32(0);
          if (seq !== sequence) run.stop(D.BadLayout, `fdAT has the sequence number ${seq} where ${sequence} belongs`, loc);
          sequence++;
          pending?.chunks.push(c);
          entry.role = 'stream';
          entry.stream = pending;
          break;
        }
        case 'iCCP':
        case 'tEXt':
        case 'zTXt':
        case 'iTXt':
        case 'eXIf':
        case 'tIME':
        case 'caBX': {
          if (UNIQUE.has(type) && count > 1) optional(run.report(C.Structure, D.Ambiguous, loc, { reason: `${type} appears twice` }));
          if (type === 'iCCP' && !placed(type, sawPlte, idatState, (header as Header).colorType)) {
            extra('out of place');
            break;
          }
          const m = await metadataChunk(run, c, data, loc);
          optional(...m.findings);
          if (m.exif) entry.exif = m.exif;
          break;
        }
        default: {
          if (critical) run.stop(D.BadLayout, `the critical chunk ${type} is unknown`, loc);
          const place = PLACEMENT.get(type);
          if (!place) {
            extra('a chunk viewers do not use');
            break;
          }
          if (UNIQUE.has(type) && count > 1) {
            optional(run.report(C.Structure, D.Ambiguous, loc, { reason: `${type} appears twice` }));
            break;
          }
          if (!placed(type, sawPlte, idatState, (header as Header).colorType)) {
            extra('out of place');
            break;
          }
          const why = invalid(type, length, data, header as Header, paletteEntries);
          if (why) extra(why);
        }
      }
    plan.chunks.push(entry);
    pos = c.end;
  }
  await run.gap(pos, end, o.afterEnd);
  return { width: header?.width ?? 0, height: header?.height ?? 0, frames, plan };
}

/** Whether an ancillary chunk sits where the specification places it. */
function placed(type: string, sawPlte: boolean, idatState: 'before' | 'in' | 'after', colorType: number): boolean {
  const place = PLACEMENT.get(type);
  if (!place) return true;
  if (idatState !== 'before') return false;
  if (place === 'beforePlte') return !sawPlte;
  // A palette image has PLTE, and these chunks refer to it.
  if (place === 'afterPlte' && colorType === 3) return sawPlte;
  return true;
}

/** Why a viewer would ignore an ancillary chunk's value, or undefined when it is valid. */
function invalid(type: string, length: number, data: Uint8Array | undefined, h: Header, paletteEntries: number): string | undefined {
  const fixed = FIXED_LENGTHS.get(type);
  if (fixed !== undefined && length !== fixed) return `${type} has the length ${length}, not ${fixed}`;
  if (type === 'sRGB' && data && data[0] > 3) return 'sRGB names an unknown rendering intent';
  if (type === 'pHYs' && data && data[8] > 1) return 'pHYs names an unknown unit';
  if (type === 'tRNS') {
    if (h.colorType === 4 || h.colorType === 6) return 'tRNS in an image with an alpha channel';
    const want = h.colorType === 0 ? 2 : h.colorType === 2 ? 6 : undefined;
    if (want !== undefined && length !== want) return `tRNS has the length ${length}, not ${want}`;
    if (h.colorType === 3 && (length === 0 || length > paletteEntries)) return 'tRNS has more entries than the palette';
  }
  if (type === 'bKGD') {
    const want = h.colorType === 3 ? 1 : h.colorType === 2 || h.colorType === 6 ? 6 : 2;
    if (length !== want) return `bKGD has the length ${length}, not ${want}`;
  }
  if (type === 'sBIT') {
    const want = h.colorType === 0 ? 1 : h.colorType === 4 ? 2 : h.colorType === 6 ? 4 : 3;
    if (length !== want) return `sBIT has the length ${length}, not ${want}`;
  }
  return undefined;
}

const RAW_PROFILE = /^Raw profile type (exif|app1|iptc|8bim|xmp|icc|icm)$/i;

/** Reports a metadata chunk: iCCP, a text chunk, eXIf, tIME or caBX. Returns the findings that name the chunk, and an eXIf chunk's EXIF block. */
async function metadataChunk(run: Run, c: Chunk, data: Uint8Array | undefined, loc: string): Promise<{ findings: ImageFinding[]; exif?: { plan: ExifPlan; skip: number } }> {
  const r = run.reader;
  if (c.type === 'eXIf') {
    let skip = 0;
    const head = await r.read(c.data, Math.min(6, c.length));
    if (latin1(head) === 'Exif\0\0') skip = 6;
    const plan = await inspectExif(run, fileSlice(r, c.data + skip, c.length - skip), loc, c.start, c.end);
    return { findings: [], exif: { plan, skip } };
  }
  if (c.type === 'tIME') {
    if (c.length !== 7) return { findings: [run.malformed(loc, c.start, c.end, 'tIME is not 7 bytes')] };
    return { findings: [run.metadata(D.Other, loc, c.start, c.end, { kind: 'modification time' })] };
  }
  if (c.type === 'caBX') return { findings: [run.metadata(D.Other, loc, c.start, c.end, { kind: 'C2PA content credentials' })] };
  const malformed = (why: string) => ({ findings: [run.malformed(loc, c.start, c.end, why)] });
  // iCCP and text chunks start with a keyword of 1 to 79 Latin-1 bytes and a NUL.
  const head = data ?? (await r.read(c.data, Math.min(c.length, 300)));
  const nul = head.indexOf(0);
  if (nul < 1 || nul > 79) return malformed(`the ${c.type} keyword is missing or longer than 79 bytes`);
  const keyword = latin1(head.subarray(0, nul));
  const body = (from: number) => fileSlice(r, c.data + from, c.length - from);
  if (c.type === 'iCCP') {
    if (head[nul + 1] !== 0) return malformed('iCCP names a compression method PNG does not define');
    const profile = await inflateMetadata(run, body(nul + 2), loc, c);
    if (typeof profile === 'string') return malformed(profile);
    const why = await checkIcc(bytesSlice(profile));
    if (why) return malformed(why);
    return { findings: [run.metadata(D.IccProfile, loc, c.start, c.end, { name: clip(keyword, 79), bytes: profile.length })] };
  }
  let text: { compressed: boolean; from: number };
  if (c.type === 'tEXt') text = { compressed: false, from: nul + 1 };
  else if (c.type === 'zTXt') {
    if (head[nul + 1] !== 0) return malformed('zTXt names a compression method PNG does not define');
    text = { compressed: true, from: nul + 2 };
  } else {
    // iTXt: a compression flag and method, then a language tag and a translated keyword, each ending in NUL.
    const flag = head[nul + 1];
    const method = head[nul + 2];
    const lang = head.indexOf(0, nul + 3);
    const translated = lang < 0 ? -1 : head.indexOf(0, lang + 1);
    if (flag > 1 || method !== 0 || translated < 0) return malformed('iTXt breaks its layout');
    text = { compressed: flag === 1, from: translated + 1 };
  }
  const raw = RAW_PROFILE.exec(keyword)?.[1].toLowerCase();
  const xmp = keyword === 'XML:com.adobe.xmp';
  let inflated: Uint8Array | undefined;
  if (text.compressed) {
    const done = await inflateMetadata(run, body(text.from), loc, c);
    if (typeof done === 'string') return malformed(done);
    inflated = done;
  }
  if (xmp) {
    const chunks = inflated ? bytesSlice(inflated).chunks() : body(text.from).chunks();
    const found = [run.metadata(D.Xmp, loc, c.start, c.end)];
    if (await hasDoctype(chunks)) found.push(run.report(C.Metadata, D.Doctype, loc));
    return { findings: found };
  }
  if (raw === 'exif' || raw === 'app1') return { findings: [run.metadata(D.Exif, loc, c.start, c.end, { keyword })] };
  if (raw === 'iptc' || raw === '8bim') return { findings: [run.metadata(D.Iptc, loc, c.start, c.end, { keyword })] };
  if (raw === 'xmp') return { findings: [run.metadata(D.Xmp, loc, c.start, c.end, { keyword })] };
  if (raw === 'icc' || raw === 'icm') return { findings: [run.metadata(D.IccProfile, loc, c.start, c.end, { keyword })] };
  return { findings: [run.metadata(D.Text, loc, c.start, c.end, { keyword: clip(keyword, 79) })] };
}

/** Inflates a compressed metadata value up to the metadata size limit. Returns why it is malformed, as a string, when it does not inflate. */
async function inflateMetadata(run: Run, slice: ReturnType<typeof fileSlice>, loc: string, c: Chunk): Promise<Uint8Array | string> {
  const pieces: Uint8Array[] = [];
  try {
    const done = await inflateChunks(slice.chunks(), run.limits.metadataBytes, piece => pieces.push(piece), run.deadline);
    if (done.consumed < slice.size) return `${c.type} holds bytes after its compressed text`;
  } catch (e) {
    if (!(e instanceof InflateError)) throw e;
    if (e.kind === 'over') run.limit(D.MetadataSize, `${loc} inflates past ${run.limits.metadataBytes} bytes`, { limit: run.limits.metadataBytes });
    return `${c.type} does not inflate: ${e.message}`;
  }
  return Buffer.concat(pieces);
}

/** A chunk of `type` holding the pieces, with its length and CRC. */
function chunkPieces(type: string, data: Piece[]): Piece[] {
  return [bytes(u32(lengthOf(data))), crcStart, bytes(ascii(type)), ...data, crcEnd];
}

/**
 * The PNG as the rewrite writes it: the signature, then each chunk the plan keeps. IDAT and fdAT data is cut at the
 * end of its zlib stream, an fdAT or fcTL takes the next sequence number when a chunk before it went, and the CRC of
 * every chunk that changed is computed again.
 */
export async function pngPieces(run: Run, plan: PngPlan): Promise<Piece[]> {
  const out: Piece[] = [bytes(Uint8Array.from(SIGNATURE))];
  const r = run.reader;
  let sequence = 0;
  const passed = new Map<Stream, number>();
  for (const e of plan.chunks) {
    run.time();
    const c = e.chunk;
    switch (e.role) {
      case 'keep':
        out.push(copy(c.start, c.end - c.start));
        break;
      case 'optional': {
        if (e.exif) {
          const tiff = await exifPieces(run, e.exif.plan, e.findings, c.start, c.end);
          if (tiff) out.push(...chunkPieces('eXIf', e.exif.skip ? [copy(c.data, e.exif.skip), ...tiff] : tiff));
        } else if (!run.drops(e.findings, c.start, c.end)) out.push(copy(c.start, c.end - c.start));
        break;
      }
      case 'frame': {
        const data = Uint8Array.from(await r.read(c.data, c.length));
        const v = new DataView(data.buffer);
        if (v.getUint32(0) === sequence) out.push(copy(c.start, c.end - c.start));
        else {
          v.setUint32(0, sequence);
          out.push(...chunkPieces(c.type, [bytes(data)]));
        }
        sequence++;
        break;
      }
      default: {
        const s = e.stream;
        if (!s) break;
        const before = passed.get(s) ?? 0;
        const n = c.length - s.skip;
        passed.set(s, before + n);
        const consumed = s.consumed ?? before + n;
        // A chunk that holds only bytes after the end of the stream goes.
        if (before >= consumed) break;
        const keep = Math.min(n, consumed - before);
        if (s.skip === 0) {
          out.push(...(keep === n ? [copy(c.start, c.end - c.start)] : chunkPieces(c.type, [copy(c.data, keep)])));
          break;
        }
        const seq = new View(await r.read(c.data, 4)).u32(0);
        if (keep === n && seq === sequence) out.push(copy(c.start, c.end - c.start));
        else out.push(...chunkPieces(c.type, [bytes(u32(sequence)), copy(c.data + 4, keep)]));
        sequence++;
      }
    }
  }
  return out;
}
