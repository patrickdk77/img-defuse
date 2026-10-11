import { expect } from 'chai';
import { inspectImage } from '../src';
import { LzwCounter } from '../src/lzw';
import { gifOf, inspectFixture, kinds, lzwEncode, of, reason, summary } from './helpers/util';

describe('GIF', () => {
  it('reads GIFs from Pillow and gifsicle as clean', async () => {
    const expected: Record<string, number> = { 'still.gif': 1, 'anim.gif': 3, 'interlaced.gif': 1, 'optimized.gif': 3 };
    for (const [name, frames] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'clean', 'gif', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, r.findings]).to.deep.equal([name, 'clean', 'gif', 'image/gif', 32, 24, frames, []]);
    }
  });

  it('decodes LZW as the table grows to 12-bit codes and stays full', async () => {
    // Noise fills the 4096-entry table, and the encoder never clears it.
    let seed = 7;
    const pixels = Array.from({ length: 200 * 200 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 251;
    });
    const r = await inspectImage(gifOf(200, 200, pixels));
    expect([r.status, r.findings]).to.deep.equal(['clean', []]);
    const lzw = new LzwCounter(8, pixels.length);
    expect(lzw.feed(lzwEncode(pixels, 8))).to.equal(undefined);
    expect([lzw.produced, lzw.ended, lzw.maxIndex, lzw.after]).to.deep.equal([pixels.length, true, 250, 0]);
  });

  it('refuses invalid codes, and output that runs past or stops short of the frame', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'gif', 'bad-code.gif'))).to.equal('code 7 before any string is defined');
    expect(reason(await inspectFixture({}, 'hostile', 'gif', 'too-many.gif'))).to.equal("more than the frame's 16 pixels");
    expect(reason(await inspectFixture({}, 'hostile', 'gif', 'too-few.gif'))).to.equal('the image data ends after 10 of 16 pixels');
    expect(reason(await inspectFixture({}, 'hostile', 'gif', 'code-size.gif'))).to.equal('the LZW minimum code size is 12');
  });

  it('reports bytes after the LZW end code as hidden data, unless they are zero padding', async () => {
    const r = await inspectFixture({}, 'hostile', 'gif', 'after-end.gif');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 20, kinds: ['STRUCTURE/HIDDEN_DATA'] });
    const lzw = new LzwCounter(2, 1);
    lzw.feed(Buffer.from([0x2c, 0x00, 0x00]));
    expect([lzw.ended, lzw.after, lzw.afterNonZero]).to.deep.equal([true, 2, false]);
  });

  it('reports frames outside the screen, a missing color table and indexes past the table as ambiguous', async () => {
    for (const [name, why] of [
      ['outside.gif', 'the image lies outside the logical screen'],
      ['no-table.gif', 'the image has no color table'],
      ['index-past.gif', 'color index 3 is past the 2-entry table'],
    ]) {
      const r = await inspectFixture({}, 'hostile', 'gif', name);
      expect([name, r.status, r.score, of(r, 'STRUCTURE/AMBIGUOUS')[0]?.data?.reason]).to.deep.equal([name, 'rejected', 0, why]);
    }
  });

  it('refuses truncation and bytes that start no block, and reports data after the trailer', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'gif', 'truncated.gif'))).to.equal('the GIF ends before its trailer');
    expect(reason(await inspectFixture({}, 'hostile', 'gif', 'bad-block.gif'))).to.equal('the byte 0x99 starts no GIF block');
    expect(summary(await inspectFixture({}, 'hostile', 'gif', 'trailing.gif'))).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/TRAILING_DATA'] });
  });

  it('checks the logical screen against the pixel limit, and each frame before decoding it', async () => {
    expect(kinds(await inspectFixture({}, 'hostile', 'gif', 'pixels.gif'))).to.deep.equal(['LIMIT/PIXELS']);
    expect(kinds(await inspectFixture({ limits: { decodedBytes: 100 } }, 'clean', 'gif', 'still.gif'))).to.deep.equal(['LIMIT/DECODED_SIZE']);
    expect(kinds(await inspectFixture({ limits: { frames: 2 } }, 'clean', 'gif', 'anim.gif'))).to.deep.equal(['LIMIT/FRAMES']);
  });

  it('drops plain text and unknown extensions, and reports metadata extensions', async () => {
    expect(of(await inspectFixture({}, 'hostile', 'gif', 'plain-text.gif'), 'STRUCTURE/EXTRA_BLOCK')[0].data?.block).to.equal('plain text extension');
    expect(of(await inspectFixture({}, 'hostile', 'gif', 'unknown-app.gif'), 'STRUCTURE/EXTRA_BLOCK')[0].data?.block).to.equal('application extension XXXXXXXX1.0');
    expect(kinds(await inspectFixture({}, 'meta', 'gif', 'comment.gif'))).to.deep.equal(['METADATA/COMMENT']);
    expect(kinds(await inspectFixture({}, 'meta', 'gif', 'xmp.gif'))).to.deep.equal(['METADATA/XMP']);
    expect(summary(await inspectFixture({}, 'hostile', 'gif', 'xmp-doctype.gif'))).to.deep.equal({ status: 'strippable', score: 40, kinds: ['METADATA/XMP', 'METADATA/DOCTYPE'] });
  });

  it('reports ImageMagick extension blocks in its own output', async () => {
    expect(of(await inspectFixture({}, 'quirks', 'gif', 'imagemagick.gif'), 'STRUCTURE/EXTRA_BLOCK')[0].data?.block).to.equal('application extension ImageMagick');
  });
});
