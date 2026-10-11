# img-defuse

img-defuse reads PNG, APNG, JPEG, GIF, WebP, TIFF, BMP, ICO, CUR, JPEG 2000, JPEG XL, Photoshop PSD and PSB, EMF and WMF images, reports what does not belong in a picture, and writes a defused copy without it. It looks for structure that two readers could take in different ways, decompression and dimension bombs, data after the end of the image or hidden between its parts, signatures that make the file open as a PDF or a ZIP too, files and color profiles loaded from outside the file, metafile records that talk to the printer driver, and metadata. It scores the risk from 0 to 100.

The copy is a rewrite of chunks, segments, blocks, IFD entries, boxes, resources and records. Compressed pixel data goes into it byte for byte. img-defuse never decodes pixels and never encodes them again.

It has no runtime dependencies and keeps memory bounded. It checks every image's pixel count and decoded size against limits before it inflates or decodes anything.

```
npm install @patrickdk77/img-defuse
```

Node 18 or later.

## Quick start

```js
const { inspectImage, disarmImage } = require('@patrickdk77/img-defuse');

const report = await inspectImage(bytes);
report.status;   // 'clean', 'strippable' or 'rejected'
report.risk;     // 'NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL' or 'UNKNOWN'
report.score;    // 0 to 100, null when the file could not be inspected
report.format;   // 'png', 'jpg', 'gif', 'webp', 'tif', 'bmp', 'ico', 'cur', 'jp2', 'j2c', 'jxl', 'psd', 'psb', 'emf', 'wmf', or ''
report.mimeType; // the MIME type of that format, or ''
report.width;    // the first image's width, the canvas width for GIF and WebP, a metafile's size in pixels; 0 when not read
report.height;
report.images;   // frames, pages and SubIFDs, or icons; 0 when not read
report.findings; // [{ category, detail, description, action, location, data, attachment, weight }]

const result = await disarmImage(bytes);
if (result.status !== 'rejected') save(result.bytes);
```

ES modules work too: `import { disarmImage } from '@patrickdk77/img-defuse'`.

`strippable` means at least one finding has the action `strip`, content the defused copy leaves out, that `stripMetadata` removes metadata, or that a plugin rewrote an image inside the image. `rejected` means a finding has the action `reject`, or the run stopped before it read the whole file.

`disarmImage` returns the shape pdf-defuse's `disarmPdf` returns. `status` is `clean` when the copy removed nothing a finding names, `defused` when it did, and `rejected` when there is no copy. `before` is the inspection of the upload, `after` the inspection of the copy, and `removed` lists the findings whose content the copy left out. `bytes` holds the copy unless the file was rejected.

### Files and S3

`inspectImageSource` and `disarmImageSource` read through a source with `size()` and `read(offset, length)`, so a local file or an S3 object never has to sit in memory. `fileSource` and `bufferSource` are included. For S3, `read` can be a ranged GetObject.

```js
const { disarmImageSource, fileSink, fileSource } = require('@patrickdk77/img-defuse');

await disarmImageSource(fileSource('upload.png'), fileSink('clean.png'));

const source = {
  size: async () => contentLength,
  read: async (offset, length) => getObjectRange(bucket, key, offset, offset + length - 1),
};
await disarmImageSource(source, fileSink('clean.png'));
```

`disarmImageSource` writes to a sink with `write(chunk)` and `close()`. `fileSink`, `bufferSink` and `writableSink`, which wraps any Node Writable, are included. It writes nothing until the copy has passed its own inspection. When writing to the sink fails, it calls the sink's `abort(error)`, if it has one, instead of `close()`, and `fileSink` then deletes its partial file. A rejected file never reaches the sink.

Both functions call the source's `close()`, if it has one, when the run ends. A `read` must return exactly the bytes asked for, or fewer only at the end of the source. Any other length fails the run with an error whose `code` is `EIO`. An error the source throws comes back unchanged, instead of a verdict on the file. `disarmImageSource` copies the upload once before it starts, to memory up to `memoryThreshold` and to a temporary file past it, so a source that changes during the run cannot make the copy differ from what was inspected.

## The defused copy

The copy holds the blocks the rewrite keeps, written end to end. Trailing data, bytes between structures, zero padding and JPEG fill bytes never reach it, whatever their findings' actions. A block goes when a finding about it has the action `strip`, or when another format's signature sits in it and its POLYGLOT finding is `strip`. With `stripMetadata`, metadata goes too, except the ICC profile and the orientation. Everything else stays, including a block whose finding an override made `info`. A clean file is rewritten as well, so the copy holds only what img-defuse read.

