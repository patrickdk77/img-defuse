import { type PhotoshopEdit, photoshopEdits } from './blocks';
import { type Box, boxPieces, isBox, readBox, readBoxes, typeName } from './boxes';
import type { Run } from './context';
import { StopError } from './errors';
import { type ExifPlan, exifPieces, inspectExif } from './exif';
import { type CodestreamPlan, codestreamPieces, inspectCodestream } from './j2k';
import { checkIcc, hasDoctype, photoshopResources } from './metadata';
import { bytes, copy, type Piece, Region } from './rewrite';
import { fileSlice, latin1, View } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding } from './types';

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex');

/** UUID boxes by their UUID, as ExifTool reads them. */
const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac';
const UUID_EXIF = new Set([hex('JpgTiffExif->JP2'), '0537cdab9d0c4431a72afa561f2a113e']);
const UUID_IPTC = new Set(['33c7a4d2b81d4723a0baf1a3e097ad38', '09a14e97c0b442e0bebf36df6f0ce36f']);
const UUID_PHOTOSHOP = '2c4c0100850440b9a03e562148d6dfeb';
const UUID_GEOJP2 = 'b14bf8bd083d4b43a5ae8cd7d5a6ce03';

/** Brands of the JPEG 2000 family this version does not read, when the file does not also list JP2. */
const BRANDS: Record<string, string> = {
  'jpx ': 'JPX',
  'jpm ': 'JPM',
  mjp2: 'Motion JPEG 2000',
  mj2s: 'Motion JPEG 2000',
  'jph ': 'JPH',
};

/** Boxes of JPX (ISO/IEC 15444-2) that a JP2 reader does not use. */
const JPX_ONLY = new Set(['free', 'ftbl', 'cref', 'jpch', 'jplh', 'comp', 'copt', 'inst', 'drep', 'nlst', 'bfil', 'chck', 'mp7b', 'roid', 'lbl ', 'cgrp', 'opct', 'creg', 'mdat']);

type Findings = Array<DefuseFinding | undefined>;

/** A box of the JP2 header box as the rewrite sees it. A colr box with a profile that goes is replaced by an enumerated one. */
type Child = { kind: 'keep'; box: Box } | { kind: 'optional'; box: Box; findings: Findings } | { kind: 'colr'; box: Box; findings: Findings };

/** A top-level box as the rewrite sees it. */
type Item =
  | { kind: 'keep'; box: Box }
  | { kind: 'optional'; box: Box; findings: Findings }
  | { kind: 'header'; box: Box; children: Child[]; grey: boolean }
  | { kind: 'codestream'; box: Box; cs: CodestreamPlan }
  | { kind: 'exif'; box: Box; skip: number; exif: ExifPlan }
  | { kind: 'photoshop'; box: Box; findings: Findings; edits: PhotoshopEdit[] };

export interface Jp2Plan {
  items: Item[];
}

interface Header {
  box: Box;
  width: number;
  height: number;
  components: number;
  bpc: number;
  bpcc?: number[];
  /** The palette's columns. */
  columns?: number;
  cmap?: Array<{ component: number; type: number; column: number }>;
  cdef?: Box;
}

const optional = (box: Box, ...findings: Findings): Item => ({ kind: 'optional', box, findings });

