import { expect } from 'chai';
import { bufferSink, bufferSource, ImageCategory as C, type ContainedFile, type ContainedFilePlugin, ImageDetail as D, disarmImage, imagePlugin, inspectImage } from '../src';
import { RUN_OPTIONS, type RunContext } from '../src/context';
import { fixture, grayPng, kinds, must, of, output } from './helpers/util';

const fileOf = (bytes: Uint8Array, more: Partial<ContainedFile> = {}): ContainedFile => ({
  name: 'file.bin',
  declaredType: 'text/plain',
  size: bytes.length,
  location: 'test',
  depth: 1,
  source: bufferSource(bytes),
  ...more,
});

/** A JPEG whose EXIF block holds a JPEG thumbnail. */
const withThumb = fixture('rewrite', 'jpeg-exif-orientation-thumb.jpg');

/** The thumbnail's place in `withThumb`: the second SOI, up to the EOI after it. */
function thumbRange(): [number, number] {
  const start = withThumb.indexOf(Buffer.from([0xff, 0xd8, 0xff]), 2);
  return [start, withThumb.indexOf(Buffer.from([0xff, 0xd9]), start) + 2];
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/** A plugin that records the files it is shown and answers with `answer`. */
function recording(answer: ContainedFilePlugin['process']): ContainedFilePlugin & { seen: ContainedFile[] } {
  const seen: ContainedFile[] = [];
  return {
    kind: 'file',
    name: 'recording',
    seen,
    accepts: f => {
      seen.push(f);
      return true;
    },
    process: answer,
  };
}

describe('image plugin', () => {
  it('accepts a file whose first bytes are a format img-defuse reads, whatever its name and declared type say', async () => {
    const p = imagePlugin();
    expect(await p.accepts(fileOf(fixture('clean', 'jpeg', 'gray.jpg'), { name: 'notes.txt' }))).to.equal(true);
    expect(await p.accepts(fileOf(fixture('clean', 'ico', 'cursor.cur')))).to.equal(true);
    expect(await p.accepts(fileOf(Buffer.from('%PDF-1.7\n'), { name: 'photo.jpg', declaredType: 'image/jpeg', sniffedType: 'image/jpeg' }))).to.equal(false);
    expect(await p.accepts(fileOf(fixture('detect', 'svg.svg'), { sniffedType: 'image/svg+xml' }))).to.equal(false);
    for (const parts of [
      ['clean', 'psd', 'flat.psd'],
      ['clean', 'psd', 'flat.psb'],
      ['clean', 'emf', 'rectangle.emf'],
      ['clean', 'wmf', 'rectangle.wmf'],
      ['clean', 'wmf', 'plain.wmf'],
    ]) {
      expect([parts.join('/'), await p.accepts(fileOf(fixture(...parts), { name: 'file.bin' }))]).to.deep.equal([parts.join('/'), true]);
    }
  });

  it('passes a clean image, scrubs one with something to remove and removes a rejected one, with weights on the findings', async () => {
    const p = imagePlugin();
    const clean = fixture('clean', 'png', 'rgb.png');
    let sink = bufferSink();
    expect(await p.process(fileOf(clean), sink, { depth: 1 })).to.deep.equal({ result: 'passed', findings: [], outputFindings: [] });
    expect(Buffer.compare(Buffer.from(sink.result()), clean)).to.equal(0);
    sink = bufferSink();
    const scrubbed = await p.process(fileOf(fixture('hostile', 'png', 'trailing-html.png')), sink, { depth: 1 });
    expect(typeof scrubbed === 'object' && [scrubbed.result, scrubbed.findings?.map(f => [f.detail, f.weight]), scrubbed.outputFindings]).to.deep.equal(['scrubbed', [['TRAILING_DATA', 10]], []]);
    expect(Buffer.compare(Buffer.from(sink.result()), grayPng())).to.equal(0);
    sink = bufferSink();
    const removed = await p.process(fileOf(fixture('hostile', 'png', 'bad-crc.png')), sink, { depth: 1 });
    expect(typeof removed === 'object' && [removed.result, removed.findings?.map(f => [f.detail, f.action, f.weight])]).to.deep.equal(['removed', [['BAD_CHECKSUM', 'reject', 0]]]);
    expect(sink.size()).to.equal(0);
  });

  it('runs with the options it was built with, or else with those of the img-defuse run that found the image', async () => {
    const comment = fixture('meta', 'gif', 'comment.gif');
    const strip: RunContext = { depth: 1, [RUN_OPTIONS]: { stripMetadata: true } };
    const fromRun = await imagePlugin().process(fileOf(comment), bufferSink(), strip);
    const own = await imagePlugin({}).process(fileOf(comment), bufferSink(), strip);
    expect([typeof fromRun === 'object' && fromRun.result, typeof own === 'object' && own.result]).to.deep.equal(['scrubbed', 'passed']);
  });

  it('keeps thumbnails and secondary images in a run, scoring them in the output and not in the upload', async () => {
    const d = await disarmImage(withThumb, { filePlugins: [imagePlugin()] });
    expect([d.status, d.before.score, d.after?.score, kinds(must(d.after, 'after'))]).to.deep.equal([
      'clean',
      0,
      6,
      ['METADATA/EXIF', 'METADATA/GPS', 'METADATA/THUMBNAIL', 'EMBEDDED_IMAGE/PLUGIN_PASSED'],
    ]);
    expect(Buffer.compare(output(d), withThumb)).to.equal(0);
  });

  it('checks limits.nestingDepth against the depth in the context, and the limit stops the whole upload', async () => {
    const e = await failure(imagePlugin({ limits: { nestingDepth: 0 } }).process(fileOf(withThumb), bufferSink(), { depth: 1 }));
    expect([(e as { code?: string }).code, (e as { limit?: string }).limit]).to.deep.equal(['DEFUSE_LIMIT', 'nesting']);
    const r = await inspectImage(withThumb, { filePlugins: [imagePlugin()], limits: { nestingDepth: 0 } });
    expect([r.status, r.score, kinds(r).slice(-1)[0]]).to.deep.equal(['rejected', null, 'LIMIT/NESTING_DEPTH']);
  });

  it('removes an image that runs past the deadline in the context, as pdf-defuse does', async () => {
    const r = await imagePlugin().process(fileOf(withThumb), bufferSink(), { depth: 1, deadline: Date.now() - 1 });
    expect(typeof r === 'object' && [r.result, r.findings?.map(f => f.detail)]).to.deep.equal(['removed', ['TIME']]);
  });

  it('passes an I/O error inside a nested image up the tree with the DEFUSE_IO code', async () => {
    const broken = Object.assign(new Error('read failed'), { code: 'EIO' });
    const source = { size: async () => 100, read: async () => Promise.reject(broken) };
    const e = await failure(imagePlugin().process({ ...fileOf(withThumb), source }, bufferSink(), { depth: 1 }));
    expect([(e as { code?: string }).code, (e as { cause?: unknown }).cause]).to.deep.equal(['DEFUSE_IO', broken]);
    const cause = new Error('bucket went away');
    const thrower: ContainedFilePlugin = { kind: 'file', name: 'io', accepts: () => true, process: async () => Promise.reject(Object.assign(new Error('nested'), { code: 'DEFUSE_IO', cause })) };
    expect(await failure(disarmImage(withThumb, { filePlugins: [thrower] }))).to.equal(cause);
    const limit: ContainedFilePlugin = {
      kind: 'file',
      name: 'limit',
      accepts: () => true,
      process: async () => Promise.reject(Object.assign(new Error('late'), { code: 'DEFUSE_LIMIT', limit: 'time' })),
    };
    const timed = await inspectImage(withThumb, { filePlugins: [limit] });
    expect([timed.status, timed.score, kinds(timed).slice(-1)[0]]).to.deep.equal(['rejected', null, 'LIMIT/TIME']);
  });

  it('labels findings from inside an image and turns a reject inside it into strip', async () => {
    const [, end] = thumbRange();
    const broken = Buffer.from(withThumb);
    // The thumbnail loses its EOI, so it ends inside its scan.
    broken[end - 2] = 0;
    broken[end - 1] = 0;
    const r = await inspectImage(broken, { filePlugins: [imagePlugin()] });
    const inside = r.findings.filter(f => f.attachment !== undefined);
    expect(inside.map(f => [f.category, f.detail, f.action, f.attachment])).to.deep.equal([['STRUCTURE', 'TRUNCATED', 'strip', 'EXIF thumbnail']]);
    expect(inside[0].location?.startsWith('APP1 segment at 2 > ')).to.equal(true);
    expect(r.status).to.equal('strippable');
    expect(of(r, 'EMBEDDED_IMAGE/PLUGIN_REMOVED').length).to.equal(1);
  });

  it('removes an image a plugin fails on, removes, or scrubs without writing', async () => {
    const answers: Array<[string, ContainedFilePlugin['process'], string]> = [
      ['throws', async () => Promise.reject(new Error('bug')), 'PLUGIN_FAILED'],
      ['removes', async () => 'removed', 'PLUGIN_REMOVED'],
      ['writes nothing', async () => 'scrubbed', 'PLUGIN_FAILED'],
    ];
    for (const [what, answer, detail] of answers) {
      const d = await disarmImage(withThumb, { filePlugins: [recording(answer)] });
      expect([what, d.status, of(d.before, `EMBEDDED_IMAGE/${detail}`).map(f => f.action)]).to.deep.equal([what, 'defused', ['strip']]);
      expect(kinds(must(d.after, 'after'))).to.not.include('METADATA/THUMBNAIL');
    }
  });

  it('shows each image its depth, location and sniffed type, and never the one TYPE_MISMATCH removes', async () => {
    const p = recording(async () => 'passed');
    await inspectImage(withThumb, { filePlugins: [p] });
    const [start, end] = thumbRange();
    expect(p.seen.map(f => [f.depth, f.location, f.sniffedType, f.declaredType, f.size, f.name])).to.deep.equal([[1, 'APP1 segment at 2', 'image/jpeg', 'image/jpeg', end - start, undefined]]);
    const html = recording(async () => 'passed');
    const r = await inspectImage(fixture('hostile', 'jpeg', 'exif-html-thumb.jpg'), { filePlugins: [html], actionOverrides: [{ category: C.EmbeddedImage, detail: D.TypeMismatch, action: 'strip' }] });
    expect([html.seen.length, kinds(r)]).to.deep.equal([0, ['METADATA/EXIF', 'METADATA/THUMBNAIL', 'EMBEDDED_IMAGE/TYPE_MISMATCH']]);
  });

  it('removes a copy that is too long for the segment that holds the image', async () => {
    const big = Buffer.alloc(70000, 0x41);
    const writer: ContainedFilePlugin = {
      kind: 'file',
      name: 'big',
      accepts: () => true,
      async process(_f, sink) {
        await sink.write(big);
        return 'scrubbed';
      },
    };
    const d = await disarmImage(withThumb, { filePlugins: [writer] });
    expect([d.status, of(d.before, 'EMBEDDED_IMAGE/PLUGIN_FAILED')[0]?.data?.reason]).to.deep.equal(['defused', 'its output does not fit the block that holds the image']);
  });
});