- PNG gets the signature and the chunks it keeps, in their order. img-defuse cuts IDAT and fdAT data at the end of its zlib stream and gives a chunk that changed a new CRC. When an fdAT chunk goes because it held nothing but bytes after its stream, the fcTL and fdAT chunks after it get new sequence numbers. An ancillary chunk with a bad CRC that an override keeps also keeps its bad CRC, so readers still skip it.
- JPEG gets SOI, the segments it keeps, each scan's entropy-coded data unchanged, and EOI. The pieces of an ICC profile go or stay together, and so do the pieces of extended XMP. A JFIF thumbnail that goes leaves the JFIF header with a thumbnail of 0 x 0. The secondary images the copy keeps follow EOI, and img-defuse writes the MPF index again with their sizes and offsets, the primary image's size, the image count, the unique ID list and the dependent image numbers.
- GIF gets the header, the screen descriptor and color tables, the extensions it keeps, each image's LZW data cut after its end code, and the trailer. A graphic control extension goes with the plain text extension it applies to. Otherwise it would apply to the next image.
- WebP gets a new RIFF header, a VP8X whose ICC, EXIF and XMP flags match the chunks kept and whose reserved bits are zero, and the chunks it keeps with zero padding bytes. An ANMF frame keeps the chunks inside it that stay.
- TIFF loses the entries, EXIF and GPS IFDs and values that go, and every byte that no kept IFD, value, strip, tile or old-style JPEG range covers. img-defuse writes every offset again for where its target lands: the header's, each IFD's next pointer, value offsets, strips and tiles, SubIFDs, the EXIF, GPS and interoperability pointers, and old-style JPEG tables. It cuts an uncompressed strip to its rows and writes the strip's byte count again. A removal of odd length leaves one zero byte behind, so every offset keeps the word alignment TIFF asks for.
- BMP gets a new file header, the info header, masks, palette and pixel data, and an embedded color profile after the pixels. A profile that goes, a linked one included, leaves the info header saying sRGB.
- ICO and CUR get a new directory with each image's size and offset, and the images in directory order. A PNG image is rewritten as a PNG, and a DIB image loses the bytes after its AND mask. When STRUCTURE/AMBIGUOUS is `strip`, the directory takes each image's own width and height.
- JP2 keeps the boxes it reads in their order. A box that changes gets a new length. The JP2 header box loses the boxes that go, and a colour specification whose profile goes becomes enumerated sRGB, or greyscale for a one-channel image. The codestream loses its comments and unknown marker segments, and img-defuse writes the Psot of each tile-part that lost one again, and its TLM entry. A bare codestream gets the same edits.
- A JPEG XL container keeps the boxes it reads, with EXIF written again when its thumbnail or GPS IFD goes, and a gain map a plugin rewrote. A bare codestream is copied as it is.
- PSD and PSB keep every section. Image resources, tagged blocks and linked files that go leave their section, and img-defuse writes every length that measured them again: the section's, the layer and mask section's, a layer's extra data, a tagged block's, and a linked file's item and data lengths with the item's padding to four bytes. Bytes hidden inside the layer and mask section become zeros, so no length changes. Layer and composite pixel data is copied as it is.
- EMF loses the records that go, and img-defuse writes the header's byte and record counts again. A comment that holds EMF+ records is written again without the ones that go. An EMF+ image a plugin rewrote goes in one EmfPlusObject record, or in continued records of 65,004 bytes each once it is larger, as GDI+ splits one. A color space that names a profile file stays, as sRGB, with the name blanked. With `stripMetadata` the description is blanked.
- WMF loses the records that go, and img-defuse writes the header's size and largest record again, and the placeable header's checksum. A META_EOF longer than 3 words is written as 3.
- An EXIF block in a JPEG, PNG, WebP, JP2 or JPEG XL file stays as it is unless its thumbnail or its GPS IFD changes. It then loses the thumbnail IFD and the thumbnail, or the GPS IFD and the entry that points at it, or takes a plugin's copy of the thumbnail with its new length, and img-defuse writes its offsets again. Gaps inside the block stay. img-defuse does not rewrite the offsets a maker note holds.

img-defuse inspects the copy before any of it reaches the sink. The copy must read through, keep the format, size and image count, and hold no finding whose action is `strip` or `reject`. img-defuse writes no copy that fails, and rejects the file with PROCESSING/VERIFICATION_FAILED, whose `data.reasons` names what was left. That happens when an override makes a finding `strip` that no container rewrite can remove, such as STRUCTURE/AMBIGUOUS for a GIF frame outside its screen.

Removing a block moves the bytes after it. That can bring another format's signature into the first 1024 bytes or the last 65,557, where PDF and ZIP readers look. When the copy holds nothing else that fails, img-defuse rewrites the copy again, up to three passes, and adds what the later passes removed to `removed`.

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
| JPEG 2000 (JP2) | the 12-byte signature box `00 00 00 0C 6A 50 20 20 0D 0A 87 0A` |
| JPEG 2000 codestream (J2C) | `FF 4F FF 51` |
| JPEG XL | `FF 0A`, or the signature box `00 00 00 0C 4A 58 4C 20 0D 0A 87 0A` |
| PSD and PSB | `8BPS`, then version 1 for PSD and 2 for PSB |
| EMF | record type 1 with ` EMF` at offset 40 |
| WMF | the placeable header `D7 CD C6 9A`, or a header of type 1 or 2, 9 words and version 0x0100 or 0x0300 |

