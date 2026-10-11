import { expect } from 'chai';
import { disarmImage, inspectImage } from '../src';
import { IfdReader } from '../src/ifd';
import { bytesSlice } from '../src/slice';
import type { ContainedFilePlugin } from '../src/types';
import { acted, disarmFixture, fixture, fixtureNames, inspectFixture, kinds, must, of, output, reason } from './helpers/util';

/** The boxes in [start, end) of a JP2, as [type, content]. */
function boxesOf(bytes: Uint8Array, start = 0, end = bytes.length): Array<[string, Buffer]> {
  const b = Buffer.from(bytes);
  const out: Array<[string, Buffer]> = [];
  for (let p = start; p < end; ) {
    const n = b.readUInt32BE(p) || end - p;
    out.push([b.toString('latin1', p + 4, p + 8), b.subarray(p + 8, p + n)]);
    p += n;
  }
  return out;
}
const types = (bytes: Uint8Array) => boxesOf(bytes).map(([t]) => t);
const boxOf = (bytes: Uint8Array, type: string) =>
  must(
    boxesOf(bytes).find(([t]) => t === type),
    type,
  )[1];
const box = (type: string, data: Uint8Array) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + data.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data]);
};

/** The marker segments of a codestream's main header after SOC, as [marker, payload], and its tile-parts. */
function codestream(cs: Uint8Array): { header: Array<[number, Buffer]>; parts: Buffer[]; tail: Buffer } {
  const b = Buffer.from(cs);
  const header: Array<[number, Buffer]> = [];
  let p = 2;
  while (b.readUInt16BE(p) !== 0xff90) {
    const n = b.readUInt16BE(p + 2);
    header.push([b.readUInt16BE(p), b.subarray(p + 4, p + 2 + n)]);
    p += 2 + n;
  }
  const parts: Buffer[] = [];
  while (b.readUInt16BE(p) === 0xff90) {
    const psot = b.readUInt32BE(p + 6);
    parts.push(b.subarray(p, p + psot));
    p += psot;
  }
  return { header, parts, tail: b.subarray(p) };
}
const markers = (cs: Uint8Array) => codestream(cs).header.map(([m]) => m);

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

const rgb = fixture('clean', 'jp2', 'rgb.jp2');

