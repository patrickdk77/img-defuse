import type { Run } from './context';
import { ascii, bytes, lengthOf, type Piece, u32, u64 } from './rewrite';
import { View } from './slice';
import { ImageDetail as D } from './types';

/** A box of the layout JPEG 2000 and JPEG XL files share (ISO/IEC 15444-1 I.4, ISO/IEC 18181-2 3.1). */
export interface Box {
  type: string;
  /** The box, from its length field. */
  start: number;
  /** Its content, after the 8- or 16-byte header. */
  data: number;
  end: number;
  /** The length field is 0, so the box runs to the end of what holds it. */
  open: boolean;
  loc: string;
}

/** Why what is at an offset is not a box, and the detail of the refusal it makes where a box must be. */
export interface NotABox {
  detail: D;
  reason: string;
  loc: string;
}

/** A box type as a location shows it: printable ASCII, and "?" for anything else. */
export const typeName = (t: string) => t.replace(/[^\x20-\x7e]/g, '?');

/**
 * Reads the box at `p` inside [p, end). `where` starts its location. What is there is not a box when its header is cut
 * short, its length is smaller than its header or past what a JavaScript number holds, or it runs past `end`.
 */
export async function readBox(run: Run, p: number, end: number, where: string): Promise<Box | NotABox> {
  const at = `${where}offset ${p}`;
  if (p + 8 > end) return { detail: D.Truncated, reason: 'a box header is cut short', loc: at };
  const h = new View(await run.reader.read(p, Math.min(16, end - p)));
  const type = h.ascii(4, 4);
  const loc = `${where}${typeName(type)} box at ${p}`;
  let length = h.u32(0);
  let header = 8;
  let open = false;
  if (length === 1) {
    if (h.length < 16) return { detail: D.Truncated, reason: `the ${typeName(type)} box's 64-bit length is cut short`, loc };
    const large = h.u64(8);
    if (large === undefined) return { detail: D.BadHeader, reason: `the ${typeName(type)} box's length is past 2^53`, loc };
    length = large;
    header = 16;
  } else if (length === 0) {
    length = end - p;
    open = true;
  }
  if (length < header) return { detail: D.BadHeader, reason: `the ${typeName(type)} box's length ${length} is shorter than its header`, loc };
  if (p + length > end) return { detail: D.Truncated, reason: `the ${typeName(type)} box runs ${p + length - end} bytes past what holds it`, loc };
  run.block();
  return { type, start: p, data: p + header, end: p + length, open, loc };
}

export const isBox = (b: Box | NotABox): b is Box => 'type' in b;

/** Reads every box in [start, end), stopping the run at anything that is not one. */
export async function readBoxes(run: Run, start: number, end: number, where: string): Promise<Box[]> {
  const out: Box[] = [];
  for (let p = start; p < end; ) {
    run.time();
    const b = await readBox(run, p, end, where);
    if (!isBox(b)) run.stop(b.detail, b.reason, b.loc);
    out.push(b);
    p = b.end;
  }
  return out;
}

/** A box of `type` holding the pieces, with a 64-bit length only when a 32-bit one is too small. */
export function boxPieces(type: string, content: Piece[]): Piece[] {
  const n = lengthOf(content);
  if (n + 8 <= 0xffffffff) return [bytes(u32(n + 8)), bytes(ascii(type)), ...content];
  return [bytes(u32(1)), bytes(ascii(type)), bytes(u64(n + 16)), ...content];
}
