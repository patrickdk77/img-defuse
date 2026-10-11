import { expect } from 'chai';
import { disarmImage, imagePlugin, inspectImage } from '../src';
import type { ContainedFilePlugin } from '../src/types';
import { acted, disarmFixture, fixture, fixtureNames, inspectFixture, kinds, must, of, output, reason } from './helpers/util';

/** The records of an EMF up to EMR_EOF, as [type, record]. */
function emfRecords(bytes: Uint8Array): Array<[number, Buffer]> {
  const b = Buffer.from(bytes);
  const out: Array<[number, Buffer]> = [];
  for (let p = 0; p + 8 <= b.length; ) {
    const size = b.readUInt32LE(p + 4);
    out.push([b.readUInt32LE(p), b.subarray(p, p + size)]);
    if (b.readUInt32LE(p) === 0x0e) break;
    p += size;
  }
  return out;
}

/** The EMF+ records of every EMF+ comment, as [type, flags, record]. */
function plusRecords(bytes: Uint8Array): Array<[number, number, Buffer]> {
  const out: Array<[number, number, Buffer]> = [];
  for (const [type, rec] of emfRecords(bytes)) {
    if (type !== 0x46 || rec.readUInt32LE(12) !== 0x2b464d45) continue;
    const end = 12 + rec.readUInt32LE(8);
    for (let p = 16; p + 12 <= end; p += rec.readUInt32LE(p + 4)) out.push([rec.readUInt16LE(p), rec.readUInt16LE(p + 2), rec.subarray(p, p + rec.readUInt32LE(p + 4))]);
  }
  return out;
}

/** The records of a WMF after its headers, as [function, record], and where they start. */
function wmfRecords(bytes: Uint8Array): { base: number; records: Array<[number, Buffer]> } {
  const b = Buffer.from(bytes);
  const base = b.readUInt32LE(0) === 0x9ac6cdd7 ? 22 : 0;
  const records: Array<[number, Buffer]> = [];
  for (let p = base + 18; p < b.length; ) {
    const words = b.readUInt32LE(p);
    records.push([b.readUInt16LE(p + 4), b.subarray(p, p + words * 2)]);
    if (b.readUInt16LE(p + 4) === 0) break;
    p += words * 2;
  }
  return { base, records };
}

/** A plugin that replaces every file it gets with `replacement`. */
const replacing = (replacement: Uint8Array): ContainedFilePlugin => ({
  kind: 'file',
  name: 'replace',
  accepts: () => true,
  async process(_file, sink) {
    await sink.write(replacement);
    return 'scrubbed';
  },
});

const rectangle = fixture('clean', 'emf', 'rectangle.emf');

