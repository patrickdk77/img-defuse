import { type PhotoshopEdit, photoshopEdits } from './blocks';
import type { Contained, Run } from './context';
import { type ExifPlan, exifPieces, inspectExif } from './exif';
import { InflateError, inflateChunks } from './inflate';
import { checkIcc, hasDoctype, photoshopResources } from './metadata';
import { bytes, lengthOf, type Piece, Region, u32, u64 } from './rewrite';
import { fileSlice, latin1, View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

type Findings = Array<DefuseFinding | undefined>;

/** Global tagged blocks whose length is 8 bytes in PSB (Adobe Photoshop File Format, Additional Layer Information). */
const BIG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']);

/** Keys of tagged blocks that Photoshop and psd-tools know. Any other is a block readers skip. */
const KNOWN_KEYS = new Set(
  (
    'abdd anFX Anno artb artd blnc blwh brit brst CgEd cinf clbl clrL curv expA FEid ffxi FMsk FXid fxrp GdFl grdm hue2 infx ' +
    'knko lclr levl lfx2 lmgm LMsk lnk2 lnk3 lnkD lnkE lnsr lrFX lsct lsdk lspf luni lyid lyvr mixr Mt16 Mt32 Mtrn nvrt Pat2 ' +
    'Pat3 Patt phfl plLd PlLd post PtFl pths PxSc PxSD selc shmd shpa sn2P SoCo SoLd SoLE thrs tsly Txt2 tySh TySh vibA vmgm ' +
    'vmsk vogk vscg vsms vstk Lr16 Lr32 Layr Alph extd extn FELS frgb iOpa lmfx lfxs vowv patt GenI OCIO'
  )
    .split(' ')
    .concat(['hue ', 'CAI ']),
);

const LINKED_KEYS = new Set(['lnk2', 'lnkD', 'lnk3', 'lnkE']);

/** MIME types for the file types a linked file names. */
const FILE_TYPES: Record<string, string> = {
  'PNG ': 'image/png',
  JPEG: 'image/jpeg',
  TIFF: 'image/tiff',
  GIFf: 'image/gif',
  '8BPS': 'image/vnd.adobe.photoshop',
  '8BPB': 'image/vnd.adobe.photoshop',
  'PDF ': 'application/pdf',
};

/** A length field the rewrite writes again for what it measures, [start, end) of the file. */
interface Container {
  at: number;
  size: 4 | 8;
  start: number;
  end: number;
}

/** A range the rewrite removes when one of its findings says so. */
interface Optional {
  start: number;
  end: number;
  findings: Findings;
}

/** A linked file: an item of a linked layer block, and its data when it holds a copy of the file. */
interface LinkedItem {
  start: number;
  /** After the item's padding to four bytes. */
  end: number;
  bodyStart: number;
  bodyEnd: number;
  /** Where the item gives the length of its data. */
  dataAt: number;
  dataStart: number;
  dataLength: number;
  findings: Findings;
  contained?: Contained;
}

export interface PsdPlan {
  /** After the composite image data. Bytes after it are trailing data. */
  end: number;
  containers: Container[];
  optional: Optional[];
  /** Hidden data inside a structure, which the rewrite overwrites with zeros. */
  zeroed: Array<[number, number]>;
  /** The image resources: where their data starts, and the thumbnails in them. */
  resources: { base: number; edits: PhotoshopEdit[] };
  /** EXIF resources, which the rewrite edits in place: the resource, its size field, and its TIFF structure. */
  exifs: Array<{ start: number; end: number; sizeAt: number; dataStart: number; exif: ExifPlan }>;
  linked: LinkedItem[];
}

/** Why a linked layer block does not parse. */
class Malformed extends Error {}

/** Reads fields one after another inside [pos, end), failing with Malformed past the end. */
class Cursor {
  constructor(
    private readonly run: Run,
    public pos: number,
    readonly end: number,
  ) {}
  private need(n: number): void {
    if (this.pos + n > this.end) throw new Malformed('a field runs past the end of its item');
  }
  async view(n: number): Promise<View> {
    this.need(n);
    const v = new View(await this.run.reader.read(this.pos, n));
    this.pos += n;
    return v;
  }
  async u8(): Promise<number> {
    return (await this.view(1)).u8(0);
  }
  async u32(): Promise<number> {
    return (await this.view(4)).u32(0);
  }
  async u64(): Promise<number> {
    const v = (await this.view(8)).u64(0);
    if (v === undefined) throw new Malformed('a length is past 2^53');
    return v;
  }
  async type(): Promise<string> {
    return (await this.view(4)).ascii(0, 4);
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

/** A Unicode string: a count of UTF-16 code units, then the units. */
async function skipUnicode(c: Cursor): Promise<void> {
  c.skip((await c.u32()) * 2);
}

/** A descriptor key or class ID: a length, then that many bytes, or four when the length is 0. */
async function skipKey(c: Cursor): Promise<void> {
  const n = await c.u32();
  c.skip(n || 4);
}

const MAX_NESTING = 64;

/** Skips a descriptor body: a name, a class ID and its items (Adobe Photoshop File Format, Descriptor structure). */
async function skipDescriptor(run: Run, c: Cursor, depth: number): Promise<void> {
  if (depth > MAX_NESTING) throw new Malformed(`descriptors nest more than ${MAX_NESTING} deep`);
  await skipUnicode(c);
  await skipKey(c);
  const count = await c.u32();
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) run.time();
    await skipKey(c);
    await skipValue(run, c, await c.type(), depth + 1);
  }
}

/** Skips one item of a descriptor or a list, of type `t`. */
async function skipValue(run: Run, c: Cursor, t: string, depth: number): Promise<void> {
  if (depth > MAX_NESTING) throw new Malformed(`descriptors nest more than ${MAX_NESTING} deep`);
  switch (t) {
    case 'obj ': {
      const count = await c.u32();
      for (let i = 0; i < count; i++) {
        if ((i & 1023) === 0) run.time();
        await skipReference(c, await c.type());
      }
      return;
    }
    case 'Objc':
    case 'GlbO':
      return skipDescriptor(run, c, depth);
    case 'VlLs': {
      const count = await c.u32();
      for (let i = 0; i < count; i++) {
        if ((i & 1023) === 0) run.time();
        await skipValue(run, c, await c.type(), depth + 1);
      }
      return;
    }
    case 'doub':
    case 'comp':
      c.skip(8);
      return;
    case 'UntF':
      c.skip(12);
      return;
    case 'UnFl': {
      c.skip(4);
      c.skip((await c.u32()) * 8);
      return;
    }
    case 'TEXT':
      return skipUnicode(c);
    case 'enum':
      await skipKey(c);
      return skipKey(c);
    case 'long':
      c.skip(4);
      return;
    case 'bool':
      c.skip(1);
      return;
    case 'type':
    case 'GlbC':
      await skipUnicode(c);
      return skipKey(c);
    case 'alis':
    case 'tdta':
    case 'Pth ':
      c.skip(await c.u32());
      return;
    case 'ObAr':
      c.skip(4);
      return skipDescriptor(run, c, depth);
    default:
      throw new Malformed(`a descriptor holds an item of type "${t.replace(/[^\x20-\x7e]/g, '?')}", which this version does not read`);
  }
}

/** Skips one item of a reference. */
async function skipReference(c: Cursor, t: string): Promise<void> {
  switch (t) {
    case 'prop':
      await skipUnicode(c);
      await skipKey(c);
      return skipKey(c);
    case 'Clss':
      await skipUnicode(c);
      return skipKey(c);
    case 'Enmr':
      await skipUnicode(c);
      await skipKey(c);
      await skipKey(c);
      return skipKey(c);
    case 'rele':
      await skipUnicode(c);
      await skipKey(c);
      c.skip(4);
      return;
    case 'Idnt':
    case 'indx':
      c.skip(4);
      return;
    case 'name':
      await skipUnicode(c);
      await skipKey(c);
      return skipUnicode(c);
    default:
      throw new Malformed(`a reference holds an item of type "${t.replace(/[^\x20-\x7e]/g, '?')}", which this version does not read`);
  }
}

/** A descriptor block: a version, then a descriptor. */
async function skipDescriptorBlock(run: Run, c: Cursor): Promise<void> {
  c.skip(4);
  await skipDescriptor(run, c, 0);
}

const align4 = (n: number) => (n + 3) & ~3;

/** What a pass over a linked layer item finds, before any finding is made. */
interface ParsedItem {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  kind: string;
  name: string;
  fileType: string;
  dataAt: number;
  data?: [number, number];
}

/**
 * Parses one item of a linked layer block (Adobe Photoshop File Format, Linked Layer): its kind, version, unique ID,
 * file name, file type and creator, the length of its data, an optional descriptor of open parameters, then for an
 * external link a descriptor of the linked file, a timestamp from version 4 and the file's size, then the data, then
 * from version 5 a child document ID, from 6 a modification time and from 7 a lock state.
 */
async function parseItem(run: Run, start: number, bodyStart: number, bodyEnd: number, end: number): Promise<ParsedItem> {
  const c = new Cursor(run, bodyStart, bodyEnd);
  const kind = await c.type();
  if (kind !== 'liFD' && kind !== 'liFE' && kind !== 'liFA') throw new Malformed(`an item of kind "${kind.replace(/[^\x20-\x7e]/g, '?')}"`);
  const version = await c.u32();
  if (version < 1 || version > 7) throw new Malformed(`an item of version ${version}`);
  c.skip(await c.u8());
  const units = await c.u32();
  const nameAt = c.pos;
  c.skip(units * 2);
  // Photoshop's Unicode strings are UTF-16 big-endian.
  const raw = Buffer.from(await run.reader.read(nameAt, Math.min(units * 2, 512)));
  const name = raw
    .subarray(0, raw.length & ~1)
    .swap16()
    .toString('utf16le')
    .split('\0')[0];
  const fileType = await c.type();
  c.skip(4);
  const dataAt = c.pos;
  const dataLength = await c.u64();
  if ((await c.u8()) !== 0) await skipDescriptorBlock(run, c);
  const item: ParsedItem = { start, end, bodyStart, bodyEnd, kind, name, fileType, dataAt };
  const takeData = () => {
    item.data = [c.pos, dataLength];
    c.skip(dataLength);
  };
  if (kind === 'liFE') {
    await skipDescriptorBlock(run, c);
    if (version > 3) c.skip(16);
    c.skip(8);
    if (version > 2) takeData();
  } else if (kind === 'liFA') c.skip(8);
  else takeData();
  if (version >= 5) await skipUnicode(c);
  if (version >= 6) c.skip(8);
  if (version >= 7) c.skip(1);
  if (kind === 'liFE' && version === 2) takeData();
  if (c.pos < bodyEnd && !(await allZeroRange(run, c.pos, bodyEnd))) throw new Malformed('an item holds bytes after its last field');
  return item;
}

async function allZeroRange(run: Run, start: number, end: number): Promise<boolean> {
  for await (const b of run.reader.chunks(start, end - start)) {
    run.time();
    if (b.some(x => x !== 0)) return false;
  }
  return true;
}

/** Everything the walk of the file collects for the rewrite. */
interface Walk {
  run: Run;
  big: boolean;
  depth: number;
  /** Room the layer and mask section has to grow, for a linked file a plugin rewrites. */
  room: number;
  plan: PsdPlan;
}

/** Hidden data at [start, end) inside a structure: reported unless it is all zero, and overwritten with zeros. */
async function hidden(w: Walk, start: number, end: number): Promise<void> {
  if (end <= start) return;
  await w.run.gap(start, end, 'hidden');
  w.plan.zeroed.push([start, end]);
}

/** Reads a linked layer block, [start, end) of the file, and reports each linked file. */
async function linkedLayers(w: Walk, blockStart: number, start: number, end: number, loc: string): Promise<void> {
  const run: Run = w.run;
  const parsed: ParsedItem[] = [];
  try {
    let q = start;
    while (q < end) {
      run.time();
      if (end - q < 8) {
        if (!(await allZeroRange(run, q, end))) throw new Malformed('the block ends with bytes that are not an item');
        break;
      }
      const length = new View(await run.reader.read(q, 8)).u64(0);
      if (length === undefined || q + 8 + length > end) throw new Malformed('an item runs past the end of its block');
      run.block();
      const itemEnd = Math.min(end, q + 8 + align4(length));
      parsed.push(await parseItem(run, q, q + 8, q + 8 + length, itemEnd));
      q = itemEnd;
    }
  } catch (e) {
    if (!(e instanceof Malformed)) throw e;
    w.plan.optional.push({ start: blockStart, end, findings: [run.malformed(loc, blockStart, end, `linked layers: ${e.message}`)] });
    return;
  }
  for (const p of parsed) {
    const itemLoc = `${loc}, item at ${p.start}`;
    const item: LinkedItem = { start: p.start, end: p.end, bodyStart: p.bodyStart, bodyEnd: p.bodyEnd, dataAt: p.dataAt, dataStart: p.data?.[0] ?? 0, dataLength: p.data?.[1] ?? 0, findings: [] };
    let kept = true;
    if (p.kind !== 'liFD') {
      run.droppableRange(p.start, p.end);
      const link = run.report(C.External, D.LinkedFile, itemLoc, { target: p.name });
      item.findings.push(link);
      kept = run.keeps(link);
    }
    if (p.data && p.data[1] > 0) {
      item.contained = await run.contained(itemLoc, 'linked file', p.data[0], p.data[1], FILE_TYPES[p.fileType], kept, p.data[1] + w.room);
    }
    w.plan.containers.push({ at: p.start, size: 8, start: p.bodyStart, end: p.bodyEnd });
    w.plan.linked.push(item);
  }
}

/**
 * Reads layer info: a count, the layer records and their channel image data, in [start, end) of the file. The layers
 * are checked against the pixel and decoded size limits, and their channels for their lengths and compression codes.
 * No channel is decoded.
 */
async function layerInfo(w: Walk, start: number, end: number, where: string, depth: number): Promise<void> {
  const run: Run = w.run;
  const r = run.reader;
  if (depth > 4) run.stop(D.BadLayout, 'layer info nests inside layer info', where);
  if (end - start < 2) run.stop(D.Truncated, 'the layer count is cut short', where);
  const count = Math.abs(new View(await r.read(start, 2)).i16(0));
  const lengthSize = w.big ? 8 : 4;
  const layers: Array<{ channels: Array<{ id: number; length: number }>; loc: string }> = [];
  let q = start + 2;
  for (let i = 0; i < count; i++) {
    run.time();
    run.block();
    const loc = `${where}layer ${i} at ${q}`;
    if (q + 18 > end) run.stop(D.Truncated, `layer record ${i} is cut short`, loc);
    const v = new View(await r.read(q, 18));
    const top = v.i32(0);
    const left = v.i32(4);
    const bottom = v.i32(8);
    const right = v.i32(12);
    const channelCount = v.u16(16);
    if (bottom < top || right < left) run.stop(D.BadHeader, `layer ${i} runs from ${left}, ${top} to ${right}, ${bottom}`, loc);
    q += 18;
    const entry = 2 + lengthSize;
    if (q + channelCount * entry + 16 > end) run.stop(D.Truncated, `layer record ${i} is cut short`, loc);
    const cv = new View(await r.read(q, channelCount * entry));
    const channels: Array<{ id: number; length: number }> = [];
    for (let k = 0; k < channelCount; k++) {
      const length = w.big ? cv.u64(k * entry + 2) : cv.u32(k * entry + 2);
      if (length === undefined) run.stop(D.BadHeader, `a channel of layer ${i} has a length past 2^53`, loc);
      channels.push({ id: cv.i16(k * entry), length });
    }
    run.block(channelCount);
    q += channelCount * entry;
    const b = new View(await r.read(q, 16));
    if (b.ascii(0, 4) !== '8BIM') run.stop(D.BadHeader, `layer ${i} has no blend mode signature`, loc);
    const extraLength = b.u32(12);
    const extraStart = q + 16;
    const extraEnd = extraStart + extraLength;
    if (extraEnd > end) run.stop(D.Truncated, `the extra data of layer ${i} runs past the layer info`, loc);
    w.plan.containers.push({ at: q + 12, size: 4, start: extraStart, end: extraEnd });
    // Layer mask data, blending ranges and the name, padded to four bytes, then the layer's tagged blocks.
    let x = extraStart;
    const sized = async (what: string) => {
      if (x + 4 > extraEnd) run.stop(D.Truncated, `the ${what} of layer ${i} is cut short`, loc);
      const n = new View(await r.read(x, 4)).u32(0);
      if (x + 4 + n > extraEnd) run.stop(D.Truncated, `the ${what} of layer ${i} runs past its extra data`, loc);
      const at = x + 4;
      x += 4 + n;
      return [at, n];
    };
    const [maskAt, maskLength] = await sized('mask data');
    await sized('blending ranges');
    if (x + 1 > extraEnd) run.stop(D.Truncated, `the name of layer ${i} is cut short`, loc);
    x += align4(1 + (await r.read(x, 1))[0]);
    if (x > extraEnd) run.stop(D.Truncated, `the name of layer ${i} runs past its extra data`, loc);
    await taggedBlocks(w, x, extraEnd, `${loc}, `, false, depth);
    // Every channel decodes to the layer's rectangle, and a mask to the mask's.
    const width = right - left;
    const height = bottom - top;
    let maskWidth = width;
    let maskHeight = height;
    if (maskLength >= 16) {
      const m = new View(await r.read(maskAt, 16));
      const mt = m.i32(0);
      const ml = m.i32(4);
      const mb = m.i32(8);
      const mr = m.i32(12);
      if (mb < mt || mr < ml) run.stop(D.BadHeader, `the mask of layer ${i} runs from ${ml}, ${mt} to ${mr}, ${mb}`, loc);
      maskWidth = mr - ml;
      maskHeight = mb - mt;
    }
    const bytesPer = (wd: number) => Math.ceil((wd * w.depth) / 8);
    let decoded = 0;
    for (const ch of channels) decoded += ch.id === -2 || ch.id === -3 ? bytesPer(maskWidth) * maskHeight : bytesPer(width) * height;
    run.inner(Math.max(width, maskWidth), Math.max(height, maskHeight), decoded, loc);
    layers.push({ channels, loc });
    q = extraEnd;
  }
  // Channel image data, in layer order.
  for (const layer of layers) {
    for (const ch of layer.channels) {
      run.time();
      if (ch.length === 0) continue;
      if (ch.length === 1) run.stop(D.BadHeader, 'a channel of 1 byte has no room for its compression code', `${layer.loc}, channel at ${q}`);
      if (q + ch.length > end) run.stop(D.Truncated, 'channel image data runs past the layer info', `${layer.loc}, channel at ${q}`);
      const compression = new View(await r.read(q, 2)).u16(0);
      if (compression > 3) run.stop(D.BadHeader, `a channel names compression ${compression}`, `${layer.loc}, channel at ${q}`);
      q += ch.length;
    }
  }
  await hidden(w, q, end);
}

/**
 * Reads tagged blocks in [start, end): a signature, a key, a length and the data. `atEnd` marks the blocks at the end
 * of the layer and mask section, which psd-tools reads padded to four bytes.
 */
async function taggedBlocks(w: Walk, start: number, end: number, where: string, atEnd: boolean, depth: number): Promise<void> {
  const run: Run = w.run;
  const r = run.reader;
  let q = start;
  while (q < end) {
    run.time();
    if (end - q < 12) {
      await hidden(w, q, end);
      return;
    }
    const h = new View(await r.read(q, 12));
    const sig = h.ascii(0, 4);
    if (sig !== '8BIM' && sig !== '8B64') {
      // Readers stop at a block without a signature, so the rest is data nothing reads.
      await hidden(w, q, end);
      return;
    }
    const key = h.ascii(4, 4);
    const lengthSize = w.big && BIG_KEYS.has(key) ? 8 : 4;
    let length: number | undefined;
    if (lengthSize === 4) length = h.u32(8);
    else length = new View(await r.read(q + 8, 8)).u64(0);
    const dataStart = q + 8 + lengthSize;
    const loc = `${where}${key.replace(/[^\x20-\x7e]/g, '?')} block at ${q}`;
    if (length === undefined) run.stop(D.BadHeader, 'a tagged block has a length past 2^53', loc);
    const dataEnd = dataStart + length;
    if (dataEnd > end) run.stop(D.Truncated, 'a tagged block runs past what holds it', loc);
    run.block();
    // Padding to four bytes after a global block, when what follows it is another block.
    let blockEnd = dataEnd;
    if (atEnd && length % 4 !== 0) {
      const pad = 4 - (length % 4);
      if (dataEnd + pad + 4 <= end) {
        const after = await r.read(dataEnd, pad + 4);
        const next = latin1(after.subarray(pad));
        if (after.subarray(0, pad).every(x => x === 0) && (next === '8BIM' || next === '8B64')) blockEnd = dataEnd + pad;
      }
    }
    if (LINKED_KEYS.has(key)) {
      w.plan.containers.push({ at: q + 8, size: lengthSize, start: dataStart, end: dataEnd });
      await linkedLayers(w, q, dataStart, dataEnd, loc);
    } else if (key === 'Lr16' || key === 'Lr32') {
      w.plan.containers.push({ at: q + 8, size: lengthSize, start: dataStart, end: dataEnd });
      if (length > 0) await layerInfo(w, dataStart, dataEnd, `${loc}, `, depth + 1);
    } else if (key === 'Anno') {
      w.plan.optional.push({ start: q, end: blockEnd, findings: [run.metadata(D.Comment, loc, q, blockEnd, { bytes: length })] });
    } else if (!KNOWN_KEYS.has(key)) {
      w.plan.optional.push({ start: q, end: blockEnd, findings: [run.extra(loc, q, blockEnd, { block: `${key.replace(/[^\x20-\x7e]/g, '?')} block` })] });
    }
    q = blockEnd;
  }
}

/** Reports the image resources at [start, end) of the file, one by one. */
async function imageResources(w: Walk, start: number, end: number): Promise<void> {
  const run: Run = w.run;
  const r = run.reader;
  w.plan.resources.base = start;
  if (end === start) return;
  const res = await photoshopResources(fileSlice(r, start, end - start));
  const where = `image resources at ${start - 4}`;
  if (typeof res === 'string') {
    w.plan.optional.push({ start, end, findings: [run.malformed(where, start, end, res)] });
    return;
  }
  run.block(res.resources.length);
  // The section's length is 32 bits, so a rewritten thumbnail can grow it by what is left.
  const room = 0xffffffff - (end - start);
  for (const rs of res.resources) {
    run.time();
    const s = start + rs.start;
    const e = start + rs.end;
    const ds = start + rs.dataStart;
    const n = rs.dataEnd - rs.dataStart;
    const loc = `resource 0x${rs.id.toString(16).padStart(4, '0')} at ${s}`;
    const optional = (...findings: Findings) => w.plan.optional.push({ start: s, end: e, findings });
    if (rs.signature !== '8BIM') continue;
    switch (rs.id) {
      case 0x0404:
        optional(run.metadata(D.Iptc, loc, s, e, { bytes: n }));
        break;
      case 0x0422:
      case 0x0423: {
        const exif = await inspectExif(run, fileSlice(r, ds, n), loc, s, e, room);
        w.plan.exifs.push({ start: s, end: e, sizeAt: ds - 4, dataStart: ds, exif });
        break;
      }
      case 0x0424:
        optional(run.metadata(D.Xmp, loc, s, e, { bytes: n }), (await hasDoctype(fileSlice(r, ds, n).chunks())) ? run.report(C.Metadata, D.Doctype, loc) : undefined);
        break;
      case 0x040f: {
        const why = await checkIcc(fileSlice(r, ds, n));
        optional(why ? run.malformed(loc, s, e, why) : run.metadata(D.IccProfile, loc, s, e, { bytes: n }));
        break;
      }
      case 0x041a:
        optional(run.metadata(D.Other, loc, s, e, { kind: 'slices, which can hold URLs' }));
        break;
      case 0x041e:
        optional(run.metadata(D.Other, loc, s, e, { kind: 'URL list' }));
        break;
      case 0x040b:
        optional(run.metadata(D.Other, loc, s, e, { kind: 'URL' }));
        break;
      case 0x041b:
        optional(run.metadata(D.Other, loc, s, e, { kind: 'workflow URL' }));
        break;
      case 0x03f0:
        optional(run.metadata(D.Text, loc, s, e, { keyword: 'caption' }));
        break;
      default:
        break;
    }
  }
  for (const t of res.thumbnails) {
    const at = start + t.offset;
    const loc = `resource at ${start + t.resourceStart}`;
    const thumb = run.metadata(D.Thumbnail, loc, start + t.resourceStart, start + t.resourceEnd, { offset: at, bytes: t.length });
    w.plan.resources.edits.push({ thumbnail: t, contained: await run.contained(loc, 'Photoshop thumbnail', at, t.length, 'image/jpeg', run.keeps(thumb), t.length + room) });
  }
}

const MODES = new Set([0, 1, 2, 3, 4, 7, 8, 9]);

/**
 * Inspects a Photoshop document, PSD or PSB (Adobe Photoshop File Format): the header, the color mode data, each image
 * resource, the layer and mask section with every layer record, the global layer mask and the tagged blocks, and the
 * composite image, which is the file's one image. Layer pixels are not decoded.
 */
export async function inspectPsd(run: Run): Promise<PsdPlan> {
  const r = run.reader;
  const size = run.size;
  if (size < 26) run.stop(D.Truncated, 'the file header is cut short', 'file header');
  const h = new View(await r.read(0, 26));
  const loc = 'file header';
  const version = h.u16(4);
  if (version !== 1 && version !== 2) run.stop(D.BadHeader, `version ${version}`, loc);
  const big = version === 2;
  if (!h.b.subarray(6, 12).every(x => x === 0)) run.stop(D.BadHeader, 'the reserved bytes are not zero', loc);
  const channels = h.u16(12);
  const height = h.u32(14);
  const width = h.u32(18);
  const depth = h.u16(22);
  const mode = h.u16(24);
  const max = big ? 300_000 : 30_000;
  if (channels < 1 || channels > 56) run.stop(D.BadHeader, `${channels} channels`, loc);
  if (width < 1 || height < 1 || width > max || height > max) run.stop(D.BadHeader, `the image is ${width} x ${height}`, loc);
  if (![1, 8, 16, 32].includes(depth)) run.stop(D.BadHeader, `a depth of ${depth} bits`, loc);
  if (!MODES.has(mode)) run.stop(D.BadHeader, `color mode ${mode}`, loc);
  if ((mode === 0) !== (depth === 1) || (mode === 2 && depth !== 8)) run.stop(D.BadHeader, `color mode ${mode} with a depth of ${depth} bits`, loc);
  const rowBytes = Math.ceil((width * depth) / 8);
  const planeBytes = rowBytes * height;
  run.image(width, height, planeBytes * channels, loc);

  const plan: PsdPlan = { end: 0, containers: [], optional: [], zeroed: [], resources: { base: 0, edits: [] }, exifs: [], linked: [] };
  const w: Walk = { run, big, depth, room: 0, plan };
  const sized = async (at: number, what: string, eight = false): Promise<[number, number]> => {
    const n = eight ? 8 : 4;
    if (at + n > size) run.stop(D.Truncated, `the ${what} length is cut short`, `${what} at ${at}`);
    const v = new View(await r.read(at, n));
    const length = eight ? v.u64(0) : v.u32(0);
    if (length === undefined) run.stop(D.BadHeader, `the ${what} length is past 2^53`, `${what} at ${at}`);
    if (at + n + length > size) run.stop(D.Truncated, `the ${what} runs past the end of the file`, `${what} at ${at}`);
    return [at + n, at + n + length];
  };

  // Color mode data: the palette of an indexed image, or the duotone specification.
  const [cmStart, cmEnd] = await sized(26, 'color mode data');
  const cmLength = cmEnd - cmStart;
  if (mode === 2 && cmLength !== 768) run.stop(D.BadHeader, `an indexed image has ${cmLength} bytes of color data`, 'color mode data at 26');
  plan.containers.push({ at: 26, size: 4, start: cmStart, end: cmEnd });
  if (mode !== 2 && mode !== 8 && cmLength > 0) {
    plan.optional.push({ start: cmStart, end: cmEnd, findings: [run.extra('color mode data at 26', cmStart, cmEnd, { block: 'color mode data', reason: 'color data in a mode that has none' })] });
  }

  const [resStart, resEnd] = await sized(cmEnd, 'image resources');
  plan.containers.push({ at: cmEnd, size: 4, start: resStart, end: resEnd });
  await imageResources(w, resStart, resEnd);

  const [lmStart, lmEnd] = await sized(resEnd, 'layer and mask section', big);
  plan.containers.push({ at: resEnd, size: big ? 8 : 4, start: lmStart, end: lmEnd });
  w.room = big ? Number.MAX_SAFE_INTEGER : 0xffffffff - (lmEnd - lmStart);
  if (lmEnd > lmStart) {
    const lmLoc = `layer and mask section at ${resEnd}`;
    const lengthSize = big ? 8 : 4;
    if (lmStart + lengthSize > lmEnd) run.stop(D.Truncated, 'the layer info length is cut short', lmLoc);
    const lv = new View(await r.read(lmStart, lengthSize));
    const liLength = big ? lv.u64(0) : lv.u32(0);
    if (liLength === undefined) run.stop(D.BadHeader, 'the layer info length is past 2^53', lmLoc);
    const liStart = lmStart + lengthSize;
    const liEnd = liStart + liLength;
    if (liEnd > lmEnd) run.stop(D.Truncated, 'the layer info runs past its section', lmLoc);
    plan.containers.push({ at: lmStart, size: lengthSize, start: liStart, end: liEnd });
    if (liLength > 0) await layerInfo(w, liStart, liEnd, '', 0);
    let q = liEnd;
    // The global layer mask info, unless a tagged block follows the layer info at once.
    if (q + 4 <= lmEnd) {
      const sig = latin1(await r.read(q, 4));
      if (sig !== '8BIM' && sig !== '8B64') {
        const gm = new View(await r.read(q, 4)).u32(0);
        if (q + 4 + gm > lmEnd) run.stop(D.Truncated, 'the global layer mask info runs past its section', `global layer mask at ${q}`);
        q += 4 + gm;
      }
    }
    await taggedBlocks(w, q, lmEnd, '', true, 0);
  }

  // The composite image, in planar order: raw, RLE with a table of row lengths, or ZIP.
  const cloc = `image data at ${lmEnd}`;
  if (lmEnd + 2 > size) run.stop(D.Truncated, 'the file ends before the image data', cloc);
  const compression = new View(await r.read(lmEnd, 2)).u16(0);
  const dataStart = lmEnd + 2;
  const expected = planeBytes * channels;
  let end: number;
  if (compression === 0) {
    end = dataStart + expected;
    if (end > size) run.stop(D.Truncated, `the image data needs ${expected} bytes`, cloc);
  } else if (compression === 1) {
    const rows = height * channels;
    const entry = big ? 4 : 2;
    const table = dataStart + rows * entry;
    if (table > size) run.stop(D.Truncated, 'the table of row lengths is cut short', cloc);
    let total = 0;
    const per = 16384;
    for (let i = 0; i < rows; i += per) {
      run.time();
      const n = Math.min(per, rows - i);
      const v = new View(await r.read(dataStart + i * entry, n * entry));
      for (let k = 0; k < n; k++) total += big ? v.u32(k * 4) : v.u16(k * 2);
    }
    end = table + total;
    if (end > size) run.stop(D.Truncated, `the row lengths add up to ${total} bytes past the end of the file`, cloc);
  } else if (compression === 2 || compression === 3) {
    let produced: number;
    let consumed: number;
    try {
      ({ produced, consumed } = await inflateChunks(fileSlice(r, dataStart, size - dataStart).chunks(), expected, () => undefined, run.deadline));
    } catch (e) {
      if (!(e instanceof InflateError)) throw e;
      run.stop(D.BadData, e.kind === 'over' ? `the image data inflates past ${expected} bytes` : `the image data does not inflate: ${e.message}`, cloc);
    }
    if (produced !== expected) run.stop(D.BadData, `the image data inflates to ${produced} bytes where ${expected} are expected`, cloc);
    end = dataStart + consumed;
  } else run.stop(D.BadHeader, `the image data names compression ${compression}`, cloc);
  plan.end = end;
  await run.gap(end, size, 'trailing');
  return plan;
}

/** A length field as the rewrite writes it again. */
const lengthBytes = (n: number, size: 4 | 8) => (size === 8 ? u64(n) : u32(n));

/**
 * The PSD as the rewrite writes it: the file up to the end of the composite image, without the resources, tagged
 * blocks and linked files that go, with hidden data inside a structure overwritten with zeros, and with every length
 * that measures something that changed written again. Pixel data is copied as it is.
 */
export async function psdPieces(run: Run, plan: PsdPlan): Promise<Piece[]> {
  const region = new Region(0, plan.end);
  const removed: Array<[number, number]> = [];
  const remove = (start: number, end: number) => {
    region.remove(start, end);
    removed.push([start, end]);
  };
  const inRemoved = (at: number, n = 1) => removed.some(([s, e]) => at < e && at + n > s);
  for (const o of plan.optional) if (run.drops(o.findings, o.start, o.end)) remove(o.start, o.end);
  // An EXIF resource goes whole, or its TIFF structure is written again without what goes, with the resource's size and
  // padding to match.
  const rewritten: Array<[number, number]> = [];
  for (const x of plan.exifs) {
    if (inRemoved(x.start)) continue;
    const tiff = await exifPieces(run, x.exif, [], x.start, x.end);
    if (!tiff) {
      remove(x.start, x.end);
      continue;
    }
    const first = tiff[0];
    if (tiff.length === 1 && first.kind === 'copy' && first.start === x.dataStart && first.length === x.exif.size) continue;
    const n = lengthOf(tiff);
    region.replace(x.dataStart, x.end, [...tiff, ...(n & 1 ? [bytes(new Uint8Array(1))] : [])]);
    region.patch(x.sizeAt, 4, () => u32(n));
    rewritten.push([x.dataStart, x.end]);
  }
  // Thumbnails that go take their resource; one a plugin rewrote replaces the resource's JPEG data.
  photoshopEdits(run, region, plan.resources.base, plan.resources.edits);
  for (const it of plan.linked) {
    if (inRemoved(it.start)) continue;
    const c = it.contained;
    if (run.drops(it.findings, it.start, it.end) || (c && c.decision === 'drop')) {
      remove(it.start, it.end);
      continue;
    }
    if (c?.decision !== 'replace' || !c.replacement) continue;
    const n = c.replacement.length;
    region.replace(it.dataStart, it.dataStart + it.dataLength, [{ kind: 'source', source: run.replacementSource(c), length: n }]);
    region.patch(it.dataAt, 8, () => u64(n));
    const body = it.bodyEnd - it.bodyStart - it.dataLength + n;
    const pad = (4 - (body % 4)) % 4;
    if (it.end - it.bodyEnd !== pad) region.replace(it.bodyEnd, it.end, pad ? [bytes(new Uint8Array(pad))] : []);
  }
  for (const [s, e] of plan.zeroed) if (!inRemoved(s, e - s) && !rewritten.some(([a, b]) => s < b && e > a)) region.patch(s, e - s, () => new Uint8Array(e - s));
  for (const k of plan.containers) {
    if (inRemoved(k.at, k.size)) continue;
    region.patch(k.at, k.size, () => {
      const start = region.map(k.start);
      const end = region.map(k.end);
      if (start === undefined || end === undefined) throw new Error('a length measures bytes the rewrite removed');
      return lengthBytes(end - start, k.size);
    });
  }
  return region.pieces();
}
