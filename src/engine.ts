import { type BmpPlan, bmpPieces, inspectBmp } from './bmp';
import { type KeptFile, type Limits, Run } from './context';
import { detect, type Format } from './detect';
import { type EmfPlan, emfPieces, inspectEmf } from './emf';
import { checkTime, isIoError, NestedIoError, NestingLimitError, StopError, stopsTree, TimeLimitError } from './errors';
import { FindingFactory } from './findings';
import { type GifPlan, gifPieces, inspectGif } from './gif';
import { type IcoPlan, icoPieces, inspectIco } from './ico';
import { bufferSink, bufferSource, copyToSink, Reader, SpillSink, strictSource, TempDir } from './io';
import type { CodestreamPlan } from './j2k';
import { inspectJ2k, inspectJp2, type Jp2Plan, j2kPieces, jp2Pieces } from './jp2';
import { inspectJpeg, type JpegPlan, jpegPieces } from './jpeg';
import { inspectJxl, type JxlPlan, jxlPieces } from './jxl';
import { inspectPng, type PngPlan, pngPieces } from './png';
import { checkPolyglots } from './polyglot';
import { inspectPsd, type PsdPlan, psdPieces } from './psd';
import { emit, layout, type Piece } from './rewrite';
import { scoreFindings } from './score';
import { inspectTiff, type TiffPlan, tiffPieces } from './tiff';
import {
  type ByteSink,
  type ByteSource,
  ImageCategory as C,
  ImageDetail as D,
  type DefuseFinding,
  type ImageDisarmResult,
  type ImageFinding,
  type ImageInspection,
  type ImageLimits,
  type ImageOptions,
  ImageRisk,
} from './types';
import { inspectWebp, type WebpPlan, webpPieces } from './webp';
import { inspectWmf, type WmfPlan, wmfPieces } from './wmf';

const DEFAULT_LIMITS = {
  pixels: 16384 * 16384,
  decodedBytes: 1024 * 1024 * 1024,
  totalDecodedBytes: 2 * 1024 * 1024 * 1024,
  frames: 10_000,
  blocks: 1_000_000,
  scans: 1_000,
  metadataBytes: 8 * 1024 * 1024,
};

const DEFAULT_THRESHOLD = 8 * 1024 * 1024;

function resolveLimits(given: ImageLimits = {}): Limits {
  return {
    pixels: given.pixels ?? DEFAULT_LIMITS.pixels,
    decodedBytes: given.decodedBytes ?? DEFAULT_LIMITS.decodedBytes,
    totalDecodedBytes: given.totalDecodedBytes ?? DEFAULT_LIMITS.totalDecodedBytes,
    frames: given.frames ?? DEFAULT_LIMITS.frames,
    blocks: given.blocks ?? DEFAULT_LIMITS.blocks,
    scans: given.scans ?? DEFAULT_LIMITS.scans,
    metadataBytes: given.metadataBytes ?? DEFAULT_LIMITS.metadataBytes,
    fileSize: given.fileSize,
    timeMs: given.timeMs,
  };
}

/** What a format's inspector leaves for the rewrite. */
type Plan =
  | { kind: 'png'; png: PngPlan }
  | { kind: 'jpeg'; jpeg: JpegPlan }
  | { kind: 'gif'; gif: GifPlan }
  | { kind: 'webp'; webp: WebpPlan }
  | { kind: 'tiff'; tiff: TiffPlan }
  | { kind: 'bmp'; bmp: BmpPlan }
  | { kind: 'ico'; ico: IcoPlan }
  | { kind: 'jp2'; jp2: Jp2Plan }
  | { kind: 'j2k'; j2k: CodestreamPlan }
  | { kind: 'jxl'; jxl: JxlPlan }
  | { kind: 'psd'; psd: PsdPlan }
  | { kind: 'emf'; emf: EmfPlan }
  | { kind: 'wmf'; wmf: WmfPlan };

interface Shape {
  format?: Format;
  width: number;
  height: number;
  images: number;
}

const PLUGIN_KEPT = new Set<string>([D.PluginPassed, D.PluginScrubbed]);
const isPluginKept = (f: DefuseFinding) => f.category === C.EmbeddedImage && PLUGIN_KEPT.has(f.detail);