Anything else, HEIC, AVIF and SVG included, is FORMAT/UNRECOGNIZED. JPX, JPM and Motion JPEG 2000 files that do not list JP2 as compatible are FORMAT/UNSUPPORTED, with the format in `data.format`.

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

### JPEG 2000

- A JP2 file starts with the signature box and the file type box. Its brand, or one of its compatible brands, must be JP2. Every box must fit what holds it. The JP2 header box comes before the codestream, once, and holds the image header first, at least one colour specification, and a palette only with a component mapping. The image header gives a size, 1 to 16,384 components, depths up to 38 bits and compression type 7.
- The JP2 header must agree with the codestream on the size, the components and their depths. When it does not, that is STRUCTURE/AMBIGUOUS, since a reader that trusts the header sees another image than one that trusts the codestream. A component mapping or channel definition that names a component or palette column that is not there stops the run.
- The codestream is read as far as its tile-part headers. SIZ comes after SOC, and the main header holds COD and QCD once. Marker segments have the lengths and values the standard allows, within OpenJPEG's limits, such as 32 decomposition levels and 65,535 tiles. Part 2 markers need a SIZ that declares Part 2. Tile-parts come in order, each within its Psot, and EOC closes the codestream. A TLM that disagrees with the tile-parts is STRUCTURE/AMBIGUOUS. JPSEC is FORMAT/UNSUPPORTED.
- A comment marker segment is METADATA/COMMENT, and an unknown marker segment is STRUCTURE/EXTRA_BLOCK. Bytes after EOC are STRUCTURE/HIDDEN_DATA inside a JP2 and STRUCTURE/TRAILING_DATA after a bare codestream.
- A data reference box names files a JPX reader loads, so it is EXTERNAL/LINKED_FILE, `strip`, with the first URL in `data.target`. A second codestream, the boxes only JPX uses, a uuid box of an unknown UUID and any other box are STRUCTURE/EXTRA_BLOCK.

### JPEG XL

- A bare codestream, or a container: the signature box, a file type box that names JPEG XL, an optional level box of 5 or 10 before the codestream, and the codestream in one `jxlc` box or in `jxlp` boxes numbered in order, the last one flagged. A file with both, or with neither, stops the run.
- The image header is read as far as the count of extra channels. That gives the size, the bit depth and the channels, and the reader checks the limits against them. A depth past 31 bits for integers or 32 for floating point stops the run.
- `Exif`, `xml ` and `jumb` boxes are metadata. A `brob` box is decompressed with Node's Brotli, up to `limits.metadataBytes`, and reports as the kind of box it holds. A thumbnail in compressed EXIF is EMBEDDED_IMAGE/NO_PLUGIN with a reason, since a plugin's copy cannot be compressed back in, so the box goes. A `jbrd` box only rebuilds the JPEG the image came from and is STRUCTURE/EXTRA_BLOCK, and so is any unknown box. A `jhgm` gain map is METADATA/SECONDARY_IMAGE, and its codestream goes to the file plugins.
- Bytes after the boxes that are not a box are STRUCTURE/TRAILING_DATA.

### PSD and PSB

- The header holds version 1 for PSD or 2 for PSB, zero reserved bytes, 1 to 56 channels, a size from 1 to 30,000, or 300,000 for PSB, a depth of 1, 8, 16 or 32 bits and a color mode Photoshop defines. Bitmap mode goes with 1 bit and indexed mode with 8. An indexed image needs 768 bytes of color data. Color data in a mode that has none is STRUCTURE/EXTRA_BLOCK.
- The composite image is the file's one image. It is raw, RLE with a table of row lengths, 16-bit in PSD and 32-bit in PSB, or ZIP, which is inflated up to the size the header gives and must come out at exactly that size. Bytes after it are STRUCTURE/TRAILING_DATA.
- Image resources are reported one by one. IPTC, EXIF, XMP, the ICC profile, the caption, slices, the URL list, the URL and the workflow URL are metadata. EXIF is checked like any EXIF block and edited in place, so its thumbnail goes to the file plugins and GPS or a thumbnail can go without the rest. A thumbnail resource goes to the file plugins. Resources that hold image state, such as the resolution, alpha channel names, guides and paths, draw no finding. Resources that do not parse are METADATA/MALFORMED, and the copy holds no resources then.
- Each layer record is walked: a rectangle whose bottom is not less than its top and whose right is not less than its left, channel lengths that fit the layer info, a blend mode signature, and extra data that fits. Every layer and mask is checked against the pixel and decoded size limits, and its decoded bytes count toward the total, but a layer is not counted among the file's images. Each channel's compression code is 0 to 3. No layer pixel is decoded. 16-bit and 32-bit layers in `Lr16` and `Lr32` blocks get the same checks.
- Tagged blocks of keys Photoshop and psd-tools know are kept. `Anno` annotations are METADATA/COMMENT. A block of any other key is STRUCTURE/EXTRA_BLOCK. In PSB the keys the specification lists have 8-byte lengths. Bytes after the last block, or inside the layer info after the last channel, that are not all zero are STRUCTURE/HIDDEN_DATA.
- Linked layers (`lnk2`, `lnkD`, `lnk3`, `lnkE`) hold smart object files. img-defuse reads each item as far as its data, skipping the descriptors on the way. A file embedded in the document goes to the file plugins, declared as the type its file type names when that is PNG, JPEG, TIFF, GIF, PSD or PDF. A link to a file outside, or an alias, is EXTERNAL/LINKED_FILE, `strip`, with the file's name in `data.target`. An item that does not parse, such as one whose descriptor holds a type img-defuse does not know, makes its whole block METADATA/MALFORMED.

