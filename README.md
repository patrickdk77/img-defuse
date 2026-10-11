# img-defuse

img-defuse reads PNG, APNG, JPEG, GIF, WebP, TIFF, BMP, ICO and CUR images and reports what does not belong in a picture: structure that two readers could take in different ways, decompression and dimension bombs, data after the end of the image or hidden between its parts, signatures that make the file open as a PDF or a ZIP too, color profiles loaded from outside the file, and metadata. It scores the risk from 0 to 100.

This version inspects and changes nothing.

It has no runtime dependencies and keeps memory bounded. It checks every image's pixel count and decoded size against limits before it inflates or decodes anything.

```
npm install @patrickdk77/img-defuse
```

Node 22 or later.

## Quick start

```js
const { inspectImage } = require('@patrickdk77/img-defuse');

const report = await inspectImage(bytes);
report.status;   // 'clean', 'strippable' or 'rejected'
report.risk;     // 'NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL' or 'UNKNOWN'
report.score;    // 0 to 100, null when the file could not be inspected
report.format;   // 'png', 'jpg', 'gif', 'webp', 'tif', 'bmp', 'ico', 'cur', or '' when not recognized
report.mimeType; // the MIME type of that format, or ''
report.width;    // the first image's width, or the canvas width for GIF and WebP; 0 when not read
report.height;
report.images;   // frames, pages and SubIFDs, or icons; 0 when not read
report.findings; // [{ category, detail, description, action, location, data }]
```

ES modules work too: `import { inspectImage } from '@patrickdk77/img-defuse'`.

`strippable` means at least one finding has the action `strip`, content a defused copy would leave out, or that `stripMetadata` would remove metadata. `rejected` means a finding has the action `reject`, or the run stopped before it read the whole file.

### Files and S3

`inspectImageSource` reads through a source with `size()` and `read(offset, length)`, so a local file or an S3 object never has to sit in memory. `fileSource` and `bufferSource` are included. For S3, `read` can be a ranged GetObject.

```js
const { inspectImageSource, fileSource } = require('@patrickdk77/img-defuse');

await inspectImageSource(fileSource('upload.png'));

const source = {
  size: async () => contentLength,
  read: async (offset, length) => getObjectRange(bucket, key, offset, offset + length - 1),
};
await inspectImageSource(source);
```

`inspectImageSource` calls the source's `close()`, if it has one, when the run ends. A `read` must return exactly the bytes asked for, or fewer only at the end of the source. Any other length fails the run with an error whose `code` is `EIO`. An error the source throws comes back unchanged, instead of a verdict on the file.

## Formats

The format comes from the first bytes, never from a file name.

| Format | Signature |
|---|---|
| PNG and APNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |
| GIF | `GIF87a` or `GIF89a` |
| WebP | `RIFF`, a size, `WEBP` |
| TIFF and BigTIFF | `II*\0`, `MM\0*`, `II+\0` or `MM\0+` |
| BMP | `BM` with an info header size of 12, 40, 52, 56, 64, 108 or 124 |
| ICO and CUR | `00 00 01 00` or `00 00 02 00` with at least one image |

JPEG 2000, JPEG XL, EMF, WMF and PSD are recognized and rejected as FORMAT/UNSUPPORTED, with the format in `data.format`. Anything else, HEIC, AVIF and SVG included, is FORMAT/UNRECOGNIZED.

## What it checks

Wherever the sections below report bytes between structures or after the end, a run made only of zero bytes counts as padding and goes unreported.

### PNG

