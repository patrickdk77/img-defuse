import type { Run } from './context';
import { type ExifPlan, exifPieces, inspectExif } from './exif';
import { checkIcc, hasDoctype } from './metadata';
import { ascii, bytes, copy, lengthOf, type Piece, u32 } from './rewrite';
import { fileSlice, latin1, View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';
import { checkVp8l } from './vp8l';

const ICC_FLAG = 0x20;
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;
const ANIMATION_FLAG = 0x02;

interface Chunk {
  id: string;
  start: number;
  data: number;
  size: number;
  /** After the padding byte. */
  end: number;
  loc: string;
}

/**
 * A chunk as the rewrite sees it. keep: written as it is. optional: written unless its findings or a signature in it
 * remove it. frame: an ANMF chunk, written with the chunks inside it the rewrite keeps.
 */
type Item =
  | { kind: 'keep'; c: Chunk }
  | { kind: 'optional'; c: Chunk; findings: Array<DefuseFinding | undefined>; exif?: { plan: ExifPlan; skip: number } }
  | { kind: 'frame'; c: Chunk; inner: Item[] };

export interface WebpPlan {
  /** The VP8X chunk of an extended file. */
  vp8x?: Chunk;
  items: Item[];
}

/** Reads the width and height from a VP8 or VP8L chunk's header. */
async function imageSize(run: Run, c: Chunk): Promise<{ width: number; height: number }> {
  const v = new View(await run.reader.read(c.data, Math.min(c.size, 10)), true);
  if (c.id === 'VP8 ') {
    if (c.size < 10) run.stop(D.Truncated, 'the VP8 header is cut short', c.loc);
    const tag = v.u24(0);
    if (tag & 1) run.stop(D.BadHeader, 'the VP8 data is not a key frame', c.loc);
    if (((tag >> 1) & 7) > 3) run.stop(D.BadHeader, 'the VP8 data has an unknown version', c.loc);
    if (!((tag >> 4) & 1)) run.stop(D.BadHeader, 'the VP8 frame is not shown', c.loc);
    if (tag >> 5 > c.size - 10) run.stop(D.Truncated, 'the first VP8 partition runs past its chunk', c.loc);
    if (v.u8(3) !== 0x9d || v.u8(4) !== 0x01 || v.u8(5) !== 0x2a) run.stop(D.BadHeader, 'the VP8 start code is missing', c.loc);
    const width = v.u16(6) & 0x3fff;
    const height = v.u16(8) & 0x3fff;
    if (width === 0 || height === 0) run.stop(D.BadHeader, `the VP8 image is ${width} x ${height}`, c.loc);
    return { width, height };
  }
  if (c.size < 5) run.stop(D.Truncated, 'the VP8L header is cut short', c.loc);
  if (v.u8(0) !== 0x2f) run.stop(D.BadHeader, 'the VP8L signature is missing', c.loc);
  const bits = v.u32(1);
  if (bits >>> 29 !== 0) run.stop(D.BadHeader, `the VP8L data has the version ${bits >>> 29}`, c.loc);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/**
 * Refuses a lossless image stream, at [start, start + length) of the file, that libwebp would refuse: its transforms,
 * color cache and prefix codes, read as libwebp reads them. This is where CVE-2023-4863 lived.
 */
async function checkLossless(run: Run, start: number, length: number, width: number, height: number, loc: string): Promise<void> {
  const why = await checkVp8l(
    (o, n) => run.reader.read(start + o, Math.min(n, length - o)),
    length,
    width,
    height,
    () => run.time(),
  );
  if (why) run.stop(D.BadData, why, loc);
}

/** Checks an ALPH chunk against the size of the image that follows it, and its lossless stream when it has one. */
async function checkAlpha(run: Run, c: Chunk, width: number, height: number): Promise<void> {
  if (c.size < 1) run.stop(D.Truncated, 'the ALPH chunk is empty', c.loc);
  const b = (await run.reader.read(c.data, 1))[0];
  if ((b & 3) > 1 || ((b >> 4) & 3) > 1 || b >> 6 !== 0) run.stop(D.BadHeader, 'the ALPH header names an unknown method', c.loc);
  if ((b & 3) === 0 && c.size - 1 !== width * height) run.stop(D.BadData, `uncompressed alpha holds ${c.size - 1} bytes for ${width * height} pixels`, c.loc);
  if ((b & 3) === 1) await checkLossless(run, c.data + 1, c.size - 1, width, height, c.loc);
}

export async function inspectWebp(run: Run): Promise<WebpPlan> {
  const r = run.reader;
  const size = run.size;
  const riffEnd = 8 + new View(await r.read(4, 4), true).u32(0);
  if (riffEnd > size) run.stop(D.Truncated, `the RIFF size runs ${riffEnd - size} bytes past the end of the file`, 'RIFF header');

  const read = async (p: number, end: number, where: string): Promise<Chunk> => {
    if (p + 8 > end) run.stop(D.Truncated, 'a chunk header is cut short', `${where} at ${p}`);
    const h = new View(await r.read(p, 8), true);
    const id = h.ascii(0, 4);
    const csize = h.u32(4);
    const loc = `${where === 'offset' ? '' : `${where}, `}${id.replace(/[^\x20-\x7e]/g, '?')} chunk at ${p}`;
    const c: Chunk = { id, start: p, data: p + 8, size: csize, end: p + 8 + csize + (csize & 1), loc };
    if (c.end > end) run.stop(D.Truncated, `the ${id} chunk runs past the RIFF data`, loc);
    run.block();
    if (csize & 1) {
      const pad = (await r.read(p + 8 + csize, 1))[0];
      if (pad !== 0) {
        run.droppableRange(p + 8 + csize, c.end);
        run.report(C.Structure, D.HiddenData, loc, { bytes: 1, reason: 'a padding byte that is not 0' });
      }
    }
    return c;
  };

  const chunks: Chunk[] = [];
  for (let p = 12; p < riffEnd; ) {
    run.time();
    const c = await read(p, riffEnd, 'offset');
    chunks.push(c);
    p = c.end;
  }
  if (!chunks.length) run.stop(D.BadLayout, 'the WebP file has no chunks', 'RIFF header');
  const first = chunks[0];
  const plan: WebpPlan = { items: [] };
  const items = plan.items;
  const optional = (c: Chunk, ...findings: Array<DefuseFinding | undefined>): Item => ({ kind: 'optional', c, findings });

  if (first.id === 'VP8 ' || first.id === 'VP8L') {
    const { width, height } = await imageSize(run, first);
    run.image(width, height, width * height * 4, first.loc);
    if (first.id === 'VP8L') await checkLossless(run, first.data + 5, first.size - 5, width, height, first.loc);
    items.push({ kind: 'keep', c: first });
    for (const c of chunks.slice(1)) items.push(optional(c, run.extra(c.loc, c.start, c.end, { block: `${c.id} chunk`, reason: 'a chunk after the image in a simple WebP file' })));
  } else if (first.id === 'VP8X') {
    plan.vp8x = first;
    if (first.size < 10) run.stop(D.BadHeader, 'VP8X is shorter than 10 bytes', first.loc);
    const v = new View(await r.read(first.data, 10), true);
    const flags = v.u8(0);
    const canvasWidth = v.u24(4) + 1;
    const canvasHeight = v.u24(7) + 1;
    if (canvasWidth * canvasHeight > 0xffffffff) run.stop(D.BadHeader, `the canvas is ${canvasWidth} x ${canvasHeight}`, first.loc);
    if (canvasWidth * canvasHeight > run.limits.pixels)
      run.limit(D.Pixels, `${canvasWidth} x ${canvasHeight} pixels at the canvas`, { width: canvasWidth, height: canvasHeight, limit: run.limits.pixels });
    run.width = canvasWidth;
    run.height = canvasHeight;
    const animated = (flags & ANIMATION_FLAG) !== 0;
    const seen = new Map<string, number>();
    let images = 0;
    let alpha: Chunk | undefined;
    let alphaItem: Item | undefined;
    for (const c of chunks.slice(1)) {
      const n = (seen.get(c.id) ?? 0) + 1;
      seen.set(c.id, n);
      if (alpha && c.id !== 'VP8 ' && c.id !== 'VP8L') run.stop(D.BadLayout, 'ALPH is not followed by image data', alpha.loc);
      switch (c.id) {
        case 'VP8 ':
        case 'VP8L': {
          if (animated) run.stop(D.BadLayout, `an animated WebP has a ${c.id} chunk outside its frames`, c.loc);
          if (++images > 1) run.stop(D.BadLayout, 'a still WebP has a second image', c.loc);
          const { width, height } = await imageSize(run, c);
          if (width !== canvasWidth || height !== canvasHeight) run.stop(D.BadLayout, `the image is ${width} x ${height} and the canvas ${canvasWidth} x ${canvasHeight}`, c.loc);
          run.image(width, height, width * height * 4, c.loc);
          if (c.id === 'VP8L') await checkLossless(run, c.data + 5, c.size - 5, width, height, c.loc);
          if (alpha) {
            if (c.id === 'VP8 ') await checkAlpha(run, alpha, width, height);
            else if (alphaItem)
              Object.assign(alphaItem, optional(alpha, run.extra(alpha.loc, alpha.start, alpha.end, { block: 'ALPH chunk', reason: 'alpha before lossless data, which carries its own' })));
            alpha = undefined;
          }
          items.push({ kind: 'keep', c });
          break;
        }
        case 'ALPH':
          if (animated) run.stop(D.BadLayout, 'an animated WebP has an ALPH chunk outside its frames', c.loc);
          alpha = c;
          alphaItem = { kind: 'keep', c };
          items.push(alphaItem);
          break;
        case 'ANIM': {
          if (!animated) run.stop(D.BadLayout, 'ANIM appears without the animation flag', c.loc);
          const twice = n > 1 ? run.report(C.Structure, D.Ambiguous, c.loc, { reason: 'ANIM appears twice' }) : undefined;
          if (c.size < 6) run.stop(D.BadHeader, 'ANIM is shorter than 6 bytes', c.loc);
          items.push(twice ? optional(c, twice) : { kind: 'keep', c });
          break;
        }
        case 'ANMF': {
          if (!animated) run.stop(D.BadLayout, 'ANMF appears without the animation flag', c.loc);
          if (!seen.has('ANIM')) run.stop(D.BadLayout, 'ANMF comes before ANIM', c.loc);
          if (c.size < 16) run.stop(D.BadHeader, 'ANMF is shorter than 16 bytes', c.loc);
          const f = new View(await r.read(c.data, 16), true);
          const x = f.u24(0) * 2;
          const y = f.u24(3) * 2;
          const width = f.u24(6) + 1;
          const height = f.u24(9) + 1;
          if (x + width > canvasWidth || y + height > canvasHeight) run.stop(D.BadLayout, 'an animation frame lies outside the canvas', c.loc);
          run.image(width, height, width * height * 4, c.loc);
          images++;
          let frameAlpha: Chunk | undefined;
          let frameAlphaItem: Item | undefined;
          let frameImage = false;
          const inner: Item[] = [];
          for (let p = c.data + 16; p < c.data + c.size; ) {
            const s = await read(p, c.data + c.size, c.loc);
            p = s.end;
            if (s.id === 'ALPH' && !frameImage && !frameAlpha) {
              frameAlpha = s;
              frameAlphaItem = { kind: 'keep', c: s };
              inner.push(frameAlphaItem);
            } else if ((s.id === 'VP8 ' || s.id === 'VP8L') && !frameImage) {
              frameImage = true;
              const dims = await imageSize(run, s);
              if (dims.width !== width || dims.height !== height) run.stop(D.BadLayout, `a frame's image is ${dims.width} x ${dims.height} where the frame is ${width} x ${height}`, s.loc);
              if (s.id === 'VP8L') await checkLossless(run, s.data + 5, s.size - 5, width, height, s.loc);
              if (frameAlpha) {
                if (s.id === 'VP8 ') await checkAlpha(run, frameAlpha, width, height);
                else if (frameAlphaItem)
                  Object.assign(
                    frameAlphaItem,
                    optional(frameAlpha, run.extra(frameAlpha.loc, frameAlpha.start, frameAlpha.end, { block: 'ALPH chunk', reason: 'alpha before lossless data, which carries its own' })),
                  );
              }
              inner.push({ kind: 'keep', c: s });
            } else if (s.id === 'ALPH' || s.id === 'VP8 ' || s.id === 'VP8L') run.stop(D.BadLayout, `an animation frame has a second ${s.id} chunk`, s.loc);
            else inner.push(optional(s, run.extra(s.loc, s.start, s.end, { block: `${s.id} chunk`, reason: 'an unknown chunk in a frame' })));
          }
          if (!frameImage) run.stop(D.BadLayout, 'an animation frame has no image data', c.loc);
          items.push({ kind: 'frame', c, inner });
          break;
        }
        case 'ICCP': {
          if (n > 1) {
            items.push(optional(c, run.report(C.Structure, D.Ambiguous, c.loc, { reason: 'ICCP appears twice' })));
            break;
          }
          const why = await checkIcc(fileSlice(r, c.data, c.size));
          items.push(optional(c, why ? run.malformed(c.loc, c.start, c.end, why) : run.metadata(D.IccProfile, c.loc, c.start, c.end, { bytes: c.size })));
          break;
        }
        case 'EXIF': {
          const twice = n > 1 ? run.report(C.Structure, D.Ambiguous, c.loc, { reason: 'EXIF appears twice' }) : undefined;
          const skip = latin1(await r.read(c.data, Math.min(6, c.size))) === 'Exif\0\0' ? 6 : 0;
          const exif = await inspectExif(run, fileSlice(r, c.data + skip, c.size - skip), c.loc, c.start, c.end);
          items.push({ kind: 'optional', c, findings: [twice], exif: { plan: exif, skip } });
          break;
        }
        case 'XMP ': {
          const twice = n > 1 ? run.report(C.Structure, D.Ambiguous, c.loc, { reason: 'XMP appears twice' }) : undefined;
          const xmp = run.metadata(D.Xmp, c.loc, c.start, c.end, { bytes: c.size });
          const doctype = (await hasDoctype(fileSlice(r, c.data, c.size).chunks())) ? run.report(C.Metadata, D.Doctype, c.loc) : undefined;
          items.push(optional(c, twice, xmp, doctype));
          break;
        }
        default:
          items.push(optional(c, run.extra(c.loc, c.start, c.end, { block: `${c.id.replace(/[^\x20-\x7e]/g, '?')} chunk` })));
      }
    }
    if (alpha) run.stop(D.BadLayout, 'ALPH is not followed by image data', alpha.loc);
    if (animated && !seen.has('ANIM')) run.stop(D.BadLayout, 'the animation flag is set and ANIM is missing', first.loc);
    if (images === 0) run.stop(D.BadLayout, 'the WebP file has no image data', first.loc);
    const flagged = (flag: number, id: string, what: string) => {
      if (((flags & flag) !== 0) !== seen.has(id)) run.report(C.Structure, D.Ambiguous, first.loc, { reason: `the ${what} flag disagrees with the chunks present` });
    };
    flagged(ICC_FLAG, 'ICCP', 'ICC');
    flagged(EXIF_FLAG, 'EXIF', 'EXIF');
    flagged(XMP_FLAG, 'XMP ', 'XMP');
  } else {
    run.stop(D.BadLayout, `the first chunk is ${first.id}, not VP8, VP8L or VP8X`, first.loc);
  }
  await run.gap(riffEnd, size, 'trailing');
  return plan;
}

const le32 = (n: number) => u32(n, true);

/** A chunk of `id` holding the pieces, with its size and a zero padding byte when the size is odd. */
function chunkPieces(id: string, data: Piece[]): Piece[] {
  const n = lengthOf(data);
  return [bytes(ascii(id)), bytes(le32(n)), ...data, ...(n & 1 ? [bytes(new Uint8Array(1))] : [])];
}

/**
 * The WebP as the rewrite writes it: a new RIFF header, a VP8X whose ICC, EXIF and XMP flags match the chunks kept,
 * and every chunk the plan keeps, each padded with a zero byte. An ANMF frame is written with the chunks inside it the
 * rewrite keeps.
 */
export async function webpPieces(run: Run, plan: WebpPlan): Promise<Piece[]> {
  // The chunks the rewrite keeps at the top level, for the flags.
  const kept = new Set<string>();
  const write = async (items: Item[], top: boolean): Promise<Piece[]> => {
    const out: Piece[] = [];
    for (const it of items) {
      run.time();
      const c = it.c;
      const whole = () => chunkPieces(c.id, [copy(c.data, c.size)]);
      if (it.kind === 'keep') out.push(...whole());
      else if (it.kind === 'frame') out.push(...chunkPieces(c.id, [copy(c.data, 16), ...(await write(it.inner, false))]));
      else if (it.exif) {
        const tiff = await exifPieces(run, it.exif.plan, it.findings, c.start, c.end);
        if (tiff) {
          if (top) kept.add(c.id);
          out.push(...chunkPieces(c.id, it.exif.skip ? [copy(c.data, it.exif.skip), ...tiff] : tiff));
        }
      } else if (!run.drops(it.findings, c.start, c.end)) {
        if (top) kept.add(c.id);
        out.push(...whole());
      }
    }
    return out;
  };
  const body = await write(plan.items, true);
  if (plan.vp8x) {
    const head = Uint8Array.from(await run.reader.read(plan.vp8x.data, 10));
    // The alpha and animation flags stay. The reserved bits and bytes are written as zero.
    head[0] = (head[0] & (0x10 | ANIMATION_FLAG)) | (kept.has('ICCP') ? ICC_FLAG : 0) | (kept.has('EXIF') ? EXIF_FLAG : 0) | (kept.has('XMP ') ? XMP_FLAG : 0);
    head.fill(0, 1, 4);
    body.unshift(...chunkPieces('VP8X', [bytes(head)]));
  }
  return [bytes(ascii('RIFF')), bytes(le32(4 + lengthOf(body))), bytes(ascii('WEBP')), ...body];
}
