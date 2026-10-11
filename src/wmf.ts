import type { Contained, Run } from './context';
import { metafileBitmap } from './dib';
import { bytes, type Piece, Region, u16, u32 } from './rewrite';
import { View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

type Findings = Array<DefuseFinding | undefined>;

const PLACEABLE_KEY = 0x9ac6cdd7;
const META_EOF = 0x0000;
const META_ESCAPE = 0x0626;
const META_DELETEOBJECT = 0x01f0;
const SETABORTPROC = 0x0009;

/** The record functions [MS-WMF] 2.1.1.1 defines. */
const FUNCTIONS = new Set([
  0x0000, 0x0035, 0x0037, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0107, 0x0108, 0x0127, 0x0139, 0x0142, 0x0149, 0x0201, 0x0209, 0x0211, 0x0213, 0x0214, 0x0220, 0x0228, 0x0231, 0x0234, 0x0324,
  0x0325, 0x020a, 0x020b, 0x020c, 0x020d, 0x020e, 0x020f, 0x0410, 0x0412, 0x0415, 0x0416, 0x0418, 0x0419, 0x0429, 0x0436, 0x0521, 0x0538, 0x0548, 0x041b, 0x041f, 0x061c, 0x061d, 0x001e, 0x081a,
  0x0b23, 0x0626, 0x012a, 0x012b, 0x012c, 0x012d, 0x012e, 0x0817, 0x0830, 0x0922, 0x0a32, 0x0d33, 0x0940, 0x0b41, 0x0f43, 0x01f0, 0x00f7, 0x01f9, 0x02fa, 0x02fb, 0x02fc, 0x06ff,
]);

/** Records that create a graphics object, which takes the lowest free slot of the object table ([MS-WMF] 3.1.4.1). */
const CREATES = new Set([0x00f7, 0x01f9, 0x02fa, 0x02fb, 0x02fc, 0x06ff, 0x0142]);

/** DIB header sizes, which tell a DIB from a Bitmap16 in a META_DIBCREATEPATTERNBRUSH of style BS_PATTERN. */
const DIB_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

interface Rec {
  fn: number;
  start: number;
  end: number;
  loc: string;
}

type Action = { kind: 'optional'; rec: Rec; findings: Findings } | { kind: 'files'; rec: Rec; files: Contained[] };

export interface WmfPlan {
  /** Where META_HEADER starts: 22 after a placeable header, or 0. */
  base: number;
  /** After META_EOF. Bytes after it are trailing data. */
  end: number;
  /** Where META_EOF starts. */
  eof: number;
  /** The size of every record after the header, in words, in order. */
  records: Array<{ start: number; words: number }>;
  actions: Action[];
  /** The object count the rewrite writes: the header's, or the slots the records use when that is more. */
  objects?: number;
}

/**
 * Checks a Bitmap16 ([MS-WMF] 2.2.2.1) at `at` that runs to `end`, with `header` bytes before its bits: a size inside
 * the limits, one plane, and bits for every row.
 */
async function bitmap16(run: Run, at: number, header: number, end: number, loc: string): Promise<void> {
  if (at + 10 > end) run.stop(D.BadHeader, 'a Bitmap16 is cut short', loc);
  const v = new View(await run.reader.read(at, 10), true);
  const width = v.i16(2);
  const height = v.i16(4);
  const planes = v.u8(8);
  const bpp = v.u8(9);
  if (width <= 0 || height <= 0 || planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bpp)) run.stop(D.BadHeader, `a Bitmap16 of ${width} x ${height}, ${planes} planes of ${bpp} bits`, loc);
  const bits = (((width * bpp + 15) >> 4) << 1) * height;
  run.inner(width, height, bits, loc);
  if (at + header + bits > end) run.stop(D.BadData, `a Bitmap16 needs ${bits} bytes and its record gives ${end - at - header}`, loc);
}

