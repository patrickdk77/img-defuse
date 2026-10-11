import { expect } from 'chai';
import { inspectImage } from '../src';
import { detect, sniffType } from '../src/detect';
import { fixture, inspectFixture, kinds } from './helpers/util';

describe('format detection', () => {
  it('names the format from the first bytes', () => {
    const head = (...parts: Array<string | number[]>) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
    const formatOf = (b: Buffer) => detect(b)?.format;
    expect(formatOf(head([0x89], 'PNG\r\n\x1a\n'))).to.equal('png');
    expect(formatOf(head([0xff, 0xd8, 0xff, 0xe0]))).to.equal('jpg');
    expect(formatOf(head('GIF87a'))).to.equal('gif');
    expect(formatOf(head('RIFF\0\0\0\0WEBP'))).to.equal('webp');
    expect(formatOf(head('RIFF\0\0\0\0WAVE'))).to.equal(undefined);
    expect(formatOf(head('MM\0*'))).to.equal('tif');
    expect(formatOf(head('II+\0'))).to.equal('tif');
    expect(formatOf(head('BM', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0]))).to.equal('bmp');
    expect(formatOf(head('BM', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 41, 0, 0, 0]))).to.equal(undefined);
    expect(formatOf(head([0, 0, 1, 0, 1, 0]))).to.equal('ico');
    expect(formatOf(head([0, 0, 2, 0, 1, 0]))).to.equal('cur');
    expect(formatOf(head([0, 0, 1, 0, 0, 0]))).to.equal(undefined);
    expect(formatOf(head([0, 0, 0, 0x0c], 'jP  \r\n', [0x87], '\n'))).to.equal('jp2');
    expect(formatOf(head([0xff, 0x4f, 0xff, 0x51]))).to.equal('j2c');
    expect(formatOf(head([0xff, 0x0a]))).to.equal('jxl');
    expect(formatOf(head([0, 0, 0, 0x0c], 'JXL \r\n', [0x87], '\n'))).to.equal('jxl');
    expect(formatOf(head('8BPS', [0, 1]))).to.equal('psd');
    expect(formatOf(head('8BPS', [0, 2]))).to.equal('psb');
    expect(formatOf(head([1, 0, 0, 0], new Array(36).fill(0), ' EMF'))).to.equal('emf');
    expect(formatOf(head([1, 0, 0, 0], new Array(36).fill(0), ' EMX'))).to.equal(undefined);
    expect(formatOf(head([0xd7, 0xcd, 0xc6, 0x9a]))).to.equal('wmf');
    expect(formatOf(head([1, 0, 9, 0, 0, 3]))).to.equal('wmf');
    expect(formatOf(head([2, 0, 9, 0, 0, 1]))).to.equal('wmf');
    expect(formatOf(head([1, 0, 9, 0, 0, 2]))).to.equal(undefined);
  });

  it('rejects anything else as unrecognized, HEIC, AVIF and SVG included', async () => {
    for (const name of ['unknown.bin', 'svg.svg', 'heic.heic', 'avif.avif']) {
      const r = await inspectFixture({}, 'detect', name);
      expect([name, r.status, kinds(r)]).to.deep.equal([name, 'rejected', ['FORMAT/UNRECOGNIZED']]);
    }
    expect(kinds(await inspectImage(new Uint8Array(0)))).to.deep.equal(['FORMAT/UNRECOGNIZED']);
  });

  it('goes by content, so a PNG named anything is a PNG', async () => {
    const r = await inspectImage(fixture('clean', 'png', 'rgb.png'));
    expect([r.format, r.mimeType]).to.deep.equal(['png', 'image/png']);
  });

  it('sniffs the type of an image inside an image, and a few formats an attacker might hide there', () => {
    expect(sniffType(fixture('clean', 'jpeg', 'baseline.jpg').subarray(0, 64))).to.equal('image/jpeg');
    expect(sniffType(Buffer.from('%PDF-1.7'))).to.equal('application/pdf');
    expect(sniffType(Buffer.from('PK\x03\x04', 'latin1'))).to.equal('application/zip');
    expect(sniffType(Buffer.from('MZ\x90\0', 'latin1'))).to.equal('application/x-msdownload');
    expect(sniffType(Buffer.from('  <html><body>'))).to.equal('text/html');
    expect(sniffType(Buffer.from('<svg xmlns="x">'))).to.equal('image/svg+xml');
    expect(sniffType(Buffer.from('hello'))).to.equal(undefined);
  });
});
