import { expect } from 'chai';
import { type ContainedFilePlugin, disarmImage, imagePlugin } from '../src';
import { IfdReader } from '../src/ifd';
import { bytesSlice } from '../src/slice';
import { acted, disarmFixture, fixture, fixtureNames, inspectFixture, kinds, must, of, output, reason } from './helpers/util';

/** The boxes of a JPEG XL container, as [type, content]. */
function boxesOf(bytes: Uint8Array): Array<[string, Buffer]> {
  const b = Buffer.from(bytes);
  const out: Array<[string, Buffer]> = [];
  for (let p = 0; p < b.length; ) {
    const n = b.readUInt32BE(p) || b.length - p;
    out.push([b.toString('latin1', p + 4, p + 8), b.subarray(p + 8, p + n)]);
    p += n;
  }
  return out;
}
const types = (bytes: Uint8Array) => boxesOf(bytes).map(([t]) => t);

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

const container = fixture('clean', 'jxl', 'container.jxl');

describe('JPEG XL', () => {
  it('reads the image header of a bare codestream and of one in a jxlc box or split over jxlp boxes', async () => {
    const sizes: Record<string, [number, number]> = { 'bare.jxl': [64, 48], 'bare-animated.jxl': [150, 100], 'container.jxl': [64, 48], 'partial.jxl': [64, 48] };
    expect(fixtureNames('clean', 'jxl')).to.deep.equal(Object.keys(sizes).sort());
    for (const [name, [width, height]] of Object.entries(sizes)) {
      const r = await inspectFixture({}, 'clean', 'jxl', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, r.findings]).to.deep.equal([name, 'clean', 'jxl', 'image/jxl', width, height, 1, []]);
      const d = await disarmImage(fixture('clean', 'jxl', name));
      expect([name, d.status, Buffer.compare(output(d), fixture('clean', 'jxl', name))]).to.deep.equal([name, 'clean', 0]);
    }
  });

  it('checks the size and the sample depth the image header gives before anything else', async () => {
    expect(kinds(await inspectFixture({}, 'hostile', 'jxl', 'huge.jxl'))).to.deep.equal(['LIMIT/PIXELS']);
    expect(reason(await inspectFixture({}, 'hostile', 'jxl', 'deep-samples.jxl'))).to.equal('the image header gives 40-bit samples');
    expect(reason(await inspectFixture({}, 'hostile', 'jxl', 'cut-header.jxl'))).to.equal('the codestream ends inside its image header');
    // 150 x 100 pixels of three 16-bit channels and one extra channel.
    expect(kinds(await inspectFixture({ limits: { decodedBytes: 150 * 100 * 4 * 2 - 1 } }, 'clean', 'jxl', 'bare-animated.jxl'))).to.deep.equal(['LIMIT/DECODED_SIZE']);
  });

  it('refuses jxlp boxes out of order or without the last one, and a codestream in both kinds of box', async () => {
    const expected: Record<string, string> = {
      'jxlp-order.jxl': 'jxlp box 1 comes where 0 should',
      'jxlp-unfinished.jxl': 'the jxlp boxes end before the last one',
      'jxlc-and-jxlp.jxl': 'a jxlp box where the codestream is in a jxlc box',
      'no-codestream.jxl': 'the file has no codestream',
    };
    for (const [name, why] of Object.entries(expected)) expect([name, reason(await inspectFixture({}, 'hostile', 'jxl', name))]).to.deep.equal([name, why]);
  });

  it('reports EXIF, GPS and XMP whether exiftool writes them plain or Brotli-compressed, and JUMBF as other metadata', async () => {
    for (const name of ['exif-xmp.jxl', 'brotli.jxl']) {
      const r = await inspectFixture({}, 'meta', 'jxl', name);
      expect([name, r.status, kinds(r)]).to.deep.equal([name, 'clean', ['METADATA/EXIF', 'METADATA/GPS', 'METADATA/XMP']]);
      const d = await disarmFixture({ stripMetadata: true }, 'meta', 'jxl', name);
      expect([name, d.status, Buffer.compare(output(d), container)]).to.deep.equal([name, 'defused', 0]);
    }
    expect(of(await inspectFixture({}, 'meta', 'jxl', 'jumbf.jxl'), 'METADATA/OTHER')[0].data?.kind).to.equal('JUMBF, such as C2PA content credentials');
  });

  it('drops trailing data and the archive in it, JPEG rebuilding data, and XMP that declares entities', async () => {
    for (const [name, found] of [
      ['trailing.jxl', ['STRUCTURE/TRAILING_DATA']],
      ['zip-trailing.jxl', ['STRUCTURE/TRAILING_DATA', 'POLYGLOT/ZIP']],
      ['jbrd.jxl', ['STRUCTURE/EXTRA_BLOCK']],
      ['doctype-xmp.jxl', ['METADATA/DOCTYPE']],
    ] as const) {
      const d = await disarmFixture({}, 'hostile', 'jxl', name);
      expect([name, acted(d.before), Buffer.compare(output(d), container)]).to.deep.equal([name, found, 0]);
    }
  });

  it('decompresses Brotli boxes up to the metadata limit, and drops one that does not decompress or holds a thumbnail', async () => {
    expect(kinds(await inspectFixture({}, 'hostile', 'jxl', 'brotli-bomb.jxl'))).to.deep.equal(['LIMIT/METADATA_SIZE']);
    const corrupt = await disarmFixture({}, 'hostile', 'jxl', 'brotli-corrupt.jxl');
    expect([acted(corrupt.before), Buffer.compare(output(corrupt), container)]).to.deep.equal([['METADATA/MALFORMED'], 0]);
    // A plugin cannot be given an image inside compressed data, so the box goes even when one is set.
    const thumb = await disarmFixture({ filePlugins: [imagePlugin()] }, 'hostile', 'jxl', 'brotli-thumbnail.jxl');
    expect([acted(thumb.before), Buffer.compare(output(thumb), container)]).to.deep.equal([['EMBEDDED_IMAGE/NO_PLUGIN'], 0]);
    expect(of(thumb.before, 'EMBEDDED_IMAGE/NO_PLUGIN')[0].description).to.equal('An image inside the image (image/jpeg) is removed. It sits in compressed metadata, where no plugin can check it');
  });

  it('drops an EXIF thumbnail no plugin accepts, keeping the rest of the EXIF box, and writes in one a plugin rewrites', async () => {
    const bytes = fixture('rewrite', 'jxl-exif-thumbnail.jxl');
    const exifOf = (b: Uint8Array) =>
      must(
        boxesOf(b).find(([t]) => t === 'Exif'),
        'Exif',
      )[1].subarray(4);
    const d = await disarmImage(bytes);
    expect([d.status, acted(d.before)]).to.deep.equal(['defused', ['EMBEDDED_IMAGE/NO_PLUGIN']]);
    const r = await IfdReader.open(bytesSlice(exifOf(output(d))));
    expect((await r.ifd(r.first)).next).to.equal(0);
    const gray = fixture('clean', 'jpeg', 'gray.jpg');
    const replaced = await disarmImage(bytes, { filePlugins: [replacing(gray)] });
    expect(of(must(replaced.after, 'after'), 'METADATA/THUMBNAIL')[0].data?.bytes).to.equal(gray.length);
  });

  it('gives a gain map to the file plugins as a secondary image, and drops it when none accepts it', async () => {
    const bytes = fixture('rewrite', 'jxl-gain-map.jxl');
    const dropped = await disarmImage(bytes);
    expect([dropped.status, kinds(dropped.before), types(output(dropped))]).to.deep.equal(['defused', ['METADATA/SECONDARY_IMAGE', 'EMBEDDED_IMAGE/NO_PLUGIN'], ['JXL ', 'ftyp', 'jxll', 'jxlc']]);
    const kept = await disarmImage(bytes, { filePlugins: [imagePlugin()] });
    expect([kept.status, Buffer.compare(output(kept), bytes)]).to.deep.equal(['clean', 0]);
    const replacement = fixture('clean', 'jxl', 'bare-animated.jxl');
    const replaced = await disarmImage(bytes, { filePlugins: [replacing(replacement)] });
    const map = must(
      boxesOf(output(replaced)).find(([t]) => t === 'jhgm'),
      'jhgm',
    )[1];
    expect(Buffer.compare(map.subarray(8), replacement)).to.equal(0);
  });
});