- `IHDR` first with values PNG defines, `IEND` last and empty, one unbroken run of `IDAT`, `PLTE` where the color type needs it and nowhere it forbids it. A critical chunk whose CRC does not match stops the run. An ancillary chunk whose CRC does not match is dropped as STRUCTURE/EXTRA_BLOCK, the way libpng and image-png skip it by default.
- An unknown chunk marked critical stops the run, since a decoder must refuse it. An unknown ancillary chunk, such as `iDOT`, `vpAg` or `prVt`, is STRUCTURE/EXTRA_BLOCK. So is a known one out of place or with the wrong length for its type. A second copy of a chunk PNG allows once, such as `gAMA`, is STRUCTURE/AMBIGUOUS.
- The image data must inflate to exactly the size `IHDR` gives, a filter byte and the packed samples for each row, pass by pass for Adam7. Inflation stops as soon as the output passes that size. Every row's filter byte must be 0 to 4. Compressed bytes after the end of the zlib stream are STRUCTURE/HIDDEN_DATA unless they are all zero.
- APNG frames have sequence numbers that count up from 0, lie inside the canvas, and match `acTL`'s frame count. Each frame's data inflates against the frame's own size. `fcTL` and `fdAT` without `acTL` are STRUCTURE/EXTRA_BLOCK, since viewers then show the still image only.

### JPEG

- The reader walks every segment from `SOI` to `EOI` and scans the entropy-coded data, which it does not decode. Fill bytes may come before a marker. Other bytes between segments are STRUCTURE/HIDDEN_DATA.
- One frame of a baseline, extended, progressive or lossless type, with Huffman or arithmetic coding. Hierarchical frames and JPEG-LS are FORMAT/UNSUPPORTED.
- Frame and scan headers in range, quantization and Huffman tables that split exactly, Huffman tables with no more codes than their lengths allow, quantization tables defined before a scan uses them, scans that select tables 0 to 3, progressive refinement scans that add a single bit, and restart markers 0 to 7 in order.
- The images an MPF index names after `EOI` are METADATA/SECONDARY_IMAGE. Other bytes after `EOI` are STRUCTURE/HIDDEN_DATA between those images and STRUCTURE/TRAILING_DATA after them, a Motion Photo's video included.

### GIF

- Blocks, sub-blocks and the trailer. A byte that starts no block stops the run.
- The LZW data of every frame is decoded, counting output without storing it. An invalid code, more pixels than the frame holds, or fewer, stops the run. Bytes after the end code are STRUCTURE/HIDDEN_DATA unless they are all zero.
- A frame outside the logical screen, an image with no color table, and a color index past the end of the table are STRUCTURE/AMBIGUOUS. Viewers draw each one differently.
- The `NETSCAPE2.0` and `ANIMEXTS1.0` loop extensions are part of the image and draw no finding. Plain text extensions and unknown extensions, ImageMagick's own included, are STRUCTURE/EXTRA_BLOCK.

### WebP

- The RIFF size and every chunk fit the file. A padding byte that is not 0 is STRUCTURE/HIDDEN_DATA. Bytes after the RIFF size are STRUCTURE/TRAILING_DATA.
- The `VP8 ` header. The `VP8L` bitstream is read the way libwebp reads it, building each prefix code to reject the incomplete or over-subscribed Huffman tables that overflowed libwebp's table construction in CVE-2023-4863; no pixels are produced. `VP8X` canvas size, the animation flag with `ANIM`, frames inside the canvas, image sizes that match their canvas or frame, and alpha that fits its image.
- An ICC, EXIF or XMP flag that disagrees with the chunks present is STRUCTURE/AMBIGUOUS. Unknown chunks, and any chunk after the image in a simple file, are STRUCTURE/EXTRA_BLOCK.

### TIFF