### EMF and WMF

- An EMF starts with EMR_HEADER, whose description and pixel format descriptor lie inside it, and ends with EMR_EOF, whose palette lies inside it. Every record is at least 8 bytes, a multiple of 4, and inside the file. A second header stops the run. Bytes after EMR_EOF are STRUCTURE/TRAILING_DATA. The picture's size comes from the header's frame at the reference device's resolution.
- A WMF has an optional placeable header, then a header of type 1 or 2, 9 words and version 0x0100 or 0x0300, then records of at least 3 words, up to META_EOF. Bytes in META_EOF after its 3 words are STRUCTURE/HIDDEN_DATA. The picture's size comes from the placeable header's bounding box at 96 pixels an inch, or else from the first window extent.
- A header count that falls short is STRUCTURE/HEADER_COUNT, `strip`, and the copy holds the right count. That is an EMF byte count that ends before EMR_EOF, a record count that leaves out more than EMR_EOF, a WMF size that ends before META_EOF, and a WMF object count smaller than the objects the records hold at once. A reader that trusts such a count stops early or makes too few objects. A count that only overstates the file, a wrong largest record size, and a wrong placeable checksum draw no finding, and the copy holds the right values too.
- Records of a type the specifications do not define are STRUCTURE/EXTRA_BLOCK. The drawing records are not interpreted.
- The bitmaps inside records, in EMR_STRETCHDIBITS and the other blits, the pattern brushes and the WMF bitmap records, are checked like a BMP's: an info header readers accept, a color table that fits, bits that hold every row, and RLE data that stays inside the image. Each is checked against the pixel and decoded size limits without counting as an image. A bitmap compressed as JPEG or PNG is a file, and goes to the file plugins.
- Escapes pass data straight to the printer driver. EMR_DRAWESCAPE, EMR_EXTESCAPE, EMR_NAMEDESCAPE and every META_ESCAPE are CONTENT/ESCAPE, `strip`. META_ESCAPE with SETABORTPROC, the escape behind the 2005 WMF code execution flaw, is CONTENT/ABORT_PROC, `strip`.
- A color space or ICM profile record that names a profile file to load is EXTERNAL/LINKED_PROFILE, `strip`.
- EMF comments are read by their identifier. EMF+ records are walked for their structure, and an EMF+ image object that holds a compressed bitmap or a metafile goes to the file plugins whole, even when it spans several records. An unknown EMF+ record is STRUCTURE/EXTRA_BLOCK. Fewer than 12 bytes after the last EMF+ record of a comment, where no record fits, are left as they are, since GDI+ leaves 4 there. Public comments may hold a metafile, or other formats of the picture such as a PDF, which go to the file plugins, and the comment goes when one of them does. A plugin's rewritten copy cannot go back into such a comment, so the comment goes then too. An EMFSPOOL comment is STRUCTURE/EXTRA_BLOCK. Its spool records go to a printer's spooler, never to a viewer, and can carry fonts, metafiles and PostScript. Any other private comment is STRUCTURE/EXTRA_BLOCK too.

## Metadata

Metadata is `info`, as in pdf-defuse.