/**
 * `incomplete` marks a run that stopped before it read the whole file. It is rejected without a score, whatever the
 * actions say, because an override can make the finding that stopped it look harmless. `isOutput` marks the check of a
 * rewrite, where what plugins kept is already in place.
 */
function finish(findings: DefuseFinding[], options: ImageOptions, incomplete: boolean, shape: Shape, isOutput = false): ImageInspection {
  const named = { format: shape.format?.format ?? '', mimeType: shape.format?.mimeType ?? '', width: shape.width, height: shape.height, images: shape.images };
  if (incomplete) return { status: 'rejected', score: null, risk: ImageRisk.Unknown, findings, ...named };
  const rejected = findings.some(f => f.action === 'reject');
  // In an upload, a metadata strip or a plugin's rewrite changes the file, so the output must be written, as in
  // pdf-defuse. In a rewrite being checked, the change is already there.
  const strippable = findings.some(
    f => f.action === 'strip' || (!isOutput && ((f.category === C.Metadata && f.detail === D.Stripped) || (f.category === C.EmbeddedImage && f.detail === D.PluginScrubbed))),
  );
  // The upload's score leaves out what plugins kept; the output's score counts it.
  const { score, risk } = scoreFindings(isOutput ? findings : findings.filter(f => !isPluginKept(f)), options);
  return { status: rejected ? 'rejected' : strippable ? 'strippable' : 'clean', score, risk, findings, ...named };
}

/** Wraps a source so that any error it throws is kept: the engine throws it instead of reporting a verdict on the file. */
function watched(source: ByteSource): ByteSource & { failure?: unknown } {
  const strict = strictSource(source);
  const w: ByteSource & { failure?: unknown } = {
    size: () =>
      strict.size().catch(e => {
        w.failure ??= e;
        throw e;
      }),
    read: (offset, length) =>
      strict.read(offset, length).catch(e => {
        w.failure ??= e;
        throw e;
      }),
  };
  return w;
}

/** Errors from a source or a plugin's I/O, which fail the run instead of judging the file, whatever their code. */
const ioErrors = new WeakSet<object>();
function ioError(e: unknown): unknown {
  if (typeof e === 'object' && e !== null) ioErrors.add(e);
  return e;
}
const isRunIoError = (e: unknown) => isIoError(e) || (typeof e === 'object' && e !== null && ioErrors.has(e));

/** The LIMIT finding for a time or nesting limit, or undefined for any other error. */
function limitFinding(factory: FindingFactory, e: unknown): ImageFinding | undefined {
  if (stopsTree(e) !== 'DEFUSE_LIMIT') return undefined;
  return factory.make(C.Limit, (e as { limit?: unknown }).limit === 'nesting' ? D.NestingDepth : D.Time);
}

interface Setup {
  depth: number;
  deadline: number | undefined;
  temp: TempDir;
  /** In a check of a rewrite, the images inside the image that plugins kept. */
  verify?: Map<string, KeptFile>;
}

/** An inspection, with the run and plan a rewrite reads when the file was read through. */
interface Analysis {
  inspection: ImageInspection;
  run?: Run;
  plan?: Plan;
}

/**
 * Inspects `source` and keeps what the rewrite needs. An I/O error is thrown instead of a verdict. At depth 0 a time
 * or nesting limit becomes a finding. Deeper, a nesting limit and a limit a plugin passed up are thrown, so the whole
 * tree stops, as in pdf-defuse.
 */
