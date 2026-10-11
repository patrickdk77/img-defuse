import type { Run } from './context';
import { LzwCounter } from './lzw';
import { checkIcc, hasDoctype } from './metadata';
import { bytes, copy, type Piece } from './rewrite';
import { fileSlice, joinedSlice, latin1, View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

/**
 * A block as the rewrite sees it. copy: written as it is. gce: a graphic control extension, which goes with a plain
 * text extension the rewrite drops, since it would otherwise apply to the next image. image: written with its LZW
 * data cut after the end code. optional: written unless its findings or a signature in it remove it.
 */
type Item =
  | { kind: 'copy'; start: number; end: number }
  | { kind: 'gce'; start: number; end: number }
  | { kind: 'image'; start: number; data: number; endAt?: number; end: number }
  | { kind: 'optional'; start: number; end: number; findings: Array<DefuseFinding | undefined>; plainText: boolean };

export interface GifPlan {
  items: Item[];
}

/** Application extensions viewers use: the loop count and buffering. */
const KEPT_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

export async function inspectGif(run: Run): Promise<GifPlan> {
  const r = run.reader;
  const size = run.size;
  if (size < 13) run.stop(D.Truncated, 'the screen descriptor is cut short', 'header');
  const sd = new View(await r.read(6, 7), true);
  const screenWidth = sd.u16(0);
  const screenHeight = sd.u16(2);
  const packed = sd.u8(4);
  if (screenWidth === 0 || screenHeight === 0) run.stop(D.BadHeader, `the logical screen is ${screenWidth} x ${screenHeight}`, 'screen descriptor at 6');
  if (screenWidth * screenHeight > run.limits.pixels)
    run.limit(D.Pixels, `${screenWidth} x ${screenHeight} pixels at the logical screen`, { width: screenWidth, height: screenHeight, limit: run.limits.pixels });
  run.width = screenWidth;
  run.height = screenHeight;
  const globalEntries = packed & 0x80 ? 2 ** ((packed & 7) + 1) : 0;
  let pos = 13 + globalEntries * 3;
  if (pos > size) run.stop(D.Truncated, 'the global color table is cut short', 'screen descriptor at 6');
  const items: Item[] = [{ kind: 'copy', start: 0, end: pos }];

  /** Walks sub-blocks from `p`, handing each one's data range to `each`. Returns the offset after the terminator. */
  const subBlocks = async (p: number, loc: string, each?: (start: number, data: Uint8Array) => void): Promise<number> => {
    let q = p;
    let count = 0;
    for (;;) {
      if ((++count & 1023) === 0) run.time();
      if (q >= size) run.stop(D.Truncated, 'the GIF ends inside a block', loc);
      const b = await r.read(q, 256);
      const n = b[0];
      if (n === 0) return q + 1;
      if (q + 1 + n > size) run.stop(D.Truncated, 'a sub-block runs past the end of the file', loc);
      each?.(q + 1, b.subarray(1, 1 + n));
      q += 1 + n;
    }
  };

  for (;;) {
    run.time();
    if (pos >= size) run.stop(D.Truncated, 'the GIF ends before its trailer', `offset ${pos}`);
    const intro = (await r.read(pos, 1))[0];
    if (intro === 0x3b) {
      pos++;
      break;
    }
    run.block();
    if (intro === 0x2c) {
      const loc = `image at ${pos}`;
      if (pos + 10 > size) run.stop(D.Truncated, 'an image descriptor is cut short', loc);
      const v = new View(await r.read(pos + 1, 9), true);
      const left = v.u16(0);
      const top = v.u16(2);
      const width = v.u16(4);
      const height = v.u16(6);
      const flags = v.u8(8);
      const localEntries = flags & 0x80 ? 2 ** ((flags & 7) + 1) : 0;
      let p = pos + 10 + localEntries * 3;
      if (p + 1 > size) run.stop(D.Truncated, 'an image is cut short', loc);
      const minCodeSize = (await r.read(p, 1))[0];
      p++;
      run.image(width, height, width * height, loc);
      // A minimum code size of 1 is read by image-gif, Wuffs, Firefox and Pillow; only giflib refuses it.
      if (minCodeSize < 1 || minCodeSize > 8) run.stop(D.BadHeader, `the LZW minimum code size is ${minCodeSize}`, loc);
      if (left + width > screenWidth || top + height > screenHeight) run.report(C.Structure, D.Ambiguous, loc, { reason: 'the image lies outside the logical screen' });
      const entries = localEntries || globalEntries;
      if (!entries) run.report(C.Structure, D.Ambiguous, loc, { reason: 'the image has no color table' });
      const lzw = new LzwCounter(minCodeSize, width * height);
      let failure: string | undefined;
      let hiddenFrom = -1;
      const end = await subBlocks(p, loc, (at, data) => {
        if (failure) return;
        const wasEnded = lzw.ended;
        failure = lzw.feed(data);
        if (!wasEnded && lzw.ended && hiddenFrom < 0) hiddenFrom = at + lzw.endIndex + 1;
      });
      items.push({ kind: 'image', start: pos, data: p, endAt: hiddenFrom < 0 ? undefined : hiddenFrom, end });
      if (failure) run.stop(D.BadData, failure, loc);
      if (lzw.produced < width * height) run.stop(D.BadData, `the image data ends after ${lzw.produced} of ${width * height} pixels`, loc);
      if (entries && lzw.maxIndex >= entries) run.report(C.Structure, D.Ambiguous, loc, { reason: `color index ${lzw.maxIndex} is past the ${entries}-entry table` });
      if (lzw.afterNonZero) {
        run.droppableRange(hiddenFrom, end);
        run.report(C.Structure, D.HiddenData, loc, { bytes: lzw.after, reason: 'bytes after the LZW end code' });
      }
      pos = end;
      continue;
    }
    if (intro !== 0x21) run.stop(D.BadLayout, `the byte 0x${intro.toString(16).padStart(2, '0')} starts no GIF block`, `offset ${pos}`);
    if (pos + 2 > size) run.stop(D.Truncated, 'an extension is cut short', `offset ${pos}`);
    const label = (await r.read(pos + 1, 1))[0];
    const start = pos;
    if (label === 0xf9) {
      const loc = `graphic control extension at ${start}`;
      const b = await r.read(pos + 2, 7);
      if (b.length < 7) run.stop(D.Truncated, 'a graphic control extension is cut short', loc);
      if (b[0] !== 4 || b[5] !== 0) run.stop(D.BadLayout, 'a graphic control extension is not 4 bytes', loc);
      pos += 8;
      items.push({ kind: 'gce', start, end: pos });
      continue;
    }
    if (label === 0xfe) {
      const loc = `comment extension at ${start}`;
      let total = 0;
      pos = await subBlocks(pos + 2, loc, (_, d) => {
        total += d.length;
      });
      items.push({ kind: 'optional', start, end: pos, findings: [run.metadata(D.Comment, loc, start, pos, { bytes: total })], plainText: false });
      continue;
    }
    if (label === 0xff) {
      const loc = `application extension at ${start}`;
      const head = await r.read(pos + 2, 12);
      if (head.length < 12 || head[0] !== 11) run.stop(D.BadLayout, 'an application extension header is not 11 bytes', loc);
      const app = latin1(head.subarray(1, 12));
      const dataStart = pos + 14;
      const ranges: Array<[number, number]> = [];
      pos = await subBlocks(dataStart, loc, (s, d) => {
        ranges.push([s, d.length]);
      });
      const named = `${loc} (${app.replace(/[^\x20-\x7e]/g, '?')})`;
      if (KEPT_APPS.has(app)) {
        items.push({ kind: 'copy', start, end: pos });
        continue;
      }
      const findings: Array<DefuseFinding | undefined> = [];
      if (app === 'XMP DataXMP') {
        findings.push(run.metadata(D.Xmp, named, start, pos));
        if (await hasDoctype(fileSlice(r, dataStart, pos - dataStart).chunks())) findings.push(run.report(C.Metadata, D.Doctype, named));
      } else if (app === 'ICCRGBG1012') {
        const why = await checkIcc(joinedSlice(r, ranges));
        findings.push(why ? run.malformed(named, start, pos, why) : run.metadata(D.IccProfile, named, start, pos));
      } else if (app === 'MGK8BIM0000' || app === 'MGKIPTC0000') {
        findings.push(run.metadata(D.Iptc, named, start, pos));
      } else {
        findings.push(run.extra(named, start, pos, { block: `application extension ${app.replace(/[^\x20-\x7e]/g, '?')}` }));
      }
      items.push({ kind: 'optional', start, end: pos, findings, plainText: false });
      continue;
    }
    // A plain text extension, which few viewers draw, or an unknown extension: both are skipped by viewers.
    const loc = `${label === 0x01 ? 'plain text' : `0x${label.toString(16).padStart(2, '0')}`} extension at ${start}`;
    pos = await subBlocks(pos + 2, loc);
    items.push({ kind: 'optional', start, end: pos, findings: [run.extra(loc, start, pos, { block: label === 0x01 ? 'plain text extension' : 'unknown extension' })], plainText: label === 0x01 });
  }
  await run.gap(pos, size, 'trailing');
  return { items };
}

/** An image's descriptor, color table and LZW data, with the data cut after the end code and sub-blocks kept whole before it. */
async function imagePieces(run: Run, it: { start: number; data: number; endAt?: number }): Promise<Piece[]> {
  const out: Piece[] = [copy(it.start, it.data - it.start)];
  for (let q = it.data; ; ) {
    run.time();
    const n = (await run.reader.read(q, 1))[0];
    if (n === 0) break;
    const blockEnd = q + 1 + n;
    if (it.endAt === undefined || blockEnd <= it.endAt) {
      out.push(copy(q, 1 + n));
      if (blockEnd === it.endAt) break;
    } else {
      const keep = it.endAt - (q + 1);
      if (keep > 0) out.push(bytes(Uint8Array.of(keep)), copy(q + 1, keep));
      break;
    }
    q = blockEnd;
  }
  out.push(bytes(Uint8Array.of(0)));
  return out;
}

/**
 * The GIF as the rewrite writes it: the header, screen descriptor and global color table, every block the plan keeps,
 * and the trailer. A graphic control extension waits until the block it applies to is decided, and goes with a plain
 * text extension that goes.
 */
export async function gifPieces(run: Run, plan: GifPlan): Promise<Piece[]> {
  const out: Piece[] = [];
  // A graphic control extension and the blocks after it that are not graphics, waiting for the next graphic.
  let pending: Piece[] | undefined;
  const flush = (keepControl: boolean) => {
    if (pending) out.push(...(keepControl ? pending : pending.slice(1)));
    pending = undefined;
  };
  const put = (...p: Piece[]) => (pending ? pending.push(...p) : out.push(...p));
  for (const it of plan.items) {
    switch (it.kind) {
      case 'copy':
        put(copy(it.start, it.end - it.start));
        break;
      case 'gce':
        flush(true);
        pending = [copy(it.start, it.end - it.start)];
        break;
      case 'image': {
        const image = await imagePieces(run, it);
        flush(true);
        out.push(...image);
        break;
      }
      default: {
        const dropped = run.drops(it.findings, it.start, it.end);
        if (it.plainText) {
          flush(!dropped);
          if (!dropped) out.push(copy(it.start, it.end - it.start));
        } else if (!dropped) put(copy(it.start, it.end - it.start));
      }
    }
  }
  flush(true);
  out.push(bytes(Uint8Array.of(0x3b)));
  return out;
}
