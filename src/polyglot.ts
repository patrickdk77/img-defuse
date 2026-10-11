import type { Run } from './context';
import { View } from './slice';
import { ImageCategory as C, ImageDetail as D } from './types';

/** ZIP readers look for the end record in the last 22 bytes plus the longest comment. */
const ZIP_WINDOW = 22 + 0xffff;

function indexes(hay: Uint8Array, needle: number[]): number[] {
  const out: number[] = [];
  const buf = Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength);
  const n = Buffer.from(needle);
  for (let i = buf.indexOf(n); i >= 0; i = buf.indexOf(n, i + 1)) out.push(i);
  return out;
}

/**
 * Looks where other readers look for their own format: a PDF header in the first 1024 bytes, and a ZIP end record in
 * the last 65,557 bytes whose central directory offset lands on a central directory. A signature inside a block the
 * rewrite can drop is strip; one inside data the image needs is reject.
 */
export async function checkPolyglots(run: Run): Promise<void> {
  const inDroppable = (at: number) => run.droppable.some(([s, e]) => at >= s && at < e);
  const head = await run.reader.read(0, Math.min(1024, run.size));
  const pdf = indexes(head, [0x25, 0x50, 0x44, 0x46, 0x2d])[0];
  if (pdf !== undefined) {
    if (inDroppable(pdf)) run.report(C.Polyglot, D.Pdf, `offset ${pdf}`, { offset: pdf });
    else run.report(C.Polyglot, D.ImageData, `offset ${pdf}`, { offset: pdf, kind: 'PDF' });
  }
  const tailStart = Math.max(0, run.size - ZIP_WINDOW);
  const tail = await run.reader.read(tailStart, run.size - tailStart);
  for (const i of indexes(tail, [0x50, 0x4b, 0x05, 0x06])) {
    const at = tailStart + i;
    if (at + 22 > run.size) continue;
    const end = new View(tail.subarray(i, i + 22), true);
    const size = end.u32(12);
    const offset = end.u32(16);
    const isDirectory = async (p: number) => p >= 0 && p + 4 <= run.size && new View(await run.reader.read(p, 4), true).u32(0) === 0x02014b50;
    // Readers take the offset as written, or relative to where the directory must sit when data was prepended.
    if (!(await isDirectory(offset)) && !(await isDirectory(at - size))) continue;
    if (inDroppable(at)) run.report(C.Polyglot, D.Zip, `offset ${at}`, { offset: at });
    else run.report(C.Polyglot, D.ImageData, `offset ${at}`, { offset: at, kind: 'ZIP' });
  }
}
