import type { Run } from './context';
import { StopError } from './errors';
import { checkIcc } from './metadata';
import { fileSlice, latin1, View } from './slice';
import { ImageCategory as C, ImageDetail as D } from './types';

const PROFILE_LINKED = 0x4c494e4b;
const PROFILE_EMBEDDED = 0x4d424544;

export interface Dib {
  headerSize: number;
  width: number;
  /** Rows, without the sign. In an icon, the color bitmap's rows: half the header's height. */
  height: number;
  topDown: boolean;
  bpp: number;
  compression: number;
  /** Bytes of masks stored after a 40-byte header. */
  maskBytes: number;
  paletteEntries: number;
  paletteEntrySize: number;
  /** Bytes in one row of the color bitmap, padded to four bytes. */
  stride: number;
  csType: number;
  profileData: number;
  profileSize: number;
}

/** Bit depths each compression allows. */
const PAIRS = new Map<number, number[]>([
  [0, [1, 2, 4, 8, 16, 24, 32]],
  [1, [8]],
  [2, [4]],
  [3, [16, 32]],
  [6, [16, 32]],
]);

const unsupported = (what: string, loc: string): never => {
  throw new StopError(C.Format, D.Unsupported, `${what} is not read by this version`, { format: what }, loc);
};

/** A mask is one run of set bits, or empty. */
function contiguous(mask: number): boolean {
  if (mask === 0) return true;
  let x = mask >>> 0;
  while ((x & 1) === 0) x >>>= 1;
  return (x & (x + 1)) === 0;
}

/** Reads a DIB info header at `at`. In an icon the height counts the AND mask too, and only uncompressed data is allowed. */
export async function readDib(run: Run, at: number, end: number, loc: string, icon: boolean): Promise<Dib> {
  const r = run.reader;
  if (at + 4 > end) run.stop(D.Truncated, 'the info header is cut short', loc);
  const headerSize = new View(await r.read(at, 4), true).u32(0);
  if (headerSize === 64) unsupported('OS/2 2.x BMP', loc);
  if (![12, 40, 52, 56, 108, 124].includes(headerSize)) run.stop(D.BadHeader, `the info header is ${headerSize} bytes`, loc);
  if (at + headerSize > end) run.stop(D.Truncated, 'the info header is cut short', loc);
  const v = new View(await r.read(at, headerSize), true);
  let width: number;
  let rawHeight: number;
  let planes: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;
  if (headerSize === 12) {
    width = v.u16(4);
    rawHeight = v.u16(6);
    planes = v.u16(8);
    bpp = v.u16(10);
  } else {
    width = v.i32(4);
    rawHeight = v.i32(8);
    planes = v.u16(12);
    bpp = v.u16(14);
    compression = v.u32(16);
    colorsUsed = v.u32(32);
  }
  if (compression === 4 || compression === 5) unsupported(compression === 4 ? 'JPEG in BMP' : 'PNG in BMP', loc);
  if (compression >= 11 && compression <= 13) unsupported('CMYK BMP', loc);
  if (width <= 0) run.stop(D.BadHeader, `the width is ${width}`, loc);
  if (rawHeight === 0 || rawHeight === -2147483648) run.stop(D.BadHeader, `the height is ${rawHeight}`, loc);
  const topDown = rawHeight < 0;
  let height = Math.abs(rawHeight);
  if (planes !== 1) run.stop(D.BadHeader, `the image has ${planes} planes`, loc);
  if (!PAIRS.get(compression)?.includes(bpp)) run.stop(D.BadHeader, `compression ${compression} with ${bpp} bits per pixel`, loc);
  if (topDown && compression !== 0 && compression !== 3 && compression !== 6) run.stop(D.BadHeader, 'a top-down image is compressed', loc);
  if (icon) {
    if (compression !== 0 || topDown) run.stop(D.BadHeader, 'an icon image is compressed or top-down', loc);
    if (height % 2 !== 0) run.stop(D.BadHeader, 'an icon image height does not count its mask', loc);
    height /= 2;
  }
  // Masks follow a 40-byte header; larger headers hold them.
  let maskBytes = 0;
  const masks: number[] = [];
  if (compression === 3 || compression === 6) {
    if (headerSize === 40) {
      maskBytes = compression === 3 ? 12 : 16;
      if (at + 40 + maskBytes > end) run.stop(D.Truncated, 'the bit field masks are cut short', loc);
      const m = new View(await r.read(at + 40, maskBytes), true);
      for (let i = 0; i < maskBytes / 4; i++) masks.push(m.u32(i * 4));
    } else {
      for (let i = 0; i < (headerSize >= 56 ? 4 : 3); i++) masks.push(v.u32(40 + i * 4));
    }
    let union = 0;
    for (const m of masks) {
      if (!contiguous(m) || (bpp < 32 && m >= 2 ** bpp) || (union & m) !== 0) run.stop(D.BadHeader, 'the bit field masks overlap, have gaps or exceed the bit depth', loc);
      union |= m;
    }
    if (masks.slice(0, 3).some(m => m === 0)) run.stop(D.BadHeader, 'a color mask is empty', loc);
  }
  if (bpp <= 8 && colorsUsed > 2 ** bpp) run.stop(D.BadHeader, `the palette holds ${colorsUsed} colors for ${bpp} bits per pixel`, loc);
  const paletteEntries = bpp <= 8 ? colorsUsed || 2 ** bpp : colorsUsed;
  if (paletteEntries > 65536) run.stop(D.BadHeader, `the palette holds ${paletteEntries} colors`, loc);
  const stride = Math.floor((width * bpp + 31) / 32) * 4;
  return {
    headerSize,
    width,
    height,
    topDown,
    bpp,
    compression,
    maskBytes,
    paletteEntries,
    paletteEntrySize: headerSize === 12 ? 3 : 4,
    stride,
    csType: headerSize >= 108 ? v.u32(56) : 0,
    profileData: headerSize >= 124 ? v.u32(112) : 0,
    profileSize: headerSize >= 124 ? v.u32(116) : 0,
  };
}

