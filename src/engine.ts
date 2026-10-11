import { inspectBmp } from './bmp';
import { type Limits, Run } from './context';
import { detect, type Format } from './detect';
import { checkTime, isIoError, StopError, stopsTree } from './errors';
import { FindingFactory } from './findings';
import { inspectGif } from './gif';
import { inspectIco } from './ico';
import { bufferSource, Reader, strictSource } from './io';
import { inspectJpeg } from './jpeg';
import { inspectPng } from './png';
import { checkPolyglots } from './polyglot';
import { scoreFindings } from './score';
import { inspectTiff } from './tiff';
import { type ByteSource, ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageInspection, type ImageLimits, type ImageOptions, ImageRisk } from './types';
import { inspectWebp } from './webp';

const DEFAULT_LIMITS = {
  pixels: 16384 * 16384,
  decodedBytes: 1024 * 1024 * 1024,
  totalDecodedBytes: 2 * 1024 * 1024 * 1024,
  frames: 10_000,
  blocks: 1_000_000,
  scans: 1_000,
  metadataBytes: 8 * 1024 * 1024,
};

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

interface Shape {
  format?: Format;
  width: number;
  height: number;
  images: number;
}

/**
 * `incomplete` marks a run that stopped before it read the whole file. It is rejected without a score, whatever the
 * actions say, because an override can make the finding that stopped it look harmless.
 */
function finish(findings: DefuseFinding[], options: ImageOptions, incomplete: boolean, shape: Shape): ImageInspection {
  const named = { format: shape.format?.format ?? '', mimeType: shape.format?.mimeType ?? '', width: shape.width, height: shape.height, images: shape.images };
  if (incomplete) return { status: 'rejected', score: null, risk: ImageRisk.Unknown, findings, ...named };
  const rejected = findings.some(f => f.action === 'reject');
  // A metadata strip changes the file, so the output must be written, as in pdf-defuse.
  const strippable = findings.some(f => f.action === 'strip' || (f.category === C.Metadata && f.detail === D.Stripped));
  const { score, risk } = scoreFindings(findings, options);
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

/** Inspects an image without changing it. The source is closed when the run ends. */
export async function inspectImageSource(source: ByteSource, options: ImageOptions = {}): Promise<ImageInspection> {
  const limits = resolveLimits(options.limits);
  const deadline = limits.timeMs !== undefined ? Date.now() + limits.timeMs : undefined;
  const factory = new FindingFactory(options.actionOverrides);
  const findings: DefuseFinding[] = [];
  const src = watched(source);
  let run: Run | undefined;
  let format: Format | undefined;
  const shape = (): Shape => ({ format, width: run?.width ?? 0, height: run?.height ?? 0, images: run?.images ?? 0 });
  try {
    const size = await src.size();
    if (limits.fileSize !== undefined && size > limits.fileSize) throw new StopError(C.Limit, D.FileSize, `${size} bytes`, { size, limit: limits.fileSize });
    checkTime(deadline);
    const reader = new Reader(src, size);
    const found = detect(await reader.read(0, 64));
    if (!found) throw new StopError(C.Format, D.Unrecognized, 'no signature this package reads');
    if ('unsupported' in found) throw new StopError(C.Format, D.Unsupported, `${found.unsupported} is not read by this version`, { format: found.unsupported });
    format = found;
    run = new Run(reader, factory, limits, deadline, options.stripMetadata === true);
    switch (found.kind) {
      case 'png':
        await inspectPng(run, 0, size, { prefix: '', afterEnd: 'trailing' });
        break;
      case 'jpeg':
        await inspectJpeg(run);
        break;
      case 'gif':
        await inspectGif(run);
        break;
      case 'webp':
        await inspectWebp(run);
        break;
      case 'tiff':
        await inspectTiff(run);
        break;
      case 'bmp':
        await inspectBmp(run);
        break;
      default:
        await inspectIco(run);
    }
    await checkPolyglots(run);
    findings.push(...run.findings);
    return finish(findings, options, false, shape());
  } catch (e) {
    if (src.failure !== undefined) throw src.failure;
    if (isIoError(e)) throw e;
    if (run) findings.push(...run.findings);
    if (e instanceof StopError) {
      findings.push(factory.make(e.category, e.detail, e.location, { ...e.data, reason: e.data?.reason ?? e.message }));
    } else if (stopsTree(e) === 'DEFUSE_LIMIT') {
      findings.push(factory.make(C.Limit, D.Time));
    } else {
      // Anything unexpected rejects the file rather than escaping as an exception.
      findings.push(factory.make(C.Format, D.Unreadable, undefined, { reason: String((e as Error)?.message ?? e).slice(0, 200) }));
    }
    return finish(findings, options, true, shape());
  } finally {
    try {
      await source.close?.();
    } catch {
      // The verdict stands whether or not the source closes.
    }
  }
}

/** Inspects image bytes. */
export async function inspectImage(bytes: Uint8Array, options: ImageOptions = {}): Promise<ImageInspection> {
  return inspectImageSource(bufferSource(bytes), options);
}
