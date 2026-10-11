import type { Contained, Run } from './context';
import { IfdError, IfdReader } from './ifd';
import { bytes, type Piece } from './rewrite';
import { fileSlice, type Slice } from './slice';
import { orientationTiff, TiffRewrite, walkIfds } from './tiffedit';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageFinding } from './types';

const EXIF_IFD = 34665;
const GPS_IFD = 34853;
const INTEROP_IFD = 40965;

/** An EXIF thumbnail: a JPEG file the thumbnail IFD points at, or raw pixels in strips. */
interface ExifThumbnail {
  finding: ImageFinding;
  raw: boolean;
  /** A thumbnail pointer of 0 bytes, which Photoshop writes. It points at nothing, and the rewrite drops it. */
  empty?: boolean;
  /** For a JPEG thumbnail, what the rewrite does with it. */
  contained?: Contained;
  /** For a JPEG thumbnail no plugin could be given, the finding that removes it. */
  removal?: ImageFinding;
}

/** What the rewrite needs of an EXIF block: the TIFF structure at [base, base + size) of the file. */
export interface ExifPlan {
  base: number;
  size: number;
  exif: ImageFinding;
  malformed?: ImageFinding;
  gps?: ImageFinding;
  /** IFD0's orientation, when the block parsed. */
  orientation?: number;
  little: boolean;
  thumbnails: ExifThumbnail[];
}

/**
 * Reports an EXIF block, the TIFF structure in `slice`, which sits in the block [blockStart, blockEnd) of the file.
 * A GPS IFD with entries is METADATA/GPS. A thumbnail in IFD1 is METADATA/THUMBNAIL, and a JPEG one is also a
 * contained image. An EXIF block that does not parse is METADATA/MALFORMED. `room` is how many bytes the block can
 * grow by, for a thumbnail a plugin rewrites. When `offer` is false, as for EXIF decompressed from the file, no plugin
 * can be given a JPEG thumbnail, so it is removed instead. A string in `offer` says why instead of the default reason.
 */