- Classic TIFF and BigTIFF in either byte order. The reader follows the IFD chain and every SubIFD, EXIF, GPS and interoperability pointer. An IFD reached twice is STRUCTURE/LOOP. An entry whose type is 0 is a null padding entry and is skipped, as libtiff skips it.
- Every byte range the file uses goes on one list: the header, each IFD, each value stored outside its entry, each strip and tile. Two ranges that share bytes stop the run with STRUCTURE/OVERLAP, unless they are the same range of the same kind, such as one value two IFDs share, or the regions of one old-style JPEG image, whose interchange format, tables and strips reference the same bytes. Gaps that are not all zero are STRUCTURE/HIDDEN_DATA.
- Each image's decoded size comes from its dimensions, samples and bits per sample. Strips and tiles lie in the file; their offset and byte-count arrays agree with each other and cover at least the grid the image needs. Strips are not decompressed. An uncompressed strip shorter than its rows stops the run.
- Compression 1, 2, 3, 4, 5, 6, 7, 8, 32773, 32946, 34925, 50000 and 50001 are read. Any other compression or photometric interpretation, such as a camera's raw CFA data, is FORMAT/UNSUPPORTED. Old-style JPEG, compression 6, is CONTENT/OLD_JPEG, `info`.
- Tags outside the image structure and the metadata tags, such as Photoshop's layer data in tag 37724, are STRUCTURE/EXTRA_BLOCK. A tag given twice in one IFD is STRUCTURE/AMBIGUOUS.

### BMP, ICO and CUR

- BMP headers of 12, 40, 52, 56, 108 or 124 bytes. Bit depth and compression pairs Windows and Windows CE define (1, 2, 4, 8, 16, 24 and 32 bits), bit field masks that are contiguous and do not overlap, and a palette no larger than the bit depth can index. A 12-byte OS/2 1.x header may hold a palette shorter than the bit depth allows, its length fixed by where the pixel data starts. The OS/2 2.x header and JPEG, PNG or CMYK compression are FORMAT/UNSUPPORTED.
- RLE4 and RLE8 data is walked command by command and must stay inside the image and end with an end-of-bitmap command.
- A V5 header's linked profile, a file path a reader would load, is EXTERNAL/LINKED_PROFILE, `strip`. An embedded profile is metadata.
- An icon's images may not overlap. A PNG image gets every PNG check. A DIB image needs room for its color bitmap and its AND mask. A directory size that disagrees with the image is STRUCTURE/AMBIGUOUS, except that a width or height of 256 or more cannot fit the one-byte field, so it may appear there as 0 or as its low byte.
- Bytes between the parts that are not all zero are STRUCTURE/HIDDEN_DATA, and bytes after the last part are STRUCTURE/TRAILING_DATA.

## Metadata

Metadata is `info`, as in pdf-defuse.

| Detail | Covers |
|---|---|
| EXIF | JPEG `APP1`, PNG `eXIf`, WebP `EXIF`, the TIFF EXIF IFD |
| GPS | A GPS IFD with entries |
| XMP | JPEG `APP1` and extended XMP, PNG `iTXt` `XML:com.adobe.xmp`, GIF `XMP DataXMP`, WebP `XMP `, TIFF tag 700 |
| ICC_PROFILE | PNG `iCCP`, JPEG `APP2`, GIF `ICCRGBG1012`, WebP `ICCP`, TIFF tag 34675, a BMP V5 embedded profile |
| IPTC | JPEG `APP13` Photoshop resources, GIF `MGK8BIM0000` and `MGKIPTC0000`, TIFF tags 33723 and 34377 |
| COMMENT | JPEG `COM`, GIF comment extensions |
| TEXT | PNG `tEXt`, `zTXt` and `iTXt`, TIFF name, description, make, model, software, date, artist, host and copyright tags |
| THUMBNAIL | EXIF, JFIF and JFXX thumbnails, Photoshop thumbnail resources |
| SECONDARY_IMAGE | An image an MPF index names after `EOI`, such as a preview, a depth map or an HDR gain map |
| OTHER | PNG `tIME` and `caBX`, JPEG `APP11` JUMBF, `APP12`, `FPXR` and the MPF index, GeoTIFF, GDAL and PrintIM tags |

ImageMagick's `Raw profile type` text chunks report as the kind they hold.

`stripMetadata: true` adds METADATA/STRIPPED, `info`, at every block a defused copy would leave out, and makes the status `strippable`. The ICC profile stays, because without it a viewer draws wide-gamut colors as sRGB. An override that makes one kind `strip` marks that kind for removal, the ICC profile included.

