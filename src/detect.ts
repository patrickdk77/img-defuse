import { latin1 } from './slice';

export type Kind = 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'ico' | 'cur';

export interface Format {
  kind: Kind;
  /** The usual file extension, without the dot. */
  format: string;
  /** The MIME type of a file in this format. */
  mimeType: string;
}

const FORMATS: Record<Kind, Format> = {
  png: { kind: 'png', format: 'png', mimeType: 'image/png' },
  jpeg: { kind: 'jpeg', format: 'jpg', mimeType: 'image/jpeg' },
  gif: { kind: 'gif', format: 'gif', mimeType: 'image/gif' },
  webp: { kind: 'webp', format: 'webp', mimeType: 'image/webp' },
  tiff: { kind: 'tiff', format: 'tif', mimeType: 'image/tiff' },
  bmp: { kind: 'bmp', format: 'bmp', mimeType: 'image/bmp' },
  ico: { kind: 'ico', format: 'ico', mimeType: 'image/vnd.microsoft.icon' },
  cur: { kind: 'cur', format: 'cur', mimeType: 'image/x-win-bitmap' },
};

/** Info header sizes a BMP file can have: core, info, the two Adobe variants, OS/2 2.x, V4 and V5. */
export const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const starts = (b: Uint8Array, at: number, bytes: number[]) => bytes.every((x, i) => b[at + i] === x);

/**
 * The format the first bytes give, or the name of a format this version recognizes but does not read, or undefined.
 * `head` should hold at least the first 64 bytes, or the whole file when it is shorter.
 */
export function detect(head: Uint8Array): Format | { unsupported: string } | undefined {
  const s = latin1(head.subarray(0, 64));
  if (starts(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return FORMATS.png;
  if (starts(head, 0, [0xff, 0xd8, 0xff])) return FORMATS.jpeg;
  if (s.startsWith('GIF87a') || s.startsWith('GIF89a')) return FORMATS.gif;
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return FORMATS.webp;
  if (s.startsWith('II*\0') || s.startsWith('MM\0*') || s.startsWith('II+\0') || s.startsWith('MM\0+')) return FORMATS.tiff;
  if (s.startsWith('BM') && head.length >= 18) {
    const header = head[14] | (head[15] << 8) | (head[16] << 16) | (head[17] << 24);
    if (BMP_HEADER_SIZES.has(header)) return FORMATS.bmp;
  }
  if (head.length >= 6 && head[0] === 0 && head[1] === 0 && (head[2] === 1 || head[2] === 2) && head[3] === 0 && (head[4] | (head[5] << 8)) > 0) {
    return head[2] === 1 ? FORMATS.ico : FORMATS.cur;
  }
  // Formats in the family's scope that a later version reads.
  if (starts(head, 0, [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) return { unsupported: 'jp2' };
  if (starts(head, 0, [0xff, 0x4f, 0xff, 0x51])) return { unsupported: 'j2k' };
  if (starts(head, 0, [0xff, 0x0a]) || starts(head, 0, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) return { unsupported: 'jxl' };
  if (head.length >= 44 && starts(head, 0, [1, 0, 0, 0]) && s.slice(40, 44) === ' EMF') return { unsupported: 'emf' };
  if (starts(head, 0, [0xd7, 0xcd, 0xc6, 0x9a]) || ((head[0] === 1 || head[0] === 2) && starts(head, 1, [0, 9, 0, 0]) && (head[5] === 3 || head[5] === 1))) return { unsupported: 'wmf' };
  if (s.startsWith('8BPS')) return { unsupported: 'psd' };
  return undefined;
}

/** The MIME type the first bytes give, for an image inside an image: one of the formats above, or a few others an attacker might hide. */
export function sniffType(head: Uint8Array): string | undefined {
  const d = detect(head);
  if (d && 'kind' in d) return d.mimeType;
  const s = latin1(head);
  if (s.startsWith('%PDF-')) return 'application/pdf';
  if (s.startsWith('PK\x03\x04')) return 'application/zip';
  if (s.startsWith('MZ')) return 'application/x-msdownload';
  if (s.startsWith('\x7fELF')) return 'application/x-executable';
  if (/^\s*<svg[\s>]/i.test(s)) return 'image/svg+xml';
  if (/^\s*<(!doctype html|html|script)[\s>]/i.test(s)) return 'text/html';
  return undefined;
}
