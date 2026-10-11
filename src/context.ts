import * as crypto from 'node:crypto';
import { sniffType } from './detect';
import { checkTime, StopError, stopsTree } from './errors';
import type { FindingFactory } from './findings';
import { type Reader, rangesSource, SpillSink, type TempDir } from './io';
import { allZero } from './slice';
import {
  type ByteSource,
  ImageCategory as C,
  type ContainedFile,
  type ContainedFilePlugin,
  type ContainedFileResult,
  ImageDetail as D,
  type DefuseFinding,
  type ImageFinding,
  type ImageOptions,
  type PluginContext,
} from './types';

export interface Limits {
  fileSize?: number;
  pixels: number;
  decodedBytes: number;
  totalDecodedBytes: number;
  frames: number;
  blocks: number;
  scans: number;
  metadataBytes: number;
  timeMs?: number;
}

/** Cuts text from the file to a length that fits a finding's data. */
export const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** The key under which a run hands its options to a plugin. No other package can name it. */
export const RUN_OPTIONS = Symbol('img-defuse run options');

/** A plugin context as img-defuse makes it. */
export type RunContext = PluginContext & { [RUN_OPTIONS]?: ImageOptions };

/** An image inside the image that a plugin kept, by the SHA-256 of the bytes the output holds. */
export interface KeptFile {
  result: 'passed' | 'scrubbed';
  plugin: string;
  /** The plugin's findings for the bytes it kept. */
  findings?: DefuseFinding[];
}

/** What the rewrite does with an image inside the image. */
export interface Contained {
  start: number;
  length: number;
  /** keep: the bytes stay as they are. drop: they go. replace: `replacement` takes their place. */
  decision: 'keep' | 'drop' | 'replace';
  replacement?: SpillSink;
}

/** What one inspection is run with, besides the file. */
export interface RunSetup {
  factory: FindingFactory;
  limits: Limits;
  deadline: number | undefined;
  options: ImageOptions;
  /** The depth of the file itself: 0 for the upload. */
  depth: number;
  temp: TempDir;
  /** In a check of a rewrite, the images inside the image that plugins kept. They are not shown to the plugins again. */
  verify?: Map<string, KeptFile>;
}

/** What one inspection holds while the format rules run, and what the rewrite reads afterwards. */
export class Run {
  readonly findings: DefuseFinding[] = [];
  /** File ranges, [start, end), that the rewrite can drop: metadata, extra blocks, trailing and hidden data. */
  readonly droppable: Array<[number, number]> = [];
  /** Offsets of another format's signature whose finding has the action strip. The block holding each one goes. */
  readonly polyglotDrops: number[] = [];
  /** Images inside the image that plugins kept, for the check of the rewrite. */
  readonly kept = new Map<string, KeptFile>();
  width = 0;
  height = 0;
  images = 0;
  /** An I/O error a plugin passed up, which fails the run instead of judging the file. */
  ioFailure?: unknown;
  /** A limit a plugin passed up from a nested run. A nested run passes it on instead of reporting it. */
  passedOn?: unknown;
  private totalDecoded = 0;
  private blockCount = 0;
  private retained = 0;
  private readonly outputs: SpillSink[] = [];
  private readonly sources: ByteSource[] = [];
  private readonly perKind = new Map<string, number>();
  private readonly overflow = new Map<string, Record<string, string | number>>();
  readonly factory: FindingFactory;
  readonly limits: Limits;
  readonly deadline: number | undefined;
  readonly stripMetadata: boolean;

  constructor(
    readonly reader: Reader,
    readonly setup: RunSetup,
  ) {
    this.factory = setup.factory;
    this.limits = setup.limits;
    this.deadline = setup.deadline;
    this.stripMetadata = setup.options.stripMetadata === true;
  }

  get size(): number {
    return this.reader.size;
  }

  /** Records a finding. Past 200 of one kind, as in pdf-defuse, one more finding counts the rest. */
  report(category: C, detail: D, location?: string, data?: Record<string, string | number>): ImageFinding {
    const k = `${category}/${detail}`;
    const n = (this.perKind.get(k) ?? 0) + 1;
    this.perKind.set(k, n);
    const made = this.factory.make(category, detail, location, data);
    if (n <= 200) {
      this.findings.push(made);
      return made;
    }
    let counted = this.overflow.get(k);
    if (!counted) {
      // The first overflow fills the description's placeholders.
      counted = { ...data, count: 0 };
      this.overflow.set(k, counted);
      this.findings.push(this.factory.make(category, detail, 'additional occurrences', counted));
    }
    counted.count = Number(counted.count) + 1;
    return made;
  }

