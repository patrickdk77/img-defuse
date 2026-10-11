import { ImageCategory as C, ImageDetail as D, type ImageActionOverride, type ImageFinding, type ImageFindingAction } from './types';

interface Spec {
  action: ImageFindingAction;
  /**
   * May contain <key> placeholders filled from data, and <first|second> choices, which take the first alternative
   * whose {key} values are all set and not empty, or that names none. A filled value has control and format
   * characters replaced by "?", and one in a choice, such as a name from the file, is cut to 60 characters.
   */
  description: string;
  weight: number;
}

const specs = new Map<string, Spec>();
function def(c: C, d: D, action: ImageFindingAction, weight: number, description: string): void {
  specs.set(`${c}/${d}`, { action, weight, description });
}

// FORMAT. Every one stops the run.
def(C.Format, D.Unrecognized, 'reject', 0, 'The file is not an image format this package reads');
def(C.Format, D.Unsupported, 'reject', 0, '<The file is {format}, which|The file uses a format or variant that> this version does not read');
def(C.Format, D.Unreadable, 'reject', 0, 'The file could not be read');
// STRUCTURE. The first seven stop the run.
def(C.Structure, D.Truncated, 'reject', 0, 'The file ends before the image does<: {reason}|>');
def(C.Structure, D.BadHeader, 'reject', 0, 'A header holds a value the format does not allow<: {reason}|>');
def(C.Structure, D.BadChecksum, 'reject', 0, 'A checksum does not match<: {reason}|>');
def(C.Structure, D.BadLayout, 'reject', 0, 'The blocks of the file are out of order, missing or repeated<: {reason}|>');
def(C.Structure, D.BadData, 'reject', 0, 'Image data does not decode to what its header says<: {reason}|>');
def(C.Structure, D.Loop, 'reject', 0, 'The file refers back to a part it already holds, which can make a reader loop');
def(C.Structure, D.Overlap, 'reject', 0, 'Two parts of the file share bytes<: {reason}|>');
def(C.Structure, D.Ambiguous, 'reject', 0, 'Readers can draw or read this in different ways<: {reason}|>');
def(C.Structure, D.TrailingData, 'strip', 10, 'Data after the end of the image');
def(C.Structure, D.HiddenData, 'strip', 20, 'Data between the parts of the image that nothing uses');
def(C.Structure, D.ExtraBlock, 'strip', 10, 'A block that viewers do not use<: {block}|>');
// METADATA
def(C.Metadata, D.Exif, 'info', 0, 'EXIF metadata, such as the camera, settings and dates');
def(C.Metadata, D.Gps, 'info', 0, 'GPS location metadata');
def(C.Metadata, D.Xmp, 'info', 0, 'XMP metadata');
def(C.Metadata, D.IccProfile, 'info', 0, 'An embedded color profile');
def(C.Metadata, D.Iptc, 'info', 0, 'IPTC or Photoshop metadata');
def(C.Metadata, D.Comment, 'info', 0, 'A comment');
def(C.Metadata, D.Text, 'info', 0, 'Descriptive text<: {keyword}|>');
def(C.Metadata, D.Thumbnail, 'info', 0, 'A thumbnail image');
def(C.Metadata, D.SecondaryImage, 'info', 0, 'An extra image stored after the main one, such as a preview, depth map or gain map');
def(C.Metadata, D.Other, 'info', 0, 'Other metadata<: {kind}|>');
def(C.Metadata, D.Stripped, 'info', 0, 'Metadata removed because the caller turned on metadata stripping');
def(C.Metadata, D.Malformed, 'strip', 20, 'A metadata block does not parse<: {reason}|>');
def(C.Metadata, D.Doctype, 'strip', 40, 'XMP metadata declares a document type or entities, which an XML reader may resolve');
// EMBEDDED_IMAGE
def(C.EmbeddedImage, D.NoPlugin, 'strip', 10, 'An image inside the image <({sniffed})|(unknown type)> is removed. No plugin accepts it');
def(C.EmbeddedImage, D.TypeMismatch, 'info', 40, 'An image inside the image is declared <{declared}|as an image> but <its content looks like {sniffed}|its content is not recognized>');
// EXTERNAL
def(C.External, D.LinkedProfile, 'strip', 40, 'The image loads its color profile from <{target}|a file outside it>');
// POLYGLOT
def(C.Polyglot, D.Pdf, 'strip', 50, 'A PDF header sits where PDF readers look for one, so the file also opens as a PDF');
def(C.Polyglot, D.Zip, 'strip', 50, 'A ZIP directory sits where ZIP readers look for one, so the file also opens as an archive');
def(C.Polyglot, D.ImageData, 'reject', 60, 'Image data the viewer needs holds <a {kind}|another format> signature, so the file also opens as another format');
// CONTENT
def(C.Content, D.OldJpeg, 'info', 20, 'An image uses old-style JPEG compression in TIFF, a past source of reader exploits');
// LIMIT. Every one stops the run.
def(C.Limit, D.FileSize, 'reject', 0, 'The file exceeds the file size limit');
def(C.Limit, D.Pixels, 'reject', 0, 'An image exceeds the pixel limit');
def(C.Limit, D.DecodedSize, 'reject', 0, 'An image exceeds the decoded size limit');
def(C.Limit, D.TotalDecodedSize, 'reject', 0, 'The images together exceed the total decoded size limit');
def(C.Limit, D.Frames, 'reject', 0, 'The file exceeds the frame limit');
def(C.Limit, D.Blocks, 'reject', 0, 'The file exceeds the block limit');
def(C.Limit, D.Scans, 'reject', 0, 'The JPEG exceeds the scan limit');
def(C.Limit, D.MetadataSize, 'reject', 0, 'A compressed metadata block exceeds the metadata size limit');
def(C.Limit, D.Time, 'reject', 0, 'The file exceeds the time limit');