describe('EMF', () => {
  it('reads hand-built EMF as clean: drawing records, bitmaps, RLE, groups and EMF+, and copies it as it is', async () => {
    for (const name of fixtureNames('clean', 'emf')) {
      const r = await inspectFixture({}, 'clean', 'emf', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, acted(r)]).to.deep.equal([name, 'clean', 'emf', 'image/emf', 64, 48, 1, []]);
      const d = await disarmImage(fixture('clean', 'emf', name));
      expect([name, d.status, Buffer.compare(output(d), fixture('clean', 'emf', name))]).to.deep.equal([name, 'clean', 0]);
    }
  });

  it('reports the description as text, and stripMetadata blanks it', async () => {
    const r = await inspectFixture({}, 'clean', 'emf', 'description.emf');
    expect([kinds(r), r.findings[0].data?.keyword]).to.deep.equal([['METADATA/TEXT'], 'description']);
    const d = await disarmFixture({ stripMetadata: true }, 'clean', 'emf', 'description.emf');
    const out = output(d);
    expect([d.status, out.readUInt32LE(60), out.readUInt32LE(64), out.includes(Buffer.from('Fixture', 'utf16le'))]).to.deep.equal(['defused', 0, 0, false]);
  });

  it('drops trailing data and the archive appended there', async () => {
    const trailing = await disarmFixture({}, 'hostile', 'emf', 'trailing.emf');
    expect([acted(trailing.before), Buffer.compare(output(trailing), rectangle)]).to.deep.equal([['STRUCTURE/TRAILING_DATA'], 0]);
    const zip = await disarmFixture({}, 'hostile', 'emf', 'zip-trailing.emf');
    expect([acted(zip.before), Buffer.compare(output(zip), rectangle)]).to.deep.equal([['STRUCTURE/TRAILING_DATA', 'POLYGLOT/ZIP'], 0]);
  });

  it('removes the escapes that pass data to the printer driver, and writes the byte and record counts again', async () => {
    const d = await disarmFixture({}, 'hostile', 'emf', 'escapes.emf');
    expect(of(d.before, 'CONTENT/ESCAPE').map(f => f.data?.escape)).to.deep.equal(['EMR_EXTESCAPE', 'EMR_DRAWESCAPE', 'EMR_NAMEDESCAPE']);
    expect(Buffer.compare(output(d), rectangle)).to.equal(0);
  });

  it('keeps a color space without the profile file it names, and removes a record that loads one', async () => {
    const d = await disarmFixture({}, 'hostile', 'emf', 'linked-profile.emf');
    expect(of(d.before, 'EXTERNAL/LINKED_PROFILE').map(f => f.data?.target)).to.deep.equal(['\\\\203.0.113.9\\share\\x.icc', '\\\\203.0.113.9\\share\\y.icc']);
    const records = emfRecords(output(d));
    expect(records.map(([t]) => t)).to.deep.equal([0x01, 0x7a, 0x2b, 0x0e]);
    const colorspace = records[1][1];
    expect([colorspace.toString('latin1', 24, 28), colorspace.subarray(80, 600).every(x => x === 0)]).to.deep.equal(['BGRs', true]);
  });

  it('removes records and comments readers skip', async () => {
    for (const name of ['unknown-record.emf', 'private-comment.emf', 'spool-comment.emf']) {
      const d = await disarmFixture({}, 'hostile', 'emf', name);
      expect([name, acted(d.before), Buffer.compare(output(d), rectangle)]).to.deep.equal([name, ['STRUCTURE/EXTRA_BLOCK'], 0]);
    }
  });

  it('refuses records that break the format, and bitmaps that run short or out of their image', async () => {
    const expected: Record<string, [string, string]> = {
      'no-eof.emf': ['STRUCTURE/TRUNCATED', 'the file ends before EMR_EOF'],
      'record-size.emf': ['STRUCTURE/BAD_HEADER', 'a record of 26 bytes'],
      'second-header.emf': ['STRUCTURE/BAD_LAYOUT', 'a second EMR_HEADER'],
      'dib-short.emf': ['STRUCTURE/BAD_DATA', 'the bitmap needs 144 bytes and the record gives 40'],
      'rle-outside.emf': ['STRUCTURE/BAD_DATA', 'an RLE run leaves the image'],
      'emfplus-unfinished.emf': ['STRUCTURE/BAD_DATA', 'a continued EMF+ object ends before its total size'],
    };
    for (const [name, [k, why]] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'hostile', 'emf', name);
      expect([name, r.status, acted(r), reason(r)]).to.deep.equal([name, 'rejected', [k], why]);
    }
    expect(kinds(await inspectFixture({}, 'hostile', 'emf', 'dib-huge.emf'))).to.deep.equal(['LIMIT/PIXELS']);
  });

  it('corrects header counts a reader would stop early at, or that make too few objects', async () => {
    const expected: Array<[string, string, string]> = [
      ['emf', 'bytes-short.emf', 'the header gives 120 bytes and the records run to 176'],
      ['emf', 'records-short.emf', 'the header gives 2 records and the file holds 4'],
      ['wmf', 'size-short.wmf', 'the header gives 20 words and the records run to 44'],
      ['wmf', 'objects.wmf', 'the header gives 1 objects and the records need 2'],
    ];
    for (const [kind, name, why] of expected) {
      const d = await disarmFixture({}, 'hostile', kind, name);
      expect([name, d.status, acted(d.before), of(d.before, 'STRUCTURE/HEADER_COUNT')[0].data?.reason]).to.deep.equal([name, 'defused', ['STRUCTURE/HEADER_COUNT'], why]);
      const out = output(d);
      if (kind === 'emf') expect([name, out.readUInt32LE(48), out.readUInt32LE(52)]).to.deep.equal([name, out.length, emfRecords(out).length]);
      else {
        // After a placeable header of 22 bytes, when the file has one.
        const base = out.readUInt32LE(0) === 0x9ac6cdd7 ? 22 : 0;
        expect([name, base + out.readUInt32LE(base + 6) * 2, name !== 'objects.wmf' || out.readUInt16LE(base + 10) >= 2]).to.deep.equal([name, out.length, true]);
      }
    }
  });

  it('writes byte and record counts that only overstate the file again, with nothing to report', async () => {
    const d = await disarmFixture({}, 'hostile', 'emf', 'counts-long.emf');
    const out = output(d);
    expect([d.status, out.readUInt32LE(48), out.readUInt32LE(52)]).to.deep.equal(['clean', out.length, 3]);
    expect(Buffer.compare(out, rectangle)).to.equal(0);
  });

  it('hands EMF+ images to the plugins, and removes EMF+ records readers skip', async () => {
    const html = await inspectFixture({}, 'hostile', 'emf', 'emfplus-html.emf');
    expect(of(html, 'EMBEDDED_IMAGE/NO_PLUGIN').map(f => f.data?.sniffed)).to.deep.equal(['text/html']);
    const unknown = await disarmFixture({}, 'hostile', 'emf', 'emfplus-unknown.emf');
    expect([acted(unknown.before), plusRecords(output(unknown)).map(([t]) => t)]).to.deep.equal([['STRUCTURE/EXTRA_BLOCK'], [0x4001, 0x4002]]);
    const images = await inspectFixture({}, 'rewrite', 'emfplus-images.emf');
    expect(of(images, 'EMBEDDED_IMAGE/NO_PLUGIN').map(f => f.data?.sniffed)).to.deep.equal(['image/png', 'image/png', 'image/wmf']);
    const d = await disarmFixture({}, 'rewrite', 'emfplus-images.emf');
    expect(plusRecords(output(d)).map(([t]) => t)).to.deep.equal([0x4001, 0x4021, 0x4002]);
    expect(emfRecords(output(d)).length).to.equal(6);
  });

  it('keeps EMF+ images a plugin passes, and splits one a plugin enlarges into continued records as GDI+ does', async () => {
    const passed = await disarmFixture({ filePlugins: [imagePlugin()] }, 'rewrite', 'emfplus-images.emf');
    expect([passed.status, of(must(passed.after, 'after'), 'EMBEDDED_IMAGE/PLUGIN_PASSED').length]).to.deep.equal(['clean', 3]);
    // The first image grows to 70,001 bytes, the others shrink to 13 and 99.
    const sizes = [70001, 13, 99];
    const growing: ContainedFilePlugin = {
      kind: 'file',
      name: 'resize',
      accepts: () => true,
      async process(_file, sink) {
        await sink.write(Buffer.alloc(sizes.shift() ?? 1, 7));
        return 'scrubbed';
      },
    };
    const d = await disarmFixture({ filePlugins: [growing] }, 'rewrite', 'emfplus-images.emf');
    const objects = plusRecords(output(d)).filter(([t]) => t === 0x4008);
    // The first image in two parts, each giving the total, then the other two in one record each.
    expect(objects.map(([, flags, rec]) => [flags, rec.readUInt32LE(8), flags & 0x8000 ? rec.readUInt32LE(12) : 0])).to.deep.equal([
      [0x8500, 65008, 70029],
      [0x8500, 5029, 70029],
      [0x0502, 41, 0],
      [0x0503, 115, 0],
    ]);
    const out = output(d);
    expect([out.readUInt32LE(48), out.readUInt32LE(52)]).to.deep.equal([out.length, emfRecords(out).length]);
    expect(kinds(must(d.after, 'after')).filter(k => k === 'EMBEDDED_IMAGE/PLUGIN_SCRUBBED')).to.have.length(3);
  });

  it('removes a comment holding a PDF or a WMF no plugin accepts, and one whose file a plugin rewrites', async () => {
    const pdf = await disarmFixture({}, 'hostile', 'emf', 'multiformats-pdf.emf');
    expect([acted(pdf.before), Buffer.compare(output(pdf), rectangle)]).to.deep.equal([['EMBEDDED_IMAGE/NO_PLUGIN', 'POLYGLOT/PDF'], 0]);
    expect(of(pdf.before, 'EMBEDDED_IMAGE/NO_PLUGIN')[0].data?.sniffed).to.equal('application/pdf');
    const wmf = await disarmFixture({}, 'hostile', 'emf', 'windows-metafile.emf');
    expect([acted(wmf.before), Buffer.compare(output(wmf), rectangle)]).to.deep.equal([['EMBEDDED_IMAGE/NO_PLUGIN'], 0]);
    const passed = await disarmFixture({ filePlugins: [imagePlugin()] }, 'hostile', 'emf', 'windows-metafile.emf');
    expect([passed.status, Buffer.compare(output(passed), fixture('hostile', 'emf', 'windows-metafile.emf'))]).to.deep.equal(['clean', 0]);
    const scrubbed = await disarmFixture({ filePlugins: [replacing(fixture('clean', 'wmf', 'plain.wmf'))] }, 'hostile', 'emf', 'windows-metafile.emf');
    expect(of(scrubbed.before, 'EMBEDDED_IMAGE/PLUGIN_FAILED')[0].data?.reason).to.equal('the block that holds the image cannot take a rewritten copy');
    expect(Buffer.compare(output(scrubbed), rectangle)).to.equal(0);
  });
});

