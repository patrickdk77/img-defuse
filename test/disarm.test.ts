import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { expect } from 'chai';
import {
  type ByteSink,
  type ByteSource,
  bufferSource,
  ImageCategory as C,
  ImageDetail as D,
  disarmImage,
  disarmImageSource,
  fileSink,
  fileSource,
  type ImageFindingAction,
  type ImageOptions,
  inspectImage,
} from '../src';
import { acted, chunk, disarmFixture, fixture, fixtureNames, fixtures, grayPng, ihdr, jpegCore, kinds, must, of, output, png, pngChunks, pngFrames } from './helpers/util';

/** Every fixture file, as [folder parts..., name]. */
function allFixtures(): string[][] {
  const out: string[][] = [];
  const walk = (parts: string[]) => {
    for (const name of fixtureNames(...parts)) {
      if (name === 'manifest.json') continue;
      if (fs.statSync(path.join(fixtures, ...parts, name)).isDirectory()) walk([...parts, name]);
      else out.push([...parts, name]);
    }
  };
  walk([]);
  return out;
}

/** Options with one action override. */
const override = (category: C, detail: D, action: ImageFindingAction): ImageOptions => ({ actionOverrides: [{ category, detail, action }] });

/** A sink that records what reaches it. */
function recordingSink(fail?: Error): ByteSink & { chunks: Buffer[]; closed: number; aborted: unknown[] } {
  const s = {
    chunks: [] as Buffer[],
    closed: 0,
    aborted: [] as unknown[],
    async write(c: Uint8Array) {
      if (fail) throw fail;
      s.chunks.push(Buffer.from(c));
    },
    async close() {
      s.closed++;
    },
    async abort(e: unknown) {
      s.aborted.push(e);
    },
  };
  return s;
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('disarm', () => {
  it('rewrites every fixture it does not reject, and the output passes its own inspection', async () => {
    for (const parts of allFixtures()) {
      const name = parts.join('/');
      const bytes = fixture(...parts);
      const i = await inspectImage(bytes);
      const d = await disarmImage(bytes);
      const want = { clean: 'clean', strippable: 'defused', rejected: 'rejected' }[i.status];
      expect(d.status, name).to.equal(want);
      expect(d.before, name).to.deep.equal(i);
      if (d.status === 'rejected') {
        expect([d.bytes, d.after, d.removed], name).to.deep.equal([undefined, undefined, []]);
        continue;
      }
      const after = must(d.after, 'after');
      expect([after.status, acted(after), after.format, after.width, after.height, after.images], name).to.deep.equal(['clean', [], i.format, i.width, i.height, i.images]);
      // A second pass, when one runs, adds what it removed after the upload's own findings.
      const strip = i.findings.filter(f => f.action === 'strip');
      expect(d.removed.slice(0, strip.length), name).to.deep.equal(strip);
      expect(await inspectImage(output(d)), name).to.deep.equal(after);
      // A second rewrite finds nothing more to do and writes the same bytes.
      const again = await disarmImage(output(d));
      expect([again.status, Buffer.compare(output(again), output(d))], name).to.deep.equal(['clean', 0]);
    }
  });

  it('writes the files the tools made back byte for byte', async () => {
    for (const parts of allFixtures().filter(p => p[0] === 'clean' || p[0] === 'meta')) {
      const bytes = fixture(...parts);
      const d = await disarmImage(bytes);
      // A thumbnail no plugin accepts goes.
      if (parts.join('/') === 'meta/jpeg/exif-gps-thumb.jpg') continue;
      expect([parts.join('/'), d.status, Buffer.compare(output(d), bytes)]).to.deep.equal([parts.join('/'), 'clean', 0]);
    }
  });

  it('leaves the JPEG tables, frame and scans and the inflated PNG data unchanged', async () => {
    for (const parts of allFixtures()) {
      const bytes = fixture(...parts);
      for (const options of [{}, { stripMetadata: true }]) {
        const d = await disarmImage(bytes, options);
        if (!d.bytes) continue;
        if (d.before.format === 'jpg') expect(Buffer.compare(jpegCore(d.bytes), jpegCore(bytes)), parts.join('/')).to.equal(0);
        // Without acTL, viewers show IDAT alone.
        const frames = (b: Uint8Array) => (pngChunks(b).some(([t]) => t === 'acTL') ? pngFrames(b) : pngFrames(b).slice(0, 1));
        if (d.before.format === 'png') expect(frames(d.bytes), parts.join('/')).to.deep.equal(frames(bytes));
      }
    }
  });

  it('removes what strip findings name and lists those findings in removed', async () => {
    const d = await disarmFixture({}, 'hostile', 'png', 'trailing-zip.png');
    expect([d.status, d.removed.map(f => `${f.category}/${f.detail}`)]).to.deep.equal(['defused', ['STRUCTURE/TRAILING_DATA', 'POLYGLOT/ZIP']]);
    expect(Buffer.compare(output(d), grayPng())).to.equal(0);
    expect(d.before.score).to.be.greaterThan(0);
    expect([d.after?.score, d.after?.risk]).to.deep.equal([0, 'NONE']);
  });

  it('writes nothing to the sink for a rejected file', async () => {
    const sink = recordingSink();
    const r = await disarmImageSource(bufferSource(fixture('hostile', 'png', 'bad-crc.png')), sink);
    expect([r.status, r.before.score, sink.chunks.length, sink.closed, sink.aborted.length]).to.deep.equal(['rejected', null, 0, 0, 0]);
  });

  it('rejects with PROCESSING/VERIFICATION_FAILED when a strip finding names something a rewrite cannot remove', async () => {
    const options = override(C.Structure, D.Ambiguous, 'strip');
    const i = await inspectImage(fixture('hostile', 'gif', 'outside.gif'), options);
    expect(i.status).to.equal('strippable');
    const sink = recordingSink();
    const r = await disarmImageSource(bufferSource(fixture('hostile', 'gif', 'outside.gif')), sink, options);
    expect([r.status, kinds(r.before).slice(-1)[0], r.after, r.removed, sink.chunks.length]).to.deep.equal(['rejected', 'PROCESSING/VERIFICATION_FAILED', undefined, [], 0]);
    expect(r.before.findings.slice(-1)[0].data?.reasons).to.equal('STRUCTURE/AMBIGUOUS');
    // The file was read through, so it keeps its score.
    expect(r.before.score).to.not.equal(null);
  });

  it('rewrites again when a removal brings a PDF header into the bytes PDF readers search', async () => {
    const bytes = fixture('rewrite', 'png-shifted-pdf.png');
    const i = await inspectImage(bytes);
    expect(kinds(i)).to.deep.equal(['STRUCTURE/EXTRA_BLOCK', 'METADATA/TEXT']);
    const d = await disarmImage(bytes);
    expect([d.status, d.removed.map(f => `${f.category}/${f.detail}`)]).to.deep.equal(['defused', ['STRUCTURE/EXTRA_BLOCK', 'POLYGLOT/PDF']]);
    expect(pngChunks(output(d)).map(([t]) => t)).to.deep.equal(['IHDR', 'IDAT', 'IEND']);
  });

  it('reads one copy of a source that changes while the run reads it', async () => {
    const original = fixture('hostile', 'png', 'trailing-html.png');
    const live = Buffer.from(original);
    let reads = 0;
    const source: ByteSource = {
      size: async () => live.length,
      read: async (o, n) => {
        // Every read after the first one sees different bytes.
        if (reads++ > 0) live.fill(0x41);
        return Buffer.from(live.subarray(o, o + n));
      },
    };
    const sink = recordingSink();
    const r = await disarmImageSource(source, sink);
    expect([r.status, reads, Buffer.compare(Buffer.concat(sink.chunks), grayPng()), sink.closed]).to.deep.equal(['defused', 1, 0, 1]);
  });

  it('throws I/O errors from the source and from the sink, and aborts the sink instead of closing it', async () => {
    const bytes = fixture('clean', 'png', 'rgb.png');
    const broken = new Error('bucket went away');
    const bad: ByteSource = { size: async () => bytes.length, read: async () => Promise.reject(broken) };
    expect(await failure(disarmImageSource(bad, recordingSink()))).to.equal(broken);
    const full = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const sink = recordingSink(full);
    expect(await failure(disarmImageSource(bufferSource(bytes), sink))).to.equal(full);
    expect([sink.closed, sink.aborted]).to.deep.equal([0, [full]]);
  });

  it('stops at the time limit and rejects a file over the size limit without reading it', async () => {
    const bytes = fixture('clean', 'tiff', 'multipage.tif');
    const slow: ByteSource = {
      size: async () => bytes.length,
      read: async (o, n) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return bytes.subarray(o, o + n);
      },
    };
    const timed = await disarmImageSource(slow, recordingSink(), { limits: { timeMs: 1 } });
    expect([timed.status, timed.before.score, kinds(timed.before).slice(-1)[0]]).to.deep.equal(['rejected', null, 'LIMIT/TIME']);
    let reads = 0;
    const counted: ByteSource = {
      size: async () => bytes.length,
      read: async (o, n) => {
        reads++;
        return bytes.subarray(o, o + n);
      },
    };
    const big = await disarmImageSource(counted, recordingSink(), { limits: { fileSize: 100 } });
    expect([big.status, kinds(big.before), reads]).to.deep.equal(['rejected', ['LIMIT/FILE_SIZE'], 0]);
  });

  it('writes the same bytes through a file sink as disarmImage returns, and closes the source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-defuse-disarm-'));
    try {
      const file = path.join(fixtures, 'hostile', 'jpeg', 'exif-html-thumb.jpg');
      const src = fileSource(file);
      let closed = 0;
      const close = must(src.close, 'close');
      const counting: ByteSource = {
        size: () => src.size(),
        read: (o, n) => src.read(o, n),
        close: async () => {
          closed++;
          await close.call(src);
        },
      };
      const out = path.join(dir, 'out.jpg');
      const r = await disarmImageSource(counting, fileSink(out));
      const d = await disarmImage(fs.readFileSync(file));
      expect([r.status, closed, Buffer.compare(fs.readFileSync(out), output(d))]).to.deep.equal(['defused', 1, 0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps temporary files only for the run, with a memory threshold of 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-defuse-temp-'));
    try {
      const d = await disarmImage(fixture('rewrite', 'jpeg-mpf-two-images.jpg'), { tempDir: dir, memoryThreshold: 0, filePlugins: [] });
      expect(d.status).to.equal('defused');
      expect(fs.readdirSync(dir)).to.deep.equal([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes metadata with stripMetadata, but the ICC profile and the orientation', async () => {
    const icc = await disarmFixture({ stripMetadata: true }, 'rewrite', 'jpeg-icc-xmp-thumbnail.jpg');
    const segs = (b: Uint8Array) => {
      const out: string[] = [];
      for (const [m, d] of jpegSegmentsOf(b)) out.push(m === 0xe0 ? `APP0 ${d.length}` : m === 0xe2 ? 'ICC' : m.toString(16));
      return out;
    };
    expect(segs(output(icc)).slice(0, 3)).to.deep.equal(['APP0 14', 'ICC', 'ICC']);
    expect(segs(output(icc))).to.not.include('fe');
    expect(output(icc).includes('ns.adobe.com')).to.equal(false);
    const o = await disarmFixture({ stripMetadata: true }, 'rewrite', 'jpeg-exif-orientation-thumb.jpg');
    const exif = jpegSegmentsOf(output(o)).find(([m]) => m === 0xe1);
    // "Exif\0\0", then a TIFF structure holding one IFD with the orientation alone.
    expect(must(exif, 'EXIF')[1].length).to.equal(6 + 26);
    const after = await inspectImage(output(o));
    expect(kinds(after)).to.deep.equal(['METADATA/EXIF']);
    expect(o.removed.map(f => `${f.category}/${f.detail}`)).to.deep.equal([]);
    expect(kinds(o.before)).to.include('METADATA/STRIPPED');
  });

  it('keeps what an info override allows and removes what a strip override names', async () => {
    const extraInfo = override(C.Structure, D.ExtraBlock, 'info');
    const kept = await disarmFixture(extraInfo, 'hostile', 'png', 'private.png');
    expect([kept.status, pngChunks(output(kept)).map(([t]) => t)]).to.deep.equal(['clean', ['IHDR', 'prVt', 'IDAT', 'IEND']]);
    // An ancillary chunk with a bad CRC stays as it was, so readers still skip it.
    const text = chunk('tEXt', 'Title\0x');
    text[text.length - 1] ^= 1;
    const bad = grayPng([text]);
    const badKept = await disarmImage(bad, extraInfo);
    expect([badKept.status, Buffer.compare(output(badKept), bad)]).to.deep.equal(['clean', 0]);
    const iccStrip = await disarmFixture(override(C.Metadata, D.IccProfile, 'strip'), 'meta', 'png', 'icc.png');
    expect([iccStrip.status, pngChunks(output(iccStrip)).some(([t]) => t === 'iCCP')]).to.deep.equal(['defused', false]);
    const gpsStrip = await disarmFixture(override(C.Metadata, D.Gps, 'strip'), 'rewrite', 'jpeg-exif-orientation-thumb.jpg');
    expect(kinds(must(gpsStrip.after, 'after')))
      .to.include('METADATA/EXIF')
      .and.not.include('METADATA/GPS');
    const twice = await disarmFixture(override(C.Structure, D.Ambiguous, 'strip'), 'hostile', 'png', 'two-gama.png');
    expect([twice.status, pngChunks(output(twice)).filter(([t]) => t === 'gAMA').length]).to.deep.equal(['defused', 1]);
  });

  it('disarms in memory far smaller than what the image data inflates to', async () => {
    // A 6000 x 6000 gray image inflates to 36 MB and deflates to a fraction of that.
    const raw = Buffer.alloc(6000 * 6001);
    for (let y = 0; y < 6000; y++) raw.fill(y % 251, y * 6001 + 1, (y + 1) * 6001);
    const image = Buffer.concat([png(ihdr(6000, 6000), chunk('IDAT', zlib.deflateSync(raw))), Buffer.from('trailing')]);
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    try {
      const d = await disarmImage(image);
      expect([d.status, output(d).length]).to.deep.equal(['defused', image.length - 8]);
    } finally {
      clearInterval(timer);
    }
    expect(image.length).to.be.lessThan(1024 * 1024);
    expect(peak - before).to.be.lessThan(16 * 1024 * 1024);
  });

  it('reports METADATA/STRIPPED for a block it removes and lists nothing in removed for it', async () => {
    const d = await disarmFixture({ stripMetadata: true }, 'meta', 'png', 'text.png');
    expect(d.status).to.equal('defused');
    expect(of(d.before, 'METADATA/STRIPPED').length).to.be.greaterThan(0);
    expect(d.removed).to.deep.equal([]);
    expect(pngChunks(output(d)).some(([t]) => t === 'tEXt' || t === 'zTXt' || t === 'iTXt')).to.equal(false);
  });
});

/** The segments of a JPEG as [marker, payload], without scan data. */
function jpegSegmentsOf(b: Uint8Array): Array<[number, Buffer]> {
  const buf = Buffer.from(b);
  const out: Array<[number, Buffer]> = [];
  for (let p = 2; p + 4 <= buf.length && buf[p] === 0xff; ) {
    const m = buf[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const n = buf.readUInt16BE(p + 2);
    out.push([m, buf.subarray(p + 4, p + 2 + n)]);
    p += 2 + n;
  }
  return out;
}
