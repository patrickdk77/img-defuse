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
export async function inflateChunks(input: AsyncIterable<Uint8Array>, max: number, onData: (chunk: Uint8Array) => void, deadline?: number): Promise<Inflated> {
  async function* timed(): AsyncGenerator<Uint8Array> {
    for await (const c of input) {
      checkTime(deadline);
      yield c;
    }
  }
  const inflater = zlib.createInflate();
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
    // zlib's own errors mean corrupt or cut-short data. Anything else, such as an I/O error or the time limit, goes up.
    const code = (err as { code?: unknown })?.code;
    if (typeof code === 'string' && code.startsWith('Z_')) throw new InflateError('corrupt', (err as Error).message);
    throw err;
  } finally {
    src.destroy();
    inflater.destroy();
  }
  return { produced, consumed: inflater.bytesWritten };
}
