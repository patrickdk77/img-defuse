import { expect } from 'chai';
import { inspectImage } from '../src';
import { inspectFixture, kindSet, kinds, of, reason, summary } from './helpers/util';

describe('BMP', () => {
  it('reads BMPs from Pillow and ImageMagick as clean, every header size and RLE8 included', async () => {
    for (const name of ['rgb24.bmp', 'pal8.bmp', 'mono.bmp', 'rle8.bmp', 'core.bmp', 'v5-alpha.bmp', 'rgb565.bmp']) {
      const r = await inspectFixture({}, 'clean', 'bmp', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, r.findings]).to.deep.equal([name, 'clean', 'bmp', 'image/bmp', 32, 24, 1, []]);
    }
    expect((await inspectFixture({}, 'clean', 'bmp', 'topdown.bmp')).status).to.equal('clean');
  });

  it('refuses truncated pixel data and reports trailing and hidden data', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'bmp', 'truncated.bmp'))).to.equal('the pixel data needs 48 bytes');
    expect(summary(await inspectFixture({}, 'hostile', 'bmp', 'trailing.bmp'))).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/TRAILING_DATA'] });
    expect(summary(await inspectFixture({}, 'hostile', 'bmp', 'hidden.bmp'))).to.deep.equal({ status: 'strippable', score: 20, kinds: ['STRUCTURE/HIDDEN_DATA'] });
  });

  it('strips a linked color profile, which reaches outside the file', async () => {
    const r = await inspectFixture({}, 'hostile', 'bmp', 'linked-profile.bmp');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 40, kinds: ['EXTERNAL/LINKED_PROFILE'] });
    expect(r.findings[0].data?.target).to.equal('\\\\attacker.invalid\\share\\profile.icc');
    expect(r.findings[0].description).to.equal('The image loads its color profile from \\\\attacker.invalid\\share\\profile.icc');
  });

  it('reports an embedded profile as metadata', async () => {
    const r = await inspectFixture({}, 'meta', 'bmp', 'icc.bmp');
    expect([r.status, kinds(r)]).to.deep.equal(['clean', ['METADATA/ICC_PROFILE']]);
  });

  it('walks RLE data and refuses runs outside the image or a missing end', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'bmp', 'rle-outside.bmp'))).to.equal('an RLE run leaves the image');
    expect(reason(await inspectFixture({}, 'hostile', 'bmp', 'rle-no-end.bmp'))).to.equal('the RLE data ends before its end-of-bitmap command');
  });

  it('refuses headers outside what Windows defines', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'bmp', 'bitfields.bmp'))).to.equal('the bit field masks overlap, have gaps or exceed the bit depth');
    expect(reason(await inspectFixture({}, 'hostile', 'bmp', 'topdown-rle.bmp'))).to.equal('a top-down image is compressed');
    expect(kinds(await inspectFixture({}, 'hostile', 'bmp', 'pixels.bmp'))).to.deep.equal(['LIMIT/PIXELS']);
  });

  it('stops at OS/2 2.x headers and embedded JPEG or PNG compression', async () => {
    for (const [name, format] of [
      ['os2v2.bmp', 'OS/2 2.x BMP'],
      ['jpeg.bmp', 'JPEG in BMP'],
    ]) {
      const r = await inspectFixture({}, 'hostile', 'bmp', name);
      expect([r.status, r.score, kinds(r), r.findings[0].data?.format]).to.deep.equal(['rejected', null, ['FORMAT/UNSUPPORTED'], format]);
    }
  });
});

describe('ICO and CUR', () => {
  it('reads icons of PNG and DIB images, and cursors, as clean', async () => {
    for (const [name, format, images] of [
      ['png.ico', 'ico', 2],
      ['bmp.ico', 'ico', 2],
      ['mixed.ico', 'ico', 2],
      ['cursor.cur', 'cur', 1],
    ] as const) {
      const r = await inspectFixture({}, 'clean', 'ico', name);
      expect([name, r.status, r.format, r.images, r.width, r.height, r.findings]).to.deep.equal([name, 'clean', format, images, 16, 16, []]);
    }
    expect((await inspectFixture({}, 'clean', 'ico', 'cursor.cur')).mimeType).to.equal('image/x-win-bitmap');
  });

  it('refuses overlapping images and images past the end', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'ico', 'overlap.ico'))).to.equal('images 1 and 2 share bytes');
    expect(reason(await inspectFixture({}, 'hostile', 'ico', 'past-end.ico'))).to.equal('an image runs past the end of the file');
    expect(reason(await inspectFixture({}, 'hostile', 'ico', 'short-dib.ico'))).to.equal('the image needs 1128 bytes and its entry gives 1088');
  });

  it('inspects a PNG image inside an icon with every PNG check', async () => {
    const r = await inspectFixture({}, 'hostile', 'ico', 'png-crc.ico');
    expect([kinds(r), r.findings[0].location]).to.deep.equal([['STRUCTURE/BAD_CHECKSUM'], 'image 1 at 22, IHDR chunk at 30']);
  });

  it('reports a directory size that disagrees with the image as ambiguous', async () => {
    const r = await inspectFixture({}, 'hostile', 'ico', 'size-mismatch.ico');
    expect([r.status, of(r, 'STRUCTURE/AMBIGUOUS')[0].data?.reason]).to.deep.equal(['rejected', 'the directory says 32 x 32 and the image is 16 x 16']);
  });

  it('reports data between and after the images', async () => {
    expect(kindSet(await inspectFixture({}, 'hostile', 'ico', 'hidden.ico'))).to.deep.equal(['STRUCTURE/HIDDEN_DATA']);
    expect(kindSet(await inspectFixture({}, 'hostile', 'ico', 'trailing.ico'))).to.deep.equal(['STRUCTURE/TRAILING_DATA']);
  });

  it('counts icons against the frame limit', async () => {
    expect(kinds(await inspectFixture({ limits: { frames: 1 } }, 'clean', 'ico', 'mixed.ico')).slice(-1)).to.deep.equal(['LIMIT/FRAMES']);
    const empty = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
    expect(reason(await inspectImage(empty))).to.equal('an image has the size 0');
  });
});
