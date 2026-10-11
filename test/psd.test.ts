import { expect } from 'chai';
import { disarmImage, imagePlugin, inspectImage } from '../src';
import { IfdReader } from '../src/ifd';
import { bytesSlice } from '../src/slice';
import type { ContainedFilePlugin } from '../src/types';
import { acted, disarmFixture, fixture, fixtureNames, inspectFixture, kinds, must, of, output, reason } from './helpers/util';

/** The sections of a PSD: color mode data, image resources, the layer and mask section, and the image data after. */
function sections(bytes: Uint8Array): { colour: Buffer; resources: Buffer; layers: Buffer; image: Buffer } {
  const b = Buffer.from(bytes);
  const big = b.readUInt16BE(4) === 2;
  let p = 26;
  const take4 = () => {
    const n = b.readUInt32BE(p);
    const out = b.subarray(p + 4, p + 4 + n);
    p += 4 + n;
    return out;
  };
  const colour = take4();
  const resources = take4();
  const n = big ? Number(b.readBigUInt64BE(p)) : b.readUInt32BE(p);
  const start = p + (big ? 8 : 4);
  return { colour, resources, layers: b.subarray(start, start + n), image: b.subarray(start + n) };
}

/** The image resources as [id, data]. */
function resourceList(res: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  for (let p = 0; p < res.length; ) {
    const name = res[p + 6];
    const at = p + 6 + ((name + 2) & ~1);
    const n = res.readUInt32BE(at);
    out.push([res.readUInt16BE(p + 4), res.subarray(at + 4, at + 4 + n)]);
    p = at + 4 + n + (n & 1);
  }
  return out;
}

/** The global tagged blocks of a layer and mask section whose layer info is empty, after the global mask length. */
function globalBlocks(layers: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  let p = 4 + layers.readUInt32BE(0) + 4;
  while (p + 12 <= layers.length) {
    const n = layers.readUInt32BE(p + 8);
    out.push([layers.toString('latin1', p + 4, p + 8), layers.subarray(p + 12, p + 12 + n)]);
    p += 12 + n;
  }
  return out;
}

