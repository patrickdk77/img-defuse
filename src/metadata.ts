import { type Slice, View } from './slice';

/**
 * Checks an ICC profile's header and tag table. Returns why the profile is malformed, or undefined. The declared size
 * must equal the profile's length, bytes 36 to 39 must be "acsp", and every tag must lie inside the profile.
 */
export async function checkIcc(profile: Slice): Promise<string | undefined> {
  if (profile.size < 132) return 'the ICC profile is shorter than its header';
  const head = new View(await profile.read(0, 132));
  if (head.u32(0) !== profile.size) return `the ICC profile declares ${head.u32(0)} bytes and holds ${profile.size}`;
  if (head.ascii(36, 4) !== 'acsp') return 'the ICC profile lacks its acsp signature';
  const count = head.u32(128);
  if (count > (profile.size - 132) / 12) return 'the ICC tag table runs past the end of the profile';
  // Read the tag table in pieces, so a large count costs no more memory than a small one.
  const per = 4096;
  for (let i = 0; i < count; i += per) {
    const n = Math.min(per, count - i);
    const t = new View(await profile.read(132 + i * 12, n * 12));
    for (let j = 0; j < n; j++) {
      const offset = t.u32(j * 12 + 4);
      const size = t.u32(j * 12 + 8);
      if (offset + size > profile.size) return 'an ICC tag lies outside the profile';
    }
  }
  return undefined;
}

const MARKERS = ['<!doctype', '<!entity'];

/**
 * Whether XML text declares a document type or an entity. NUL bytes are left out before the search, so UTF-16 and
 * UTF-32 text matches as well as UTF-8.
 */
export async function hasDoctype(chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
  let carry = '';
  for await (const c of chunks) {
    let s = '';
    for (const b of c) if (b !== 0) s += String.fromCharCode(b);
    const text = (carry + s).toLowerCase();
    if (MARKERS.some(m => text.includes(m))) return true;
    carry = text.slice(-16);
  }
  return false;
}

export interface PhotoshopResources {
  /** A resource 0x0404 holds IPTC data. */
  iptc: boolean;
  /** Thumbnail resources 0x0409 and 0x040C: the JPEG data's offset in the slice and its length. */
  thumbnails: Array<{ offset: number; length: number }>;
}

/**
 * Reads Photoshop image resources: "8BIM" blocks of an id, a padded Pascal name, a size and padded data. Returns why
 * they are malformed instead, as a string.
 */
export async function photoshopResources(slice: Slice): Promise<PhotoshopResources | string> {
  const out: PhotoshopResources = { iptc: false, thumbnails: [] };
  let p = 0;
  while (p < slice.size) {
    if (p + 7 > slice.size) return 'a Photoshop resource ends inside its header';
    const h = new View(await slice.read(p, 7));
    const sig = h.ascii(0, 4);
    if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'PHUT' && sig !== 'AgHg' && sig !== 'DCSR') return 'a Photoshop resource has no 8BIM signature';
    const id = h.u16(4);
    const nameLength = h.u8(6);
    // The length byte and the name together are padded to an even length.
    const nameEnd = p + 6 + ((1 + nameLength + 1) & ~1);
    if (nameEnd + 4 > slice.size) return 'a Photoshop resource ends inside its header';
    const size = new View(await slice.read(nameEnd, 4)).u32(0);
    const data = nameEnd + 4;
    if (data + size > slice.size) return 'a Photoshop resource runs past its block';
    if (id === 0x0404) out.iptc = true;
    if ((id === 0x0409 || id === 0x040c) && size > 28) out.thumbnails.push({ offset: data + 28, length: size - 28 });
    p = data + size + (size & 1);
  }
  return out;
}
