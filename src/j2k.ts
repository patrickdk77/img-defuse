import type { Run } from './context';
import { StopError } from './errors';
import { type Piece, Region, u16, u32 } from './rewrite';
import { View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

/** Marker codes of a JPEG 2000 codestream (ISO/IEC 15444-1 A.2). */
const SOC = 0xff4f;
const SIZ = 0xff51;
const COD = 0xff52;
const COC = 0xff53;
const TLM = 0xff55;
const PLM = 0xff57;
const PLT = 0xff58;
const QCD = 0xff5c;
const QCC = 0xff5d;
const RGN = 0xff5e;
const POC = 0xff5f;
const PPM = 0xff60;
const PPT = 0xff61;
const CRG = 0xff63;
const COM = 0xff64;
/** JPSEC (ISO/IEC 15444-8), whose codestreams can be encrypted. */
const SEC = 0xff65;
const SOT = 0xff90;
const SOD = 0xff93;
const EOC = 0xffd9;
/** Capabilities and the high-throughput profile (ISO/IEC 15444-15). */
const CAP = 0xff50;
const CPF = 0xff59;
/** Part 2 marker segments (ISO/IEC 15444-2 A.2), from DCO to ATK. */
const PART2 = new Set([0xff70, 0xff71, 0xff72, 0xff73, 0xff74, 0xff75, 0xff76, 0xff77, 0xff78, 0xff79]);

const NAMES = new Map([
  [SOC, 'SOC'],
  [SIZ, 'SIZ'],
  [COD, 'COD'],
  [COC, 'COC'],
  [TLM, 'TLM'],
  [PLM, 'PLM'],
  [PLT, 'PLT'],
  [QCD, 'QCD'],
  [QCC, 'QCC'],
  [RGN, 'RGN'],
  [POC, 'POC'],
  [PPM, 'PPM'],
  [PPT, 'PPT'],
  [CRG, 'CRG'],
  [COM, 'COM'],
  [SEC, 'SEC'],
  [CAP, 'CAP'],
  [CPF, 'CPF'],
  [SOT, 'SOT'],
  [SOD, 'SOD'],
  [EOC, 'EOC'],
]);
const markerName = (m: number) => NAMES.get(m) ?? `marker 0x${m.toString(16).toUpperCase().padStart(4, '0')}`;

/** At most 32 decomposition levels, 97 subbands, and 65,535 tiles, numbered in a 16-bit field. */
const MAX_LEVELS = 32;
const MAX_BANDS = 97;
const MAX_TILES = 65535;

export interface Siz {
  width: number;
  height: number;
  components: number;
  /** Each component's Ssiz: bit 7 is the sign, bits 0 to 6 the depth less one. */
  ssiz: number[];
  tiles: number;
  /** The codestream declares Part 2, which allows transforms and options Part 1 does not. */
  part2: boolean;
}

/** A marker segment the rewrite can drop: a comment or an unknown segment, in the main header or a tile-part's. */
interface Removable {
  start: number;
  end: number;
  findings: Array<DefuseFinding | undefined>;
  /** The tile-part whose header holds it, or -1 for the main header. */
  part: number;
}

export interface CodestreamPlan {
  start: number;
  /** After EOC. */
  end: number;
  siz: Siz;
  removable: Removable[];
  /** Each tile-part's SOT offset, its Psot, and its length, in codestream order. */
  parts: Array<{ sot: number; psot: number; length: number }>;
  /** Where TLM gives each tile-part's length, in the same order, when TLM lists every tile-part. */
  tlm: Array<{ at: number; size: number }>;
}

interface Segment {
  marker: number;
  start: number;
  /** After the length field. */
  data: number;
  end: number;
  loc: string;
}

/** Reads SIZ: the image and tile grid, and every component's depth and subsampling. Counts the image. */
async function readSiz(run: Run, s: Segment): Promise<Siz> {
  const n = s.end - s.start - 2;
  if (n < 41) run.stop(D.BadHeader, 'SIZ is cut short', s.loc);
  const v = new View(await run.reader.read(s.start + 2, n));
  const xsiz = v.u32(4);
  const ysiz = v.u32(8);
  const xo = v.u32(12);
  const yo = v.u32(16);
  const xt = v.u32(20);
  const yt = v.u32(24);
  const xto = v.u32(28);
  const yto = v.u32(32);
  const components = v.u16(36);
  if (components < 1 || components > 16384) run.stop(D.BadHeader, `SIZ gives ${components} components`, s.loc);
  if (n !== 38 + 3 * components) run.stop(D.BadHeader, `SIZ is ${n} bytes for ${components} components`, s.loc);
  if (xo >= xsiz || yo >= ysiz) run.stop(D.BadHeader, `the image area runs from ${xo}, ${yo} to ${xsiz}, ${ysiz}`, s.loc);
  if (xt === 0 || yt === 0 || xto > xo || yto > yo || xt + xto <= xo || yt + yto <= yo) run.stop(D.BadHeader, 'the tile grid does not cover the image area', s.loc);
  const tiles = Math.ceil((xsiz - xto) / xt) * Math.ceil((ysiz - yto) / yt);
  if (tiles > MAX_TILES) run.stop(D.BadHeader, `SIZ makes ${tiles} tiles`, s.loc);
  const ssiz: number[] = [];
  let decoded = 0;
  for (let i = 0; i < components; i++) {
    const at = 38 + 3 * i;
    const depth = (v.u8(at) & 0x7f) + 1;
    const xr = v.u8(at + 1);
    const yr = v.u8(at + 2);
    if (depth > 38) run.stop(D.BadHeader, `component ${i} has ${depth}-bit samples`, s.loc);
    if (xr === 0 || yr === 0) run.stop(D.BadHeader, `component ${i} is subsampled by 0`, s.loc);
    ssiz.push(v.u8(at));
    const w = Math.ceil(xsiz / xr) - Math.ceil(xo / xr);
    const h = Math.ceil(ysiz / yr) - Math.ceil(yo / yr);
    decoded += w * h * (depth <= 8 ? 1 : depth <= 16 ? 2 : 4);
  }
  const width = xsiz - xo;
  const height = ysiz - yo;
  run.image(width, height, decoded, s.loc);
  return { width, height, components, ssiz, tiles, part2: (v.u16(2) & 0x8000) !== 0 };
}

/**
 * Checks COD or COC. `v` holds the segment from its length field, and `cb` is the size of a component index, which COC
 * starts with. The limits are OpenJPEG's, which refuses a codestream that breaks them.
 */
function codingStyle(run: Run, s: Segment, v: View, cb: number, siz: Siz, cod: boolean): void {
  const name = markerName(s.marker);
  const scodAt = 2 + cb;
  const sp = scodAt + 1 + (cod ? 4 : 0);
  if (v.length < sp + 5) run.stop(D.BadHeader, `${name} is cut short`, s.loc);
  const scod = v.u8(scodAt);
  if (cod) {
    if (v.u8(scodAt + 1) > 4) run.stop(D.BadHeader, `COD names progression order ${v.u8(scodAt + 1)}`, s.loc);
    if (v.u16(scodAt + 2) === 0) run.stop(D.BadHeader, 'COD gives 0 quality layers', s.loc);
    if (!siz.part2 && v.u8(scodAt + 4) > 1) run.stop(D.BadHeader, `COD names component transform ${v.u8(scodAt + 4)}`, s.loc);
  }
  const levels = v.u8(sp);
  const xcb = v.u8(sp + 1);
  const ycb = v.u8(sp + 2);
  if (levels > MAX_LEVELS) run.stop(D.BadHeader, `${name} gives ${levels} decomposition levels`, s.loc);
  if (xcb > 8 || ycb > 8 || xcb + ycb > 8) run.stop(D.BadHeader, `${name} gives code-blocks of 2^${xcb + 2} by 2^${ycb + 2}`, s.loc);
  if (!siz.part2 && v.u8(sp + 4) > 1) run.stop(D.BadHeader, `${name} names wavelet ${v.u8(sp + 4)}`, s.loc);
  const expected = sp + 5 + (scod & 1 ? levels + 1 : 0);
  if (v.length !== expected) run.stop(D.BadHeader, `${name} is ${v.length} bytes where ${levels} levels make ${expected}`, s.loc);
  if (scod & 1) {
    for (let i = 1; i <= levels; i++) {
      const pp = v.u8(sp + 5 + i);
      if ((pp & 0x0f) === 0 || pp >> 4 === 0) run.stop(D.BadHeader, `${name} gives a precinct of one sample above the lowest resolution`, s.loc);
    }
  }
}

/** Checks QCD or QCC, whose Sqcd byte is at `at` of `v`. */
function quantization(run: Run, s: Segment, v: View, at: number, siz: Siz): void {
  const name = markerName(s.marker);
  const style = v.u8(at) & 0x1f;
  const n = v.length - at - 1;
  const bands = style === 0 ? n : style === 2 ? n / 2 : 1;
  const fits = style === 1 ? n === 2 : style === 0 ? n >= 1 : style === 2 ? n >= 2 && n % 2 === 0 : false;
  if (!fits) run.stop(D.BadHeader, `${name} is ${v.length} bytes for quantization style ${style}`, s.loc);
  if (!siz.part2 && bands > MAX_BANDS) run.stop(D.BadHeader, `${name} gives ${bands} subbands`, s.loc);
}

/**
 * Inspects the codestream in [start, end): its main header, every tile-part's header, and the EOC that must close it.
 * `where` starts its locations. Bytes after EOC are hidden data inside a box, or trailing data for a bare codestream.
 * Entropy-coded data is not decoded.
 */
export async function inspectCodestream(run: Run, start: number, end: number, where: string, after: 'hidden' | 'trailing'): Promise<CodestreamPlan> {
  const read = async (at: number, n: number) => new View(await run.reader.read(at, n));
  const segment = async (p: number): Promise<Segment> => {
    if (p + 2 > end) run.stop(D.Truncated, 'the codestream ends before EOC', `${where}offset ${p}`);
    const marker = (await read(p, 2)).u16(0);
    const loc = `${where}${markerName(marker)} at ${p}`;
    if (marker >> 8 !== 0xff) run.stop(D.BadHeader, `0x${marker.toString(16).padStart(4, '0')} is where a marker should be`, `${where}offset ${p}`);
    // SOC, SOD, EOC and the reserved 0xFF30 to 0xFF3F have no length.
    if (marker === SOC || marker === SOD || marker === EOC || (marker >= 0xff30 && marker <= 0xff3f)) return { marker, start: p, data: p + 2, end: p + 2, loc };
    if (p + 4 > end) run.stop(D.Truncated, `the ${markerName(marker)} segment is cut short`, loc);
    const length = (await read(p + 2, 2)).u16(0);
    if (length < 2) run.stop(D.BadHeader, `the ${markerName(marker)} segment's length is ${length}`, loc);
    if (p + 2 + length > end) run.stop(D.Truncated, `the ${markerName(marker)} segment runs past the codestream`, loc);
    run.block();
    return { marker, start: p, data: p + 4, end: p + 2 + length, loc };
  };

  const soc = await segment(start);
  if (soc.marker !== SOC) run.stop(D.BadHeader, 'the codestream does not start with SOC', soc.loc);
  const sizSeg = await segment(soc.end);
  if (sizSeg.marker !== SIZ) run.stop(D.BadLayout, 'SIZ does not follow SOC', sizSeg.loc);
  const siz = await readSiz(run, sizSeg);
  const cb = siz.components < 257 ? 1 : 2;
  const plan: CodestreamPlan = { start, end: start, siz, removable: [], parts: [], tlm: [] };
  const tlms: Array<{ z: number; first: number; count: number; st: number; sp: number }> = [];

  const component = (seg: Segment, v: View, at: number) => {
    const c = cb === 1 ? v.u8(at) : v.u16(at);
    if (c >= siz.components) run.stop(D.BadHeader, `${markerName(seg.marker)} names component ${c} of ${siz.components}`, seg.loc);
  };
  const removable = (seg: Segment, part: number, finding: DefuseFinding) => plan.removable.push({ start: seg.start, end: seg.end, part, findings: [finding] });
  const unknown = (seg: Segment, part: number) =>
    removable(seg, part, run.extra(seg.loc, seg.start, seg.end, { block: `${markerName(seg.marker)} segment`, reason: 'a marker segment JPEG 2000 does not define here' }));

  /** Checks a marker segment either header can hold. Returns false for one this does not know. */
  const common = async (seg: Segment, part: number): Promise<boolean> => {
    if (seg.end === seg.data) {
      // A reserved marker without a length.
      unknown(seg, part);
      return true;
    }
    const n = seg.end - seg.start - 2;
    const v = await read(seg.start + 2, n);
    switch (seg.marker) {
      case COD:
        codingStyle(run, seg, v, 0, siz, true);
        return true;
      case COC:
        if (n < 3 + cb) run.stop(D.BadHeader, 'COC is cut short', seg.loc);
        component(seg, v, 2);
        codingStyle(run, seg, v, cb, siz, false);
        return true;
      case QCD:
        if (n < 4) run.stop(D.BadHeader, 'QCD is cut short', seg.loc);
        quantization(run, seg, v, 2, siz);
        return true;
      case QCC:
        if (n < 4 + cb) run.stop(D.BadHeader, 'QCC is cut short', seg.loc);
        component(seg, v, 2);
        quantization(run, seg, v, 2 + cb, siz);
        return true;
      case RGN:
        if (n !== 4 + cb) run.stop(D.BadHeader, `RGN is ${n} bytes`, seg.loc);
        component(seg, v, 2);
        return true;
      case POC: {
        const size = 5 + 2 * cb;
        if (n < 2 + size || (n - 2) % size !== 0) run.stop(D.BadHeader, `POC is ${n} bytes`, seg.loc);
        for (let at = 2; at < n; at += size) {
          const rs = v.u8(at);
          const cs = cb === 1 ? v.u8(at + 1) : v.u16(at + 1);
          const re = v.u8(at + 3 + cb);
          const ce = (cb === 1 ? v.u8(at + 4 + cb) : v.u16(at + 4 + cb)) || (cb === 1 ? 256 : 16384);
          if (rs >= re || re > MAX_LEVELS + 1 || cs >= ce || v.u8(at + size - 1) > 4) run.stop(D.BadHeader, 'a POC progression change names an empty range or an unknown order', seg.loc);
        }
        return true;
      }
      case COM: {
        if (n < 4) run.stop(D.BadHeader, 'COM is cut short', seg.loc);
        const binary = v.u16(2) === 0;
        removable(seg, part, run.metadata(D.Comment, seg.loc, seg.start, seg.end, { bytes: n - 4, ...(binary ? { binary: 'yes' } : {}) }));
        return true;
      }
      case SEC:
        throw new StopError(C.Format, D.Unsupported, 'JPSEC is not read by this version', { format: 'JPSEC' }, seg.loc);
      default:
        if (!PART2.has(seg.marker)) return false;
        if (!siz.part2) run.stop(D.BadLayout, `${markerName(seg.marker)} is a Part 2 marker in a codestream that does not declare Part 2`, seg.loc);
        return true;
    }
  };

  // The main header, up to the first SOT.
  const seen = new Set<number>();
  let ppm = false;
  let s = await segment(sizSeg.end);
  while (s.marker !== SOT) {
    run.time();
    if (s.marker === SIZ || s.marker === SOC || s.marker === SOD || s.marker === EOC) run.stop(D.BadLayout, `${markerName(s.marker)} in the main header`, s.loc);
    if ((s.marker === COD || s.marker === QCD) && seen.has(s.marker)) run.stop(D.BadLayout, `a second ${markerName(s.marker)} in the main header`, s.loc);
    seen.add(s.marker);
    if (!(await common(s, -1))) {
      const n = s.end - s.start - 2;
      switch (s.marker) {
        case TLM: {
          if (n < 4) run.stop(D.BadHeader, 'TLM is cut short', s.loc);
          const v = await read(s.data, 2);
          const stlm = v.u8(1);
          const st = (stlm >> 4) & 3;
          const sp = (stlm >> 6) & 1;
          const size = st + (sp ? 4 : 2);
          if (stlm & 0x8f || st === 3 || (n - 4) % size !== 0) run.stop(D.BadHeader, 'TLM has an impossible entry size', s.loc);
          tlms.push({ z: v.u8(0), first: s.data + 2, count: (n - 4) / size, st, sp });
          break;
        }
        case PLM:
        case PPM:
          if (n < 3) run.stop(D.BadHeader, `${markerName(s.marker)} is cut short`, s.loc);
          if (s.marker === PPM) ppm = true;
          break;
        case CRG:
          if (n !== 2 + 4 * siz.components) run.stop(D.BadHeader, `CRG is ${n} bytes for ${siz.components} components`, s.loc);
          break;
        case CAP:
          if (n < 6) run.stop(D.BadHeader, 'CAP is cut short', s.loc);
          break;
        case CPF:
          break;
        default:
          unknown(s, -1);
      }
    }
    s = await segment(s.end);
  }
  if (!seen.has(COD) || !seen.has(QCD)) run.stop(D.BadLayout, `the main header has no ${seen.has(COD) ? 'QCD' : 'COD'}`, s.loc);

  // Tile-parts: SOT, the tile-part header, SOD and the data, until EOC.
  const tiles = new Map<number, { next: number; total: number }>();
  const tileOf: number[] = [];
  while (s.marker === SOT) {
    run.time();
    const sot = s;
    if (sot.end - sot.start !== 12) run.stop(D.BadHeader, `SOT is ${sot.end - sot.start - 2} bytes`, sot.loc);
    const v = await read(sot.data, 8);
    const tile = v.u16(0);
    const psot = v.u32(2);
    const index = v.u8(6);
    const total = v.u8(7);
    if (tile >= siz.tiles) run.stop(D.BadHeader, `SOT names tile ${tile} of ${siz.tiles}`, sot.loc);
    const state = tiles.get(tile) ?? { next: 0, total: 0 };
    if (index !== state.next) run.stop(D.BadLayout, `tile ${tile}'s tile-part ${index} comes where ${state.next} should`, sot.loc);
    if (total !== 0 && (index >= total || (state.total !== 0 && total !== state.total))) run.stop(D.BadHeader, `tile ${tile} gives its tile-part count as ${total}`, sot.loc);
    if (state.total !== 0 && index >= state.total) run.stop(D.BadLayout, `tile ${tile} has more tile-parts than its count of ${state.total}`, sot.loc);
    tiles.set(tile, { next: index + 1, total: total || state.total });
    if (psot !== 0 && psot < 14) run.stop(D.BadHeader, `Psot is ${psot}`, sot.loc);
    let partEnd: number;
    if (psot === 0) {
      // The last tile-part runs to EOC, which must then end the codestream.
      if (end - sot.start < 16 || (await read(end - 2, 2)).u16(0) !== EOC) run.stop(D.Truncated, 'a tile-part that runs to EOC has none at the end', sot.loc);
      partEnd = end - 2;
    } else {
      partEnd = sot.start + psot;
      if (partEnd > end) run.stop(D.Truncated, 'a tile-part runs past the codestream', sot.loc);
    }
    const part = plan.parts.length;
    plan.parts.push({ sot: sot.start, psot, length: partEnd - sot.start });
    tileOf.push(tile);
    run.block();
    let h = await segment(sot.end);
    for (; h.marker !== SOD; h = await segment(h.end)) {
      run.time();
      if (h.end > partEnd) run.stop(D.BadLayout, `${markerName(h.marker)} runs past its tile-part`, h.loc);
      if (h.marker === SOT || h.marker === EOC || h.marker === SIZ || h.marker === SOC) run.stop(D.BadLayout, `${markerName(h.marker)} in a tile-part header`, h.loc);
      if (index > 0 && (h.marker === COD || h.marker === COC || h.marker === QCD || h.marker === QCC)) run.stop(D.BadLayout, `${markerName(h.marker)} after a tile's first tile-part`, h.loc);
      if (await common(h, part)) continue;
      if (h.marker === PLT || h.marker === PPT) {
        if (h.end - h.start < 5) run.stop(D.BadHeader, `${markerName(h.marker)} is cut short`, h.loc);
        if (h.marker === PPT && ppm) run.stop(D.BadLayout, 'PPT in a codestream whose main header has PPM', h.loc);
        continue;
      }
      unknown(h, part);
    }
    if (h.end > partEnd) run.stop(D.BadLayout, 'SOD runs past its tile-part', h.loc);
    s = await segment(partEnd);
  }
  if (s.marker !== EOC) run.stop(D.BadLayout, `${markerName(s.marker)} where a tile-part or EOC should be`, s.loc);
  if (!plan.parts.length) run.stop(D.BadLayout, 'the codestream has no tile-parts', s.loc);
  plan.end = s.end;

  // TLM gives every tile-part's tile and length, in order. A reader that seeks by it must find what one that walks finds.
  if (tlms.length) {
    tlms.sort((a, b) => a.z - b.z);
    const entries: Array<{ tile: number; at: number; size: number }> = [];
    for (const t of tlms) {
      const size = t.st + (t.sp ? 4 : 2);
      const v = await read(t.first, t.count * size);
      for (let i = 0; i < t.count; i++) {
        const tile = t.st === 0 ? entries.length : t.st === 1 ? v.u8(i * size) : v.u16(i * size);
        entries.push({ tile, at: t.first + i * size + t.st, size: t.sp ? 4 : 2 });
      }
    }
    let why: string | undefined;
    if (entries.length !== plan.parts.length) why = `TLM lists ${entries.length} tile-parts and the codestream holds ${plan.parts.length}`;
    for (let i = 0; !why && i < entries.length; i++) {
      const e = entries[i];
      const v = await read(e.at, e.size);
      const length = e.size === 2 ? v.u16(0) : v.u32(0);
      if (length !== plan.parts[i].length || e.tile !== tileOf[i]) why = `TLM gives tile-part ${i} as tile ${e.tile} of ${length} bytes, and it is tile ${tileOf[i]} of ${plan.parts[i].length}`;
    }
    if (why) run.report(C.Structure, D.Ambiguous, `${where}TLM`, { reason: why });
    else plan.tlm = entries.map(e => ({ at: e.at, size: e.size }));
  }
  await run.gap(plan.end, end, after);
  return plan;
}

/**
 * The codestream as the rewrite writes it: without the comments and unknown segments its findings remove, with the
 * Psot of each tile-part that lost one, and its TLM entry, written again. Bytes after EOC go. `changed` says whether
 * the bytes differ from [start, end) of the input.
 */
export function codestreamPieces(run: Run, plan: CodestreamPlan, end: number): { pieces: Piece[]; changed: boolean } {
  const region = new Region(plan.start, plan.end);
  const removed = new Map<number, number>();
  let changed = plan.end !== end;
  for (const x of plan.removable) {
    if (!run.drops(x.findings, x.start, x.end)) continue;
    region.remove(x.start, x.end);
    changed = true;
    if (x.part >= 0) removed.set(x.part, (removed.get(x.part) ?? 0) + x.end - x.start);
  }
  for (const [i, n] of removed) {
    const part = plan.parts[i];
    if (part.psot !== 0) region.patch(part.sot + 6, 4, () => u32(part.psot - n));
    const t = plan.tlm[i];
    if (t) region.patch(t.at, t.size, () => (t.size === 2 ? u16(part.length - n) : u32(part.length - n)));
  }
  return { pieces: region.pieces(), changed };
}