async function analyze(source: ByteSource, options: ImageOptions, setup: Setup): Promise<Analysis> {
  const limits = resolveLimits(options.limits);
  const factory = new FindingFactory(options.actionOverrides);
  const findings: DefuseFinding[] = [];
  const src = watched(source);
  let run: Run | undefined;
  let format: Format | undefined;
  const shape = (): Shape => ({ format, width: run?.width ?? 0, height: run?.height ?? 0, images: run?.images ?? 0 });
  try {
    const nesting = options.limits?.nestingDepth;
    if (nesting !== undefined && setup.depth > nesting) throw new NestingLimitError('Nesting limit exceeded');
    const size = await src.size();
    if (limits.fileSize !== undefined && size > limits.fileSize) throw new StopError(C.Limit, D.FileSize, `${size} bytes`, { size, limit: limits.fileSize });
    checkTime(setup.deadline);
    const reader = new Reader(src, size);
    const found = detect(await reader.read(0, 64));
    if (!found) throw new StopError(C.Format, D.Unrecognized, 'no signature this package reads');
    format = found;
    run = new Run(reader, { factory, limits, deadline: setup.deadline, options, depth: setup.depth, temp: setup.temp, verify: setup.verify });
    let plan: Plan;
    switch (found.kind) {
      case 'png':
        plan = { kind: 'png', png: (await inspectPng(run, 0, size, { prefix: '', afterEnd: 'trailing' })).plan };
        break;
      case 'jpeg':
        plan = { kind: 'jpeg', jpeg: await inspectJpeg(run) };
        break;
      case 'gif':
        plan = { kind: 'gif', gif: await inspectGif(run) };
        break;
      case 'webp':
        plan = { kind: 'webp', webp: await inspectWebp(run) };
        break;
      case 'tiff':
        plan = { kind: 'tiff', tiff: await inspectTiff(run) };
        break;
      case 'bmp':
        plan = { kind: 'bmp', bmp: await inspectBmp(run) };
        break;
      case 'jp2':
        plan = { kind: 'jp2', jp2: await inspectJp2(run) };
        break;
      case 'j2k':
        plan = { kind: 'j2k', j2k: await inspectJ2k(run) };
        break;
      case 'jxl':
        plan = { kind: 'jxl', jxl: await inspectJxl(run) };
        break;
      case 'psd':
      case 'psb':
        plan = { kind: 'psd', psd: await inspectPsd(run) };
        break;
      case 'emf':
        plan = { kind: 'emf', emf: await inspectEmf(run) };
        break;
      case 'wmf':
        plan = { kind: 'wmf', wmf: await inspectWmf(run) };
        break;
      default:
        plan = { kind: 'ico', ico: await inspectIco(run) };
    }
    await checkPolyglots(run);
    findings.push(...run.findings);
    return { inspection: finish(findings, options, false, shape(), setup.verify !== undefined), run, plan };
  } catch (e) {
    if (src.failure !== undefined) throw ioError(src.failure);
    if (run?.ioFailure !== undefined) throw ioError(run.ioFailure);
    if (isIoError(e)) throw e;
    if (setup.depth > 0 && (e instanceof NestingLimitError || (run !== undefined && e === run.passedOn))) throw e;
    if (run) findings.push(...run.findings);
    if (e instanceof StopError) {
      findings.push(factory.make(e.category, e.detail, e.location, { ...e.data, reason: e.data?.reason ?? e.message }));
    } else {
      // Anything unexpected rejects the file rather than escaping as an exception.
      findings.push(limitFinding(factory, e) ?? factory.make(C.Format, D.Unreadable, undefined, { reason: String((e as Error)?.message ?? e).slice(0, 200) }));
    }
    return { inspection: finish(findings, options, true, shape()), run };
  }
}

async function closeSource(source: ByteSource): Promise<void> {
  try {
    await source.close?.();
  } catch {
    // The verdict stands whether or not the source closes.
  }
}

/** Inspects an image without changing it. The source is closed when the run ends. */
export async function inspectImageSource(source: ByteSource, options: ImageOptions = {}): Promise<ImageInspection> {
  const temp = new TempDir(options.tempDir);
  const deadline = options.limits?.timeMs !== undefined ? Date.now() + options.limits.timeMs : undefined;
  let run: Run | undefined;
  try {
    const a = await analyze(source, options, { depth: 0, deadline, temp });
    run = a.run;
    return a.inspection;
  } finally {
    await closeSource(source);
    await run?.dispose();
    await temp.cleanup();
  }
}

/** Inspects image bytes. */
export async function inspectImage(bytes: Uint8Array, options: ImageOptions = {}): Promise<ImageInspection> {
  return inspectImageSource(bufferSource(bytes), options);
}

