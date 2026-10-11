import { expect } from 'chai';
import { ImageCategory as C, type ContainedFilePlugin, ImageDetail as D, disarmImage, type ImageOptions, imagePlugin, inspectImage } from '../src';
import { IfdReader } from '../src/ifd';
import { copy, layout, lengthOf, Mark, mark, Region, RewriteError } from '../src/rewrite';
import { bytesSlice } from '../src/slice';
import { acted, disarmFixture, fixture, jpegCore, jpegSegments, kinds, must, of, output, pngChunks, pngFrames } from './helpers/util';

/** The IFDs of a TIFF structure along its chain, each as its entries by tag with their values. */
async function tiffIfds(bytes: Uint8Array): Promise<Array<{ at: number; tags: Map<number, number[]> }>> {
  const r = await IfdReader.open(bytesSlice(bytes));
  const out: Array<{ at: number; tags: Map<number, number[]> }> = [];
  for (let at = r.first; at; ) {
    const ifd = await r.ifd(at);
    const tags = new Map<number, number[]>();
    for (const e of ifd.entries) tags.set(e.tag, [1, 3, 4, 13, 16, 18].includes(e.type) ? await r.numbers(e) : []);
    out.push({ at, tags });
    at = ifd.next;
  }
  return out;
}

/** A plugin that replaces every image it gets with `replacement`. */
const replacing = (replacement: Uint8Array): ContainedFilePlugin => ({
  kind: 'file',
  name: 'replace',
  accepts: () => true,
  async process(_file, sink) {
    await sink.write(replacement);
    return 'scrubbed';
  },
});

const gray = fixture('clean', 'jpeg', 'gray.jpg');

