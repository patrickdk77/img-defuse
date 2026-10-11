import { expect } from 'chai';
import { ImageCategory as C, ImageDetail as D, inspectImage } from '../src';
import { checkIcc, hasDoctype, photoshopResources } from '../src/metadata';
import { bytesSlice } from '../src/slice';
import { chunk, fixture, grayPng, inspectFixture, kinds, of } from './helpers/util';

async function* pieces(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield Buffer.from(p, 'latin1');
}

describe('metadata', () => {
  it('reports metadata as info and leaves the status clean', async () => {
    const r = await inspectFixture({}, 'meta', 'jpeg', 'xmp-iptc-comment.jpg');
    expect([r.status, r.score, r.findings.map(f => f.action)]).to.deep.equal(['clean', 0, ['info', 'info', 'info']]);
  });

  it('with stripMetadata, adds METADATA/STRIPPED at each block and makes the status strippable, as pdf-defuse does', async () => {
    const r = await inspectFixture({ stripMetadata: true }, 'meta', 'jpeg', 'xmp-iptc-comment.jpg');
    expect([r.status, r.score, kinds(r)]).to.deep.equal(['strippable', 0, ['METADATA/IPTC', 'METADATA/STRIPPED', 'METADATA/XMP', 'METADATA/STRIPPED', 'METADATA/COMMENT', 'METADATA/STRIPPED']]);
    expect(of(r, 'METADATA/STRIPPED').map(f => f.location)).to.deep.equal(of(r, 'METADATA/STRIPPED').map((_, i) => r.findings[i * 2].location));
  });

  it('keeps the ICC profile when metadata is stripped, unless an override strips it', async () => {
    const kept = await inspectFixture({ stripMetadata: true }, 'meta', 'jpeg', 'icc.jpg');
    expect([kept.status, kinds(kept)]).to.deep.equal(['clean', ['METADATA/ICC_PROFILE']]);
    const stripped = await inspectFixture({ actionOverrides: [{ category: C.Metadata, detail: D.IccProfile, action: 'strip' }] }, 'meta', 'jpeg', 'icc.jpg');
    expect(stripped.status).to.equal('strippable');
  });

  it('hands a kept thumbnail to the plugins, and with stripMetadata or a strip override the thumbnail goes with its block', async () => {
    const plain = await inspectFixture({}, 'meta', 'jpeg', 'exif-gps-thumb.jpg');
    expect(kinds(plain)).to.include('EMBEDDED_IMAGE/NO_PLUGIN');
    const stripped = await inspectFixture({ stripMetadata: true }, 'meta', 'jpeg', 'exif-gps-thumb.jpg');
    expect(kinds(stripped)).to.deep.equal(['METADATA/EXIF', 'METADATA/STRIPPED', 'METADATA/GPS', 'METADATA/THUMBNAIL']);
    const thumbOff = await inspectFixture({ actionOverrides: [{ category: C.Metadata, detail: D.Thumbnail, action: 'strip' }] }, 'meta', 'jpeg', 'exif-gps-thumb.jpg');
    expect(kinds(thumbOff)).to.not.include('EMBEDDED_IMAGE/NO_PLUGIN');
    const exifOff = await inspectFixture({ actionOverrides: [{ category: C.Metadata, detail: D.Exif, action: 'strip' }] }, 'meta', 'jpeg', 'exif-gps-thumb.jpg');
    expect(kinds(exifOff)).to.not.include('EMBEDDED_IMAGE/NO_PLUGIN');
  });

  it('checks ICC headers and tag tables', async () => {
    const good = fixture('meta', 'bmp', 'icc.bmp').subarray(14 + 124 + 16);
    expect(await checkIcc(bytesSlice(good))).to.equal(undefined);
    const longer = Buffer.concat([good, Buffer.alloc(4)]);
    expect(await checkIcc(bytesSlice(longer))).to.match(/declares \d+ bytes and holds/);
    const noMagic = Buffer.from(good);
    noMagic.write('xxxx', 36, 'latin1');
    expect(await checkIcc(bytesSlice(noMagic))).to.equal('the ICC profile lacks its acsp signature');
    const badTag = Buffer.from(good);
    badTag.writeUInt32BE(0xffffff00, 132 + 4);
    expect(await checkIcc(bytesSlice(badTag))).to.equal('an ICC tag lies outside the profile');
    const manyTags = Buffer.from(good);
    manyTags.writeUInt32BE(0x10000000, 128);
    expect(await checkIcc(bytesSlice(manyTags))).to.equal('the ICC tag table runs past the end of the profile');
  });

  it('finds a document type or entity in XML in any case, across pieces, and in UTF-16', async () => {
    expect(await hasDoctype(pieces('<x:xmpmeta/>'))).to.equal(false);
    expect(await hasDoctype(pieces('<!DocType x>'))).to.equal(true);
    expect(await hasDoctype(pieces('<x/><!EN', 'TITY e "x">'))).to.equal(true);
    expect(await hasDoctype(pieces(Buffer.from('<!DOCTYPE x>', 'utf16le').toString('latin1')))).to.equal(true);
  });

  it('reads Photoshop resources for IPTC and thumbnails, and lists every resource', async () => {
    const res = (id: number, data: Buffer) => {
      const head = Buffer.from('8BIM\0\0\0\0\0\0\0\0', 'latin1');
      head.writeUInt16BE(id, 4);
      head.writeUInt32BE(data.length, 8);
      return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const parsed = await photoshopResources(bytesSlice(Buffer.concat([res(0x0404, Buffer.alloc(3)), res(0x040c, Buffer.alloc(40))])));
    expect(parsed).to.deep.equal({
      iptc: true,
      thumbnails: [{ offset: 16 + 12 + 28, length: 12, resourceStart: 16, resourceEnd: 16 + 12 + 40, sizeAt: 16 + 8, dataStart: 16 + 12 }],
      resources: [
        { signature: '8BIM', id: 0x0404, start: 0, end: 16, dataStart: 12, dataEnd: 15 },
        { signature: '8BIM', id: 0x040c, start: 16, end: 68, dataStart: 28, dataEnd: 68 },
      ],
    });
    expect(await photoshopResources(bytesSlice(Buffer.from('nope')))).to.equal('a Photoshop resource ends inside its header');
    expect(await photoshopResources(bytesSlice(Buffer.from('ABCDEFGH')))).to.equal('a Photoshop resource has no 8BIM signature');
  });

  it('reports a text chunk as metadata whatever it says, and its keyword in data', async () => {
    const r = await inspectImage(grayPng([chunk('tEXt', 'Author\0someone')]));
    expect([r.status, r.findings[0].data, r.findings[0].description]).to.deep.equal(['clean', { keyword: 'Author' }, 'Descriptive text: Author']);
  });
});
