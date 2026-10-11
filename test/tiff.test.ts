import { expect } from 'chai';
import { inspectImage } from '../src';
import { fixture, inspectFixture, kindSet, kinds, of, reason, summary } from './helpers/util';

describe('TIFF', () => {
  it('reads TIFFs from Pillow and ImageMagick as clean: every compression, tiles, planes, pages and BigTIFF', async () => {
    const expected: Record<string, [number, number, number]> = {
      'none.tif': [32, 24, 1],
      'lzw.tif': [32, 24, 1],
      'deflate.tif': [32, 24, 1],
      'packbits.tif': [32, 24, 1],
      'jpeg.tif': [32, 24, 1],
      'palette.tif': [32, 24, 1],
      'multipage.tif': [32, 24, 3],
      'tiled.tif': [32, 24, 1],
      'bigtiff.tif': [32, 24, 1],
      'planar.tif': [32, 24, 1],
      'hand.tif': [8, 8, 1],
      'hand-mm.tif': [4, 2, 1],
    };
    for (const [name, [w, h, n]] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'clean', 'tiff', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images]).to.deep.equal([name, 'clean', 'tif', 'image/tiff', w, h, n]);
      expect(
        r.findings.filter(f => f.action !== 'info'),
        name,
      ).to.deep.equal([]);
    }
  });

  it('stops at an IFD reached twice, through the chain or a SubIFD', async () => {
    for (const name of ['loop.tif', 'subifd-loop.tif']) {
      const r = await inspectFixture({}, 'hostile', 'tiff', name);
      expect([name, r.status, r.score, kinds(r).slice(-1)[0], reason(r)]).to.deep.equal([name, 'rejected', null, 'STRUCTURE/LOOP', 'the IFD at 8 is reached twice']);
    }
  });

  it('stops at two structures that share bytes', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'tiff', 'overlap.tif'))).to.equal('the IFD at 8 shares bytes with the strip at 8');
  });

  it('checks strips against the file and the image size', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'tiff', 'truncated.tif'))).to.equal('strip 0 runs past the end of the file');
    expect(reason(await inspectFixture({}, 'hostile', 'tiff', 'short-strip.tif'))).to.equal('uncompressed strip 0 holds 32 bytes for 64');
    expect(reason(await inspectFixture({}, 'hostile', 'tiff', 'strip-count.tif'))).to.equal('the image needs 2 strips and lists only 1');
    expect(reason(await inspectFixture({}, 'hostile', 'tiff', 'no-counts.tif'))).to.equal('the image has no strip byte counts');
  });

  it('computes the decoded size from the dimensions and checks it before anything else', async () => {
    expect(kinds(await inspectFixture({}, 'hostile', 'tiff', 'pixels.tif'))).to.deep.equal(['LIMIT/PIXELS']);
    expect(kinds(await inspectFixture({ limits: { decodedBytes: 1000 } }, 'clean', 'tiff', 'none.tif'))).to.deep.equal(['LIMIT/DECODED_SIZE']);
    expect(kinds(await inspectFixture({ limits: { frames: 2 } }, 'clean', 'tiff', 'multipage.tif')).slice(-1)).to.deep.equal(['LIMIT/FRAMES']);
  });

  it('stops at a compression or photometric interpretation it does not read', async () => {
    for (const [name, format] of [
      ['jpeg2000.tif', 'TIFF compression 34712'],
      ['cfa.tif', 'TIFF photometric interpretation 32803'],
    ]) {
      const r = await inspectFixture({}, 'hostile', 'tiff', name);
      expect([name, kinds(r), r.findings[0].data?.format]).to.deep.equal([name, ['FORMAT/UNSUPPORTED'], format]);
    }
  });

  it('reports old-style JPEG compression as info, and lets its data hold the strips', async () => {
    const r = await inspectFixture({}, 'hostile', 'tiff', 'old-jpeg.tif');
    expect(summary(r)).to.deep.equal({ status: 'clean', score: 20, kinds: ['CONTENT/OLD_JPEG'] });
  });

  it('reports gaps that are not zero as hidden data, and bytes after the last structure as trailing', async () => {
    expect(summary(await inspectFixture({}, 'hostile', 'tiff', 'hidden.tif'))).to.deep.equal({ status: 'strippable', score: 20, kinds: ['STRUCTURE/HIDDEN_DATA'] });
    expect(summary(await inspectFixture({}, 'hostile', 'tiff', 'trailing.tif'))).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/TRAILING_DATA'] });
    // Pillow writes each page as a whole TIFF and leaves the page's header in place.
    const pillow = await inspectFixture({}, 'quirks', 'tiff', 'pillow-multipage.tif');
    expect([pillow.status, of(pillow, 'STRUCTURE/HIDDEN_DATA').map(f => f.data?.bytes)]).to.deep.equal(['strippable', [12]]);
  });

  it('drops private tags, and reports a tag given twice as ambiguous', async () => {
    const r = await inspectFixture({}, 'hostile', 'tiff', 'private-tag.tif');
    expect([r.status, of(r, 'STRUCTURE/EXTRA_BLOCK')[0].data?.tags]).to.deep.equal(['strippable', '37724']);
    const dup = await inspectFixture({}, 'hostile', 'tiff', 'duplicate-tag.tif');
    expect([dup.status, of(dup, 'STRUCTURE/AMBIGUOUS')[0].data?.reason]).to.deep.equal(['rejected', 'tags given twice: 305']);
    expect(reason(await inspectFixture({}, 'hostile', 'tiff', 'bad-type.tif'))).to.equal('tag 305 has the type 99, which TIFF does not define');
  });

  it('reports descriptive tags, XMP, EXIF and GPS as metadata', async () => {
    const r = await inspectFixture({}, 'meta', 'tiff', 'meta.tif');
    expect([r.status, kindSet(r)]).to.deep.equal(['clean', ['METADATA/XMP', 'METADATA/TEXT', 'METADATA/EXIF', 'METADATA/GPS']]);
  });

  it('refuses headers that are not TIFF', async () => {
    const t = Buffer.from(fixture('clean', 'tiff', 'hand.tif'));
    t.writeUInt32LE(100000, 4);
    expect(reason(await inspectImage(t))).to.equal('an IFD at 100000 lies outside the file');
    const big = Buffer.from('II+\0\x04\0\0\0', 'latin1');
    expect(reason(await inspectImage(Buffer.concat([big, Buffer.alloc(8)])))).to.equal('the BigTIFF header has an offset size other than 8');
  });
});
