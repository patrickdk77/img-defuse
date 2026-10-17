# Changelog

## 0.3.0 - 2026-10-17

- EMBEDDED_IMAGE/PLUGIN_PASSED and PLUGIN_SCRUBBED weigh 0, in the upload's score and the copy's. The copy's score counted them at 6 and 3. An image a plugin kept now scores what the plugin found in it.
- EMBEDDED_IMAGE/PLUGIN_FAILED weighs 10, what EMBEDDED_IMAGE/NO_PLUGIN weighs, since no plugin answered for the image. It weighed 0.

## 0.2.1 - 2026-10-11

- `detectImage` and `detectImageSource` tell a router whether img-defuse reads a file and in which format, by the signature test the inspection picks its reader by. `imagePlugin` takes what they find.

## 0.2.0 - 2026-10-11

### Formats

- JPEG 2000, JP2 files and bare codestreams, reported as `jp2` and `j2c`. img-defuse checks the boxes, the JP2 header against the codestream, and the codestream's main and tile-part headers, and reports comments, metadata boxes and data reference boxes. The copy writes box lengths, Psot and TLM again when something goes.
- JPEG XL, bare codestreams and containers, reported as `jxl`. img-defuse reads the image header for the size and depth, decompresses `brob` boxes with Brotli, and hands gain maps to the file plugins. It does not read the frames, so a bare codestream is copied as it is.
- Photoshop PSD and PSB. img-defuse checks the header, each image resource, each layer record and tagged block, and the composite image, which it inflates when it is ZIP. Layers count against the pixel and decoded size limits. A file embedded in a linked layer goes to the file plugins, and a link or alias to a file outside is EXTERNAL/LINKED_FILE.
- EMF with EMF+, and WMF. img-defuse checks each record's type and size, the bitmaps inside records, and the header counts readers stop at. A count that falls short is STRUCTURE/HEADER_COUNT, and the copy holds the right one. EMF+ images and the files in EMF comments go to the file plugins. Escapes to the printer driver are CONTENT/ESCAPE, and SETABORTPROC is CONTENT/ABORT_PROC. EMFSPOOL comments, which carry fonts, metafiles and PostScript for a printer, and private comments are STRUCTURE/EXTRA_BLOCK.
- `imagePlugin` accepts all of them. FORMAT/UNSUPPORTED is left for variants, such as JPX, JPSEC and hierarchical JPEG.

### Defused copies

- `disarmImage` and `disarmImageSource` write a defused copy and return what pdf-defuse's `disarmPdf` returns: `status` (`clean`, `defused` or `rejected`), `before`, `after` and `removed`. The package now exports `fileSink`, `bufferSink` and `writableSink` for the output.
- The copy is a rewrite of chunks, segments, blocks, IFD entries, boxes, resources and records. Compressed pixel data goes into it byte for byte, and img-defuse never decodes and encodes it again.
- The copy leaves out trailing data, bytes between structures, padding, and every block a `strip` finding names, including a block that holds another format's signature. With `stripMetadata` it leaves out metadata too. It keeps the ICC profile, and writes a new EXIF block holding only the orientation when the old one had an orientation from 2 to 8.
- When a removal moves or changes an offset, a length, a CRC, an APNG sequence number, a WebP flag, an MPF entry, a JPEG 2000 Psot or TLM entry, a Photoshop length, or an EMF or WMF header count, img-defuse writes it again. TIFF removals keep offsets word-aligned.
- img-defuse inspects the copy before anything reaches the sink. When the copy keeps a `strip` or `reject` finding, or changes the format, size or image count, img-defuse writes nothing and rejects the file with the new PROCESSING/VERIFICATION_FAILED. When a removal only brings another format's signature into the bytes its readers search, img-defuse rewrites the copy again, up to three passes.

### Images inside images

- `filePlugins` takes file plugins with pdf-defuse's shapes. EXIF, JFXX and Photoshop thumbnails and MPF secondary images that the copy would keep go to them, and the bytes a plugin writes replace the image. New findings EMBEDDED_IMAGE/PLUGIN_PASSED, PLUGIN_SCRUBBED, PLUGIN_FAILED and PLUGIN_REMOVED report each plugin's answer.
- JPEG XL gain maps, files embedded in Photoshop linked layers, EMF+ images, metafile bitmaps compressed as JPEG or PNG, and the files in EMF public comments go to them too.
- `imagePlugin(options?)` runs images inside other files through img-defuse, for a router in the defuse family or for thumbnails inside images. It accepts a file by its first bytes alone.
- `limits.nestingDepth` limits how deep in the upload an image may sit, and LIMIT/NESTING_DEPTH reports it. A nesting limit, and an I/O error inside a nested image, go up the tree with the family's `DEFUSE_LIMIT` and `DEFUSE_IO` codes.

### Command-line tool

- `img-defuse inspect <file>` and `img-defuse defuse <in> <out>` take `-` for stdin and stdout, and `--plugin`, `--config`, `--defuse-thumbnails`, `--strip-metadata`, `--limit` and `--json`. They exit with pdf-defuse's codes: 0 clean, 1 defused or strippable, 2 rejected, 3 usage or I/O error.

### Inspection

- New findings: EXTERNAL/LINKED_FILE, `strip`, weight 40, for a JP2 data reference box and a Photoshop link or alias to a file outside. CONTENT/ESCAPE, `strip`, weight 20, and CONTENT/ABORT_PROC, `strip`, weight 70, for metafile escapes.
- EXTERNAL/LINKED_PROFILE also covers EMF color space and ICM profile records that name a profile file.
- EMBEDDED_IMAGE/NO_PLUGIN gives a reason when a thumbnail sits where no plugin can be given it, in compressed JPEG XL EXIF.
- An EXIF thumbnail pointer of 0 bytes, which Photoshop writes, is STRUCTURE/EXTRA_BLOCK. The copy drops the pointer and keeps the rest of the EXIF. It used to make the whole block METADATA/MALFORMED.
- With `stripMetadata`, an EXIF block that holds only an orientation gets no METADATA/STRIPPED finding, since the copy keeps the orientation.
- An MPF index whose chain of IFDs does not read is METADATA/MALFORMED. 0.1.1 read the first IFD only.

### Options

- `tempDir` and `memoryThreshold`, as in pdf-defuse. The upload's copy, the defused copy and the images that plugins write stay in memory up to `memoryThreshold`, 8 MiB by default, and go to temporary files past it.

## 0.1.1 - 2026-10-11

- `engines` now asks for Node 18 instead of 22. Nothing in the package needed 22.
- PNG chunk CRCs use zlib.crc32 where Node has it, about 50 times faster than the lookup table. Node 18 and early releases of Node 20 and 22 lack it and keep the table.

## 0.1.0 - 2026-10-10

First release.