  /** Reports content that goes whatever the overrides say. Its action is strip, or reject when the caller asked for that. */
  removal(detail: D, location: string, data: Record<string, string | number>): ImageFinding {
    const f = this.report(C.EmbeddedImage, detail, location, data);
    if (f.action === 'info') f.action = 'strip';
    return f;
  }

  time(): void {
    checkTime(this.deadline);
  }

  /** Stops the run with a STRUCTURE refusal. */
  stop(detail: D, reason: string, location?: string, data?: Record<string, string | number>): never {
    throw new StopError(C.Structure, detail, reason, { ...data, reason: clip(reason) }, location);
  }

  /** Stops the run at a limit. */
  limit(detail: D, message: string, data: Record<string, string | number>): never {
    throw new StopError(C.Limit, detail, message, data);
  }

  /** Counts chunks, segments, blocks, entries, strips or tiles against the block limit. */
  block(n = 1): void {
    this.blockCount += n;
    if (this.blockCount > this.limits.blocks) this.limit(D.Blocks, `more than ${this.limits.blocks} blocks`, { limit: this.limits.blocks });
  }

  /**
   * Counts one image or frame, and checks its pixels and the bytes its data decodes to against the limits before any
   * of that data is read.
   */
  image(width: number, height: number, decoded: number, location: string): void {
    this.images++;
    if (this.images === 1 && this.width === 0) {
      this.width = width;
      this.height = height;
    }
    if (this.images > this.limits.frames) this.limit(D.Frames, `more than ${this.limits.frames} images`, { limit: this.limits.frames });
    const pixels = width * height;
    if (pixels > this.limits.pixels) this.limit(D.Pixels, `${width} x ${height} pixels at ${location}`, { width, height, limit: this.limits.pixels });
    if (decoded > this.limits.decodedBytes) this.limit(D.DecodedSize, `${decoded} bytes at ${location}`, { bytes: decoded, limit: this.limits.decodedBytes });
    this.totalDecoded += decoded;
    if (this.totalDecoded > this.limits.totalDecodedBytes) this.limit(D.TotalDecodedSize, `more than ${this.limits.totalDecodedBytes} bytes`, { limit: this.limits.totalDecodedBytes });
  }

  /**
   * Checks an image that is part of the file but not one of its images, such as a Photoshop layer or a bitmap inside
   * a metafile, against the pixel and decoded size limits. Its decoded bytes count toward the total.
   */
  inner(width: number, height: number, decoded: number, location: string): void {
    const pixels = width * height;
    if (pixels > this.limits.pixels) this.limit(D.Pixels, `${width} x ${height} pixels at ${location}`, { width, height, limit: this.limits.pixels });
    if (decoded > this.limits.decodedBytes) this.limit(D.DecodedSize, `${decoded} bytes at ${location}`, { bytes: decoded, limit: this.limits.decodedBytes });
    this.totalDecoded += decoded;
    if (this.totalDecoded > this.limits.totalDecodedBytes) this.limit(D.TotalDecodedSize, `more than ${this.limits.totalDecodedBytes} bytes`, { limit: this.limits.totalDecodedBytes });
  }

  /** Marks a range of the file as one the rewrite can drop. */
  droppableRange(start: number, end: number): void {
    if (end > start) this.droppable.push([start, end]);
  }

  /**
   * Reports a metadata block at [start, end) of the file. With stripMetadata, every block but an ICC profile also
   * gets METADATA/STRIPPED.
   */
  metadata(detail: D, location: string, start: number, end: number, data?: Record<string, string | number>): ImageFinding {
    this.droppableRange(start, end);
    const f = this.report(C.Metadata, detail, location, data);
    if (this.stripMetadata && detail !== D.IccProfile) this.report(C.Metadata, D.Stripped, location);
    return f;
  }

  /** Whether the rewrite keeps the content a finding names. The finding's action decides, and stripMetadata removes all metadata but the ICC profile. */
  keeps(f: DefuseFinding): boolean {
    if (this.stripMetadata && f.category === C.Metadata && f.detail !== D.IccProfile) return false;
    return f.action !== 'strip';
  }