A metadata block that does not parse, such as EXIF that loops or points outside its block, an ICC profile whose size field is wrong, or a text chunk that does not inflate, is METADATA/MALFORMED, `strip`. XMP that contains `<!DOCTYPE` or `<!ENTITY` is METADATA/DOCTYPE, `strip`. Compressed metadata inflates up to `limits.metadataBytes`.

## Images inside images

An EXIF thumbnail, a JFXX JPEG thumbnail, a Photoshop thumbnail and an MPF secondary image are image files inside the image. A defused copy keeps one only when a file plugin accepts it, as pdf-defuse does with attached files. This version takes no plugins, so each one the copy would keep is EMBEDDED_IMAGE/NO_PLUGIN, `strip`. With `stripMetadata`, or an override that strips the thumbnail or the block that holds it, the thumbnail goes with its block and gets no NO_PLUGIN finding.

When the bytes are not the JPEG the container declares, EMBEDDED_IMAGE/TYPE_MISMATCH reports it, `info`. Thumbnails of raw pixels, such as a JFIF thumbnail, are not files and never count as one.

## Polyglots

A polyglot is a file that a second kind of reader also accepts. img-defuse looks where other readers look. PDF readers take `%PDF-` anywhere in the first 1024 bytes. ZIP readers find an end record in the last 65,557 bytes; img-defuse counts one only when its central directory offset leads to a central directory.

POLYGLOT/PDF and POLYGLOT/ZIP are `strip` when the signature lies in a block a defused copy leaves out, such as metadata, an extra block, or trailing or hidden data. POLYGLOT/IMAGE_DATA is `reject` when it lies in data the image needs.

## Findings

Every finding has a `category` and a `detail`, plain strings such as `STRUCTURE` and `TRAILING_DATA`, and a `description` that is safe to show the uploader. A description that quotes a value from the file cuts it to 60 characters and shows control and format characters as `?`. `data` keeps the values, and `location` names the chunk, segment, block or IFD with its byte offset.

```js
{ category: 'STRUCTURE', detail: 'TRAILING_DATA', description: 'Data after the end of the image', action: 'strip', location: 'offset 4096', data: { offset: 4096, bytes: 41 } }
```

Past 200 findings of one kind, one more finding with the location `additional occurrences` counts the rest in `data.count`.

`action` is `reject`, `strip` or `info`. Each rule decides its own action, and `info` only reports. The enums are exported as `ImageCategory` and `ImageDetail`, and `allFindingSpecs()` lists every pair with its default action, description and weight. `actionOverrides` changes the action by category, or by category and detail:

```js
await inspectImage(bytes, { actionOverrides: [{ category: 'STRUCTURE', detail: 'TRAILING_DATA', action: 'reject' }] });
```

A run that stops rejects the file with a null score and the UNKNOWN level, whatever `actionOverrides` say about the finding that stopped it. A format this package does not read, a structure refusal, a limit and an unexpected error, FORMAT/UNREADABLE, all stop a run. The findings made before the stop stay in the report.

## Scoring

The method is pdf-defuse's. Each kind of finding has a weight: another format's signature in image data is 60, a PDF or ZIP signature in a block the copy drops is 50, a linked profile is 40, hidden data is 20, trailing data is 10, metadata is 0. The highest weight counts in full, every other kind adds a quarter of its weight, and repeats of one kind count once. Another format's signature together with trailing data, hidden data or an extra block adds 20. The total is capped at 100.

The bands are NONE at 0, LOW from 1, MEDIUM from 25, HIGH from 50 and CRITICAL from 80. `scoreWeights` and `scoreBands` change them. A finding of a kind img-defuse does not make, such as one from another package, scores at its `weight`, or 0 without one.

## Options