/** Checks the bitmap of a record that holds one, and hands a JPEG or PNG one to the file plugins. */
async function bitmaps(run: Run, plan: WmfPlan, rec: Rec, words: number): Promise<void> {
  const r = run.reader;
  const dib = async (offset: number, usage: number, scans?: number) => {
    const at = rec.start + offset;
    if (at + 4 > rec.end) run.stop(D.BadHeader, 'a record is too short for its bitmap', rec.loc);
    const file = await metafileBitmap(run, { bmi: at, bmiLength: rec.end - at, usage, scans, loc: `${rec.loc}, bitmap` });
    if (file && file.bitsLength > 0) {
      plan.actions.push({
        kind: 'files',
        rec,
        files: [await run.contained(`${rec.loc}, bitmap`, 'bitmap', file.bits, file.bitsLength, file.declared, true, Number.POSITIVE_INFINITY, { replaceable: false })],
      });
    }
  };
  const field = async (offset: number) => {
    if (rec.start + offset + 2 > rec.end) run.stop(D.BadHeader, 'a record is cut short', rec.loc);
    return new View(await r.read(rec.start + offset, 2), true).u16(0);
  };
  switch (rec.fn) {
    // META_DIBBITBLT and META_BITBLT have no bitmap at 12 words, META_DIBSTRETCHBLT and META_STRETCHBLT at 14.
    case 0x0940:
      if (words !== 12) await dib(22, 0);
      break;
    case 0x0b41:
      if (words !== 14) await dib(26, 0);
      break;
    case 0x0d33:
      await dib(24, await field(6), await field(8));
      break;
    case 0x0f43:
      await dib(28, await field(10));
      break;
    case 0x0142: {
      const style = await field(6);
      const usage = await field(8);
      if (rec.start + 14 > rec.end) run.stop(D.BadHeader, 'a record is too short for its bitmap', rec.loc);
      const lead = new View(await r.read(rec.start + 10, 4), true).u32(0);
      // BS_PATTERN names a Bitmap16, though writers often put a DIB there; LibreOffice tells them apart by the header size.
      if (style === 3 && !DIB_HEADERS.has(lead)) await bitmap16(run, rec.start + 10, 10, rec.end, `${rec.loc}, bitmap`);
      else await dib(10, style === 3 ? 0 : usage);
      break;
    }
    case 0x0922:
      if (words !== 12) await bitmap16(run, rec.start + 22, 10, rec.end, `${rec.loc}, bitmap`);
      break;
    case 0x0b23:
      if (words !== 14) await bitmap16(run, rec.start + 26, 10, rec.end, `${rec.loc}, bitmap`);
      break;
    case 0x01f9:
      // A Bitmap16 of 14 bytes, its last four a pointer that is never used, then 18 reserved bytes and the bits.
      await bitmap16(run, rec.start + 6, 32, rec.end, `${rec.loc}, bitmap`);
      break;
    default:
      break;
  }
}

/**
 * Inspects a WMF file ([MS-WMF]): the optional placeable header, META_HEADER, and every record's size and function up
 * to META_EOF, which must come last. Bitmaps inside records are checked, and escapes, which pass data to the printer
 * driver, are reported. The drawing records are not interpreted. Bytes after META_EOF are trailing data.
 */