/** Reads the boxes of the JP2 header box and checks each one. */
async function inspectHeader(run: Run, jp2h: Box): Promise<{ children: Child[]; header: Header }> {
  const r = run.reader;
  const boxes = await readBoxes(run, jp2h.data, jp2h.end, `${jp2h.loc}, `);
  if (boxes[0]?.type !== 'ihdr') run.stop(D.BadLayout, 'the JP2 header box does not start with an image header box', jp2h.loc);
  const v0 = new View(await r.read(boxes[0].data, Math.min(14, boxes[0].end - boxes[0].data)));
  if (v0.length !== 14 || boxes[0].end - boxes[0].data !== 14) run.stop(D.BadHeader, `the image header box holds ${boxes[0].end - boxes[0].data} bytes`, boxes[0].loc);
  const header: Header = { box: jp2h, height: v0.u32(0), width: v0.u32(4), components: v0.u16(8), bpc: v0.u8(10) };
  if (header.width === 0 || header.height === 0) run.stop(D.BadHeader, `the image header gives ${header.width} x ${header.height}`, boxes[0].loc);
  if (header.components === 0 || header.components > 16384) run.stop(D.BadHeader, `the image header gives ${header.components} components`, boxes[0].loc);
  if (header.bpc !== 255 && (header.bpc & 0x7f) > 37) run.stop(D.BadHeader, `the image header gives ${(header.bpc & 0x7f) + 1}-bit components`, boxes[0].loc);
  if (v0.u8(11) !== 7) run.stop(D.BadHeader, `the image header names compression type ${v0.u8(11)}`, boxes[0].loc);

  const children: Child[] = [{ kind: 'keep', box: boxes[0] }];
  const seen = new Set<string>(['ihdr']);
  let colours = 0;
  let palette: Box | undefined;
  for (const b of boxes.slice(1)) {
    run.time();
    const n = b.end - b.data;
    const once = () => {
      if (seen.has(b.type)) run.stop(D.BadLayout, `a second ${typeName(b.type)} box in the JP2 header`, b.loc);
      seen.add(b.type);
    };
    const extra = (reason: string) => children.push({ kind: 'optional', box: b, findings: [run.extra(b.loc, b.start, b.end, { block: `${typeName(b.type)} box`, reason })] });
    switch (b.type) {
      case 'ihdr':
        run.stop(D.BadLayout, 'a second image header box', b.loc);
        break;
      case 'bpcc': {
        once();
        if (header.bpc !== 255) {
          extra('bits per component the image header does not defer to');
          break;
        }
        if (n !== header.components) run.stop(D.BadHeader, `the bits per component box holds ${n} bytes for ${header.components} components`, b.loc);
        header.bpcc = [...(await r.read(b.data, n))];
        if (header.bpcc.some(x => (x & 0x7f) > 37)) run.stop(D.BadHeader, 'the bits per component box gives a depth over 38 bits', b.loc);
        children.push({ kind: 'keep', box: b });
        break;
      }
      case 'colr': {
        if (n < 3) run.stop(D.BadHeader, 'a colour specification box is cut short', b.loc);
        colours++;
        const method = (await r.read(b.data, 1))[0];
        if (method === 1 && n < 7) run.stop(D.BadHeader, 'an enumerated colour space is cut short', b.loc);
        if (method === 2 || method === 3) {
          const why = await checkIcc(fileSlice(r, b.data + 3, n - 3));
          const f = why ? run.malformed(b.loc, b.start, b.end, why) : run.metadata(D.IccProfile, b.loc, b.start, b.end, { bytes: n - 3 });
          children.push({ kind: 'colr', box: b, findings: [f] });
        } else children.push({ kind: 'keep', box: b });
        break;
      }
      case 'pclr': {
        once();
        if (n < 3) run.stop(D.BadHeader, 'the palette box is cut short', b.loc);
        const v = new View(await r.read(b.data, Math.min(n, 3 + 255)));
        const entries = v.u16(0);
        const columns = v.u8(2);
        if (entries === 0 || entries > 1024 || columns === 0) run.stop(D.BadHeader, `the palette has ${entries} entries of ${columns} columns`, b.loc);
        if (n < 3 + columns) run.stop(D.BadHeader, 'the palette box is cut short', b.loc);
        let row = 0;
        for (let i = 0; i < columns; i++) {
          const depth = (v.u8(3 + i) & 0x7f) + 1;
          if (depth > 38) run.stop(D.BadHeader, `a palette column has ${depth}-bit values`, b.loc);
          row += Math.ceil(depth / 8);
        }
        if (n !== 3 + columns + entries * row) run.stop(D.BadHeader, `the palette box holds ${n} bytes where its entries make ${3 + columns + entries * row}`, b.loc);
        header.columns = columns;
        palette = b;
        children.push({ kind: 'keep', box: b });
        break;
      }
      case 'cmap': {
        once();
        if (n === 0 || n % 4 !== 0) run.stop(D.BadHeader, `the component mapping box holds ${n} bytes`, b.loc);
        const v = new View(await r.read(b.data, n));
        header.cmap = [];
        for (let at = 0; at < n; at += 4) header.cmap.push({ component: v.u16(at), type: v.u8(at + 2), column: v.u8(at + 3) });
        children.push({ kind: 'keep', box: b });
        break;
      }
      case 'cdef':
        once();
        header.cdef = b;
        children.push({ kind: 'keep', box: b });
        break;
      case 'res ': {
        once();
        for (const c of await readBoxes(run, b.data, b.end, `${b.loc}, `)) {
          if ((c.type !== 'resc' && c.type !== 'resd') || c.end - c.data !== 10) run.stop(D.BadHeader, 'the resolution box holds something other than capture and display resolutions', c.loc);
          const v = new View(await r.read(c.data, 10));
          if (v.u16(2) === 0 || v.u16(6) === 0) run.stop(D.BadHeader, 'a resolution has a denominator of 0', c.loc);
        }
        children.push({ kind: 'keep', box: b });
        break;
      }
      default:
        extra('a box the JP2 header does not hold');
    }
  }
  if (header.bpc === 255 && !header.bpcc) run.stop(D.BadLayout, 'the image header defers to a bits per component box that is missing', jp2h.loc);
  if (!colours) run.stop(D.BadLayout, 'the JP2 header has no colour specification box', jp2h.loc);
  if (palette && !header.cmap) run.stop(D.BadLayout, 'a palette without a component mapping box', palette.loc);
  if (header.cmap && !palette) run.stop(D.BadLayout, 'a component mapping box without a palette', jp2h.loc);
  return { children, header };
}