describe('rewrite', () => {
  describe('regions', () => {
    it('maps each kept byte to where it lands, and nothing inside an edit', () => {
      const r = new Region(100, 200);
      r.remove(110, 120);
      r.replace(150, 160, [{ kind: 'bytes', data: new Uint8Array(4) }]);
      r.remove(170, 175);
      r.remove(175, 180);
      r.seal();
      expect([r.map(100), r.map(109), r.map(110), r.map(115), r.map(120), r.map(150), r.map(155), r.map(160), r.map(180), r.map(200)]).to.deep.equal([
        0,
        9,
        10,
        undefined,
        10,
        40,
        undefined,
        44,
        54,
        74,
      ]);
      // A pointer may land on the start of a replacement, never on removed bytes.
      expect([r.mapKept(110), r.mapKept(150), r.mapKept(170)]).to.deep.equal([undefined, 40, undefined]);
      expect(r.length).to.equal(74);
      expect(lengthOf(r.pieces())).to.equal(74);
    });

    it('applies patches to the bytes that stay and refuses one inside an edit', () => {
      const r = new Region(0, 10);
      r.remove(2, 4);
      r.patch(6, 2, () => Uint8Array.of(9, 9));
      expect(r.pieces()).to.deep.equal([
        copy(0, 2),
        copy(4, 2),
        { kind: 'lazy', length: 2, make: r.pieces()[2].kind === 'lazy' ? (r.pieces()[2] as { make: () => Uint8Array }).make : undefined },
        copy(8, 2),
      ]);
      const bad = new Region(0, 10);
      bad.remove(2, 6);
      bad.patch(3, 1, () => Uint8Array.of(1));
      expect(() => bad.pieces()).to.throw(RewriteError);
      const overlap = new Region(0, 10);
      overlap.remove(2, 6);
      overlap.replace(4, 8, []);
      overlap.replace(5, 7, [{ kind: 'bytes', data: Uint8Array.of(1) }]);
      expect(() => overlap.seal()).to.throw(RewriteError);
    });

    it('lays out marks at their output positions', () => {
      const a = new Mark();
      const b = new Mark();
      const total = layout([copy(0, 5), mark(a), { kind: 'crcStart' }, { kind: 'bytes', data: new Uint8Array(3) }, { kind: 'crcEnd' }, mark(b)]);
      expect([total, a.at, b.at]).to.deep.equal([12, 5, 12]);
    });
  });

  describe('PNG', () => {
    it('cuts IDAT data at the end of the zlib stream and writes its CRC again', async () => {
      const bytes = fixture('hostile', 'png', 'after-stream.png');
      const d = await disarmImage(bytes);
      const idat = must(
        pngChunks(output(d)).find(([t]) => t === 'IDAT'),
        'IDAT',
      )[1];
      expect([d.status, idat.length, output(d).length]).to.deep.equal([
        'defused',
        must(
          pngChunks(bytes).find(([t]) => t === 'IDAT'),
          'IDAT',
        )[1].length - 6,
        bytes.length - 6,
      ]);
      expect(pngFrames(output(d))).to.deep.equal(pngFrames(bytes));
    });

    it('drops an fdAT that holds only bytes after its stream, and numbers the chunks after it again', async () => {
      const bytes = fixture('rewrite', 'png-apng-stream-tail.png');
      const i = await inspectImage(bytes);
      expect(acted(i)).to.deep.equal(['STRUCTURE/HIDDEN_DATA']);
      const d = await disarmImage(bytes);
      const sequence = pngChunks(output(d))
        .filter(([t]) => t === 'fcTL' || t === 'fdAT')
        .map(([t, data]) => `${t} ${data.readUInt32BE(0)}`);
      expect(sequence).to.deep.equal(['fcTL 0', 'fcTL 1', 'fdAT 2', 'fcTL 3', 'fdAT 4']);
      expect([d.after?.images, pngFrames(output(d))]).to.deep.equal([3, pngFrames(bytes)]);
    });

    it('takes the thumbnail out of an eXIf chunk and keeps the GPS IFD', async () => {
      const bytes = fixture('rewrite', 'png-exif-thumbnail.png');
      const d = await disarmImage(bytes);
      expect([d.status, kinds(must(d.after, 'after'))]).to.deep.equal(['defused', ['METADATA/ICC_PROFILE', 'METADATA/EXIF', 'METADATA/GPS', 'METADATA/TEXT']]);
      const exif = must(
        pngChunks(output(d)).find(([t]) => t === 'eXIf'),
        'eXIf',
      )[1];
      const ifds = await tiffIfds(exif);
      expect(ifds.length).to.equal(1);
      expect([...must(ifds[0], 'IFD0').tags.keys()]).to.deep.equal([0x0112, 34853]);
      const kept = await disarmImage(bytes, { filePlugins: [imagePlugin()] });
      expect([kept.status, Buffer.compare(output(kept), bytes)]).to.deep.equal(['clean', 0]);
    });
  });

  describe('JPEG', () => {
    it('rewrites the MPF index for the secondary images it keeps', async () => {
      const bytes = fixture('rewrite', 'jpeg-mpf-two-images.jpg');
      const mpfOf = async (b: Uint8Array) => {
        const seg = must(
          jpegSegments(b).find(([m, data]) => m === 0xe2 && data.subarray(0, 4).toString('latin1') === 'MPF\0'),
          'MPF',
        )[1];
        const tiff = seg.subarray(4);
        const r = await IfdReader.open(bytesSlice(tiff));
        const ifd = await r.ifd(r.first);
        const list = must(ifd.byTag.get(0xb002), 'MP entries');
        const v = Buffer.from(tiff.subarray(list.at, list.at + list.size));
        const base = Buffer.from(b).indexOf(Buffer.from('MPF\0', 'latin1')) + 4;
        const entries = Array.from({ length: list.size / 16 }, (_, k) => ({
          size: v.readUInt32BE(k * 16 + 4),
          at: k ? base + v.readUInt32BE(k * 16 + 8) : 0,
          dep: [v.readUInt16BE(k * 16 + 12), v.readUInt16BE(k * 16 + 14)],
        }));
        const uids = must(ifd.byTag.get(0xb003), 'UIDs').size;
        const attributes = ifd.next ? (await r.ifd(ifd.next)).entries.map(e => e.tag) : [];
        return { entries, uids, attributes, count: (await r.numbers(must(ifd.byTag.get(0xb001), 'count')))[0] };
      };
      const original = await mpfOf(bytes);
      expect(original.entries.map(e => e.dep)).to.deep.equal([
        [2, 3],
        [0, 0],
        [0, 0],
      ]);
      // No plugin: both secondary images go, and the index names the primary image alone.
      const none = await disarmImage(bytes);
      const n = await mpfOf(output(none));
      expect([n.count, n.uids, n.attributes, n.entries]).to.deep.equal([1, 33, [0xb000, 0xb101], [{ size: output(none).length, at: 0, dep: [0, 0] }]]);
      // A plugin that keeps the first secondary image only.
      const firstOnly: ContainedFilePlugin = {
        kind: 'file',
        name: 'first',
        accepts: () => true,
        process: async f => (f.location === original.entries[1].at.toString() || f.size === original.entries[1].size ? 'passed' : 'removed'),
      };
      const one = await disarmImage(bytes, { filePlugins: [firstOnly] });
      const o = await mpfOf(output(one));
      const out = output(one);
      expect([o.count, o.uids, o.entries.map(e => e.dep)]).to.deep.equal([
        2,
        66,
        [
          [2, 0],
          [0, 0],
        ],
      ]);
      expect(Buffer.compare(out.subarray(o.entries[1].at, o.entries[1].at + o.entries[1].size), bytes.subarray(original.entries[1].at, original.entries[1].at + original.entries[1].size))).to.equal(0);
      expect(o.entries[0].size).to.equal(o.entries[1].at);
      expect(kinds(must(one.after, 'after'))).to.deep.equal(['METADATA/OTHER', 'METADATA/SECONDARY_IMAGE', 'EMBEDDED_IMAGE/PLUGIN_PASSED']);
      // A plugin that rewrites both: the entries take the new sizes and offsets.
      const both = await disarmImage(bytes, { filePlugins: [replacing(gray)] });
      const b2 = await mpfOf(output(both));
      expect(b2.entries.slice(1).map(e => e.size)).to.deep.equal([gray.length, gray.length]);
      for (const e of b2.entries.slice(1)) expect(Buffer.compare(output(both).subarray(e.at, e.at + e.size), gray)).to.equal(0);
    });

    it("takes an EXIF thumbnail out, or puts a plugin's copy in its place with its length", async () => {
      const bytes = fixture('rewrite', 'jpeg-exif-orientation-thumb.jpg');
      const exifOf = (b: Uint8Array) =>
        must(
          jpegSegments(b).find(([m]) => m === 0xe1),
          'EXIF',
        )[1].subarray(6);
      const d = await disarmImage(bytes);
      expect((await tiffIfds(exifOf(output(d)))).length).to.equal(1);
      expect(Buffer.compare(jpegCore(output(d)), jpegCore(bytes))).to.equal(0);
      const r = await disarmImage(bytes, { filePlugins: [replacing(gray)] });
      const exif = exifOf(output(r));
      const ifd1 = must((await tiffIfds(exif))[1], 'IFD1').tags;
      const [at] = must(ifd1.get(513), 'offset');
      expect(must(ifd1.get(514), 'length')).to.deep.equal([gray.length]);
      expect(Buffer.compare(exif.subarray(at, at + gray.length), gray)).to.equal(0);
      expect(kinds(must(r.after, 'after'))).to.include('EMBEDDED_IMAGE/PLUGIN_SCRUBBED');
    });

    it('takes a thumbnail resource out of Photoshop resources and keeps the others', async () => {
      const d = await disarmFixture({}, 'rewrite', 'jpeg-photoshop-thumbnail.jpg');
      const block = must(
        jpegSegments(output(d)).find(([m]) => m === 0xed),
        'APP13',
      )[1].subarray(14);
      const ids: number[] = [];
      for (let p = 0; p < block.length; ) {
        ids.push(block.readUInt16BE(p + 4));
        const size = block.readUInt32BE(p + 8);
        p += 12 + size + (size & 1);
      }
      expect([d.status, ids]).to.deep.equal(['defused', [0x0404, 0x0425]]);
      const r = await disarmFixture({ filePlugins: [replacing(gray)] }, 'rewrite', 'jpeg-photoshop-thumbnail.jpg');
      const after = must(r.after, 'after');
      expect(of(after, 'METADATA/THUMBNAIL')[0].data?.bytes).to.equal(gray.length);
    });

    it('keeps a JFXX thumbnail a plugin passes and drops one no plugin accepts', async () => {
      const j = fixture('clean', 'jpeg', 'gray.jpg');
      const jfxx = Buffer.concat([Buffer.from([0xff, 0xe0]), Buffer.alloc(2), Buffer.from('JFXX\0\x10', 'latin1'), gray]);
      jfxx.writeUInt16BE(jfxx.length - 2, 2);
      const bytes = Buffer.concat([j.subarray(0, 2), jfxx, j.subarray(2)]);
      const dropped = await disarmImage(bytes);
      expect([dropped.status, Buffer.compare(output(dropped), j)]).to.deep.equal(['defused', 0]);
      const kept = await disarmImage(bytes, { filePlugins: [imagePlugin()] });
      expect([kept.status, Buffer.compare(output(kept), bytes)]).to.deep.equal(['clean', 0]);
    });

    it('drops fill bytes and bytes between segments', async () => {
      const j = fixture('clean', 'jpeg', 'gray.jpg');
      const filled = Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff]), j.subarray(2)]);
      const d = await disarmImage(filled);
      expect([d.status, Buffer.compare(output(d), j)]).to.deep.equal(['clean', 0]);
    });
  });

  describe('GIF', () => {
    it('drops a plain text extension with the control extension before it, and the bytes after an end code', async () => {
      const bytes = fixture('rewrite', 'gif-control-plain-text.gif');
      expect(acted(await inspectImage(bytes))).to.deep.equal(['STRUCTURE/EXTRA_BLOCK', 'STRUCTURE/HIDDEN_DATA']);
      const out = output(await disarmImage(bytes));
      const controls: number[] = [];
      for (let p = out.indexOf(Buffer.from([0x21, 0xf9, 0x04])); p >= 0; p = out.indexOf(Buffer.from([0x21, 0xf9, 0x04]), p + 1)) controls.push(out.readUInt16LE(p + 4));
      expect([controls, out.includes('hello'), out.includes('TAIL'), out.includes('a comment'), out.includes('NETSCAPE2.0')]).to.deep.equal([[20], false, false, true, true]);
    });
  });

  describe('WebP', () => {
    it('writes the RIFF size, zero padding and VP8X flags for the chunks it keeps', async () => {
      const chunksOf = (b: Buffer) => {
        const out: Array<[string, number, number]> = [];
        for (let p = 12; p < b.length; ) {
          const n = b.readUInt32LE(p + 4);
          out.push([b.toString('latin1', p, p + 4), n, n & 1 ? b[p + 8 + n] : -1]);
          p += 8 + n + (n & 1);
        }
        return out;
      };
      const bytes = fixture('rewrite', 'webp-extended-meta.webp');
      const d = output(await disarmImage(bytes));
      expect(d.readUInt32LE(4)).to.equal(d.length - 8);
      expect(chunksOf(d).map(([id, , pad]) => `${id}${pad > 0 ? ` pad ${pad}` : ''}`)).to.deep.equal(['VP8X', 'ICCP', 'VP8L', 'EXIF', 'XMP ']);
      expect(d[20] & 0x3c).to.equal(0x2c);
      const s = output(await disarmImage(bytes, { stripMetadata: true }));
      expect([chunksOf(s).map(([id]) => id), s[20] & 0x3c]).to.deep.equal([['VP8X', 'ICCP', 'VP8L'], 0x20]);
      const anim = output(await disarmFixture({}, 'rewrite', 'webp-anim-inner-chunk.webp'));
      expect([anim.includes('ABCD'), anim.readUInt32LE(4), (await inspectImage(anim)).images]).to.deep.equal([false, anim.length - 8, 2]);
    });
  });

  describe('TIFF', () => {
    it('removes gaps, trailing bytes and a private tag, cuts a strip to its rows, and writes every offset again', async () => {
      const bytes = fixture('rewrite', 'tiff-gaps-exif-gps.tif');
      expect(acted(await inspectImage(bytes))).to.deep.equal(['STRUCTURE/EXTRA_BLOCK', 'STRUCTURE/HIDDEN_DATA', 'STRUCTURE/TRAILING_DATA']);
      const d = await disarmImage(bytes);
      const out = output(d);
      expect(['HIDE', 'TRAILING', 'XTRA', 'private'].map(text => out.includes(text))).to.deep.equal([false, false, false, false]);
      const [ifd0] = await tiffIfds(out);
      const offsets = must(ifd0.tags.get(273), 'offsets');
      expect(must(ifd0.tags.get(279), 'counts')).to.deep.equal([32, 32]);
      expect(Buffer.concat(offsets.map(o => out.subarray(o, o + 32)))).to.deep.equal(Buffer.from(Array.from({ length: 64 }, (_, k) => k)));
      expect(ifd0.tags.has(37724)).to.equal(false);
      expect(kinds(must(d.after, 'after'))).to.deep.equal(['METADATA/TEXT', 'METADATA/EXIF', 'METADATA/GPS']);
      // Removals keep their length even, so every offset keeps its parity, and TIFF's word alignment with it.
      const [inIfd0] = await tiffIfds(bytes);
      expect([ifd0.at % 2, ...offsets.map(o => o % 2)]).to.deep.equal([inIfd0.at % 2, ...must(inIfd0.tags.get(273), 'offsets').map(o => o % 2)]);
      const s = await disarmImage(bytes, { stripMetadata: true });
      const [stripped] = await tiffIfds(output(s));
      expect([...stripped.tags.keys()]).to.deep.equal([256, 257, 258, 259, 262, 273, 277, 278, 279]);
      expect(kinds(must(s.after, 'after'))).to.deep.equal([]);
    });

    it('rewrites a BigTIFF with a SubIFD', async () => {
      const bytes = fixture('rewrite', 'tiff-big-subifd.tif');
      const d = await disarmImage(bytes);
      expect([d.status, d.after?.images, output(d).length, output(d).includes('HIDDEN')]).to.deep.equal(['defused', 2, bytes.length - 8, false]);
    });

    it("takes a thumbnail out of Photoshop resources in a tag, or puts a plugin's copy in its place", async () => {
      const bytes = fixture('rewrite', 'tiff-photoshop-thumbnail.tif');
      const d = await disarmImage(bytes);
      expect([d.status, kinds(must(d.after, 'after'))]).to.deep.equal(['defused', ['METADATA/IPTC']]);
      const r = await disarmImage(bytes, { filePlugins: [replacing(gray)] });
      const after = must(r.after, 'after');
      expect([r.status, of(after, 'METADATA/THUMBNAIL')[0].data?.bytes, acted(after)]).to.deep.equal(['defused', gray.length, []]);
    });
  });

  describe('BMP and ICO', () => {
    it('moves a kept color profile up to the pixels, or turns the image to sRGB when the profile goes', async () => {
      const bytes = fixture('rewrite', 'bmp-v5-profile-gap.bmp');
      const d = output(await disarmImage(bytes));
      expect([d.length, d.readUInt32LE(2), d.readUInt32LE(14 + 112) + 14, d.includes('GAP')]).to.deep.equal([bytes.length - 6, d.length, 14 + 124 + 16, false]);
      const options: ImageOptions = { actionOverrides: [{ category: C.Metadata, detail: D.IccProfile, action: 'strip' }] };
      const s = output(await disarmImage(bytes, options));
      expect([s.length, s.toString('latin1', 14 + 56, 14 + 60), s.readUInt32LE(14 + 112), s.readUInt32LE(14 + 116)]).to.deep.equal([14 + 124 + 16, 'BGRs', 0, 0]);
      const linked = output(await disarmFixture({}, 'hostile', 'bmp', 'linked-profile.bmp'));
      expect([linked.toString('latin1', 14 + 56, 14 + 60), linked.includes('attacker')]).to.deep.equal(['BGRs', false]);
    });

    it('writes an icon directory for the images it rewrote', async () => {
      const bytes = fixture('rewrite', 'ico-png-text-hidden.ico');
      const d = output(await disarmImage(bytes));
      expect([d.includes('AFTERIEND'), d.includes('AFTERMASK'), d.includes('icon text')]).to.deep.equal([false, false, true]);
      const entries = [0, 1].map(k => ({ size: d.readUInt32LE(6 + 16 * k + 8), at: d.readUInt32LE(6 + 16 * k + 12) }));
      expect([entries[0].at, entries[1].at, entries[1].at + entries[1].size]).to.deep.equal([6 + 32, 6 + 32 + entries[0].size, d.length]);
      const s = output(await disarmImage(bytes, { stripMetadata: true }));
      expect(s.includes('icon text')).to.equal(false);
      const mismatch = await disarmFixture({ actionOverrides: [{ category: C.Structure, detail: D.Ambiguous, action: 'strip' }] }, 'hostile', 'ico', 'size-mismatch.ico');
      expect([mismatch.status, output(mismatch)[6], output(mismatch)[7]]).to.deep.equal(['defused', 16, 16]);
    });
  });
});