| Option | Default | Purpose |
|---|---|---|
| `limits.fileSize` | none | Bytes in the upload, checked before any read |
| `limits.pixels` | 268,435,456 | Pixels in one image, frame, logical screen or canvas, 16,384 x 16,384 |
| `limits.decodedBytes` | 1 GiB | Bytes one image or frame decodes to, from its header |
| `limits.totalDecodedBytes` | 2 GiB | Bytes all images and frames decode to together |
| `limits.frames` | 10,000 | Images in one file: frames, pages and SubIFDs, or icons |
| `limits.blocks` | 1,000,000 | PNG chunks, JPEG segments, GIF blocks, WebP chunks, TIFF and EXIF IFDs and entries, strips and tiles, and ICO images |
| `limits.scans` | 1,000 | `SOS` markers in one JPEG. A progressive JPEG with many scans makes a decoder redo the image for each one |
| `limits.metadataBytes` | 8 MiB | Bytes one compressed metadata block inflates to |
| `limits.timeMs` | none | The whole run |
| `stripMetadata` | `false` | Report the metadata blocks a defused copy would remove, as described under Metadata |
| `actionOverrides` | none | Change the action for a category, or for a category and detail |
| `scoreWeights`, `scoreBands` | built in | Change the scoring |

The seven limits with a default bound the memory or work any input can cost, so they apply unless you set them. `Infinity` turns one off. A limit that is reached stops the run with a LIMIT finding.

## The defuse family

img-defuse is one of a family of packages that each handle one kind of file, beside [pdf-defuse](https://github.com/patrickdk77/pdf-defuse) and office-defuse. It declares the family's shared types with the same shapes as pdf-defuse: `DefuseFinding`, `ByteSource`, `ByteSink`, `PluginContext`, `ContainedFile`, `ContainedFileResult` and `ContainedFilePlugin`. It does not depend on pdf-defuse, and TypeScript matches the types by shape.

A finding's `category` and `detail` are plain strings, and `weight`, when set, says how much it adds to a score. The time limit's error carries `code: 'DEFUSE_LIMIT'` and `limit: 'time'`, the code every package of the family passes up the tree of files. `inspectImage` turns it into LIMIT/TIME.

## What it does not check

- The pixels. VP8 data, JPEG entropy-coded data and compressed TIFF strips are not decoded. VP8L data is read for its structure, the transforms and prefix codes, but never expanded to pixels. So a bug a decoder's pixel stage hits on ordinary-looking data goes unseen.
- The content of XMP beyond the document type check, maker notes, and Photoshop resources beyond IPTC and thumbnails.
- Text in metadata that a server could run if it included the image as code, such as a PHP tag in a comment. `stripMetadata` reports the blocks that carry it.
- JPEG 2000, JPEG XL, EMF, WMF and PSD.

## Development

Development needs Node 22.12 or later. mocha 12 requires it, and the CommonJS test build loads chai 6, an ES module, with `require()`, which Node 22 supports only from 22.12. The pre-commit hook needs Node 22.22.1 or later for lint-staged. The published package has no runtime dependencies and runs on any Node 22.

```sh
npm install --ignore-scripts
npm run build
npm test
npm run lint
npm run format
```

`npm run build` compiles `src` into `dist`. `npm test` runs the lint, builds the package and the tests, then runs mocha, so a lint error fails the tests. `npm run lint` runs `biome check` over the whole tree and changes nothing. `npm run format` rewrites files in Biome's format.

`npx husky` activates the pre-commit hook. A plain `npm install` does the same through the `prepare` script. The hook runs Biome on the staged files, applying its safe fixes, then runs `npm audit`. The commit stops if either one fails.

The fixtures under `test/fixtures` are committed. `python3 -I scripts/make-fixtures.py` rebuilds them, and needs Pillow, ImageMagick's `convert`, `cjpeg`, `gifsicle`, `cwebp`, `img2webp`, `gif2webp`, `webpmux` and `exiftool`. The hostile files are built byte by byte.

## License

MIT
