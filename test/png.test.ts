import * as zlib from 'node:zlib';
import { expect } from 'chai';
import { inspectImage } from '../src';
import { chunk, fixture, grayPng, grayRows, ihdr, inspectFixture, kindSet, kinds, of, png, reason, summary } from './helpers/util';

describe('PNG', () => {
  it('reads PNGs from Pillow and ImageMagick as clean, with their size and frame count', async () => {
    const expected: Record<string, [number, number, number]> = {
      'rgb.png': [32, 24, 1],
      'rgba.png': [32, 24, 1],
      'palette.png': [32, 24, 1],
      'gray1.png': [32, 24, 1],
      'gray16.png': [32, 24, 1],
      'interlaced.png': [32, 24, 1],
      'apng.png': [32, 24, 3],
      'apng-default.png': [32, 24, 3],
      'apng-hand.png': [8, 8, 3],
    };
    for (const [name, [w, h, n]] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'clean', 'png', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, r.findings]).to.deep.equal([name, 'clean', 'png', 'image/png', w, h, n, []]);
    }
  });

  it('refuses a bad CRC, truncation and a missing IEND, and stops the run', async () => {
    const cases: Record<string, string> = {
      'bad-crc.png': 'STRUCTURE/BAD_CHECKSUM',
      'truncated.png': 'STRUCTURE/TRUNCATED',
      'no-iend.png': 'STRUCTURE/TRUNCATED',
    };
    for (const [name, k] of Object.entries(cases)) {
      const r = await inspectFixture({}, 'hostile', 'png', name);
      expect([name, r.status, r.score, r.risk, kinds(r).slice(-1)[0]]).to.deep.equal([name, 'rejected', null, 'UNKNOWN', k]);
    }
  });

  it('checks the CRC of IDAT chunks after the end of the zlib stream', async () => {
    const after = chunk('IDAT', Buffer.alloc(4));
    after[after.length - 1] ^= 1;
    const r = await inspectImage(png(ihdr(8, 8), chunk('IDAT', zlib.deflateSync(grayRows(8, 8))), after));
    expect(kinds(r)).to.deep.equal(['STRUCTURE/BAD_CHECKSUM']);
  });

  it('drops an ancillary chunk whose CRC does not match, as libpng and image-png do by default', async () => {
    const text = chunk('tEXt', 'Title\0x');
    text[text.length - 1] ^= 1;
    const r = await inspectImage(grayPng([text]));
    expect([r.status, kinds(r)]).to.deep.equal(['strippable', ['STRUCTURE/EXTRA_BLOCK']]);
    expect(of(r, 'STRUCTURE/EXTRA_BLOCK')[0].data?.reason).to.equal('its CRC does not match');
  });

  it('reports trailing data after IEND as strip', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'trailing-html.png');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/TRAILING_DATA'] });
    const size = fixture('hostile', 'png', 'trailing-html.png').length;
    expect(r.findings[0].data).to.deep.equal({ offset: size - 38, bytes: 38 });
    // Zero bytes after IEND are padding.
    expect((await inspectImage(Buffer.concat([grayPng(), Buffer.alloc(16)]))).status).to.equal('clean');
  });

  it('checks the pixel and decoded size limits from IHDR before it reads any image data', async () => {
    const pixels = await inspectFixture({}, 'hostile', 'png', 'pixels.png');
    expect([pixels.status, kinds(pixels)]).to.deep.equal(['rejected', ['LIMIT/PIXELS']]);
    const decoded = await inspectFixture({}, 'hostile', 'png', 'decoded.png');
    expect([decoded.status, kinds(decoded)]).to.deep.equal(['rejected', ['LIMIT/DECODED_SIZE']]);
    expect(decoded.findings[0].data).to.include({ bytes: 16000 * (1 + 16000 * 8), limit: 1024 ** 3 });
    // The IDAT is corrupt and its CRC wrong, so reading it would end the run another way.
    const idat = chunk('IDAT', 'not zlib at all');
    idat[idat.length - 1] ^= 1;
    expect(kinds(await inspectImage(png(ihdr(100000, 100000), idat)))).to.deep.equal(['LIMIT/PIXELS']);
  });

  it('stops inflating as soon as the output passes the size IHDR gives', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'zlib-bomb.png');
    expect([kinds(r), reason(r)]).to.deep.equal([['STRUCTURE/BAD_DATA'], 'the image data inflates past 10100 bytes']);
    expect(fixture('hostile', 'png', 'zlib-bomb.png').length).to.be.lessThan(100_000);
  });

  it('refuses image data that is short, has a bad filter byte, or is not one unbroken IDAT run', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'png', 'short-data.png'))).to.equal('the image data inflates to 36 bytes, not 72');
    expect(reason(await inspectFixture({}, 'hostile', 'png', 'bad-filter.png'))).to.match(/filter type 7/);
    const split = await inspectFixture({}, 'hostile', 'png', 'split-idat.png');
    expect([kinds(split).slice(-1)[0], reason(split)]).to.deep.equal(['STRUCTURE/BAD_LAYOUT', 'IDAT chunks are not consecutive']);
  });

  it('checks filter bytes pass by pass in an interlaced image', async () => {
    const h = { width: 5, height: 5 };
    // The seven Adam7 passes of a 5 x 5 image, each a list of its rows' widths.
    const rows: number[][] = [[1], [1], [2], [1, 1], [3], [2, 2, 2], [5, 5]];
    const raw = Buffer.concat(rows.flatMap(pass => pass.map(n => Buffer.concat([Buffer.from([0]), Buffer.alloc(n, 9)]))));
    const ok = png(ihdr(h.width, h.height, 8, 0, 1), chunk('IDAT', zlib.deflateSync(raw)));
    expect((await inspectImage(ok)).status).to.equal('clean');
    const bad = Buffer.from(raw);
    bad[raw.length - 6] = 5;
    expect(reason(await inspectImage(png(ihdr(5, 5, 8, 0, 1), chunk('IDAT', zlib.deflateSync(bad)))))).to.match(/filter type 5/);
  });

  it('reports compressed bytes after the end of the zlib stream as hidden data', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'after-stream.png');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 20, kinds: ['STRUCTURE/HIDDEN_DATA'] });
    expect(r.findings[0].data).to.include({ bytes: 6 });
    const padded = png(ihdr(8, 8), chunk('IDAT', Buffer.concat([zlib.deflateSync(grayRows(8, 8)), Buffer.alloc(4)])));
    expect((await inspectImage(padded)).status).to.equal('clean');
  });

  it('refuses an unknown critical chunk and drops an unknown ancillary one', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'png', 'critical.png'))).to.equal('the critical chunk CRIT is unknown');
    const r = await inspectFixture({}, 'hostile', 'png', 'private.png');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/EXTRA_BLOCK'] });
    expect(r.findings[0].data).to.deep.equal({ block: 'prVt chunk', reason: 'a chunk viewers do not use' });
  });

  it('reports a second ancillary chunk the specification allows once as ambiguous', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'two-gama.png');
    expect([r.status, r.score, kinds(r)]).to.deep.equal(['rejected', 0, ['STRUCTURE/AMBIGUOUS']]);
  });

  it('drops chunks out of place or with the wrong length', async () => {
    expect(of(await inspectFixture({}, 'hostile', 'png', 'late-gama.png'), 'STRUCTURE/EXTRA_BLOCK')[0].data?.reason).to.equal('out of place');
    expect(of(await inspectImage(grayPng([chunk('gAMA', 'xx')])), 'STRUCTURE/EXTRA_BLOCK')[0].data?.reason).to.equal('gAMA has the length 2, not 4');
    expect(of(await inspectImage(grayPng([chunk('tRNS', 'x')])), 'STRUCTURE/EXTRA_BLOCK')[0].data?.reason).to.equal('tRNS has the length 1, not 2');
    expect((await inspectImage(grayPng([chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])), chunk('pHYs', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0]))]))).status).to.equal('clean');
  });

  it('refuses header values PNG does not define', async () => {
    const bad = async (h: Buffer) => kinds(await inspectImage(png(h, chunk('IDAT', zlib.deflateSync(grayRows(8, 8))))))[0];
    expect(await bad(ihdr(0, 8))).to.equal('STRUCTURE/BAD_HEADER');
    expect(await bad(ihdr(8, 8, 3, 0))).to.equal('STRUCTURE/BAD_HEADER');
    expect(await bad(ihdr(8, 8, 16, 3))).to.equal('STRUCTURE/BAD_HEADER');
    expect(await bad(ihdr(8, 8, 8, 0, 2))).to.equal('STRUCTURE/BAD_HEADER');
    expect(await bad(chunk('IHDR', Buffer.alloc(12)))).to.equal('STRUCTURE/BAD_HEADER');
    expect(kinds(await inspectImage(png(ihdr(8, 8), chunk('PLTE', Buffer.alloc(6)), chunk('IDAT', zlib.deflateSync(grayRows(8, 8)))))).slice(-1)).to.deep.equal(['STRUCTURE/BAD_LAYOUT']);
    expect(reason(await inspectImage(Buffer.concat([png(ihdr(8, 8, 8, 3)).subarray(0, -12), chunk('IDAT', zlib.deflateSync(grayRows(8, 8))), chunk('IEND')])))).to.equal(
      'a palette image has no PLTE before IDAT',
    );
  });

  it('checks APNG frames: sequence numbers, the canvas, and acTL', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'png', 'apng-sequence.png'))).to.equal('fdAT has the sequence number 9 where 4 belongs');
    expect(reason(await inspectFixture({}, 'hostile', 'png', 'apng-outside.png'))).to.equal('an APNG frame lies outside the canvas');
    const r = await inspectFixture({}, 'hostile', 'png', 'apng-no-actl.png');
    expect([r.status, r.images, of(r, 'STRUCTURE/EXTRA_BLOCK').map(f => f.data?.reason)]).to.deep.equal([
      'strippable',
      1,
      ['fcTL without acTL', 'fcTL without acTL', 'fdAT without acTL', 'fcTL without acTL', 'fdAT without acTL'],
    ]);
  });

  it('counts APNG frames against the frame limit and inflates each against its own size', async () => {
    expect(kinds(await inspectFixture({ limits: { frames: 2 } }, 'clean', 'png', 'apng-hand.png'))).to.deep.equal(['LIMIT/FRAMES']);
    expect(kinds(await inspectFixture({ limits: { totalDecodedBytes: 150 } }, 'clean', 'png', 'apng-hand.png'))).to.deep.equal(['LIMIT/TOTAL_DECODED_SIZE']);
  });

  it('reports metadata chunks as info, by what they hold', async () => {
    const text = await inspectFixture({}, 'meta', 'png', 'text.png');
    expect([text.status, of(text, 'METADATA/TEXT').map(f => f.data?.keyword)]).to.deep.equal(['clean', ['Title', 'Comment', 'Description']]);
    expect(kindSet(await inspectFixture({}, 'meta', 'png', 'xmp.png'))).to.deep.equal(['METADATA/XMP']);
    expect(kindSet(await inspectFixture({}, 'meta', 'png', 'icc.png'))).to.deep.equal(['METADATA/ICC_PROFILE']);
    expect(kindSet(await inspectFixture({}, 'meta', 'png', 'exif.png'))).to.deep.equal(['METADATA/EXIF', 'METADATA/GPS']);
    expect(of(await inspectFixture({}, 'meta', 'png', 'time.png'), 'METADATA/OTHER')[0].data?.kind).to.equal('modification time');
    const raw = await inspectImage(grayPng([chunk('zTXt', Buffer.concat([Buffer.from('Raw profile type iptc\0\0'), zlib.deflateSync('\niptc\n4\n00000000\n')]))]));
    expect(kinds(raw)).to.deep.equal(['METADATA/IPTC']);
  });

  it('stops at the metadata size limit when a compressed text chunk inflates too far', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'ztxt-bomb.png');
    expect([r.status, kinds(r).slice(-1)[0]]).to.deep.equal(['rejected', 'LIMIT/METADATA_SIZE']);
    expect(kinds(await inspectFixture({ limits: { metadataBytes: 30 } }, 'meta', 'png', 'text.png')).slice(-1)).to.deep.equal(['LIMIT/METADATA_SIZE']);
  });

  it('reports text chunks that break their layout or do not inflate as malformed', async () => {
    const bad = async (c: Buffer) => of(await inspectImage(grayPng([c])), 'METADATA/MALFORMED')[0]?.data?.reason;
    expect(await bad(chunk('tEXt', 'no keyword end'))).to.match(/keyword/);
    expect(await bad(chunk('zTXt', 'Title\0\0not zlib'))).to.match(/does not inflate/);
    expect(await bad(chunk('zTXt', 'Title\0\x05x'))).to.match(/compression method/);
    expect(await bad(chunk('iTXt', 'Title\0\x02\0\0\0x'))).to.equal('iTXt breaks its layout');
    expect(await bad(chunk('iCCP', Buffer.concat([Buffer.from('sRGB\0\0'), zlib.deflateSync(Buffer.alloc(200))])))).to.match(/ICC profile declares 0 bytes/);
  });

  it('reports XMP that declares a document type', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'xmp-doctype.png');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 40, kinds: ['METADATA/XMP', 'METADATA/DOCTYPE'] });
  });

  it('reports an EXIF chunk that loops as malformed', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'exif-loop.png');
    expect(of(r, 'METADATA/MALFORMED')[0].data?.reason).to.equal('EXIF: the IFD at 8 is reached twice');
  });

  it('counts chunks against the block limit', async () => {
    const many = grayPng(Array.from({ length: 20 }, () => chunk('tEXt', 'a\0b')));
    expect(kinds(await inspectImage(many, { limits: { blocks: 10 } })).slice(-1)).to.deep.equal(['LIMIT/BLOCKS']);
  });
});