/** The items of a linked layer block as [kind, item length, data length, item]. */
function linkedItems(block: Buffer): Array<[string, number, number, Buffer]> {
  const out: Array<[string, number, number, Buffer]> = [];
  for (let p = 0; p + 8 <= block.length; ) {
    const n = Number(block.readBigUInt64BE(p));
    const item = block.subarray(p + 8, p + 8 + n);
    const uid = item[8];
    const units = item.readUInt32BE(9 + uid);
    const dataAt = 9 + uid + 4 + units * 2 + 8;
    out.push([item.toString('latin1', 0, 4), n, Number(item.readBigUInt64BE(dataAt)), item]);
    p += 8 + n + ((4 - (n % 4)) % 4);
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

const flat = fixture('clean', 'psd', 'flat.psd');

describe('Photoshop', () => {
  it('reads what ImageMagick writes and hand-built documents as clean: RGB, gray, indexed, CMYK, 16-bit, layers, RLE, ZIP, raw and PSB', async () => {
    for (const name of fixtureNames('clean', 'psd')) {
      const r = await inspectFixture({}, 'clean', 'psd', name);
      const big = name.endsWith('.psb');
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, kinds(r)]).to.deep.equal([name, 'clean', big ? 'psb' : 'psd', 'image/vnd.adobe.photoshop', 32, 24, 1, []]);
      const d = await disarmImage(fixture('clean', 'psd', name));
      expect([name, d.status, Buffer.compare(output(d), fixture('clean', 'psd', name))]).to.deep.equal([name, 'clean', 0]);
    }
  });

  it('reports the EXIF, GPS, IPTC and XMP exiftool writes, and stripMetadata takes their resources out', async () => {
    const r = await inspectFixture({}, 'meta', 'psd', 'exif-iptc-xmp.psd');
    expect([r.status, kinds(r)]).to.deep.equal(['clean', ['METADATA/IPTC', 'METADATA/EXIF', 'METADATA/GPS', 'METADATA/XMP']]);
    const d = await disarmFixture({ stripMetadata: true }, 'meta', 'psd', 'exif-iptc-xmp.psd');
    expect([d.status, kinds(must(d.after, 'after'))]).to.deep.equal(['defused', []]);
    const ids = resourceList(sections(output(d)).resources).map(([id]) => id);
    expect(ids.filter(id => id === 0x0404 || id === 0x0422 || id === 0x0424)).to.deep.equal([]);
    expect(sections(output(d)).image.equals(sections(fixture('meta', 'psd', 'exif-iptc-xmp.psd')).image)).to.equal(true);
  });

  it('reports a color profile, a caption, a URL list and slices, and keeps the profile and the resolution under stripMetadata', async () => {
    const r = await inspectFixture({}, 'meta', 'psd', 'resources.psd');
    expect(kinds(r)).to.deep.equal(['METADATA/ICC_PROFILE', 'METADATA/TEXT', 'METADATA/OTHER', 'METADATA/OTHER']);
    expect(of(r, 'METADATA/OTHER').map(f => f.data?.kind)).to.deep.equal(['URL list', 'slices, which can hold URLs']);
    const d = await disarmFixture({ stripMetadata: true }, 'meta', 'psd', 'resources.psd');
    expect(resourceList(sections(output(d)).resources).map(([id]) => id)).to.deep.equal([0x03ed, 0x040f]);
  });

  it('removes a thumbnail no plugin accepts, and writes one a plugin rewrites into its resource with the resource and JPEG sizes again', async () => {
    const dropped = await disarmFixture({}, 'rewrite', 'psd-thumbnail.psd');
    expect([acted(dropped.before), resourceList(sections(output(dropped)).resources)]).to.deep.equal([['EMBEDDED_IMAGE/NO_PLUGIN'], []]);
    const gray = fixture('clean', 'jpeg', 'gray.jpg');
    const d = await disarmFixture({ filePlugins: [replacing(gray)] }, 'rewrite', 'psd-thumbnail.psd');
    expect([d.status, kinds(must(d.after, 'after'))]).to.deep.equal(['defused', ['METADATA/THUMBNAIL', 'EMBEDDED_IMAGE/PLUGIN_SCRUBBED']]);
    const [[id, data]] = resourceList(sections(output(d)).resources);
    expect([id, data.length, data.readUInt32BE(20), data.subarray(28).equals(gray)]).to.deep.equal([0x040c, 28 + gray.length, gray.length, true]);
  });

  it('reports annotations as comments, and stripMetadata drops their block and writes the section length again', async () => {
    const r = await inspectFixture({}, 'meta', 'psd', 'annotations.psd');
    expect(kinds(r)).to.deep.equal(['METADATA/COMMENT']);
    const d = await disarmFixture({ stripMetadata: true }, 'meta', 'psd', 'annotations.psd');
    expect(globalBlocks(sections(output(d)).layers)).to.deep.equal([]);
    expect(kinds(must(d.after, 'after'))).to.deep.equal([]);
  });

  it('drops trailing data and the archive appended there', async () => {
    const trailing = await disarmFixture({}, 'hostile', 'psd', 'trailing.psd');
    expect([acted(trailing.before), Buffer.compare(output(trailing), flat)]).to.deep.equal([['STRUCTURE/TRAILING_DATA'], 0]);
    const zip = await disarmFixture({}, 'hostile', 'psd', 'zip-trailing.psd');
    expect([acted(zip.before), Buffer.compare(output(zip), flat)]).to.deep.equal([['STRUCTURE/TRAILING_DATA', 'POLYGLOT/ZIP'], 0]);
  });

  it('drops a tagged block readers skip, and overwrites bytes hidden at the end of the layer info with zeros', async () => {
    const block = await disarmFixture({}, 'hostile', 'psd', 'unknown-block.psd');
    expect([acted(block.before), globalBlocks(sections(output(block)).layers)]).to.deep.equal([['STRUCTURE/EXTRA_BLOCK'], []]);
    const input = fixture('hostile', 'psd', 'hidden-layer-info.psd');
    const hidden = await disarmImage(input);
    expect([acted(hidden.before), output(hidden).length, output(hidden).includes(Buffer.from('HIDDEN'))]).to.deep.equal([['STRUCTURE/HIDDEN_DATA'], input.length, false]);
  });

  it('drops XMP that declares entities, a profile that does not parse, and a caption that holds a PDF header', async () => {
    const doctype = await disarmFixture({}, 'hostile', 'psd', 'doctype-xmp.psd');
    expect([acted(doctype.before), resourceList(sections(output(doctype)).resources)]).to.deep.equal([['METADATA/DOCTYPE'], []]);
    const icc = await disarmFixture({}, 'hostile', 'psd', 'bad-icc.psd');
    expect([acted(icc.before), resourceList(sections(output(icc)).resources)]).to.deep.equal([['METADATA/MALFORMED'], []]);
    const pdf = await disarmFixture({}, 'hostile', 'psd', 'pdf-in-caption.psd');
    expect([acted(pdf.before), resourceList(sections(output(pdf)).resources)]).to.deep.equal([['POLYGLOT/PDF'], []]);
  });

  it('hands an embedded linked file to the plugins and reports links to files outside', async () => {
    const r = await inspectFixture({}, 'rewrite', 'psd-linked.psd');
    expect(kinds(r)).to.deep.equal(['EMBEDDED_IMAGE/NO_PLUGIN', 'EXTERNAL/LINKED_FILE', 'EXTERNAL/LINKED_FILE']);
    expect(of(r, 'EMBEDDED_IMAGE/NO_PLUGIN')[0].data?.sniffed).to.equal('image/png');
    expect(of(r, 'EXTERNAL/LINKED_FILE').map(f => f.data?.target)).to.deep.equal(['linked.png', 'alias.png']);
    const d = await disarmImage(fixture('rewrite', 'psd-linked.psd'));
    const blocks = globalBlocks(sections(output(d)).layers);
    expect(blocks.map(([k, v]) => [k, v.length])).to.deep.equal([
      ['lnk2', 0],
      ['Patt', 0],
    ]);
  });

  it('keeps a linked file a plugin passes, and writes the lengths and padding of one it rewrites again', async () => {
    const passed = await disarmFixture({ filePlugins: [imagePlugin()] }, 'rewrite', 'psd-linked.psd');
    const [lnk] = globalBlocks(sections(output(passed)).layers);
    expect(linkedItems(lnk[1]).map(([k]) => k)).to.deep.equal(['liFD']);
    expect(kinds(must(passed.after, 'after'))).to.deep.equal(['EMBEDDED_IMAGE/PLUGIN_PASSED']);
    const odd = Buffer.concat([fixture('clean', 'png', 'rgb.png'), Buffer.alloc(3)]);
    const d = await disarmFixture({ filePlugins: [replacing(odd)] }, 'rewrite', 'psd-linked.psd');
    const [block] = globalBlocks(sections(output(d)).layers);
    const [[kind, length, dataLength, item]] = linkedItems(block[1]);
    expect([kind, dataLength, block[1].length % 4, length > dataLength, item.includes(odd)]).to.deep.equal(['liFD', odd.length, 0, true, true]);
    const again = await inspectImage(output(d));
    expect(again.status).to.equal('strippable');
    expect(kinds(again)).to.deep.equal(['EMBEDDED_IMAGE/NO_PLUGIN']);
  });

  it('edits an EXIF resource in place: its thumbnail goes to the plugins, and goes alone when none takes it', async () => {
    const kept = await disarmFixture({ filePlugins: [imagePlugin()] }, 'hostile', 'psd', 'exif-thumbnail.psd');
    expect([kept.status, kinds(kept.before).filter(k => k.startsWith('EMBEDDED_IMAGE'))]).to.deep.equal(['clean', ['EMBEDDED_IMAGE/PLUGIN_PASSED']]);
    const alone = await disarmFixture({}, 'hostile', 'psd', 'exif-thumbnail.psd');
    expect([alone.status, acted(alone.before)]).to.deep.equal(['defused', ['EMBEDDED_IMAGE/NO_PLUGIN']]);
    const resources = resourceList(sections(output(alone)).resources);
    expect(resources.map(([id]) => id)).to.deep.equal([0x03ed, 0x0422]);
    const exif = must(
      resources.find(([id]) => id === 0x0422),
      'EXIF',
    )[1];
    const r = await IfdReader.open(bytesSlice(exif));
    expect((await r.ifd(r.first)).next).to.equal(0);
  });

  it('drops a thumbnail pointer of 0 bytes, as Photoshop writes it, and keeps the EXIF around it', async () => {
    const d = await disarmFixture({}, 'hostile', 'psd', 'exif-empty-thumbnail.psd');
    expect([d.status, acted(d.before), of(d.before, 'STRUCTURE/EXTRA_BLOCK')[0].data?.block]).to.deep.equal(['defused', ['STRUCTURE/EXTRA_BLOCK'], 'an EXIF thumbnail of 0 bytes']);
    const resources = resourceList(sections(output(d)).resources);
    expect(resources.map(([id]) => id)).to.deep.equal([0x03ed, 0x0422]);
    const exif = must(
      resources.find(([id]) => id === 0x0422),
      'EXIF',
    )[1];
    const r = await IfdReader.open(bytesSlice(exif));
    const ifd0 = await r.ifd(r.first);
    expect([ifd0.next, ifd0.byTag.has(0x010f)]).to.deep.equal([0, true]);
    expect(kinds(must(d.after, 'after'))).to.deep.equal(['METADATA/EXIF']);
  });

  it('drops a linked layer block whose descriptor holds a type no reader defines', async () => {
    const d = await disarmFixture({}, 'hostile', 'psd', 'linked-unknown-type.psd');
    expect(acted(d.before)).to.deep.equal(['METADATA/MALFORMED']);
    expect(of(d.before, 'METADATA/MALFORMED')[0].data?.reason).to.equal('linked layers: a descriptor holds an item of type "XXXX", which this version does not read');
    expect(globalBlocks(sections(output(d)).layers)).to.deep.equal([]);
  });

  it('refuses a header, layer or composite that breaks the format', async () => {
    const expected: Record<string, [string, string]> = {
      'version.psd': ['STRUCTURE/BAD_HEADER', 'version 3'],
      'reserved.psd': ['STRUCTURE/BAD_HEADER', 'the reserved bytes are not zero'],
      'channels.psd': ['STRUCTURE/BAD_HEADER', '57 channels'],
      'indexed-no-palette.psd': ['STRUCTURE/BAD_HEADER', 'an indexed image has 0 bytes of color data'],
      'negative-rectangle.psd': ['STRUCTURE/BAD_HEADER', 'layer 0 runs from 0, 10 to 4, 2'],
      'channel-compression.psd': ['STRUCTURE/BAD_HEADER', 'a channel names compression 7'],
      'channel-length.psd': ['STRUCTURE/TRUNCATED', 'channel image data runs past the layer info'],
      'rle-short.psd': ['STRUCTURE/TRUNCATED', 'the row lengths add up to 2376 bytes past the end of the file'],
      'zip-bomb.psd': ['STRUCTURE/BAD_DATA', 'the image data inflates past 2304 bytes'],
    };
    for (const [name, [k, why]] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'hostile', 'psd', name);
      expect([name, r.status, acted(r), reason(r)]).to.deep.equal([name, 'rejected', [k], why]);
    }
  });

  it('checks the composite and every layer against the pixel limit, counting only the composite as an image', async () => {
    expect(kinds(await inspectFixture({}, 'hostile', 'psd', 'huge.psd'))).to.deep.equal(['LIMIT/PIXELS']);
    const layer = await inspectFixture({}, 'hostile', 'psd', 'huge-layer.psd');
    expect([kinds(layer), layer.images]).to.deep.equal([['LIMIT/PIXELS'], 1]);
    // The composite decodes to 2304 bytes, the layers to 3072 and 576.
    const layers = await inspectFixture({ limits: { decodedBytes: 3072, totalDecodedBytes: 5952 } }, 'clean', 'psd', 'hand-layers.psd');
    expect([layers.status, layers.images]).to.deep.equal(['clean', 1]);
    expect(kinds(await inspectFixture({ limits: { decodedBytes: 3000 } }, 'clean', 'psd', 'hand-layers.psd'))).to.deep.equal(['LIMIT/DECODED_SIZE']);
    expect(kinds(await inspectFixture({ limits: { totalDecodedBytes: 5000 } }, 'clean', 'psd', 'hand-layers.psd'))).to.deep.equal(['LIMIT/TOTAL_DECODED_SIZE']);
  });
});
