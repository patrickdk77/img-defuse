import { expect } from 'chai';
import { inspectImage } from '../src';
import { fixture, inspectFixture, kindSet, kinds, of, reason, summary } from './helpers/util';

/** A JPEG segment: marker, length, payload. */
const segment = (marker: number, payload: Buffer | string) => {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
const afterSoi = (jpeg: Buffer, ...segments: Buffer[]) => Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
const baseline = () => fixture('clean', 'jpeg', 'baseline.jpg');

describe('JPEG', () => {
  it('reads baseline, progressive, gray, CMYK, arithmetic and restart JPEGs as clean', async () => {
    for (const name of ['baseline.jpg', 'progressive.jpg', 'gray.jpg', 'cmyk.jpg', 'arithmetic.jpg', 'restart.jpg', 'progressive-restart.jpg']) {
      const r = await inspectFixture({}, 'clean', 'jpeg', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, r.findings]).to.deep.equal([name, 'clean', 'jpg', 'image/jpeg', 32, 24, 1, []]);
    }
  });

  it('refuses a file that ends inside a scan', async () => {
    const r = await inspectFixture({}, 'hostile', 'jpeg', 'truncated.jpg');
    expect([r.status, r.score, kinds(r), reason(r)]).to.deep.equal(['rejected', null, ['STRUCTURE/TRUNCATED'], 'the JPEG ends inside a scan']);
  });

  it('reports data after EOI as trailing, and an appended ZIP as a polyglot too', async () => {
    expect(summary(await inspectFixture({}, 'hostile', 'jpeg', 'trailing-php.jpg'))).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/TRAILING_DATA'] });
    const zip = await inspectFixture({}, 'hostile', 'jpeg', 'trailing-zip.jpg');
    expect(summary(zip)).to.deep.equal({ status: 'strippable', score: 73, kinds: ['STRUCTURE/TRAILING_DATA', 'POLYGLOT/ZIP'] });
  });

  it('reports bytes between segments as hidden data, but not fill bytes', async () => {
    expect(summary(await inspectFixture({}, 'hostile', 'jpeg', 'hidden.jpg'))).to.deep.equal({ status: 'strippable', score: 20, kinds: ['STRUCTURE/HIDDEN_DATA'] });
    const j = baseline();
    const filled = Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff]), j.subarray(2)]);
    expect((await inspectImage(filled)).status).to.equal('clean');
  });

  it('checks the pixel limit from the frame header before reading any scan', async () => {
    const r = await inspectFixture({}, 'hostile', 'jpeg', 'pixels.jpg');
    expect([kinds(r), r.width, r.height]).to.deep.equal([['LIMIT/PIXELS'], 65535, 65535]);
    expect(kinds(await inspectImage(baseline(), { limits: { decodedBytes: 1000 } }))).to.deep.equal(['LIMIT/DECODED_SIZE']);
  });

  it('caps the number of scans', async () => {
    expect(kinds(await inspectFixture({ limits: { scans: 3 } }, 'clean', 'jpeg', 'progressive.jpg'))).to.deep.equal(['LIMIT/SCANS']);
  });

  it('refuses hierarchical frames and markers JPEG does not define', async () => {
    const sof5 = await inspectFixture({}, 'hostile', 'jpeg', 'sof5.jpg');
    expect([kinds(sof5), sof5.findings[0].data?.format]).to.deep.equal([['FORMAT/UNSUPPORTED'], 'hierarchical JPEG']);
    expect(reason(await inspectFixture({}, 'hostile', 'jpeg', 'unknown-marker.jpg'))).to.equal('marker 0xFFC8 is not a marker JPEG defines here');
  });

  it('refuses a Huffman table with more codes than its lengths allow', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'jpeg', 'huffman.jpg'))).to.equal('a Huffman table holds more codes than its code lengths allow');
  });

  it('checks restart markers count 0 to 7 in order', async () => {
    expect(reason(await inspectFixture({}, 'hostile', 'jpeg', 'restart-order.jpg'))).to.equal('restart marker 5 appears where 1 belongs');
  });

  it('refuses frame and scan headers out of range', async () => {
    const j = baseline();
    const sofAt = j.indexOf(Buffer.from([0xff, 0xc0]));
    const zeroHeight = Buffer.from(j);
    zeroHeight.writeUInt16BE(0, sofAt + 5);
    expect(reason(await inspectImage(zeroHeight))).to.equal('the frame height is 0, which needs a DNL marker');
    const twoFrames = Buffer.concat([j.subarray(0, sofAt), j.subarray(sofAt, sofAt + 2 + j.readUInt16BE(sofAt + 2)), j.subarray(sofAt)]);
    expect(reason(await inspectImage(twoFrames))).to.equal('the JPEG has a second frame header');
    const sosAt = j.indexOf(Buffer.from([0xff, 0xda]));
    const noFrame = Buffer.concat([j.subarray(0, sofAt), j.subarray(sofAt + 2 + j.readUInt16BE(sofAt + 2))]);
    expect(reason(await inspectImage(noFrame))).to.equal('a scan comes before the frame header');
    const badComponent = Buffer.from(j);
    badComponent[sosAt + 5] = 99;
    expect(reason(await inspectImage(badComponent))).to.match(/component 99/);
  });

  it('reports APP segments as metadata, and unknown ones as extra blocks', async () => {
    expect(summary(await inspectFixture({}, 'hostile', 'jpeg', 'app15.jpg'))).to.deep.equal({ status: 'strippable', score: 10, kinds: ['STRUCTURE/EXTRA_BLOCK'] });
    const meta = await inspectFixture({}, 'meta', 'jpeg', 'xmp-iptc-comment.jpg');
    expect([meta.status, kindSet(meta)]).to.deep.equal(['clean', ['METADATA/IPTC', 'METADATA/XMP', 'METADATA/COMMENT']]);
    expect(kindSet(await inspectFixture({}, 'meta', 'jpeg', 'icc.jpg'))).to.deep.equal(['METADATA/ICC_PROFILE']);
    const others = afterSoi(baseline(), segment(0xec, 'Ducky\0\x01'), segment(0xe2, 'FPXR\0\x01'), segment(0xeb, 'JP\0\x00jumb'));
    expect(of(await inspectImage(others), 'METADATA/OTHER').map(f => f.data?.kind)).to.deep.equal(['Ducky', 'FlashPix', 'JUMBF, such as C2PA content credentials']);
  });

  it('reports EXIF, GPS and the EXIF thumbnail, which no plugin takes', async () => {
    const r = await inspectFixture({}, 'meta', 'jpeg', 'exif-gps-thumb.jpg');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 10, kinds: ['METADATA/EXIF', 'METADATA/GPS', 'METADATA/THUMBNAIL', 'EMBEDDED_IMAGE/NO_PLUGIN'] });
    expect(of(r, 'EMBEDDED_IMAGE/NO_PLUGIN')[0].data?.sniffed).to.equal('image/jpeg');
  });

  it('reports a thumbnail whose bytes are not the JPEG its container declares', async () => {
    const r = await inspectFixture({}, 'hostile', 'jpeg', 'exif-html-thumb.jpg');
    expect(of(r, 'EMBEDDED_IMAGE/TYPE_MISMATCH')[0].data).to.include({ declared: 'image/jpeg', sniffed: 'text/html' });
    expect(r.findings.find(f => f.detail === 'TYPE_MISMATCH')?.action).to.equal('info');
  });

  it('reports a looping EXIF block as malformed and a second EXIF segment as ambiguous', async () => {
    expect(of(await inspectFixture({}, 'hostile', 'jpeg', 'exif-loop.jpg'), 'METADATA/MALFORMED')[0].data?.reason).to.equal('EXIF: the IFD at 8 is reached twice');
    const two = await inspectFixture({}, 'hostile', 'jpeg', 'two-exif.jpg');
    expect([two.status, two.score, of(two, 'STRUCTURE/AMBIGUOUS')[0].data?.reason]).to.deep.equal(['rejected', 0, 'a second EXIF segment']);
  });

  it('assembles the ICC profile from APP2 chunks and refuses chunks that do not number 1 to n', async () => {
    expect(of(await inspectFixture({}, 'hostile', 'jpeg', 'icc-order.jpg'), 'METADATA/MALFORMED')[0].data?.reason).to.equal('the ICC profile chunks do not number 1 to n');
  });

  it('reports XMP with a document type', async () => {
    expect(summary(await inspectFixture({}, 'hostile', 'jpeg', 'xmp-doctype.jpg'))).to.deep.equal({ status: 'strippable', score: 40, kinds: ['METADATA/XMP', 'METADATA/DOCTYPE'] });
  });

  it('reads the MPF index and reports the images after EOI, then any data no image covers', async () => {
    const mpf = await inspectFixture({}, 'hostile', 'jpeg', 'mpf.jpg');
    expect(summary(mpf)).to.deep.equal({ status: 'strippable', score: 10, kinds: ['METADATA/OTHER', 'METADATA/SECONDARY_IMAGE', 'EMBEDDED_IMAGE/NO_PLUGIN'] });
    const size = fixture('hostile', 'jpeg', 'mpf.jpg').length;
    const second = of(mpf, 'METADATA/SECONDARY_IMAGE')[0].data ?? {};
    expect(Number(second.offset) + Number(second.bytes)).to.equal(size);
    const trailing = await inspectFixture({}, 'hostile', 'jpeg', 'mpf-trailing.jpg');
    expect(kindSet(trailing)).to.include('STRUCTURE/TRAILING_DATA');
    expect(of(trailing, 'STRUCTURE/TRAILING_DATA')[0].data?.bytes).to.equal('MOTIONPHOTOVIDEO'.length);
  });

  it('reports Photoshop resources as IPTC, with their thumbnail', async () => {
    const r = await inspectFixture({}, 'hostile', 'jpeg', 'photoshop-thumb.jpg');
    expect(summary(r)).to.deep.equal({ status: 'strippable', score: 10, kinds: ['METADATA/IPTC', 'METADATA/THUMBNAIL', 'EMBEDDED_IMAGE/NO_PLUGIN'] });
    const broken = afterSoi(baseline(), segment(0xed, 'Photoshop 3.0\x008BIM\x04\x04\x00\x00\x00\x00\xff\xff'));
    expect(of(await inspectImage(broken), 'METADATA/MALFORMED')[0].data?.reason).to.equal('a Photoshop resource runs past its block');
  });

  it('reports a JFIF thumbnail of raw pixels without handing it to a plugin', async () => {
    const jfif = Buffer.concat([Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\x02\x01', 'latin1'), Buffer.alloc(6)]);
    const j = baseline();
    const app0At = j.indexOf(Buffer.from([0xff, 0xe0]));
    const swapped = Buffer.concat([j.subarray(0, app0At), segment(0xe0, jfif), j.subarray(app0At + 2 + j.readUInt16BE(app0At + 2))]);
    const r = await inspectImage(swapped);
    expect([r.status, kinds(r), r.findings[0].data]).to.deep.equal(['clean', ['METADATA/THUMBNAIL'], { format: 'raw' }]);
    const short = Buffer.concat([j.subarray(0, app0At), segment(0xe0, jfif.subarray(0, 16)), j.subarray(app0At + 2 + j.readUInt16BE(app0At + 2))]);
    expect(kinds(await inspectImage(short))).to.deep.equal(['METADATA/MALFORMED']);
  });
});
