import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { disarmImage, inspectImage } from '../../src';
import { crc32 } from '../../src/crc32';
import type { DefuseFinding, ImageInspection, ImageOptions } from '../../src/types';

/** The package root. This file runs from build-test/test/helpers. */
export const root = path.join(__dirname, '..', '..', '..');
export const fixtures = path.join(root, 'test', 'fixtures');
export const fixture = (...parts: string[]) => fs.readFileSync(path.join(fixtures, ...parts));

const cli = path.join(root, 'dist', 'cli.js');
/** Runs the built command-line tool. */
export const runCli = (args: string[], opts: { input?: Buffer; env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  spawnSync(process.execPath, [cli, ...args], { input: opts.input, env: { ...process.env, ...opts.env }, cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });

export const kind = (f: DefuseFinding) => `${f.category}/${f.detail}`;
export const kinds = (i: { findings: DefuseFinding[] }) => i.findings.map(kind);
/** The kinds of finding, each once, in the order they first appear. */
export const kindSet = (i: { findings: DefuseFinding[] }) => [...new Set(kinds(i))];
/** The findings of one kind, such as 'STRUCTURE/TRAILING_DATA'. */
export const of = (i: { findings: DefuseFinding[] }, k: string) => i.findings.filter(f => kind(f) === k);
export const has = (i: { findings: DefuseFinding[] }, k: string) => of(i, k).length > 0;

/** Returns `value`, or fails the test when it is null or undefined. `what` names the value in the failure. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

export const inspectFixture = (options: ImageOptions, ...parts: string[]): Promise<ImageInspection> => inspectImage(fixture(...parts), options);

/** The fixtures in one folder, by name. */
export const fixtureNames = (...parts: string[]) => fs.readdirSync(path.join(fixtures, ...parts)).sort();

/** A short summary of an inspection: status, score, and the kinds found, each once. */
export const summary = (r: ImageInspection) => ({ status: r.status, score: r.score, kinds: kindSet(r) });

/** The reason a stopping finding gives. */
export const reason = (r: ImageInspection) => String(r.findings.find(f => f.action === 'reject')?.data?.reason ?? '');

// ---------- PNG building blocks ----------

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

export function chunk(type: string, data: Uint8Array | string = new Uint8Array(0)): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data)]);
  return Buffer.concat([u32(body.length - 4), body, u32(crc32(body))]);
}

export function ihdr(width: number, height: number, depth = 8, colorType = 0, interlace = 0): Buffer {
  return chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([depth, colorType, 0, 0, interlace])]));
}

/** Rows of gray pixels, each led by filter byte 0. */
export const grayRows = (width: number, height: number, value = 0x80) => Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, value)])));

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG of the chunks given, then IEND. */
export const png = (...chunks: Buffer[]) => Buffer.concat([PNG_SIGNATURE, ...chunks, chunk('IEND')]);

/** An 8 x 8 gray PNG with chunks before and after its IDAT. */
export const grayPng = (before: Buffer[] = [], after: Buffer[] = [], width = 8, height = 8) => png(ihdr(width, height), ...before, chunk('IDAT', zlib.deflateSync(grayRows(width, height))), ...after);

// ---------- GIF building blocks ----------

/**
 * A GIF LZW encoder as the format describes it: one clear code at the start, the table grows to 4096 entries, and
 * after that codes stay 12 bits wide with no further clear.
 */
export function lzwEncode(pixels: number[], minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let bits = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  };
  const table = new Map<string, number>();
  let next = end + 1;
  emit(clear);
  let current = '';
  for (const p of pixels) {
    const key = current === '' ? String(p) : `${current},${p}`;
    if (current === '' || table.has(key)) {
      current = key;
      continue;
    }
    emit(current.includes(',') ? must(table.get(current), current) : Number(current));
    if (next < 4096) {
      table.set(key, next++);
      // The decoder adds this entry one code later, so it widens one code later too.
      if (next - 1 === 1 << codeSize && codeSize < 12) codeSize++;
    }
    current = String(p);
  }
  if (current !== '') emit(current.includes(',') ? must(table.get(current), current) : Number(current));
  emit(end);
  if (bitCount) out.push(bits & 0xff);
  return Buffer.from(out);
}

