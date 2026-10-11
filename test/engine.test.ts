import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { expect } from 'chai';
import { type ByteSource, bufferSource, fileSource, inspectImage, inspectImageSource } from '../src';
import { stopsTree, TimeLimitError } from '../src/errors';
import { chunk, fixture, fixtures, grayPng, ihdr, kinds, must, of, png, root } from './helpers/util';

const sourceOf = (bytes: Buffer, read?: (offset: number, length: number) => Promise<Uint8Array>): ByteSource => ({
  size: async () => bytes.length,
  read: read ?? (async (offset, length) => bytes.subarray(offset, offset + length)),
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('engine', () => {
  it('gives the same result from a file source as from a buffer, and closes the source', async () => {
    const file = path.join(fixtures, 'meta', 'jpeg', 'exif-gps-thumb.jpg');
    let closed = 0;
    const src = fileSource(file);
    const close = must(src.close, 'close');
    const counting: ByteSource = {
      size: () => src.size(),
      read: (o, n) => src.read(o, n),
      close: async () => {
        closed++;
        await close.call(src);
      },
    };
    const a = await inspectImageSource(counting);
    const b = await inspectImage(fs.readFileSync(file));
    expect(a).to.deep.equal(b);
    expect(closed).to.equal(1);
  });

  it('throws I/O errors from the source instead of judging the file', async () => {
    const missing = await failure(inspectImageSource(fileSource(path.join(os.tmpdir(), 'img-defuse-no-such-file.png'))));
    expect((missing as NodeJS.ErrnoException).code).to.equal('ENOENT');
    const bytes = fixture('clean', 'png', 'rgb.png');
    const custom = new Error('bucket went away');
    expect(await failure(inspectImageSource(sourceOf(bytes, async () => Promise.reject(custom))))).to.equal(custom);
    const short = await failure(inspectImageSource(sourceOf(bytes, async (o, n) => bytes.subarray(o, o + Math.max(0, n - 1)))));
    expect((short as NodeJS.ErrnoException).code).to.equal('EIO');
  });

  it('rejects a file over the size limit without reading it', async () => {
    const bytes = fixture('clean', 'png', 'rgb.png');
    let reads = 0;
    const r = await inspectImageSource(
      sourceOf(bytes, async (o, n) => {
        reads++;
        return bytes.subarray(o, o + n);
      }),
      { limits: { fileSize: 100 } },
    );
    expect([r.status, r.score, kinds(r), reads]).to.deep.equal(['rejected', null, ['LIMIT/FILE_SIZE'], 0]);
    expect(r.findings[0].data).to.include({ size: bytes.length, limit: 100 });
  });

  it('turns a limit off with Infinity', async () => {
    const r = await inspectImage(fixture('hostile', 'png', 'pixels.png'), {
      limits: { pixels: Number.POSITIVE_INFINITY, decodedBytes: Number.POSITIVE_INFINITY, totalDecodedBytes: Number.POSITIVE_INFINITY },
    });
    expect(kinds(r)).to.deep.equal(['STRUCTURE/BAD_DATA']);
  });

  it('stops at the time limit with LIMIT/TIME, and its error carries the family code', async () => {
    const bytes = fixture('clean', 'tiff', 'multipage.tif');
    const slow = sourceOf(bytes, async (o, n) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return bytes.subarray(o, o + n);
    });
    const r = await inspectImageSource(slow, { limits: { timeMs: 1 } });
    expect([r.status, r.score, kinds(r).slice(-1)[0]]).to.deep.equal(['rejected', null, 'LIMIT/TIME']);
    const e = new TimeLimitError('x');
    expect([e.code, e.limit, stopsTree(e), stopsTree(Object.assign(new Error('io'), { code: 'DEFUSE_IO' })), stopsTree(new Error('x'))]).to.deep.equal([
      'DEFUSE_LIMIT',
      'time',
      'DEFUSE_LIMIT',
      'DEFUSE_IO',
      undefined,
    ]);
  });

  it('rejects the file as unreadable when something unexpected fails', async () => {
    const bytes = fixture('clean', 'png', 'rgb.png');
    // A source that hands back a plain array rather than bytes.
    const odd = sourceOf(bytes, async (o, n) => Array.from(bytes.subarray(o, o + n)) as unknown as Uint8Array);
    const r = await inspectImageSource(odd);
    expect([r.status, r.score, kinds(r)]).to.deep.equal(['rejected', null, ['FORMAT/UNREADABLE']]);
  });

  it('keeps 200 findings of one kind and counts the rest in one more', async () => {
    const many = grayPng(Array.from({ length: 250 }, (_, i) => chunk('tEXt', `k${i}\0v`)));
    const r = await inspectImage(many);
    const text = of(r, 'METADATA/TEXT');
    expect(text.length).to.equal(201);
    expect([text[200].location, text[200].data?.count]).to.deep.equal(['additional occurrences', 50]);
  });

  it('inspects in memory far smaller than what the image data inflates to', async () => {
    // A 6000 x 6000 gray image inflates to 36 MB and deflates to a fraction of that.
    const raw = Buffer.alloc(6000 * 6001);
    for (let y = 0; y < 6000; y++) raw.fill(y % 251, y * 6001 + 1, (y + 1) * 6001);
    const image = png(ihdr(6000, 6000), chunk('IDAT', zlib.deflateSync(raw)));
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    try {
      const r = await inspectImageSource(bufferSource(image));
      expect(r.status).to.equal('clean');
    } finally {
      clearInterval(timer);
    }
    expect(image.length).to.be.lessThan(1024 * 1024);
    expect(peak - before).to.be.lessThan(16 * 1024 * 1024);
  });

  it('exports the same API to ES modules and CommonJS', async () => {
    const cjs = require(path.join(root, 'dist', 'index.js')) as Record<string, unknown>;
    const esm = (await (new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, unknown>>)(path.join(root, 'dist', 'index.mjs'))) as Record<string, unknown>;
    const names = Object.keys(cjs)
      .filter(n => n !== '__esModule')
      .sort();
    expect(names).to.include.members(['inspectImage', 'inspectImageSource', 'bufferSource', 'fileSource', 'allFindingSpecs', 'scoreFindings', 'ImageCategory', 'ImageDetail', 'ImageRisk']);
    for (const n of names) expect(esm[n], n).to.equal(cjs[n]);
  });
});
