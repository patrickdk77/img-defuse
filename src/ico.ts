import { readDib } from './bmp';
import type { Run } from './context';
import { inspectPng } from './png';
import { View } from './slice';
import { ImageCategory as C, ImageDetail as D } from './types';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Inspects an ICO or CUR file: a directory, then images that are each a PNG or a DIB with an AND mask. */
export async function inspectIco(run: Run): Promise<void> {
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
    const bytes = dir.u32(e + 8);
    const start = dir.u32(e + 12);
    const loc = `directory entry ${i + 1}`;
    if (bytes === 0) run.stop(D.BadHeader, 'an image has the size 0', loc);
    if (start < dirEnd) run.stop(D.Overlap, 'an image starts inside the directory', loc);
    if (start + bytes > size) run.stop(D.Truncated, 'an image runs past the end of the file', loc);
    entries.push({ index: i + 1, width: dir.u8(e) || 256, height: dir.u8(e + 1) || 256, start, end: start + bytes });
  }
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) run.stop(D.Overlap, `images ${sorted[i - 1].index} and ${sorted[i].index} share bytes`, `directory entry ${sorted[i].index}`);
  }
  for (const e of entries) {
    run.time();
    const loc = `image ${e.index} at ${e.start}`;
    const head = await r.read(e.start, 8);
    let width: number;
    let height: number;
    if (head.length === 8 && PNG.every((b, i) => head[i] === b)) {
      ({ width, height } = await inspectPng(run, e.start, e.end, { prefix: `${loc}, `, afterEnd: 'hidden' }));
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
    }
    // The directory's width and height are one byte each, so a dimension of 256 or more can only be stored as 0 (read as 256) or its low byte.
    const fits = (dirValue: number, actual: number) => dirValue === actual || (actual >= 256 && (dirValue === 256 || dirValue === (actual & 0xff)));
    if (!fits(e.width, width) || !fits(e.height, height)) run.report(C.Structure, D.Ambiguous, loc, { reason: `the directory says ${e.width} x ${e.height} and the image is ${width} x ${height}` });
  }
  let p = dirEnd;
  for (const e of sorted) {
    await run.gap(p, e.start, 'hidden');
    p = e.end;
  }
  await run.gap(p, size, 'trailing');
}
