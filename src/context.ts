import { sniffType } from './detect';
import { checkTime, StopError } from './errors';
import type { FindingFactory } from './findings';
import type { Reader } from './io';
import { allZero } from './slice';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageFinding } from './types';

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

/** What one inspection holds while the format rules run. */
export class Run {
  readonly findings: DefuseFinding[] = [];
  /** File ranges, [start, end), that the rewrite can drop: metadata, extra blocks, trailing and hidden data. */
  readonly droppable: Array<[number, number]> = [];
  width = 0;
  height = 0;
  images = 0;
  private totalDecoded = 0;
  private blockCount = 0;
  private readonly perKind = new Map<string, number>();
  private readonly overflow = new Map<string, Record<string, string | number>>();

  constructor(
    readonly reader: Reader,
    readonly factory: FindingFactory,
    readonly limits: Limits,
    readonly deadline: number | undefined,
    readonly stripMetadata: boolean,
  ) {}

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

  /** Whether the rewrite keeps the content a finding names. */
  keeps(f: DefuseFinding): boolean {
    if (this.stripMetadata && f.category === C.Metadata && f.detail !== D.IccProfile) return false;
    return f.action !== 'strip';
  }

  /** A block viewers skip, at [start, end) of the file. */
  extra(location: string, start: number, end: number, data?: Record<string, string | number>): void {
    this.droppableRange(start, end);
    this.report(C.Structure, D.ExtraBlock, location, data);
  }

  /** A metadata block that does not parse. */
  malformed(location: string, start: number, end: number, reason: string): void {
    this.droppableRange(start, end);
    this.report(C.Metadata, D.Malformed, location, { reason: clip(reason) });
  }

  /**
   * Bytes at [start, end) that no structure covers: hidden between structures, or trailing after the format's end.
   * A run of zero bytes is padding and goes unreported.
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

  /**
   * An image file inside the image, such as a thumbnail, at [start, start + length) of the file. `declared` is the
   * type its container gives it. `kept` says whether the rewrite keeps it; one it keeps goes to the plugins, and with
   * none that accepts it, it goes as EMBEDDED_IMAGE/NO_PLUGIN.
   */
  async contained(location: string, start: number, length: number, declared: string | undefined, kept: boolean): Promise<void> {
    const sniffed = sniffType(await this.reader.read(start, Math.min(length, 64))) ?? '';
    if (declared !== undefined && sniffed !== declared) this.report(C.EmbeddedImage, D.TypeMismatch, location, { declared, sniffed, offset: start, bytes: length });
    if (kept) this.report(C.EmbeddedImage, D.NoPlugin, location, { sniffed, offset: start, bytes: length });
  }
}