| Detail | Covers |
|---|---|
| EXIF | JPEG `APP1`, PNG `eXIf`, WebP `EXIF`, the TIFF EXIF IFD, a JP2 EXIF uuid box, a JPEG XL `Exif` box, PSD resources 0x0422 and 0x0423 |
| GPS | A GPS IFD with entries |
| XMP | JPEG `APP1` and extended XMP, PNG `iTXt` `XML:com.adobe.xmp`, GIF `XMP DataXMP`, WebP `XMP `, TIFF tag 700, a JP2 XMP uuid box, a JPEG XL `xml ` box, PSD resource 0x0424 |
| ICC_PROFILE | PNG `iCCP`, JPEG `APP2`, GIF `ICCRGBG1012`, WebP `ICCP`, TIFF tag 34675, a BMP V5 embedded profile, a JP2 colour specification with a profile, PSD resource 0x040F |
| IPTC | JPEG `APP13` Photoshop resources, GIF `MGK8BIM0000` and `MGKIPTC0000`, TIFF tags 33723 and 34377, JP2 IPTC and Photoshop uuid boxes, PSD resource 0x0404 |
| COMMENT | JPEG `COM`, GIF comment extensions, JPEG 2000 `COM` marker segments, PSD `Anno` annotations |
| TEXT | PNG `tEXt`, `zTXt` and `iTXt`, TIFF name, description, make, model, software, date, artist, host and copyright tags, the PSD caption, the EMF description |
| THUMBNAIL | EXIF, JFIF and JFXX thumbnails, Photoshop thumbnail resources |
| SECONDARY_IMAGE | An image an MPF index names after `EOI`, such as a preview, a depth map or an HDR gain map, and a JPEG XL gain map |
| OTHER | PNG `tIME` and `caBX`, JPEG `APP11` JUMBF, `APP12`, `FPXR` and the MPF index, GeoTIFF, GDAL and PrintIM tags, JP2 `xml `, `jp2i`, `asoc` and `jumb` boxes and GeoJP2, JPEG XL `jumb` boxes, PSD slices, URL list, URL and workflow URL |

ImageMagick's `Raw profile type` text chunks report as the kind they hold.

`stripMetadata: true` removes metadata from the copy. It adds METADATA/STRIPPED, `info`, at every block the copy leaves out, and makes the status `strippable`. The ICC profile stays, because without it a viewer draws wide-gamut colors as sRGB. The orientation stays too, since without it a phone photo can show sideways. When an EXIF block with an orientation from 2 to 8 goes, the copy gets a new EXIF block in its place that holds only the orientation. An EXIF block that already holds only that gets no STRIPPED finding. A TIFF keeps its orientation tag, which is image structure. An override that makes one kind `strip` removes that kind, the ICC profile included, and an EXIF block removed that way gets no orientation block.

A metadata block that does not parse, such as EXIF that loops or points outside its block, an ICC profile whose size field is wrong, a text chunk that does not inflate, or an MPF index with an IFD that does not read, is METADATA/MALFORMED, `strip`. XMP, and XML in JP2 boxes, that contains `<!DOCTYPE` or `<!ENTITY` is METADATA/DOCTYPE, `strip`. Compressed metadata inflates up to `limits.metadataBytes`.

## Images inside images

An EXIF thumbnail, a JFXX JPEG thumbnail, a Photoshop thumbnail, an MPF secondary image and a JPEG XL gain map are image files inside the image. So are a file embedded in a Photoshop linked layer, an EMF+ image object, a bitmap in a metafile record compressed as JPEG or PNG, and a metafile, a PDF or another picture in an EMF public comment. The ones the copy would keep go to the file plugins in `filePlugins`, the way pdf-defuse hands its attached files to them. The first plugin that accepts an image handles it. With `stripMetadata`, or an override that strips the thumbnail or the block that holds it, the image goes with its block and no plugin sees it.

```js
const { disarmImage, imagePlugin } = require('@patrickdk77/img-defuse');

await disarmImage(bytes, { filePlugins: [imagePlugin()] });
```

`imagePlugin()` runs each image through img-defuse again, as pdf-defuse's `pdfPlugin` does with attached PDFs. Its findings go into the outer report with `attachment` set to the image's kind, such as `EXIF thumbnail` or `secondary image`, and `location` starting with where it sits. A `reject` inside the image becomes `strip`, because the image goes and the file stays.

The bytes a plugin writes replace the image, and img-defuse writes the block that holds it again to match. That rewrites the EXIF thumbnail's length, the JFXX segment, the Photoshop resource's size and its header's compressed size, the MPF entry, the gain map box, the linked file's item, or the EMF+ object records. A plugin that passes an image without writing keeps the image as it is. A metafile bitmap record and an EMF public comment cannot take a rewritten copy. An image there that a plugin passes stays as it is, and one a plugin scrubs goes with its record.

| Detail | Action | Weight | What it means |
|---|---|---|---|
| EMBEDDED_IMAGE/PLUGIN_PASSED | info | 6 | A plugin kept the image with nothing removed |
| EMBEDDED_IMAGE/PLUGIN_SCRUBBED | info | 3 | A plugin cleaned the image and kept it |
| EMBEDDED_IMAGE/PLUGIN_REMOVED | strip | 0 | A plugin removed the image |
| EMBEDDED_IMAGE/PLUGIN_FAILED | strip | 0 | A plugin threw, scrubbed and wrote nothing, or wrote a copy the block holding the image cannot take |
| EMBEDDED_IMAGE/NO_PLUGIN | strip | 10 | No plugin accepts the image |