/**
 * Checks the JP2 header against the codestream: the size, the components and their depths, and the channels the
 * palette, the component mapping and the channel definitions name. A reader that trusts the header must find what
 * one that trusts the codestream finds.
 */
async function crossCheck(run: Run, h: Header, cs: CodestreamPlan): Promise<void> {
  const siz = cs.siz;
  if (h.width !== siz.width || h.height !== siz.height || h.components !== siz.components) {
    run.report(C.Structure, D.Ambiguous, h.box.loc, {
      reason: `the JP2 header gives ${h.width} x ${h.height} with ${h.components} components and the codestream ${siz.width} x ${siz.height} with ${siz.components}`,
    });
    return;
  }
  const depths = h.bpcc ?? new Array<number>(h.components).fill(h.bpc);
  if (depths.some((d, i) => d !== siz.ssiz[i])) run.report(C.Structure, D.Ambiguous, h.box.loc, { reason: 'the JP2 header gives component depths the codestream does not' });
  let channels = siz.components;
  if (h.cmap && h.columns !== undefined) {
    for (const m of h.cmap) {
      if (m.component >= siz.components || m.type > 1 || (m.type === 1 && m.column >= h.columns)) {
        run.stop(D.BadData, `the component mapping names component ${m.component}, type ${m.type}, column ${m.column}`, h.box.loc);
      }
    }
    channels = h.cmap.length;
  }
  if (h.cdef) {
    const n = h.cdef.end - h.cdef.data;
    const v = new View(await run.reader.read(h.cdef.data, Math.min(n, 2 + 6 * 65535)));
    const count = n >= 2 ? v.u16(0) : 0;
    if (count === 0 || n !== 2 + 6 * count) run.stop(D.BadHeader, `the channel definition box holds ${n} bytes`, h.cdef.loc);
    const named = new Set<number>();
    for (let i = 0; i < count; i++) {
      const at = 2 + 6 * i;
      const channel = v.u16(at);
      const type = v.u16(at + 2);
      const assoc = v.u16(at + 4);
      if (channel >= channels || named.has(channel) || (type > 2 && type !== 65535) || (assoc > channels && assoc !== 65535)) {
        run.stop(D.BadData, `the channel definitions name channel ${channel}, type ${type}, association ${assoc} of ${channels} channels`, h.cdef.loc);
      }
      named.add(channel);
    }
  }
}

/** The first URL a data reference box names, for its finding, or '' when none reads. */
async function firstUrl(run: Run, b: Box): Promise<string> {
  for (let p = b.data + 2; p < b.end; ) {
    const u = await readBox(run, p, b.end, '');
    if (!isBox(u)) break;
    if (u.type === 'url ' && u.end - u.data > 4) {
      const text = latin1(await run.reader.read(u.data + 4, Math.min(u.end - u.data - 4, 1024)));
      return text.split('\0')[0];
    }
    p = u.end;
  }
  return '';
}