/** Splits data into GIF sub-blocks with the terminator. */
export function subBlocks(data: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const piece = data.subarray(i, i + 255);
    parts.push(Buffer.from([piece.length]), Buffer.from(piece));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A GIF with a 256-entry global table and one frame of the pixels given. */
export function gifOf(width: number, height: number, pixels: number[], minCodeSize = 8): Buffer {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'latin1');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[10] = 0x87;
  const table = Buffer.alloc(768);
  const image = Buffer.alloc(10);
  image[0] = 0x2c;
  image.writeUInt16LE(width, 5);
  image.writeUInt16LE(height, 7);
  return Buffer.concat([head, table, image, Buffer.from([minCodeSize]), subBlocks(lzwEncode(pixels, minCodeSize)), Buffer.from([0x3b])]);
}

// ---------- disarm helpers ----------

/** Disarms a fixture. */
export const disarmFixture = (options: ImageOptions, ...parts: string[]) => disarmImage(fixture(...parts), options);

/** The output of a disarm, or a failed test when the file was rejected. */
export function output(r: { bytes?: Uint8Array }): Buffer {
  return Buffer.from(must(r.bytes, 'the defused bytes'));
}

/** The kinds of finding with an action other than info. */
export const acted = (i: { findings: DefuseFinding[] }) => [...new Set(i.findings.filter(f => f.action !== 'info').map(kind))];

/** The chunks of a PNG, in order, as [type, data]. */
export function pngChunks(bytes: Uint8Array): Array<[string, Buffer]> {
  const b = Buffer.from(bytes);
  const out: Array<[string, Buffer]> = [];
  for (let p = 8; p + 12 <= b.length; ) {
    const n = b.readUInt32BE(p);
    out.push([b.toString('latin1', p + 4, p + 8), b.subarray(p + 8, p + 8 + n)]);
    p += 12 + n;
  }
  return out;
}

/** The marker segments of a JPEG up to EOI, as [marker, payload], with each scan's entropy-coded data after its SOS. */
export function jpegSegments(bytes: Uint8Array): Array<[number, Buffer]> {
  const b = Buffer.from(bytes);
  const out: Array<[number, Buffer]> = [];
  let p = 2;
  while (p < b.length) {
    // Fill bytes and any other bytes between segments are no part of the image.
    while (p < b.length && !(b[p] === 0xff && b[p + 1] !== 0xff && b[p + 1] !== 0)) p++;
    const marker = b[p + 1];
    if (marker === 0xd9) break;
    const n = b.readUInt16BE(p + 2);
    out.push([marker, b.subarray(p + 4, p + 2 + n)]);
    p += 2 + n;
    if (marker === 0xda) {
      let q = p;
      while (!(b[q] === 0xff && b[q + 1] !== 0 && (b[q + 1] < 0xd0 || b[q + 1] > 0xd7) && b[q + 1] !== 0xff)) q++;
      out.push([-1, b.subarray(p, q)]);
      p = q;
    }
  }
  return out;
}

/** What a JPEG decoder reads for its pixels: the tables, frame, scans and their data, without APP and COM segments. */
export const jpegCore = (bytes: Uint8Array) =>
  Buffer.concat(
    jpegSegments(bytes)
      .filter(([m]) => !(m >= 0xe0 && m <= 0xef) && m !== 0xfe)
      .map(([m, d]) => Buffer.concat([Buffer.from([m & 0xff]), d])),
  );

/** The image data of each PNG frame, inflated: IDAT first, then each run of fdAT chunks. */
export function pngFrames(bytes: Uint8Array): Buffer[] {
  const frames: Buffer[][] = [];
  let last = '';
  for (const [type, data] of pngChunks(bytes)) {
    if (type === 'IDAT' || type === 'fdAT') {
      if (type !== last) frames.push([]);
      frames[frames.length - 1].push(type === 'fdAT' ? data.subarray(4) : data);
    }
    last = type;
  }
  return frames.map(parts => zlib.inflateSync(Buffer.concat(parts)));
}