/** The built-in spec for a kind of finding, or undefined for a kind img-defuse does not make, such as one from another package. */
export function findingSpec(category: string, detail: string): Spec | undefined {
  return specs.get(`${category}/${detail}`);
}

/** The spec of a kind img-defuse makes itself, which always has one. */
function ownSpec(category: C, detail: D): Spec {
  const s = findingSpec(category, detail);
  if (!s) throw new Error(`No finding spec for ${category}/${detail}`);
  return s;
}

/** Every category and detail pair img-defuse makes, with its default action, description and score weight. */
export function allFindingSpecs(): Array<{ category: C; detail: D } & Spec> {
  return [...specs.entries()].map(([k, s]) => {
    const [category, detail] = k.split('/') as [C, D];
    return { category, detail, ...s };
  });
}

/** Values from the file can hold control or direction characters, so the description shows none of them. */
const shown = (v: string | number) => String(v).replace(/[\p{Cc}\p{Cf}]/gu, '?');

export class FindingFactory {
  constructor(private readonly overrides: ImageActionOverride[] = []) {}

  actionFor(category: C, detail: D): ImageFindingAction {
    const exact = this.overrides.find(o => o.category === category && o.detail === detail);
    if (exact) return exact.action;
    const byCategory = this.overrides.find(o => o.category === category && o.detail === undefined);
    if (byCategory) return byCategory.action;
    return ownSpec(category, detail).action;
  }

  make(category: C, detail: D, location?: string, data?: Record<string, string | number>): ImageFinding {
    const spec = ownSpec(category, detail);
    const description = spec.description.replace(/<([^<>]*)>/g, (m, body: string) => {
      if (/^[a-z]+$/.test(body)) return data?.[body] !== undefined ? shown(data[body]) : m;
      for (const alt of body.split('|')) {
        let missing = false;
        const filled = alt.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => {
          const v = data?.[key];
          if (v === undefined || v === '') missing = true;
          const s = shown(v ?? '');
          return s.length > 60 ? `${s.slice(0, 57)}...` : s;
        });
        if (!missing) return filled;
      }
      return '';
    });
    const f: ImageFinding = { category, detail, description, action: this.actionFor(category, detail) };
    if (location !== undefined) f.location = location;
    if (data !== undefined && Object.keys(data).length) f.data = data;
    return f;
  }
}
