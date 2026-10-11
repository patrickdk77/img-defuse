import { expect } from 'chai';
import { inspectImage } from '../src';
import { fixture, inspectFixture, kindSet, kinds, of, reason, summary } from './helpers/util';

const riffChunk = (id: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
};
const webp = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const head = Buffer.from('RIFF\0\0\0\0', 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const vp8x = (flags: number, width: number, height: number) => {
  const b = Buffer.alloc(10);
  b[0] = flags;
  b.writeUIntLE(width - 1, 4, 3);
  b.writeUIntLE(height - 1, 7, 3);
  return riffChunk('VP8X', b);
};
/** The VP8L chunk data of the lossless fixture, a 32 x 24 image. */
const vp8l = () => {
  const f = fixture('clean', 'webp', 'lossless.webp');
  return f.subarray(20, 20 + f.readUInt32LE(16));
};

describe('WebP', () => {
  it('reads lossy, lossless, alpha and animated WebP from the libwebp tools as clean', async () => {
    const expected: Record<string, number> = { 'lossy.webp': 1, 'lossless.webp': 1, 'alpha.webp': 1, 'anim.webp': 3, 'from-gif.webp': 3 };
    for (const [name, frames] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'clean', 'webp', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, r.findings]).to.deep.equal([name, 'clean', 'webp', 'image/webp', 32, 24, frames, []]);
    }
  });

  it('refuses a RIFF size past the end and reports bytes after it as trailing', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'webp', 'riff-size.webp'))).to.equal('the RIFF size runs 100 bytes past the end of the file');
    expect(summary(await inspectFixture({}, 'hostile', 'webp', 'trailing.webp'))).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/TRAILING_DATA'] });
  });

  it('drops unknown chunks, and reports a padding byte that is not zero as hidden data', async () => {
    expect(of(await inspectFixture({}, 'hostile', 'webp', 'simple-extra.webp'), 'STRUCTURE/EXTRA_BLOCK')[0].data?.reason).to.equal('a chunk after the image in a simple WebP file');
    expect(kindSet(await inspectFixture({}, 'hostile', 'webp', 'unknown-chunk.webp'))).to.deep.equal(['STRUCTURE/HIDDEN_DATA', 'STRUCTURE/EXTRA_BLOCK']);
  });

  it('checks the canvas against the pixel limit and the image against the canvas', async () => {
    expect(kinds(await inspectFixture({}, 'hostile', 'webp', 'canvas.webp'))).to.deep.equal(['LIMIT/PIXELS']);
    expect(reason(await inspectFixture({}, 'hostile', 'webp', 'canvas-mismatch.webp'))).to.equal('the image is 32 x 24 and the canvas 64 x 64');
    expect(reason(await inspectImage(webp(vp8x(0, 65536, 65536), riffChunk('VP8L', vp8l()))))).to.equal('the canvas is 65536 x 65536');
  });

  it('checks animation frames and the flags', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'webp', 'frame-outside.webp'))).to.equal('an animation frame lies outside the canvas');
    expect(of(await inspectFixture({}, 'hostile', 'webp', 'icc-flag.webp'), 'STRUCTURE/AMBIGUOUS')[0].data?.reason).to.equal('the ICC flag disagrees with the chunks present');
    expect(reason(await inspectImage(webp(vp8x(0x02, 32, 24), riffChunk('VP8L', vp8l()))))).to.equal('an animated WebP has a VP8L chunk outside its frames');
    expect(reason(await inspectImage(webp(vp8x(0, 32, 24), riffChunk('ANIM', Buffer.alloc(6)))))).to.equal('ANIM appears without the animation flag');
  });

  it('checks the VP8 and VP8L headers without decoding their data', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'webp', 'not-keyframe.webp'))).to.equal('the VP8 data is not a key frame');
    expect(reason(await inspectFixture({}, 'hostile', 'webp', 'first-chunk.webp'))).to.equal('the first chunk is ABCD, not VP8, VP8L or VP8X');
    const v = Buffer.from(vp8l());
    v[4] |= 0x20;
    expect(reason(await inspectImage(webp(riffChunk('VP8L', v))))).to.equal('the VP8L data has the version 1');
  });

  it('checks uncompressed alpha against the image size', async () => {
    const lossy = fixture('clean', 'webp', 'lossy.webp');
    const vp8 = lossy.subarray(20, 20 + lossy.readUInt32LE(16));
    const ok = webp(vp8x(0x10, 32, 24), riffChunk('ALPH', Buffer.concat([Buffer.from([0]), Buffer.alloc(32 * 24)])), riffChunk('VP8 ', vp8));
    expect((await inspectImage(ok)).status).to.equal('clean');
    const short = webp(vp8x(0x10, 32, 24), riffChunk('ALPH', Buffer.concat([Buffer.from([0]), Buffer.alloc(10)])), riffChunk('VP8 ', vp8));
    expect(reason(await inspectImage(short))).to.equal('uncompressed alpha holds 10 bytes for 768 pixels');
  });

  it('reports ICC, EXIF and XMP chunks as metadata', async () => {
    const r = await inspectFixture({}, 'meta', 'webp', 'meta.webp');
    expect([r.status, kindSet(r)]).to.deep.equal(['clean', ['METADATA/ICC_PROFILE', 'METADATA/EXIF', 'METADATA/GPS', 'METADATA/XMP']]);
    expect(summary(await inspectFixture({}, 'hostile', 'webp', 'xmp-doctype.webp'))).to.deep.equal({ status: 'strippable', score: 40, kinds: ['METADATA/XMP', 'METADATA/DOCTYPE'] });
  });
});