/** The pieces of the rewrite of what a run read. */
async function planPieces(run: Run, plan: Plan): Promise<Piece[]> {
  switch (plan.kind) {
    case 'png':
      return pngPieces(run, plan.png);
    case 'jpeg':
      return jpegPieces(run, plan.jpeg);
    case 'gif':
      return gifPieces(run, plan.gif);
    case 'webp':
      return webpPieces(run, plan.webp);
    case 'tiff':
      return tiffPieces(run, plan.tiff);
    case 'bmp':
      return bmpPieces(run, plan.bmp);
    case 'jp2':
      return jp2Pieces(run, plan.jp2);
    case 'j2k':
      return j2kPieces(run, plan.j2k);
    case 'jxl':
      return jxlPieces(run, plan.jxl);
    case 'psd':
      return psdPieces(run, plan.psd);
    case 'emf':
      return emfPieces(run, plan.emf);
    case 'wmf':
      return wmfPieces(run, plan.wmf);
    default:
      return icoPieces(run, plan.ico);
  }
}

/** Copies to the caller's sink. On failure it aborts the sink instead of closing it, so a partial copy does not look whole. */
async function deliver(from: ByteSource, sink: ByteSink): Promise<void> {
  try {
    await copyToSink(from, sink);
  } catch (e) {
    try {
      await sink.abort?.(e);
    } catch {
      // The copy's error is the one to report.
    }
    throw e;
  }
  await sink.close();
}

/** Rewrites of one upload. Each pass rewrites the output of the one before, and only another format's signature that a removal moved into view starts a new pass. */
const MAX_PASSES = 3;

/**
 * Writes a defused copy of `source` to `sink`. Nothing reaches the sink unless the output passes inspection. The
 * source is closed when the run ends.
 */
export async function disarmImageSource(source: ByteSource, sink: ByteSink, options: ImageOptions = {}): Promise<ImageDisarmResult> {
  return disarmAtDepth(source, sink, options, 0);
}