The upload's score leaves out PLUGIN_PASSED and PLUGIN_SCRUBBED, and the copy's score counts them, as in pdf-defuse. The check of the copy matches an image a plugin kept by its SHA-256 and does not show it to the plugins again.

When the bytes are not the type the container declares, EMBEDDED_IMAGE/TYPE_MISMATCH reports it, `info`. An override that makes it `strip` removes the image before any plugin sees it. Thumbnails of raw pixels, such as a JFIF thumbnail, are not files and never go to a plugin.

A plugin of your own has pdf-defuse's shape. `process` gets the image, a sink for the bytes to keep and a context with `depth` and `deadline`, and returns `'scrubbed'`, `'passed'`, `'removed'`, or `{ result, findings, outputFindings }`.

```js
const keepSmall = {
  kind: 'file',
  name: 'keep-small',
  accepts: (file) => file.sniffedType === 'image/jpeg',
  process: async (file) => (file.size < 65536 ? 'passed' : 'removed'),
};
```

Each image arrives with no `name`, `declaredType` set to the type its container gives, such as `image/jpeg` for a thumbnail, or none for an EMF+ bitmap, `sniffedType` from its first bytes, its `size`, a `location` such as `APP1 segment at 2`, and `depth` one more than the file that holds it. An error a plugin throws with `code: 'DEFUSE_LIMIT'` or `'DEFUSE_IO'` stops the whole run, as described under The defuse family. Any other error is PLUGIN_FAILED.

## Polyglots

A polyglot is a file that a second kind of reader also accepts. img-defuse looks where other readers look. PDF readers take `%PDF-` anywhere in the first 1024 bytes. ZIP readers find an end record in the last 65,557 bytes; img-defuse counts one only when its central directory offset leads to a central directory.

POLYGLOT/PDF and POLYGLOT/ZIP are `strip` when the signature lies in a block the copy can leave out, such as metadata, an extra block, or trailing or hidden data. While the finding is `strip`, the copy drops the block that holds the signature, whatever the metadata rule says about that block. POLYGLOT/IMAGE_DATA is `reject` when the signature lies in data the image needs.

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

PROCESSING/VERIFICATION_FAILED, `reject`, marks a copy that failed its own inspection, and LIMIT/NESTING_DEPTH an image deeper in the upload than `limits.nestingDepth` allows. Images inside images describes the PLUGIN details. These findings describe what a file asks a reader or a printer to do:

| Detail | Action | Weight | What it means |
|---|---|---|---|
| EXTERNAL/LINKED_PROFILE | strip | 40 | A BMP V5 header or an EMF record loads its color profile from a file outside the image |
| EXTERNAL/LINKED_FILE | strip | 40 | A JP2 data reference box, or a Photoshop linked layer that links to a file outside or is an alias of one |
| CONTENT/OLD_JPEG | info | 20 | A TIFF image with old-style JPEG compression, a past source of reader exploits |
| CONTENT/ESCAPE | strip | 20 | An EMF or WMF escape record, which passes data straight to the printer driver |
| CONTENT/ABORT_PROC | strip | 70 | A WMF escape that sets an abort procedure, the escape behind the 2005 WMF code execution flaw |

A run that stops rejects the file with a null score and the UNKNOWN level, whatever `actionOverrides` say about the finding that stopped it. A format this package does not read, a structure refusal, a limit and an unexpected error, FORMAT/UNREADABLE, all stop a run. The findings made before the stop stay in the report.

## Scoring

The method is pdf-defuse's. Each kind of finding has a weight: a WMF abort procedure is 70, another format's signature in image data is 60, a PDF or ZIP signature in a block the copy drops is 50, a file or profile loaded from outside the image is 40, hidden data and a printer escape are 20, trailing data is 10, metadata is 0. The highest weight counts in full, every other kind adds a quarter of its weight, and repeats of one kind count once. Another format's signature together with trailing data, hidden data or an extra block adds 20. The total is capped at 100.

The bands are NONE at 0, LOW from 1, MEDIUM from 25, HIGH from 50 and CRITICAL from 80. `scoreWeights` and `scoreBands` change them. A finding of a kind img-defuse does not make, such as one from another package, scores at its `weight`, or 0 without one.

## Options

