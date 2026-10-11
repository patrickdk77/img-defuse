import { readDib, walkRle } from './bmp';
import type { Run } from './context';
import { ImageDetail as D } from './types';

/**
 * A bitmap in a metafile record: its header and color table, and its bits, as ranges of the file. A packed bitmap, as
 * WMF records hold one, has its bits right after its color table: `bmiLength` then covers the whole bitmap, and
 * `bits` and `bitsLength` are left out.
 */
export interface MetafileBitmap {
  bmi: number;
  bmiLength: number;
  bits?: number;
  bitsLength?: number;
  /** How the color table is read: 0 RGB values, 1 16-bit palette indexes, 2 none ([MS-WMF] 2.1.1.6). */
  usage: number;
  /** For EMR_SETDIBITSTODEVICE and META_SETDIBTODEV, the scan lines the bits hold, when fewer than the height. */
  scans?: number;
  loc: string;
}

/**
 * Checks a bitmap inside a metafile record ([MS-WMF] 2.2.2.9): an info header BMP readers accept, a color table that
 * fits the header's bytes, a size inside the pixel and decoded size limits, and bits that hold every row, or RLE data
 * that stays inside the image and ends inside its bytes. A bitmap compressed as JPEG or PNG is a whole file, which
 * comes back with its declared type for the file plugins.
 */
export async function metafileBitmap(run: Run, b: MetafileBitmap): Promise<{ declared: string; bits: number; bitsLength: number } | undefined> {
  const dib = await readDib(run, b.bmi, b.bmi + b.bmiLength, b.loc, false, true);
  const entry = b.usage === 1 ? 2 : b.usage === 2 ? 0 : dib.paletteEntrySize;
  const head = dib.headerSize + dib.maskBytes + dib.paletteEntries * entry;
  if (head > b.bmiLength) run.stop(D.BadData, `the bitmap header and color table need ${head} bytes and the record gives ${b.bmiLength}`, b.loc);
  const bits = b.bits ?? b.bmi + head;
  const bitsLength = b.bitsLength ?? b.bmiLength - head;
  if (dib.compression === 4 || dib.compression === 5) {
    run.inner(dib.width, dib.height, dib.width * dib.height * 4, b.loc);
    return { declared: dib.compression === 4 ? 'image/jpeg' : 'image/png', bits, bitsLength };
  }
  run.inner(dib.width, dib.height, dib.stride * dib.height, b.loc);
  if (dib.compression === 1 || dib.compression === 2) {
    await walkRle(run, bits, dib, b.loc, bits + bitsLength);
    return undefined;
  }
  const rows = b.scans !== undefined ? Math.min(b.scans, dib.height) : dib.height;
  if (dib.stride * rows > bitsLength) run.stop(D.BadData, `the bitmap needs ${dib.stride * rows} bytes and the record gives ${bitsLength}`, b.loc);
  return undefined;
}