/** Internal entry that carries the depth of an image inside another file, and the deadline it shares with the upload. */
export async function disarmAtDepth(
  source: ByteSource,
  sink: ByteSink,
  options: ImageOptions,
  depth: number,
  deadline = options.limits?.timeMs !== undefined ? Date.now() + options.limits.timeMs : undefined,
): Promise<ImageDisarmResult> {
  const temp = new TempDir(options.tempDir);
  const factory = new FindingFactory(options.actionOverrides);
  const threshold = options.memoryThreshold ?? DEFAULT_THRESHOLD;
  const runs: Run[] = [];
  const sinks: SpillSink[] = [];
  const sources: ByteSource[] = [];
  const spill = () => {
    const s = new SpillSink(temp, threshold);
    sinks.push(s);
    return s;
  };
  const sourceOf = (s: SpillSink) => {
    const src = s.source();
    sources.push(src);
    return src;
  };
  try {
    let first: Analysis;
    try {
      // A caller's source can change between reads, so the inspection and the rewrite read one snapshot. An image
      // inside another file already sits in its container's copy, and a file over the size limit is rejected unread.
      let input = source;
      const fileSize = options.limits?.fileSize;
      if (depth === 0 && (fileSize === undefined || (await source.size()) <= fileSize)) {
        const snapshot = spill();
        try {
          await copyToSink(source, snapshot, () => checkTime(deadline));
        } finally {
          await snapshot.close();
        }
        input = sourceOf(snapshot);
      }
      first = await analyze(input, options, { depth, deadline, temp });
    } catch (e) {
      if (!(e instanceof TimeLimitError)) throw e;
      first = { inspection: finish([factory.make(C.Limit, D.Time)], options, true, { width: 0, height: 0, images: 0 }) };
    }
    if (first.run) runs.push(first.run);
    const before = first.inspection;
    if (before.status === 'rejected' || !first.run || !first.plan) return { status: 'rejected', before, removed: [] };
    const removed = before.findings.filter(f => f.action === 'strip');
    const kept = new Map(first.run.kept);
    const verifyOptions: ImageOptions = {
      actionOverrides: options.actionOverrides,
      scoreWeights: options.scoreWeights,
      scoreBands: options.scoreBands,
      tempDir: options.tempDir,
      memoryThreshold: options.memoryThreshold,
      limits: { ...options.limits, fileSize: undefined, timeMs: undefined },
    };
    const reject = (reasons: string): ImageDisarmResult => {
      before.findings.push(factory.make(C.Processing, D.VerificationFailed, undefined, { reasons }));
      before.status = 'rejected';
      return { status: 'rejected', before, removed: [] };
    };
    let current: Analysis = first;
    for (let pass = 1; ; pass++) {
      const run = current.run;
      const plan = current.plan;
      if (!run || !plan) return reject('a rewrite pass did not read its input through');
      const out = spill();
      try {
        const pieces = await planPieces(run, plan);
        layout(pieces);
        await emit(pieces, run.reader, out, () => run.time());
        await out.close();
      } catch (e) {
        await out.close().catch(() => {
          // The write's failure, handled here, is the one that counts.
        });
        const failure = (run.reader.source as { failure?: unknown }).failure ?? run.ioFailure;
        if (failure !== undefined) throw ioError(failure);
        if (isRunIoError(e)) throw e;
        const lf = limitFinding(factory, e);
        if (lf) {
          before.findings.push(lf);
          before.status = 'rejected';
          before.score = null;
          before.risk = ImageRisk.Unknown;
          return { status: 'rejected', before, removed: [] };
        }
        return reject(`write failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
      }
      const check = await analyze(sourceOf(out), verifyOptions, { depth, deadline, temp, verify: kept });
      if (check.run) runs.push(check.run);
      const after = check.inspection;
      const reasons = after.findings.filter(f => f.action !== 'info').map(f => `${f.category}/${f.detail}`);
      // A check that stopped early verified nothing, even when the caller overrode the finding that stopped it to info.
      if (after.status === 'rejected' && !reasons.length) reasons.push('the output check stopped early');
      if (after.format !== before.format || after.width !== before.width || after.height !== before.height || after.images !== before.images) {
        reasons.push(
          `the image changed from ${before.format} ${before.width} x ${before.height}, ${before.images} images, to ${after.format} ${after.width} x ${after.height}, ${after.images} images`,
        );
      }
      if (!reasons.length) {
        await deliver(sourceOf(out), sink);
        return { status: before.status === 'clean' && removed.length === 0 ? 'clean' : 'defused', before, after, removed };
      }
      // Removing a block moves the bytes after it, which can bring another format's signature into the part of the
      // file its readers search. Another pass removes it.
      const moved = after.status !== 'rejected' && after.findings.every(f => f.action === 'info' || (f.category === C.Polyglot && (f.detail === D.Pdf || f.detail === D.Zip)));
      if (!moved || pass >= MAX_PASSES) return reject([...new Set(reasons)].slice(0, 10).join(', '));
      const next = await analyze(sourceOf(out), options, { depth, deadline, temp, verify: kept });
      if (next.run) runs.push(next.run);
      if (next.inspection.status === 'rejected') return reject([...new Set(reasons)].slice(0, 10).join(', '));
      removed.push(...next.inspection.findings.filter(f => f.action === 'strip'));
      for (const [k, v] of next.run?.kept ?? []) kept.set(k, v);
      current = next;
    }
  } catch (e) {
    // An I/O error inside a nested image's run fails the upload's run too, instead of counting as a failed plugin.
    if (depth > 0 && isRunIoError(e)) throw new NestedIoError(e);
    throw e;
  } finally {
    for (const r of runs) await r.dispose();
    for (const s of sources) await closeSource(s);
    for (const s of sinks) await s.dispose();
    if (depth === 0) await closeSource(source);
    await temp.cleanup();
  }
}

/** Defuses image bytes. `bytes` holds the output unless the file was rejected. */
export async function disarmImage(bytes: Uint8Array, options: ImageOptions = {}): Promise<ImageDisarmResult & { bytes?: Uint8Array }> {
  const sink = bufferSink();
  const result = await disarmImageSource(bufferSource(bytes), sink, options);
  return result.status === 'rejected' ? result : { ...result, bytes: sink.result() };
}