/** Walks RLE4 or RLE8 data from `at` to its end-of-bitmap command. Returns the offset after it. */
async function walkRle(run: Run, at: number, dib: Dib, loc: string): Promise<number> {
  const r = run.reader;
  let window: Uint8Array = new Uint8Array(0);
  let windowAt = at;
  const byte = async (q: number): Promise<number> => {
    if (q >= run.size) run.stop(D.Truncated, 'the RLE data ends before its end-of-bitmap command', loc);
    if (q < windowAt || q >= windowAt + window.length) {
      run.time();
      windowAt = q;
      window = await r.read(q, 65536);
    }
    return window[q - windowAt];
  };
  const outside = (why: string) => run.stop(D.BadData, `an RLE ${why} leaves the image`, loc);
  let x = 0;
  let y = 0;
  let p = at;
  for (;;) {
    const a = await byte(p);
    const b = await byte(p + 1);
    p += 2;
    if (a > 0) {
      if (y >= dib.height || x + a > dib.width) outside('run');
      x += a;
      continue;
    }
    if (b === 0) {
      x = 0;
      y++;
      if (y > dib.height) outside('line end');
    } else if (b === 1) {
      return p;
    } else if (b === 2) {
      x += await byte(p);
      y += await byte(p + 1);
      p += 2;
      if (x > dib.width || y > dib.height) outside('delta');
    } else {
      if (y >= dib.height || x + b > dib.width) outside('literal run');
      x += b;
      const bytes = dib.compression === 1 ? b : Math.ceil(b / 2);
      p += bytes + (bytes & 1);
      if (p > run.size) run.stop(D.Truncated, 'the RLE data ends inside a literal run', loc);
    }
  }
}

/** Ranges of the file a BMP uses, sorted and checked for overlaps. Gaps between them are hidden data. */
async function layout(run: Run, ranges: Array<{ start: number; end: number; what: string }>, loc: string): Promise<void> {
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) run.stop(D.Overlap, `the ${ranges[i - 1].what} and the ${ranges[i].what} share bytes`, loc);
  }
  let p = 0;
  for (const g of ranges) {
    await run.gap(p, g.start, 'hidden');
    p = g.end;
  }
  await run.gap(p, run.size, 'trailing');
}

export async function inspectBmp(run: Run): Promise<void> {
  const r = run.reader;
  const size = run.size;
  if (size < 18) run.stop(D.Truncated, 'the file header is cut short', 'file header');
  const pixelOffset = new View(await r.read(10, 4), true).u32(0);
  const loc = 'info header at 14';
  const dib = await readDib(run, 14, size, loc, false);
  const paletteStart = 14 + dib.headerSize + dib.maskBytes;
  // An OS/2 1.x (12-byte header) BMP may store a palette shorter than 2^bpp; its entries run up to the pixel data.
  if (dib.headerSize === 12 && pixelOffset > paletteStart) {
    const room = Math.floor((pixelOffset - paletteStart) / dib.paletteEntrySize);
    if (room >= 0 && room < dib.paletteEntries) dib.paletteEntries = room;
  }
  const paletteEnd = paletteStart + dib.paletteEntries * dib.paletteEntrySize;
  if (paletteEnd > size) run.stop(D.Truncated, 'the palette is cut short', loc);
  const ranges = [{ start: 0, end: paletteStart, what: 'headers' }];
  if (paletteEnd > paletteStart) ranges.push({ start: paletteStart, end: paletteEnd, what: 'palette' });
  run.image(dib.width, dib.height, dib.stride * dib.height, loc);
  const pixelLoc = `pixel data at ${pixelOffset}`;
  if (pixelOffset >= size) run.stop(D.Truncated, 'the pixel data starts past the end of the file', pixelLoc);
  let pixelEnd: number;
  if (dib.compression === 1 || dib.compression === 2) pixelEnd = await walkRle(run, pixelOffset, dib, pixelLoc);
  else {
    pixelEnd = pixelOffset + dib.stride * dib.height;
    if (pixelEnd > size) run.stop(D.Truncated, `the pixel data needs ${dib.stride * dib.height} bytes`, pixelLoc);
  }
  ranges.push({ start: pixelOffset, end: pixelEnd, what: 'pixel data' });
  if (dib.csType === PROFILE_LINKED || dib.csType === PROFILE_EMBEDDED) {
    const start = 14 + dib.profileData;
    const end = start + dib.profileSize;
    const ploc = `color profile at ${start}`;
    if (dib.profileSize === 0 || end > size) run.stop(D.Truncated, 'the color profile lies outside the file', ploc);
    ranges.push({ start, end, what: 'color profile' });
    if (dib.csType === PROFILE_LINKED) {
      const raw = await r.read(start, Math.min(dib.profileSize, 1024));
      const nul = raw.indexOf(0);
      run.droppableRange(start, end);
      run.report(C.External, D.LinkedProfile, ploc, { target: latin1(nul < 0 ? raw : raw.subarray(0, nul)) });
    } else {
      const why = await checkIcc(fileSlice(r, start, dib.profileSize));
      if (why) run.malformed(ploc, start, end, why);
      else run.metadata(D.IccProfile, ploc, start, end, { bytes: dib.profileSize });
    }
  }
  await layout(run, ranges, loc);
}
