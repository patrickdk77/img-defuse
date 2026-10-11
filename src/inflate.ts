import * as stream from 'node:stream';
import * as zlib from 'node:zlib';
import { checkTime } from './errors';

/** Why inflation stopped short: the data is corrupt or ends early, or the output passed the most allowed. */
export class InflateError extends Error {
  constructor(
    readonly kind: 'corrupt' | 'over',
    message: string,
  ) {
    super(message);
  }
}

export interface Inflated {
  /** Bytes of output. */
  produced: number;
  /** Bytes of input up to the end of the zlib stream. Input after that is not part of the stream. */
  consumed: number;
}

/**
 * Inflates a zlib stream fed in chunks, handing each piece of output to `onData`. It stops with an 'over' error as
 * soon as the output passes `max` bytes, so a small stream that would inflate to gigabytes costs at most `max` bytes
 * of work.
 */
export function inflateChunks(input: AsyncIterable<Uint8Array>, max: number, onData: (chunk: Uint8Array) => void, deadline?: number): Promise<Inflated> {
  return decompress(zlib.createInflate(), input, max, onData, deadline);
}

/** Decompresses a Brotli stream fed in chunks, as inflateChunks does a zlib stream. */
export function brotliChunks(input: AsyncIterable<Uint8Array>, max: number, onData: (chunk: Uint8Array) => void, deadline?: number): Promise<Inflated> {
  return decompress(zlib.createBrotliDecompress(), input, max, onData, deadline);
}

async function decompress(inflater: zlib.Inflate | zlib.BrotliDecompress, input: AsyncIterable<Uint8Array>, max: number, onData: (chunk: Uint8Array) => void, deadline?: number): Promise<Inflated> {
  async function* timed(): AsyncGenerator<Uint8Array> {
    for await (const c of input) {
      checkTime(deadline);
      yield c;
    }
  }
  const src = stream.Readable.from(timed());
  src.on('error', err => inflater.destroy(err));
  src.pipe(inflater);
  let produced = 0;
  try {
    for await (const c of inflater as AsyncIterable<Buffer>) {
      produced += c.length;
      if (produced > max) throw new InflateError('over', `inflates past ${max} bytes`);
      onData(c);
    }
  } catch (err) {
    // The decoder's own errors mean corrupt or cut-short data: Z_ codes from zlib, and from Brotli ERR__ERROR_ codes, or
    // on Node 18.0 ERR_ codes that carry the decoder's errno. Anything else, such as an I/O error or the time limit,
    // goes up.
    const code = (err as { code?: unknown })?.code;
    const errno = (err as { errno?: unknown })?.errno;
    if (typeof code === 'string' && (code.startsWith('Z_') || code.startsWith('ERR__ERROR_') || (code.startsWith('ERR_') && typeof errno === 'number' && errno < 0))) {
      throw new InflateError('corrupt', (err as Error).message);
    }
    throw err;
  } finally {
    src.destroy();
    inflater.destroy();
  }
  return { produced, consumed: inflater.bytesWritten };
}