describe('WMF', () => {
  const wmf = fixture('clean', 'wmf', 'rectangle.wmf');

  it('reads hand-built WMF as clean, placeable or not, with a DIB or a Bitmap16, and copies it as it is', async () => {
    for (const name of fixtureNames('clean', 'wmf')) {
      const r = await inspectFixture({}, 'clean', 'wmf', name);
      expect([name, r.status, r.format, r.mimeType, r.width, r.height, r.images, kinds(r)]).to.deep.equal([name, 'clean', 'wmf', 'image/wmf', 64, 48, 1, []]);
      const d = await disarmImage(fixture('clean', 'wmf', name));
      expect([name, d.status, Buffer.compare(output(d), fixture('clean', 'wmf', name))]).to.deep.equal([name, 'clean', 0]);
    }
  });

  it('removes SETABORTPROC and other escapes, and writes the size and the largest record again', async () => {
    const abort = await disarmFixture({}, 'hostile', 'wmf', 'abort-proc.wmf');
    expect([acted(abort.before), abort.before.score, Buffer.compare(output(abort), wmf)]).to.deep.equal([['CONTENT/ABORT_PROC'], 70, 0]);
    const other = await disarmFixture({}, 'hostile', 'wmf', 'escape.wmf');
    expect([acted(other.before), other.before.findings[0].data?.escape, Buffer.compare(output(other), wmf)]).to.deep.equal([['CONTENT/ESCAPE'], 'escape 0x000f', 0]);
  });

  it('drops trailing data, a record of a function WMF does not define, and data hidden in META_EOF', async () => {
    const trailing = await disarmFixture({}, 'hostile', 'wmf', 'trailing.wmf');
    expect([acted(trailing.before), Buffer.compare(output(trailing), wmf)]).to.deep.equal([['STRUCTURE/TRAILING_DATA'], 0]);
    const unknown = await disarmFixture({}, 'hostile', 'wmf', 'unknown-function.wmf');
    expect([acted(unknown.before), Buffer.compare(output(unknown), wmf)]).to.deep.equal([['STRUCTURE/EXTRA_BLOCK'], 0]);
    const eof = await disarmFixture({}, 'hostile', 'wmf', 'eof-hidden.wmf');
    expect([acted(eof.before), Buffer.compare(output(eof), wmf)]).to.deep.equal([['STRUCTURE/HIDDEN_DATA'], 0]);
  });

  it('writes a size, a largest record and a placeable checksum that readers do not stop at again, with nothing to report', async () => {
    const d = await disarmFixture({}, 'hostile', 'wmf', 'counts.wmf');
    expect([d.status, kinds(d.before), Buffer.compare(output(d), wmf)]).to.deep.equal(['clean', [], 0]);
  });

  it('refuses records and bitmaps that break the format', async () => {
    const expected: Record<string, [string, string]> = {
      'header-size.wmf': ['STRUCTURE/BAD_HEADER', 'a header of 8 words'],
      'no-eof.wmf': ['STRUCTURE/TRUNCATED', 'the file ends before META_EOF'],
      'bitmap16-short.wmf': ['STRUCTURE/BAD_DATA', 'a Bitmap16 needs 8 bytes and its record gives 4'],
      'rle-outside.wmf': ['STRUCTURE/BAD_DATA', 'an RLE run leaves the image'],
    };
    for (const [name, [k, why]] of Object.entries(expected)) {
      const r = await inspectFixture({}, 'hostile', 'wmf', name);
      expect([name, r.status, acted(r), reason(r)]).to.deep.equal([name, 'rejected', [k], why]);
    }
  });

  it('rewrites what Inkscape writes without its escape, and EMF without its private comments', async () => {
    const w = await disarmFixture({}, 'quirks', 'inkscape.wmf');
    expect([acted(w.before), wmfRecords(output(w)).records.some(([fn]) => fn === 0x0626)]).to.deep.equal([['CONTENT/ESCAPE'], false]);
    const e = await disarmFixture({}, 'quirks', 'inkscape.emf');
    expect([acted(e.before), emfRecords(output(e)).some(([t]) => t === 0x46)]).to.deep.equal([['STRUCTURE/EXTRA_BLOCK'], false]);
    expect((await inspectImage(output(e))).status).to.equal('clean');
  });
});