/** Inspects a JP2 file: its boxes, the JP2 header, the codestream, and every metadata box. */
export async function inspectJp2(run: Run): Promise<Jp2Plan> {
  const r = run.reader;
  const size = run.size;
  const items: Item[] = [];
  const sig = await readBox(run, 0, size, '');
  if (!isBox(sig) || sig.end !== 12) run.stop(D.BadHeader, 'the signature box is not 12 bytes', 'offset 0');
  items.push({ kind: 'keep', box: sig });
  const ft = await readBox(run, 12, size, '');
  if (!isBox(ft)) run.stop(ft.detail, ft.reason, ft.loc);
  if (ft.type !== 'ftyp') run.stop(D.BadLayout, 'the file type box does not follow the signature', ft.loc);
  const n = ft.end - ft.data;
  if (n < 8 || (n - 8) % 4 !== 0) run.stop(D.BadHeader, `the file type box holds ${n} bytes`, ft.loc);
  const ftyp = latin1(await r.read(ft.data, Math.min(n, 4096)));
  const brand = ftyp.slice(0, 4);
  const compatible = (ftyp.slice(8).match(/[\s\S]{4}/g) ?? ([] as string[])).includes('jp2 ');
  if (brand !== 'jp2 ' && !compatible) {
    throw new StopError(C.Format, D.Unsupported, `brand ${brand}`, { format: BRANDS[brand] ?? `a JPEG 2000 file of brand "${typeName(brand)}"` }, ft.loc);
  }
  items.push({ kind: 'keep', box: ft });

  const doctype = async (b: Box, from: number) => ((await hasDoctype(fileSlice(r, from, b.end - from).chunks())) ? run.report(C.Metadata, D.Doctype, b.loc) : undefined);
  let header: Header | undefined;
  let codestream: CodestreamPlan | undefined;
  for (let p = ft.end; p < size; ) {
    run.time();
    const b = await readBox(run, p, size, '');
    if (!isBox(b)) {
      // JP2 readers stop at the codestream, so what does not read as a box after it is trailing data.
      if (!codestream) run.stop(b.detail, b.reason, b.loc);
      await run.gap(p, size, 'trailing');
      break;
    }
    p = b.end;
    switch (b.type) {
      case 'jp2h': {
        if (header) run.stop(D.BadLayout, 'a second JP2 header box', b.loc);
        if (codestream) run.stop(D.BadLayout, 'the JP2 header box comes after the codestream', b.loc);
        const h = await inspectHeader(run, b);
        header = h.header;
        items.push({ kind: 'header', box: b, children: h.children, grey: (h.header.cmap?.length ?? h.header.components) < 3 });
        break;
      }
      case 'jp2c':
        if (!header) run.stop(D.BadLayout, 'the codestream comes before the JP2 header box', b.loc);
        if (codestream) {
          items.push(optional(b, run.extra(b.loc, b.start, b.end, { block: 'jp2c box', reason: 'a second codestream, which JP2 readers do not show' })));
          break;
        }
        codestream = await inspectCodestream(run, b.data, b.end, `${b.loc}, `, 'hidden');
        items.push({ kind: 'codestream', box: b, cs: codestream });
        break;
      case 'rreq':
        items.push({ kind: 'keep', box: b });
        break;
      case 'xml ':
      case 'jp2i':
        items.push(optional(b, run.metadata(D.Other, b.loc, b.start, b.end, { kind: b.type === 'xml ' ? 'XML' : 'intellectual property rights' }), await doctype(b, b.data)));
        break;
      case 'asoc':
        items.push(optional(b, run.metadata(D.Other, b.loc, b.start, b.end, { kind: 'labels and XML, such as GML georeferencing' }), await doctype(b, b.data)));
        break;
      case 'jumb':
        items.push(optional(b, run.metadata(D.Other, b.loc, b.start, b.end, { kind: 'JUMBF, such as C2PA content credentials' })));
        break;
      case 'uuid':
        items.push(await uuidBox(run, b, doctype));
        break;
      case 'dtbl':
        run.droppableRange(b.start, b.end);
        items.push(optional(b, run.report(C.External, D.LinkedFile, b.loc, { target: await firstUrl(run, b) })));
        break;
      case 'uinf':
        items.push(optional(b, run.extra(b.loc, b.start, b.end, { block: 'uinf box', reason: 'a list of vendor UUIDs and a link about them' })));
        break;
      case 'jP  ':
      case 'ftyp':
        run.stop(D.BadLayout, `a second ${b.type === 'ftyp' ? 'file type' : 'signature'} box`, b.loc);
        break;
      default:
        items.push(optional(b, run.extra(b.loc, b.start, b.end, { block: `${typeName(b.type)} box`, ...(JPX_ONLY.has(b.type) ? { reason: 'a JPX box that JP2 readers do not use' } : {}) })));
    }
  }
  if (!header) run.stop(D.BadLayout, 'the file has no JP2 header box', 'offset 0');
  if (!codestream) run.stop(D.BadLayout, 'the file has no codestream', 'offset 0');
  await crossCheck(run, header, codestream);
  return { items };
}