describe('JPEG 2000', () => {
  it('reads what OpenJPEG writes as clean: JP2 in gray, RGB and RGBA, tiled, layered, with a palette, and bare codestreams', async () => {
    for (const name of fixtureNames('clean', 'jp2')) {
      const r = await inspectFixture({}, 'clean', 'jp2', name);
      const bare = name.endsWith('.j2c');
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, kinds(r)]).to.deep.equal([
        name,
        'clean',
        bare ? 'j2c' : 'jp2',
        bare ? 'image/j2c' : 'image/jp2',
        32,
        24,
        1,
        ['METADATA/COMMENT'],
      ]);
      const d = await disarmImage(fixture('clean', 'jp2', name));
      expect([name, d.status, Buffer.compare(output(d), fixture('clean', 'jp2', name))]).to.deep.equal([name, 'clean', 0]);
    }
  });

  it("drops the encoder's comment under stripMetadata, and nothing else of the codestream", async () => {
    const d = await disarmImage(rgb, { stripMetadata: true });
    expect([d.status, kinds(must(d.after, 'after'))]).to.deep.equal(['defused', []]);
    const before = codestream(boxOf(rgb, 'jp2c'));
    const after = codestream(boxOf(output(d), 'jp2c'));
    expect(after.header).to.deep.equal(before.header.filter(([m]) => m !== 0xff64));
    expect(Buffer.concat(after.parts).equals(Buffer.concat(before.parts))).to.equal(true);
    const bare = await disarmFixture({ stripMetadata: true }, 'clean', 'jp2', 'codestream.j2c');
    expect([bare.status, markers(output(bare))]).to.deep.equal(['defused', [0xff51, 0xff52, 0xff5c]]);
  });

  it('reports the EXIF, GPS, IPTC and XMP exiftool writes, and stripMetadata removes their boxes', async () => {
    const r = await inspectFixture({}, 'meta', 'jp2', 'exif-iptc-xmp.jp2');
    expect([r.status, kinds(r)]).to.deep.equal(['clean', ['METADATA/COMMENT', 'METADATA/EXIF', 'METADATA/GPS', 'METADATA/IPTC', 'METADATA/XMP']]);
    const d = await disarmFixture({ stripMetadata: true }, 'meta', 'jp2', 'exif-iptc-xmp.jp2');
    expect([d.status, types(output(d))]).to.deep.equal(['defused', ['jP  ', 'ftyp', 'jp2h', 'jp2c']]);
  });

  it('keeps a colour profile under stripMetadata, and reports GeoJP2 and XML boxes as other metadata', async () => {
    const icc = await disarmFixture({ stripMetadata: true }, 'meta', 'jp2', 'icc.jp2');
    expect(kinds(icc.before)).to.deep.equal(['METADATA/ICC_PROFILE', 'METADATA/COMMENT', 'METADATA/STRIPPED']);
    expect(boxesOf(boxOf(output(icc), 'jp2h'))[1][1][0]).to.equal(2);
    const geo = await inspectFixture({}, 'meta', 'jp2', 'geojp2-xml.jp2');
    expect(of(geo, 'METADATA/OTHER').map(f => f.data?.kind)).to.deep.equal(['GeoJP2 georeferencing', 'XML']);
  });

  it('drops trailing data, data after EOC inside the codestream box, and the archive hidden there', async () => {
    const trailing = await disarmFixture({}, 'hostile', 'jp2', 'trailing.jp2');
    expect([acted(trailing.before), Buffer.compare(output(trailing), rgb)]).to.deep.equal([['STRUCTURE/TRAILING_DATA'], 0]);
    const hidden = await disarmFixture({}, 'hostile', 'jp2', 'hidden-after-eoc.jp2');
    expect([acted(hidden.before), Buffer.compare(output(hidden), rgb)]).to.deep.equal([['STRUCTURE/HIDDEN_DATA'], 0]);
    const zip = await disarmFixture({}, 'hostile', 'jp2', 'zip-after-eoc.jp2');
    expect([acted(zip.before), Buffer.compare(output(zip), rgb)]).to.deep.equal([['STRUCTURE/HIDDEN_DATA', 'POLYGLOT/ZIP'], 0]);
  });

  it('drops a PDF header in an XML box, XML that declares entities, a link to another file, and a second codestream', async () => {
    const pdf = await disarmFixture({}, 'hostile', 'jp2', 'pdf-in-xml.jp2');
    expect([acted(pdf.before), types(output(pdf))]).to.deep.equal([['POLYGLOT/PDF'], ['jP  ', 'ftyp', 'jp2h', 'jp2c']]);
    const doctype = await disarmFixture({}, 'hostile', 'jp2', 'doctype-xmp.jp2');
    expect([acted(doctype.before), Buffer.compare(output(doctype), rgb)]).to.deep.equal([['METADATA/DOCTYPE'], 0]);
    const link = await disarmFixture({}, 'hostile', 'jp2', 'data-reference.jp2');
    expect([acted(link.before), of(link.before, 'EXTERNAL/LINKED_FILE')[0].data?.target, Buffer.compare(output(link), rgb)]).to.deep.equal([
      ['EXTERNAL/LINKED_FILE'],
      'http://203.0.113.9/remote.j2c',
      0,
    ]);
    const second = await disarmFixture({}, 'hostile', 'jp2', 'second-codestream.jp2');
    expect([acted(second.before), Buffer.compare(output(second), rgb)]).to.deep.equal([['STRUCTURE/EXTRA_BLOCK'], 0]);
  });

  it('replaces a colour profile that does not parse with sRGB, and drops a box the JP2 header does not hold', async () => {
    const d = await disarmFixture({}, 'rewrite', 'jp2-header-edits.jp2');
    expect(acted(d.before)).to.deep.equal(['METADATA/MALFORMED', 'STRUCTURE/EXTRA_BLOCK']);
    expect(boxesOf(boxOf(output(d), 'jp2h')).map(([t, c]) => [t, c.toString('hex')])).to.deep.equal([
      ['ihdr', boxesOf(boxOf(rgb, 'jp2h'))[0][1].toString('hex')],
      ['colr', '01000000000010'],
    ]);
    expect(Buffer.compare(output(d), rgb)).to.equal(0);
    const bad = await disarmFixture({}, 'hostile', 'jp2', 'bad-icc.jp2');
    expect([bad.status, Buffer.compare(output(bad), rgb)]).to.deep.equal(['defused', 0]);
  });

  it('drops an unknown marker segment from the main header', async () => {
    const d = await disarmFixture({}, 'hostile', 'jp2', 'unknown-marker.j2c');
    expect([acted(d.before), Buffer.compare(output(d), fixture('clean', 'jp2', 'codestream.j2c'))]).to.deep.equal([['STRUCTURE/EXTRA_BLOCK'], 0]);
  });

  it("takes a comment out of a tile-part's header, writing its Psot and TLM entry again", async () => {
    const bytes = fixture('rewrite', 'jp2-tile-comment-tlm.j2c');
    const d = await disarmImage(bytes, { stripMetadata: true });
    expect([d.status, kinds(must(d.after, 'after'))]).to.deep.equal(['defused', []]);
    const out = codestream(output(d));
    const tlm = must(
      out.header.find(([m]) => m === 0xff55),
      'TLM',
    )[1];
    const listed = out.parts.map((_, i) => [tlm[2 + 5 * i], tlm.readUInt32BE(3 + 5 * i)]);
    expect(listed).to.deep.equal(out.parts.map(p => [p.readUInt16BE(4), p.length]));
    expect(out.parts.some(p => p.includes(Buffer.from('A tile-part comment')))).to.equal(false);
    expect(Buffer.concat(out.parts).equals(Buffer.concat(codestream(fixture('clean', 'jp2', 'tiled.j2c')).parts))).to.equal(true);
  });

  it('drops thumbnails no plugin accepts from Photoshop resources and EXIF, and writes in the ones a plugin rewrites', async () => {
    const bytes = fixture('rewrite', 'jp2-photoshop-exif.jp2');
    const d = await disarmImage(bytes);
    expect(acted(d.before)).to.deep.equal(['EMBEDDED_IMAGE/NO_PLUGIN']);
    const [photoshop, exif] = boxesOf(output(d)).filter(([t]) => t === 'uuid');
    const ids: number[] = [];
    const resources = photoshop[1].subarray(16);
    for (let p = 0; p < resources.length; ) {
      ids.push(resources.readUInt16BE(p + 4));
      const size = resources.readUInt32BE(p + 8);
      p += 12 + size + (size & 1);
    }
    expect(ids).to.deep.equal([0x0404, 0x0425]);
    const ifds = await IfdReader.open(bytesSlice(exif[1].subarray(16)));
    expect((await ifds.ifd(ifds.first)).next).to.equal(0);
    const gray = fixture('clean', 'jpeg', 'gray.jpg');
    const r = await disarmImage(bytes, { filePlugins: [replacing(gray)] });
    const after = must(r.after, 'after');
    expect([r.status, of(after, 'METADATA/THUMBNAIL').map(f => f.data?.bytes)]).to.deep.equal(['defused', [gray.length, gray.length]]);
    expect(kinds(after).filter(k => k === 'EMBEDDED_IMAGE/PLUGIN_SCRUBBED')).to.have.length(2);
  });

  it('refuses a codestream and a JP2 header that disagree, and channels or palette columns that are not there', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'jp2', 'size-mismatch.jp2'))).to.equal('the JP2 header gives 64 x 24 with 3 components and the codestream 32 x 24 with 3');
    expect(reason(await inspectFixture({}, 'hostile', 'jp2', 'cmap-column.jp2'))).to.equal('the component mapping names component 0, type 1, column 5');
    const boxes = boxesOf(rgb);
    const header = boxesOf(boxes[2][1]);
    const cdef = Buffer.from([0, 1, 0, 3, 0, 0, 0, 0]);
    const withCdef = Buffer.concat([
      box('jP  ', boxes[0][1]),
      box('ftyp', boxes[1][1]),
      box('jp2h', Buffer.concat([...header.map(([t, c]) => box(t, c)), box('cdef', cdef)])),
      box('jp2c', boxes[3][1]),
    ]);
    expect(reason(await inspectImage(withCdef))).to.equal('the channel definitions name channel 3, type 0, association 0 of 3 channels');
  });

  it('refuses a broken codestream: no EOC, too many levels or tiles, tile-parts out of order, and a TLM that disagrees', async () => {
    const expected: Record<string, [string, string]> = {
      'no-eoc.j2c': ['STRUCTURE/TRUNCATED', 'the codestream ends before EOC'],
      'levels.j2c': ['STRUCTURE/BAD_HEADER', 'COD gives 33 decomposition levels'],
      'many-tiles.j2c': ['STRUCTURE/BAD_HEADER', 'SIZ makes 131072 tiles'],
      'tile-part-order.j2c': ['STRUCTURE/BAD_LAYOUT', "tile 0's tile-part 1 comes where 0 should"],
      'tlm-wrong.j2c': ['STRUCTURE/AMBIGUOUS', 'TLM gives tile-part 2 as tile 2 of 157 bytes, and it is tile 2 of 156'],
      'no-header.jp2': ['STRUCTURE/BAD_LAYOUT', 'the codestream comes before the JP2 header box'],
    };
    for (const [name, [k, why]] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'hostile', 'jp2', name);
      expect([name, r.status, acted(r), reason(r)]).to.deep.equal([name, 'rejected', [k], why]);
    }
    expect(kinds(await inspectFixture({}, 'hostile', 'jp2', 'huge.j2c'))).to.deep.equal(['LIMIT/PIXELS']);
  });

  it('leaves JPX, JPM and Motion JPEG 2000 that do not list JP2 to a later version', async () => {
    const r = await inspectFixture({}, 'hostile', 'jp2', 'jpx-brand.jp2');
    expect([kinds(r), r.findings[0].data?.format]).to.deep.equal([['FORMAT/UNSUPPORTED'], 'JPX']);
  });
});
