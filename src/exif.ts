import type { Run } from './context';
import { IfdError, IfdReader } from './ifd';
import type { Slice } from './slice';
import { ImageCategory as C, ImageDetail as D } from './types';

const EXIF_IFD = 34665;
const GPS_IFD = 34853;
const INTEROP_IFD = 40965;

/**
 * Reports an EXIF block, the TIFF structure in `slice`, which sits in the block [blockStart, blockEnd) of the file.
 * A GPS IFD with entries is METADATA/GPS. A thumbnail in IFD1 is METADATA/THUMBNAIL, and a JPEG one is also a
 * contained image. An EXIF block that does not parse is METADATA/MALFORMED.
 */
export async function inspectExif(run: Run, slice: Slice, location: string, blockStart: number, blockEnd: number): Promise<void> {
  const exif = run.metadata(D.Exif, location, blockStart, blockEnd, { bytes: slice.size });
  const base = slice.base ?? blockStart;
  let gps = false;
  const thumbnails: Array<{ offset: number; length: number; raw: boolean }> = [];
  try {
    const r = await IfdReader.open(slice);
    const visited = new Set<number>();
    const queue: Array<{ offset: number; kind: 'chain' | 'exif' | 'gps' | 'interop'; index: number }> = [{ offset: r.first, kind: 'chain', index: 0 }];
    while (queue.length) {
      run.time();
      const item = queue.shift();
      if (!item || item.offset === 0) continue;
      if (visited.has(item.offset)) throw new IfdError(D.Loop, `the IFD at ${item.offset} is reached twice`);
      visited.add(item.offset);
      const ifd = await r.ifd(item.offset);
      run.block(ifd.entries.length);
      if (item.kind === 'chain') {
        if (ifd.next) queue.push({ offset: ifd.next, kind: 'chain', index: item.index + 1 });
        const exifIfd = ifd.byTag.get(EXIF_IFD);
        if (exifIfd) queue.push({ offset: (await r.number(ifd, EXIF_IFD)) ?? 0, kind: 'exif', index: 0 });
        const gpsIfd = ifd.byTag.get(GPS_IFD);
        if (gpsIfd) queue.push({ offset: (await r.number(ifd, GPS_IFD)) ?? 0, kind: 'gps', index: 0 });
        if (item.index === 1) {
          const at = await r.number(ifd, 513);
          const length = await r.number(ifd, 514);
          if (at !== undefined || length !== undefined) {
            if (at === undefined || length === undefined) throw new IfdError(D.BadLayout, 'the thumbnail has an offset or a length but not both');
            if (at + length > slice.size || length === 0) throw new IfdError(D.Truncated, 'the thumbnail lies outside the EXIF block');
            thumbnails.push({ offset: at, length, raw: false });
          } else if (ifd.byTag.has(273)) {
            // An uncompressed thumbnail in strips: pixels, not a file.
            thumbnails.push({ offset: 0, length: 0, raw: true });
          }
        }
      } else if (item.kind === 'exif') {
        if (ifd.byTag.has(INTEROP_IFD)) queue.push({ offset: (await r.number(ifd, INTEROP_IFD)) ?? 0, kind: 'interop', index: 0 });
      } else if (item.kind === 'gps' && ifd.entries.length > 0) {
        gps = true;
      }
    }
  } catch (e) {
    if (e instanceof IfdError) {
      run.malformed(location, blockStart, blockEnd, `EXIF: ${e.message}`);
      return;
    }
    throw e;
  }
  if (gps) run.report(C.Metadata, D.Gps, location);
  for (const t of thumbnails) {
    if (t.raw) {
      run.report(C.Metadata, D.Thumbnail, location, { format: 'raw' });
      continue;
    }
    const thumb = run.report(C.Metadata, D.Thumbnail, location, { offset: base + t.offset, bytes: t.length });
    await run.contained(location, base + t.offset, t.length, 'image/jpeg', run.keeps(exif) && run.keeps(thumb));
  }
}