| Option | Default | Purpose |
|---|---|---|
| `limits.fileSize` | none | Bytes in the upload, checked before any read |
| `limits.pixels` | 268,435,456 | Pixels in one image, frame, logical screen or canvas, PSD layer or metafile bitmap, 16,384 x 16,384 |
| `limits.decodedBytes` | 1 GiB | Bytes one image, frame, PSD layer or metafile bitmap decodes to, from its header |
| `limits.totalDecodedBytes` | 2 GiB | Bytes all of those decode to together |
| `limits.frames` | 10,000 | Images in one file: frames, pages and SubIFDs, or icons |
| `limits.blocks` | 1,000,000 | PNG chunks, JPEG segments, GIF blocks, WebP chunks, TIFF and EXIF IFDs and entries, strips and tiles, ICO images, JPEG 2000 and JPEG XL boxes, JPEG 2000 marker segments and tile-parts, PSD layers, channels, resources, tagged blocks and linked files, and EMF, EMF+ and WMF records |
| `limits.scans` | 1,000 | `SOS` markers in one JPEG. A progressive JPEG with many scans makes a decoder redo the image for each one |
| `limits.metadataBytes` | 8 MiB | Bytes one compressed metadata block inflates to |
| `limits.nestingDepth` | none | The deepest an image may sit in the upload, where the upload is at depth 0 |
| `limits.timeMs` | none | The whole run, plugins and the check of the copy included |
| `stripMetadata` | `false` | Remove metadata from the copy, as described under Metadata |
| `actionOverrides` | none | Change the action for a category, or for a category and detail |
| `scoreWeights`, `scoreBands` | built in | Change the scoring |
| `filePlugins` | none | Plugins for the images inside the image |
| `tempDir` | `os.tmpdir()` | Directory for temporary files |
| `memoryThreshold` | 8 MiB | Bytes of the upload's copy, the defused copy and the images that plugins wrote that stay in memory before going to a temporary file |

The seven limits with a default bound the memory or work any input can cost, so they apply unless you set them. `Infinity` turns one off. A limit that is reached stops the run with a LIMIT finding.

The upload, the copy and the copies plugins write each stay in memory up to `memoryThreshold`, and the copies plugins write share that amount between them. Past it they go to temporary files in `tempDir`, which the run deletes when it ends.

## The defuse family

