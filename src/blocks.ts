import type { Contained, Run } from './context';
import type { PhotoshopThumbnail } from './metadata';
import { bytes, type Region, u32 } from './rewrite';

/** A thumbnail resource in a block of Photoshop resources, and what the rewrite does with it. */
export interface PhotoshopEdit {
  thumbnail: PhotoshopThumbnail;
  contained: Contained;
}

/**
 * Applies the rewrite's decisions to the thumbnails in a block of Photoshop resources that starts at file offset
 * `base` and lies in `region`. A thumbnail that goes takes its whole resource with it. One a plugin rewrote replaces
 * the resource's JPEG data, and this writes the resource's size field and its header's compressed size again.
 * Returns whether anything changed.
 */
export function photoshopEdits(run: Run, region: Region, base: number, edits: PhotoshopEdit[]): boolean {
  let changed = false;
  for (const { thumbnail: t, contained: c } of edits) {
    if (c.decision === 'keep') continue;
    changed = true;
    if (c.decision === 'drop' || !c.replacement) {
      region.remove(base + t.resourceStart, base + t.resourceEnd);
      continue;
    }
    const n = c.replacement.length;
    // Resource data is padded to an even length.
    region.replace(base + t.offset, base + t.resourceEnd, [{ kind: 'source', source: run.replacementSource(c), length: n }, ...(n & 1 ? [bytes(new Uint8Array(1))] : [])]);
    region.patch(base + t.sizeAt, 4, () => u32(28 + n));
    region.patch(base + t.dataStart + 20, 4, () => u32(n));
  }
  return changed;
}