export async function inspectWmf(run: Run): Promise<WmfPlan> {
  const r = run.reader;
  const size = run.size;
  let base = 0;
  let width = 0;
  let height = 0;
  if (size >= 4 && new View(await r.read(0, 4), true).u32(0) === PLACEABLE_KEY) {
    if (size < 22) run.stop(D.Truncated, 'the placeable header is cut short', 'placeable header');
    const p = new View(await r.read(0, 22), true);
    const inch = p.u16(14) || 1440;
    width = Math.round((Math.abs(p.i16(10) - p.i16(6)) * 96) / inch);
    height = Math.round((Math.abs(p.i16(12) - p.i16(8)) * 96) / inch);
    base = 22;
  }
  const hloc = `META_HEADER at ${base}`;
  if (base + 18 > size) run.stop(D.Truncated, 'META_HEADER is cut short', hloc);
  const h = new View(await r.read(base, 18), true);
  const type = h.u16(0);
  const headerWords = h.u16(2);
  const version = h.u16(4);
  const sizeWords = h.u32(6);
  const objects = h.u16(10);
  if (type !== 1 && type !== 2) run.stop(D.BadHeader, `metafile type ${type}`, hloc);
  if (headerWords !== 9) run.stop(D.BadHeader, `a header of ${headerWords} words`, hloc);
  if (version !== 0x0100 && version !== 0x0300) run.stop(D.BadHeader, `version 0x${version.toString(16)}`, hloc);

  const plan: WmfPlan = { base, end: 0, eof: 0, records: [], actions: [] };
  // The object table: each object takes the lowest free slot.
  const slots: boolean[] = [];
  let needed = 0;
  let windowExtent: [number, number] | undefined;
  let p = base + 18;
  let eofStart = -1;
  for (let i = 1; ; i++) {
    run.time();
    if (p + 6 > size) run.stop(D.Truncated, 'the file ends before META_EOF', `offset ${p}`);
    const v = new View(await r.read(p, 6), true);
    const words = v.u32(0);
    const fn = v.u16(4);
    const rec: Rec = { fn, start: p, end: p + words * 2, loc: `record ${i} at ${p}` };
    if (words < 3) run.stop(D.BadHeader, `a record of ${words} words`, rec.loc);
    if (rec.end > size) run.stop(D.Truncated, 'a record runs past the end of the file', rec.loc);
    run.block();
    plan.records.push({ start: p, words });
    if (fn === META_EOF) {
      // META_EOF has no parameters. What a longer one holds is hidden data, and the rewrite writes it as 3 words.
      await run.gap(p + 6, rec.end, 'hidden');
      eofStart = p;
      p = rec.end;
      break;
    }
    if (!FUNCTIONS.has(fn)) {
      run.droppableRange(rec.start, rec.end);
      plan.actions.push({ kind: 'optional', rec, findings: [run.report(C.Structure, D.ExtraBlock, rec.loc, { block: `record of function 0x${fn.toString(16).padStart(4, '0')}` })] });
    } else if (fn === META_ESCAPE) {
      if (words < 5) run.stop(D.BadHeader, 'META_ESCAPE is cut short', rec.loc);
      const e = new View(await r.read(p + 6, 4), true);
      const fnEscape = e.u16(0);
      if (10 + e.u16(2) > words * 2) run.stop(D.BadHeader, 'the data of META_ESCAPE runs past its record', rec.loc);
      run.droppableRange(rec.start, rec.end);
      const name = `escape 0x${fnEscape.toString(16).padStart(4, '0')}`;
      plan.actions.push({ kind: 'optional', rec, findings: [fnEscape === SETABORTPROC ? run.report(C.Content, D.AbortProc, rec.loc) : run.report(C.Content, D.Escape, rec.loc, { escape: name })] });
    } else {
      if (CREATES.has(fn)) {
        let slot = slots.indexOf(false);
        if (slot < 0) slot = slots.length;
        slots[slot] = true;
        needed = Math.max(needed, slot + 1);
      } else if (fn === META_DELETEOBJECT && words >= 4) {
        const index = new View(await r.read(p + 6, 2), true).u16(0);
        if (index < slots.length) slots[index] = false;
      } else if (fn === 0x020c && words >= 5 && !windowExtent) {
        const ext = new View(await r.read(p + 6, 4), true);
        windowExtent = [Math.abs(ext.i16(2)), Math.abs(ext.i16(0))];
      }
      await bitmaps(run, plan, rec, words);
    }
    p = rec.end;
  }
  if (base === 0 && windowExtent) [width, height] = windowExtent;
  run.image(width, height, width * height * 4, hloc);
  plan.end = p;
  plan.eof = eofStart;
  // A reader that trusts the header stops after its size in words, before META_EOF, or makes an object table too small
  // for every object. The rewrite writes the size and the object count again, so a count that falls short is a strip
  // finding. One that only overstates is corrected with nothing to report.
  plan.objects = Math.max(objects, needed);
  if (base + sizeWords * 2 < eofStart) run.report(C.Structure, D.HeaderCount, hloc, { reason: `the header gives ${sizeWords} words and the records run to ${(p - base) / 2}` });
  if (objects < needed) run.report(C.Structure, D.HeaderCount, hloc, { reason: `the header gives ${objects} objects and the records need ${needed}` });
  await run.gap(p, size, 'trailing');
  return plan;
}

/**
 * The WMF as the rewrite writes it: every record up to META_EOF but those its findings remove, with the header's size
 * and largest record written again, and the placeable header's checksum.
 */
export async function wmfPieces(run: Run, plan: WmfPlan): Promise<Piece[]> {
  const region = new Region(0, plan.end);
  const removed = new Set<number>();
  for (const a of plan.actions) {
    const drop = a.kind === 'optional' ? run.drops(a.findings, a.rec.start, a.rec.end) : a.files.some(f => f.decision === 'drop') || run.drops([], a.rec.start, a.rec.end);
    if (drop && !removed.has(a.rec.start)) {
      removed.add(a.rec.start);
      region.remove(a.rec.start, a.rec.end);
    }
  }
  if (plan.end - plan.eof !== 6) region.replace(plan.eof, plan.end, [bytes(Uint8Array.of(3, 0, 0, 0, 0, 0))]);
  const kept = plan.records.filter(x => !removed.has(x.start));
  const largest = kept.reduce((m, x) => Math.max(m, x.start === plan.eof ? 3 : x.words), 0);
  region.patch(plan.base + 6, 4, () => u32((region.length - plan.base) / 2, true));
  region.patch(plan.base + 12, 4, () => u32(largest, true));
  const objects = plan.objects;
  if (objects !== undefined) region.patch(plan.base + 10, 2, () => u16(objects, true));
  if (plan.base === 22) {
    const words = new View(await run.reader.read(0, 20), true);
    let sum = 0;
    for (let i = 0; i < 10; i++) sum ^= words.u16(i * 2);
    region.patch(20, 2, () => u16(sum, true));
  }
  return region.pieces();
}