export async function inspectExif(run: Run, slice: Slice, location: string, blockStart: number, blockEnd: number, room = Number.POSITIVE_INFINITY, offer: boolean | string = true): Promise<ExifPlan> {
  const base = slice.base ?? blockStart;
  let little = false;
  let gps = false;
  let orientation: number | undefined;
  let entries = 0;
  let failure: IfdError | undefined;
  const thumbnails: Array<{ offset: number; length: number; raw: boolean; empty?: boolean }> = [];
  try {
    const r = await IfdReader.open(slice);
    little = r.little;
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
      entries += ifd.entries.length;
      if (item.kind === 'chain') {
        if (ifd.next) queue.push({ offset: ifd.next, kind: 'chain', index: item.index + 1 });
        const exifIfd = ifd.byTag.get(EXIF_IFD);
        if (exifIfd) queue.push({ offset: (await r.number(ifd, EXIF_IFD)) ?? 0, kind: 'exif', index: 0 });
        const gpsIfd = ifd.byTag.get(GPS_IFD);
        if (gpsIfd) queue.push({ offset: (await r.number(ifd, GPS_IFD)) ?? 0, kind: 'gps', index: 0 });
        if (item.index === 0) {
          const o = ifd.byTag.get(274);
          if (o && o.type === 3 && o.count === 1) orientation = await r.number(ifd, 274);
        }
        if (item.index === 1) {
          const at = await r.number(ifd, 513);
          const length = await r.number(ifd, 514);
          if (at !== undefined || length !== undefined) {
            if (at === undefined || length === undefined) throw new IfdError(D.BadLayout, 'the thumbnail has an offset or a length but not both');
            if (length === 0) thumbnails.push({ offset: at, length, raw: false, empty: true });
            else if (at + length > slice.size) throw new IfdError(D.Truncated, 'the thumbnail lies outside the EXIF block');
            else thumbnails.push({ offset: at, length, raw: false });
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
    if (!(e instanceof IfdError)) throw e;
    failure = e;
  }
  run.droppableRange(blockStart, blockEnd);
  const exif = run.report(C.Metadata, D.Exif, location, { bytes: slice.size });
  const plan: ExifPlan = { base, size: slice.size, exif, little, thumbnails: [] };
  // A block that holds only the orientation is what the rewrite writes in its place, so stripMetadata removes nothing.
  const orientationOnly = !failure && entries === 1 && orientation !== undefined && orientation >= 2 && orientation <= 8;
  if (run.stripMetadata && !orientationOnly) run.report(C.Metadata, D.Stripped, location);
  if (failure) {
    plan.malformed = run.malformed(location, blockStart, blockEnd, `EXIF: ${failure.message}`);
    return plan;
  }
  plan.orientation = orientation;
  if (gps) plan.gps = run.report(C.Metadata, D.Gps, location);
  for (const t of thumbnails) {
    if (t.empty) {
      // A block kept or dropped whole cannot lose the pointer, and a pointer at nothing holds no image, so it stays.
      if (offer === true) plan.thumbnails.push({ finding: run.extra(location, blockStart, blockStart, { block: 'an EXIF thumbnail of 0 bytes' }), raw: false, empty: true });
      continue;
    }
    if (t.raw) {
      plan.thumbnails.push({ finding: run.report(C.Metadata, D.Thumbnail, location, { format: 'raw' }), raw: true });
      continue;
    }
    const thumb = run.report(C.Metadata, D.Thumbnail, location, { offset: base + t.offset, bytes: t.length });
    if (offer !== true) {
      const reason = offer || 'It sits in compressed metadata, where no plugin can check it';
      const removal = run.report(C.EmbeddedImage, D.NoPlugin, location, { sniffed: 'image/jpeg', bytes: t.length, reason });
      plan.thumbnails.push({ finding: thumb, raw: false, removal });
      continue;
    }
    const contained = await run.contained(location, 'EXIF thumbnail', base + t.offset, t.length, 'image/jpeg', run.keeps(exif) && run.keeps(thumb), t.length + room);
    plan.thumbnails.push({ finding: thumb, raw: false, contained });
  }
  return plan;
}

/** Every finding of an EXIF block, for a block the rewrite keeps or drops whole. */
export const exifFindings = (plan: ExifPlan): Array<DefuseFinding | undefined> => [plan.exif, plan.malformed, plan.gps, ...plan.thumbnails.flatMap(t => [t.finding, t.removal])];

/**
 * The EXIF block's TIFF structure as the rewrite writes it, or undefined when the block goes. `own` are the findings
 * of the block that holds it, such as a second EXIF segment's. When the block goes only because of stripMetadata or a
 * signature inside it, and its orientation is not 1, a new structure holding only the orientation takes its place.
 */
export async function exifPieces(run: Run, plan: ExifPlan, own: Array<DefuseFinding | undefined>, start: number, end: number): Promise<Piece[] | undefined> {
  const findings = [plan.exif, plan.malformed, ...own];
  if (run.drops(findings, start, end)) {
    const removedByRule = findings.some(f => f?.action === 'strip');
    const o = plan.orientation;
    if (!removedByRule && o !== undefined && o >= 2 && o <= 8) return [bytes(orientationTiff(plan.little, o))];
    return undefined;
  }
  const thumbnail = plan.thumbnails[0];
  const thumbDecision = thumbnail ? (thumbnail.raw || thumbnail.empty ? (run.keeps(thumbnail.finding) ? 'keep' : 'drop') : (thumbnail.contained?.decision ?? 'drop')) : 'keep';
  const dropGps = plan.gps !== undefined && !run.keeps(plan.gps);
  if (thumbDecision === 'keep' && !dropGps) return [{ kind: 'copy', start: plan.base, length: plan.size }];

  const r = await IfdReader.open(fileSlice(run.reader, plan.base, plan.size));
  const ifds = await walkIfds(r, false);
  const t = new TiffRewrite(r, plan.base, ifds);
  if (dropGps) for (const w of ifds) if (w.kind === 'gps') t.dropIfd(w);
  const ifd1 = ifds.find(w => w.kind === 'chain' && w.index === 1);
  if (ifd1 && thumbDecision !== 'keep') {
    const at = await r.number(ifd1.ifd, 513);
    const length = await r.number(ifd1.ifd, 514);
    const lengthEntry = ifd1.ifd.byTag.get(514);
    if (thumbDecision === 'replace' && at !== undefined && length !== undefined && lengthEntry && thumbnail?.contained?.replacement) {
      const n = thumbnail.contained.replacement.length;
      t.replaceRange(at, at + length, [{ kind: 'source', source: run.replacementSource(thumbnail.contained), length: n }]);
      t.setValue(lengthEntry, 0, n);
    } else {
      t.dropIfd(ifd1);
      if (at !== undefined && length !== undefined) t.removeRange(at, at + length);
      const offsets = ifd1.ifd.byTag.get(273);
      const counts = ifd1.ifd.byTag.get(279);
      if (offsets && counts) {
        const os = await r.numbers(offsets);
        const cs = await r.numbers(counts);
        for (let i = 0; i < Math.min(os.length, cs.length); i++) t.removeRange(os[i], os[i] + cs[i]);
      }
    }
  }
  return t.pieces(false);
}