  /** Whether the rewrite drops the block at [start, end): one of its findings removes it, or another format's signature sits in it. */
  drops(findings: Array<DefuseFinding | undefined>, start: number, end: number): boolean {
    return findings.some(f => f !== undefined && !this.keeps(f)) || this.polyglotDrops.some(p => p >= start && p < end);
  }

  /** A block viewers skip, at [start, end) of the file. */
  extra(location: string, start: number, end: number, data?: Record<string, string | number>): ImageFinding {
    this.droppableRange(start, end);
    return this.report(C.Structure, D.ExtraBlock, location, data);
  }

  /** A metadata block that does not parse. */
  malformed(location: string, start: number, end: number, reason: string): ImageFinding {
    this.droppableRange(start, end);
    return this.report(C.Metadata, D.Malformed, location, { reason: clip(reason) });
  }

  /**
   * Bytes at [start, end) that no structure covers: hidden between structures, or trailing after the format's end.
   * A run of zero bytes is padding and goes unreported. The rewrite drops both.
   */
  async gap(start: number, end: number, kind: 'hidden' | 'trailing'): Promise<void> {
    if (end <= start) return;
    let zero = true;
    for await (const c of this.reader.chunks(start, end - start)) {
      this.time();
      if (!allZero(c)) {
        zero = false;
        break;
      }
    }
    if (zero) return;
    this.droppableRange(start, end);
    this.report(C.Structure, kind === 'hidden' ? D.HiddenData : D.TrailingData, `offset ${start}`, { offset: start, bytes: end - start });
  }

  /** The SHA-256 of ranges of the file, each [start, length], in hex. */
  private async digest(ranges: Array<[number, number]>): Promise<string> {
    const h = crypto.createHash('sha256');
    for (const [start, length] of ranges) {
      for await (const c of this.reader.chunks(start, length)) {
        this.time();
        h.update(c);
      }
    }
    return h.digest('hex');
  }

  /**
   * Adds the findings a plugin reported from inside an image, labeled with where it sits. A reject inside it means
   * that image goes, not the file, so it is recorded here as strip.
   */
  private pushContained(found: DefuseFinding[] | undefined, location: string, label: string): void {
    for (const f of found ?? []) {
      this.findings.push({
        ...f,
        action: f.action === 'reject' ? 'strip' : f.action,
        location: f.location ? `${location} > ${f.location}` : location,
        data: f.data && { ...f.data },
        attachment: f.attachment ? `${label} > ${f.attachment}` : label,
      });
    }
  }

  /**
   * Throws on an error a plugin threw that stops the whole tree. An I/O error fails this run as one of its own would,
   * so its cause goes up.
   */
  private passOn(e: unknown): void {
    const code = stopsTree(e);
    if (code === 'DEFUSE_IO') {
      const cause = (e as { cause?: unknown }).cause ?? e;
      this.ioFailure ??= cause;
      throw cause;
    }
    if (code === 'DEFUSE_LIMIT') {
      this.passedOn = e;
      throw e;
    }
  }