img-defuse is one of a family of packages that each handle one kind of file, beside [pdf-defuse](https://github.com/patrickdk77/pdf-defuse) and office-defuse. It declares the family's shared types with the same shapes as pdf-defuse: `DefuseFinding`, `ByteSource`, `ByteSink`, `PluginContext`, `ContainedFile`, `ContainedFileResult` and `ContainedFilePlugin`. It does not depend on pdf-defuse, and TypeScript matches the types by shape.

`@patrickdk77/file-defuse` routes each upload to the package that reads it, through one file plugin that holds every package's plugin. It puts that same router in every package's `filePlugins`, so a thumbnail inside a JPEG inside a PDF goes through the router at every level. `imagePlugin(options)` is img-defuse's plugin for that router.

- `accepts` reads the file's first bytes and takes every format under Formats: PNG, JPEG, GIF, WebP, TIFF, BMP, ICO, CUR, JPEG 2000, JPEG XL, PSD, PSB, EMF and WMF. The name, `declaredType` and `sniffedType` play no part.
- `process` defuses the image at the depth in its context and returns `passed` for a clean copy, `scrubbed` for a defused one and `removed` for a rejected file, with the image's findings in `findings` and the copy's in `outputFindings`. The sink gets the copy, for `passed` too.
- Built without options, it takes the options of the img-defuse run that found the image, which img-defuse passes under a symbol only it can read. Called by another package with a context of its own, it runs with no options, so a master builds it with options.
- It sets `weight` on every finding it returns, to the weight img-defuse scores that finding at under the run's `scoreWeights`. A finding of a kind img-defuse does not make, such as one a plugin returned, scores at its own `weight`.

The context holds `depth` and `deadline`. `depth` is the depth of the file itself, the upload being 0, whatever the formats in between. img-defuse gives each image inside an image its own depth plus one, and checks `limits.nestingDepth` against the depth an image arrives at. `deadline` is the `Date.now()` value the whole upload must finish by, and img-defuse hands it on unchanged.

Two error codes stop the whole tree of files. `code: 'DEFUSE_LIMIT'` marks a time or nesting limit, with `limit: 'time'` or `limit: 'nesting'`. `code: 'DEFUSE_IO'` marks an I/O error, with the original error in `cause`. img-defuse's nesting limit carries the limit code, and an I/O error in an image at depth 1 or more leaves `imagePlugin` with the I/O code. When a plugin throws an error with either code, img-defuse passes it up and reports no PLUGIN_FAILED. At depth 0 a limit becomes LIMIT/TIME or LIMIT/NESTING_DEPTH and rejects the file, and an I/O error fails the run with `cause`, or the error itself when it has none. An image inside the upload that runs past the deadline at one of img-defuse's own checks comes back `removed`, with LIMIT/TIME among its findings, as in pdf-defuse.

## Command line

```
img-defuse inspect <file> [options]
img-defuse defuse <in> <out> [options]

--plugin <module>        load file plugins from a file or an installed package, repeatable
--config <module>        load a whole options object, repeatable; the other options apply on top
--defuse-thumbnails      defuse the images inside the image, thumbnails included, with img-defuse and keep them
--strip-metadata
--limit <name>=<value>   fileSize, pixels, decodedBytes, totalDecodedBytes, frames, blocks, scans,
                         metadataBytes, nestingDepth, timeMs; sizes accept kb, mb, gb
--json                   print the result as JSON
```

Use `-` for stdin or stdout. The tool copies stdin to a temporary file in `tempDir`, which a `--config` module can set. The copy stops one byte past `limits.fileSize`, and the run then rejects the upload without reading the rest. The copy counts toward `limits.timeMs`. `inspect` prints its report to stdout. `defuse` does too, unless the image itself goes to stdout, and then the report goes to stderr. `defuse` refuses an output that is its input under any name, because a failed write deletes the partial output.

The text report shows each control character as an escape such as `\u001b`. The JSON report escapes DEL and the C1 range too, which JSON itself does not require. A keyword or a value from the image can hold an escape sequence that rewrites what the terminal shows, the verdict included.

`fileSize`, `decodedBytes`, `totalDecodedBytes` and `metadataBytes` take sizes. The other limits take whole numbers. Any other value is a usage error.

A `--plugin` module exports `plugins`, an array, or `plugin`, a single plugin, each with `kind: 'file'`. Either can also sit on the default export. ES modules, CommonJS files and installed packages all load, the same way pdf-defuse's tool loads them. A `--config` module's default export is the options object. Several `--config` modules combine. Their plugin lists join in order and their limits merge, and for any other option the later module wins. The flags apply on top of every module, wherever they sit on the command line.

Exit codes are 0 for clean, 1 for defused or strippable, 2 for rejected and 3 for a usage or I/O error. An output or a report that could not be written is an I/O error. An unknown option shows in the error without the text after its `=`.

## What it does not check

- The pixels. VP8 data, JPEG entropy-coded data and compressed TIFF strips are not decoded. VP8L data is read for its structure, the transforms and prefix codes, but never expanded to pixels. So a bug a decoder's pixel stage hits on ordinary-looking data goes unseen.
- JPEG 2000 and JPEG XL entropy-coded data. A JPEG 2000 codestream is read as far as its tile-part headers. A JPEG XL codestream is read as far as its image header, and its frames are not read, so a bare JPEG XL codestream shows no trailing data and is copied as it is.
- PSD layer pixels. Layer channels are checked for their lengths and compression codes only, and the composite only for its size.
- EMF and WMF drawing. Records are checked for their type and size, and the bitmaps inside them, but the drawing records' parameters and EMF+ drawing are not interpreted.
- The content of XMP beyond the document type check, maker notes, and Photoshop resources in JPEG, TIFF and JP2 beyond IPTC and thumbnails.
- Text in metadata that a server could run if it included the image as code, such as a PHP tag in a comment. `stripMetadata` removes the blocks that carry it.
- Offsets inside a maker note. When a thumbnail or the GPS IFD leaves an EXIF block, or an EXIF IFD in a TIFF moves, the bytes of a maker note stay together, but img-defuse does not write again the offsets it keeps to data outside itself.

## Development

Development needs Node 22.12 or later. mocha 12 requires it, and the CommonJS test build loads chai 6, an ES module, with `require()`, which Node 22 supports only from 22.12. The pre-commit hook needs Node 22.22.1 or later for lint-staged. The published package has no runtime dependencies and runs on Node 18 or later.

```sh
npm install --ignore-scripts
npm run build
npm test
npm run lint
npm run format
```

`npm run build` compiles `src` into `dist`. `npm test` runs the lint, builds the package and the tests, then runs mocha, so a lint error fails the tests. `npm run lint` runs `biome check` over the whole tree and changes nothing. `npm run format` rewrites files in Biome's format.

`npx husky` activates the pre-commit hook. A plain `npm install` does the same through the `prepare` script. The hook runs Biome on the staged files, applying its safe fixes, then runs `npm audit`. The commit stops if either one fails.

The fixtures under `test/fixtures` are committed, and `rewrite/` holds the ones whose defused copy edits a structure inside the file. `python3 -I scripts/make-fixtures.py` rebuilds them, and needs Pillow with OpenJPEG, the `brotli` module, ImageMagick's `convert`, `cjpeg`, `gifsicle`, `cwebp`, `img2webp`, `gif2webp`, `webpmux`, `exiftool` and Inkscape. The hostile files are built byte by byte, and so are the EMF and WMF files. Naming groups, as in `python3 -I scripts/make-fixtures.py photoshop metafile`, rebuilds only those.

## License

MIT
