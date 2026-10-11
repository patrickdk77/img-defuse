import { readDib } from './bmp';
import type { Run } from './context';
import { inspectPng, type PngPlan, pngPieces } from './png';
import { bytes, copy, lengthOf, type Piece, u16, u32 } from './rewrite';
import { View } from './slice';
import { ImageCategory as C, ImageDetail as D, type ImageFinding } from './types';

/** An icon as the rewrite sees it: its directory entry, its own size, and a PNG's plan or a DIB's file range. */
interface Icon {
  /** File offset of the 16-byte directory entry. */
  dir: number;
  width: number;
  height: number;
  /** A directory size that disagrees with the image. The rewrite writes the image's own size when it is strip. */
  mismatch?: ImageFinding;
  png?: PngPlan;
  start: number;
  end: number;
}

export interface IcoPlan {
  type: number;
  icons: Icon[];
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Inspects an ICO or CUR file: a directory, then images that are each a PNG or a DIB with an AND mask. */
export async function inspectIco(run: Run): Promise<IcoPlan> {
  const r = run.reader;
  const size = run.size;
  const count = new View(await r.read(4, 2), true).u16(0);
  const dirEnd = 6 + count * 16;
  if (dirEnd > size) run.stop(D.Truncated, `the directory of ${count} images is cut short`, 'directory at 6');
  run.block(count);
  const dir = new View(await r.read(6, count * 16), true);
  const entries: Array<{ index: number; width: number; height: number; start: number; end: number }> = [];
  for (let i = 0; i < count; i++) {
    const e = i * 16;
    const length = dir.u32(e + 8);
    const start = dir.u32(e + 12);
    const loc = `directory entry ${i + 1}`;
    if (length === 0) run.stop(D.BadHeader, 'an image has the size 0', loc);
    if (start < dirEnd) run.stop(D.Overlap, 'an image starts inside the directory', loc);
    if (start + length > size) run.stop(D.Truncated, 'an image runs past the end of the file', loc);
    entries.push({ index: i + 1, width: dir.u8(e) || 256, height: dir.u8(e + 1) || 256, start, end: start + length });
  }
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) run.stop(D.Overlap, `images ${sorted[i - 1].index} and ${sorted[i].index} share bytes`, `directory entry ${sorted[i].index}`);
  }
  const icons: Icon[] = [];
  for (const e of entries) {
    run.time();
    const loc = `image ${e.index} at ${e.start}`;
    const head = await r.read(e.start, 8);
    let width: number;
    let height: number;
    const icon: Icon = { dir: 6 + (e.index - 1) * 16, width: 0, height: 0, start: e.start, end: e.end };
    if (head.length === 8 && PNG.every((b, i) => head[i] === b)) {
      const png = await inspectPng(run, e.start, e.end, { prefix: `${loc}, `, afterEnd: 'hidden' });
      ({ width, height } = png);
      icon.png = png.plan;
    } else {
      const dib = await readDib(run, e.start, e.end, loc, true);
      const paletteEnd = e.start + dib.headerSize + dib.paletteEntries * dib.paletteEntrySize;
      const andStride = Math.floor((dib.width + 31) / 32) * 4;
      const imageEnd = paletteEnd + dib.stride * dib.height + andStride * dib.height;
      if (imageEnd > e.end) run.stop(D.Truncated, `the image needs ${imageEnd - e.start} bytes and its entry gives ${e.end - e.start}`, loc);
      run.image(dib.width, dib.height, dib.stride * dib.height, loc);
      await run.gap(imageEnd, e.end, 'hidden');
      width = dib.width;
      height = dib.height;
      icon.end = imageEnd;
    }
    // The directory's width and height are one byte each, so a dimension of 256 or more can only be stored as 0 (read as 256) or its low byte.
    const fits = (dirValue: number, actual: number) => dirValue === actual || (actual >= 256 && (dirValue === 256 || dirValue === (actual & 0xff)));
    if (!fits(e.width, width) || !fits(e.height, height))
      icon.mismatch = run.report(C.Structure, D.Ambiguous, loc, { reason: `the directory says ${e.width} x ${e.height} and the image is ${width} x ${height}` });
    icon.width = width;
    icon.height = height;
    icons.push(icon);
  }
  let p = dirEnd;
  for (const e of sorted) {
    await run.gap(p, e.start, 'hidden');
    p = e.end;
  }
  await run.gap(p, size, 'trailing');
  return { type: new View(await r.read(2, 2), true).u16(0), icons };
}

/**
 * The ICO or CUR as the rewrite writes it: the header, a directory with each image's new size and offset, and the
 * images end to end in directory order. A PNG image is rewritten as a PNG, and a DIB image loses the bytes after its
 * AND mask.
 */
export async function icoPieces(run: Run, plan: IcoPlan): Promise<Piece[]> {
  const images: Piece[][] = [];
  for (const icon of plan.icons) images.push(icon.png ? await pngPieces(run, icon.png) : [copy(icon.start, icon.end - icon.start)]);
  const out: Piece[] = [bytes(u16(0, true)), bytes(u16(plan.type, true)), bytes(u16(plan.icons.length, true))];
  let at = 6 + 16 * plan.icons.length;
  const body: Piece[] = [];
  for (let i = 0; i < plan.icons.length; i++) {
    const icon = plan.icons[i];
    const entry = Uint8Array.from(await run.reader.read(icon.dir, 16));
    if (icon.mismatch && !run.keeps(icon.mismatch)) {
      entry[0] = icon.width >= 256 ? 0 : icon.width;
      entry[1] = icon.height >= 256 ? 0 : icon.height;
    }
    const n = lengthOf(images[i]);
    entry.set(u32(n, true), 8);
    entry.set(u32(at, true), 12);
    out.push(bytes(entry));
    body.push(...images[i]);
    at += n;
  }
  return [...out, ...body];
}