  /**
   * An image file inside the image, such as a thumbnail, at [start, start + length) of the file. `declared` is the
   * type its container gives it, and `label` names it in the findings a plugin returns. `kept` says whether the rules
   * of the block that holds it keep it. One that stays goes to the file plugins, and with none that accepts it, it
   * goes as EMBEDDED_IMAGE/NO_PLUGIN. A plugin's output longer than `maxLength` does not fit the block, and the image
   * goes. `more.ranges` gives a file split over several ranges of the file, each [start, length], which then replace
   * `start` and `length`. When `more.replaceable` is false, the block cannot take a rewritten copy: an image a plugin
   * passes stays as it is, and one it scrubs goes.
   */
  async contained(
    location: string,
    label: string,
    start: number,
    length: number,
    declared: string | undefined,
    kept: boolean,
    maxLength = Number.POSITIVE_INFINITY,
    more: { ranges?: Array<[number, number]>; replaceable?: boolean } = {},
  ): Promise<Contained> {
    const ranges = more.ranges ?? [[start, length]];
    const total = ranges.reduce((t, [, n]) => t + n, 0);
    const source = rangesSource(this.reader, ranges);
    const sniffed = sniffType(await source.read(0, Math.min(total, 64))) ?? '';
    const c: Contained = { start: ranges[0]?.[0] ?? start, length: total, decision: 'drop' };
    const mismatch = declared !== undefined && sniffed !== declared ? this.report(C.EmbeddedImage, D.TypeMismatch, location, { declared, sniffed, offset: c.start, bytes: total }) : undefined;
    // TYPE_MISMATCH made strip removes the image before any plugin sees it, as in pdf-defuse.
    if (!kept || mismatch?.action === 'strip') return c;
    const plugins: ContainedFilePlugin[] = this.setup.options.filePlugins ?? [];
    // The digest matches a kept image in the check of a rewrite, and names what a plugin keeps.
    const hash = this.setup.verify || plugins.length ? await this.digest(ranges) : '';
    const expected = this.setup.verify?.get(hash);
    if (expected) {
      this.report(C.EmbeddedImage, expected.result === 'passed' ? D.PluginPassed : D.PluginScrubbed, location, { plugin: expected.plugin });
      this.pushContained(expected.findings, location, label);
      c.decision = 'keep';
      return c;
    }
    if (plugins.length) {
      const file: ContainedFile = { declaredType: declared, sniffedType: sniffed || undefined, size: total, location, depth: this.setup.depth + 1, source };
      const context: RunContext = { depth: file.depth, deadline: this.deadline, [RUN_OPTIONS]: this.setup.options };
      const threshold = this.setup.options.memoryThreshold ?? 8 * 1024 * 1024;
      for (const plugin of plugins) {
        try {
          if (!(await plugin.accepts(file))) continue;
        } catch (e) {
          this.passOn(e);
          continue;
        }
        // The copies plugins write wait in memory until the rewrite, so all of them together stay under one threshold.
        const out = new SpillSink(this.setup.temp, Math.max(0, threshold - this.retained));
        const data = { plugin: plugin.name };
        try {
          const answer = await plugin.process(file, out, context);
          const r: Partial<ContainedFileResult> = typeof answer === 'string' ? { result: answer } : (answer ?? {});
          await out.close();
          let keep = false;
          if (r.result === 'passed') {
            this.report(C.EmbeddedImage, D.PluginPassed, location, data);
            keep = true;
          } else if (r.result === 'scrubbed' && out.length > 0) {
            this.report(C.EmbeddedImage, D.PluginScrubbed, location, data);
            keep = true;
          } else this.removal(r.result === 'removed' ? D.PluginRemoved : D.PluginFailed, location, data);
          this.pushContained(r.findings, location, label);
          if (keep && out.length > maxLength) {
            this.removal(D.PluginFailed, location, { ...data, reason: 'its output does not fit the block that holds the image' });
            keep = false;
          }
          if (keep && more.replaceable === false) {
            await out.dispose();
            if (r.result === 'passed') {
              // The block keeps the image as it is, so the check of the rewrite finds these bytes.
              this.kept.set(hash, { result: 'passed', plugin: plugin.name, findings: r.outputFindings });
              c.decision = 'keep';
            } else this.removal(D.PluginFailed, location, { ...data, reason: 'the block that holds the image cannot take a rewritten copy' });
            return c;
          }
          if (keep) {
            // Bytes the plugin wrote are the ones kept, such as an image rewritten with nothing removed.
            const replaced = out.length > 0;
            this.kept.set(replaced ? out.digest() : hash, { result: r.result === 'passed' ? 'passed' : 'scrubbed', plugin: plugin.name, findings: r.outputFindings });
            if (replaced) {
              c.decision = 'replace';
              c.replacement = out;
              this.outputs.push(out);
              if (!out.spilled) this.retained += out.length;
              return c;
            }
            c.decision = 'keep';
          }
          await out.dispose();
          return c;
        } catch (e) {
          await out.dispose();
          this.passOn(e);
          this.removal(D.PluginFailed, location, data);
          return c;
        }
      }
    }
    const f = this.report(C.EmbeddedImage, D.NoPlugin, location, { sniffed, offset: c.start, bytes: total });
    if (f.action !== 'strip') c.decision = 'keep';
    return c;
  }

  /** A source over a replacement a plugin wrote. It is closed when the run ends. */
  replacementSource(c: Contained): ByteSource {
    if (!c.replacement) throw new Error('The image has no replacement');
    const s = c.replacement.source();
    this.sources.push(s);
    return s;
  }

  /** Releases what plugins wrote. */
  async dispose(): Promise<void> {
    for (const s of this.sources.splice(0)) await s.close?.();
    for (const o of this.outputs.splice(0)) await o.dispose();
  }
}