/** Reports a UUID box by its UUID: XMP, EXIF, IPTC, Photoshop resources and GeoJP2, or an extra block. */
async function uuidBox(run: Run, b: Box, doctype: (b: Box, from: number) => Promise<DefuseFinding | undefined>): Promise<Item> {
  const r = run.reader;
  const n = b.end - b.data;
  if (n < 16) return optional(b, run.malformed(b.loc, b.start, b.end, 'a UUID box shorter than its UUID'));
  const id = Buffer.from(await r.read(b.data, 16)).toString('hex');
  const body = b.data + 16;
  // How many bytes the box can grow by before its length needs 64 bits, for a thumbnail a plugin rewrites.
  const room = 0xffffffff - (b.end - b.start);
  if (id === UUID_XMP) return optional(b, run.metadata(D.Xmp, b.loc, b.start, b.end, { bytes: n - 16 }), await doctype(b, body));
  if (UUID_EXIF.has(id)) {
    const skip = latin1(await r.read(body, Math.min(6, b.end - body))) === 'Exif\0\0' ? 6 : 0;
    const exif = await inspectExif(run, fileSlice(r, body + skip, b.end - body - skip), b.loc, b.start, b.end, room);
    return { kind: 'exif', box: b, skip: 16 + skip, exif };
  }
  if (UUID_IPTC.has(id)) return optional(b, run.metadata(D.Iptc, b.loc, b.start, b.end, { bytes: n - 16 }));
  if (id === UUID_PHOTOSHOP) {
    const block = run.metadata(D.Iptc, b.loc, b.start, b.end, { bytes: n - 16 });
    const res = await photoshopResources(fileSlice(r, body, b.end - body));
    if (typeof res === 'string') return optional(b, block, run.malformed(b.loc, b.start, b.end, res));
    const edits: PhotoshopEdit[] = [];
    for (const t of res.thumbnails) {
      const at = body + t.offset;
      const thumb = run.report(C.Metadata, D.Thumbnail, b.loc, { offset: at, bytes: t.length });
      edits.push({ thumbnail: t, contained: await run.contained(b.loc, 'Photoshop thumbnail', at, t.length, 'image/jpeg', run.keeps(block) && run.keeps(thumb), t.length + room) });
    }
    return { kind: 'photoshop', box: b, findings: [block], edits };
  }
  if (id === UUID_GEOJP2) return optional(b, run.metadata(D.Other, b.loc, b.start, b.end, { kind: 'GeoJP2 georeferencing' }));
  return optional(b, run.extra(b.loc, b.start, b.end, { block: `uuid box ${id}` }));
}

/** An enumerated colour space, sRGB or greyscale, for a colr box whose profile goes. */
const enumerated = (grey: boolean) => Uint8Array.of(1, 0, 0, 0, 0, 0, grey ? 17 : 16);

/**
 * The JP2 as the rewrite writes it: every box its findings keep, the JP2 header box without the boxes that go, and the
 * codestream without its comments and unknown segments. A box that changes is written with a new length. A colour
 * specification whose profile goes becomes an enumerated sRGB or greyscale one, since the header must hold one.
 */
export async function jp2Pieces(run: Run, plan: Jp2Plan): Promise<Piece[]> {
  const out: Piece[] = [];
  for (const it of plan.items) {
    run.time();
    const b = it.box;
    const whole = () => out.push(copy(b.start, b.end - b.start));
    switch (it.kind) {
      case 'keep':
        whole();
        break;
      case 'optional':
        if (!run.drops(it.findings, b.start, b.end)) whole();
        break;
      case 'header': {
        const kids: Piece[] = [];
        let changed = false;
        for (const c of it.children) {
          const k = c.box;
          if (c.kind === 'keep' || !run.drops(c.findings, k.start, k.end)) kids.push(copy(k.start, k.end - k.start));
          else {
            changed = true;
            if (c.kind === 'colr') kids.push(...boxPieces('colr', [bytes(enumerated(it.grey))]));
          }
        }
        if (changed) out.push(...boxPieces('jp2h', kids));
        else whole();
        break;
      }
      case 'codestream': {
        const cs = codestreamPieces(run, it.cs, b.end);
        if (cs.changed) out.push(...boxPieces('jp2c', cs.pieces));
        else whole();
        break;
      }
      case 'exif': {
        const tiff = await exifPieces(run, it.exif, [], b.start, b.end);
        if (tiff) out.push(...boxPieces('uuid', [copy(b.data, it.skip), ...tiff]));
        break;
      }
      case 'photoshop': {
        if (run.drops(it.findings, b.start, b.end)) break;
        const region = new Region(b.data, b.end);
        if (photoshopEdits(run, region, b.data + 16, it.edits)) out.push(...boxPieces('uuid', region.pieces()));
        else whole();
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Inspects a bare codestream, as a .j2k or .j2c file holds one. */
export function inspectJ2k(run: Run): Promise<CodestreamPlan> {
  return inspectCodestream(run, 0, run.size, '', 'trailing');
}

/** The bare codestream as the rewrite writes it. */
export function j2kPieces(run: Run, plan: CodestreamPlan): Piece[] {
  return codestreamPieces(run, plan, run.size).pieces;
}
