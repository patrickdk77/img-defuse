#!/usr/bin/env python3
"""Rebuilds test/fixtures.

clean/ holds images from Pillow, ImageMagick's convert, cjpeg, gifsicle and the libwebp tools, and
hand-built PSD, EMF and WMF files.
meta/ holds images with metadata added by exiftool, Pillow and webpmux.
quirks/ holds real tool output that a rewrite would change: ImageMagick's own GIF extension, the
stray TIFF header Pillow leaves between pages, and Inkscape's private EMF comments and WMF escape.
hostile/ holds files built byte by byte: bombs, bad checksums, truncation, trailing and hidden
data, polyglots, loops, overlaps and huge dimensions.
detect/ holds files of formats outside the package, which detection must not take for an image.
rewrite/ holds files built byte by byte whose defused copy needs edits inside a structure: offsets,
sequence numbers, sizes and flags written again.

Run it with `python3 -I scripts/make-fixtures.py`. It needs Pillow with OpenJPEG and the brotli module,
and convert, cjpeg, gifsicle, cwebp, img2webp, gif2webp, webpmux, exiftool and inkscape on the PATH.
Naming groups, as in `python3 -I scripts/make-fixtures.py jpeg2000`, rebuilds only those, over the
files already there. The groups are jpeg2000, jpegxl, photoshop and metafile.
"""

import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

import brotli
from PIL import Image, ImageCms, PngImagePlugin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'test', 'fixtures')
TMP = tempfile.mkdtemp(prefix='img-defuse-fixtures-')


def path(rel):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def write(rel, data):
    with open(path(rel), 'wb') as f:
        f.write(data)


def read(rel):
    with open(path(rel), 'rb') as f:
        return f.read()


def tmp(name):
    return os.path.join(TMP, name)


def run(*cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def picture(w=32, h=24, mode='RGB'):
    """A small deterministic gradient."""
    im = Image.new('RGB', (w, h))
    im.putdata([((x * 255) // max(1, w - 1), (y * 255) // max(1, h - 1), ((x + y) * 7) % 256) for y in range(h) for x in range(w)])
    if mode == 'RGB':
        return im
    if mode == 'RGBA':
        im = im.convert('RGBA')
        im.putalpha(Image.linear_gradient('L').resize((w, h)))
        return im
    if mode == 'P':
        return im.convert('P', palette=Image.Palette.ADAPTIVE, colors=16)
    return im.convert(mode)


def save(im, fmt, **kw):
    b = io.BytesIO()
    im.save(b, fmt, **kw)
    return b.getvalue()


SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()

# ---------- PNG building blocks ----------

PNG_SIG = b'\x89PNG\r\n\x1a\n'


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def ihdr(w, h, depth=8, ctype=0, interlace=0):
    return chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, depth, ctype, 0, 0, interlace))


def gray_rows(w, h, value=0x80, filt=0):
    return b''.join(bytes([filt]) + bytes([value]) * w for _ in range(h))


def png(*chunks):
    return PNG_SIG + b''.join(chunks) + chunk(b'IEND', b'')


def gray_png(w=8, h=8, extra_before=(), extra_after=()):
    return png(ihdr(w, h), *extra_before, chunk(b'IDAT', zlib.compress(gray_rows(w, h))), *extra_after)


def fctl(seq, w, h, x=0, y=0, dispose=0, blend=0):
    return chunk(b'fcTL', struct.pack('>IIIIIHHBB', seq, w, h, x, y, 1, 10, dispose, blend))


def apng(frames=3, w=8, h=8, seq_fault=False, outside=False, actl=True):
    """IDAT is frame 0. Each later frame has one fdAT."""
    out = [ihdr(w, h)]
    if actl:
        out.append(chunk(b'acTL', struct.pack('>II', frames, 0)))
    out += [fctl(0, w, h), chunk(b'IDAT', zlib.compress(gray_rows(w, h)))]
    seq = 1
    for i in range(1, frames):
        fw, fh = (w, h) if not (outside and i == 1) else (w, h + 4)
        out.append(fctl(seq, fw, fh))
        seq += 1
        fd_seq = seq + (5 if seq_fault and i == 2 else 0)
        out.append(chunk(b'fdAT', struct.pack('>I', fd_seq) + zlib.compress(gray_rows(fw, fh, 0x20 * i))))
        seq += 1
    return png(*out)


# ---------- JPEG building blocks ----------


def seg(marker, payload):
    return bytes([0xFF, marker]) + struct.pack('>H', len(payload) + 2) + payload


def after_soi(jpeg, *segs):
    return jpeg[:2] + b''.join(segs) + jpeg[2:]


def jpeg_segments(jpeg):
    """Splits a JPEG into (marker, whole segment bytes) up to SOS, then the rest."""
    p, out = 2, []
    while True:
        m = jpeg[p + 1]
        n = struct.unpack('>H', jpeg[p + 2:p + 4])[0]
        if m == 0xDA:
            return out, jpeg[p:]
        out.append((m, jpeg[p:p + 2 + n]))
        p += 2 + n


def base_jpeg(w=32, h=24, **kw):
    return save(picture(w, h), 'JPEG', quality=85, **kw)


# ---------- TIFF and EXIF building blocks ----------


def ifd(entries, next_offset, big=False, order='<'):
    """entries: (tag, type, count, value) with value a number stored in the value field."""
    if big:
        out = struct.pack(order + 'Q', len(entries))
        for tag, typ, count, value in entries:
            out += struct.pack(order + 'HHQQ', tag, typ, count, value)
        return out + struct.pack(order + 'Q', next_offset)
    out = struct.pack(order + 'H', len(entries))
    for tag, typ, count, value in entries:
        if order == '>' and typ == 3 and count == 1:
            out += struct.pack(order + 'HHIHH', tag, typ, count, value, 0)
        else:
            out += struct.pack(order + 'HHII', tag, typ, count, value)
    return out + struct.pack(order + 'I', next_offset)


def gray_tiff(w=8, h=8, extra=(), compression=1, photometric=1, rows=None, counts=None, strip_at=None, gap=b'', trailing=b'', next_offset=0, drop=(), pixels=None):
    """An 8-bit grayscale TIFF with one strip after its IFD. `extra` adds entries, sorted in by tag."""
    if pixels is None:
        pixels = bytes((x * 30 + y * 7) % 256 for y in range(h) for x in range(w))
    entries = [
        (256, 3, 1, w),
        (257, 3, 1, h),
        (258, 3, 1, 8),
        (259, 3, 1, compression),
        (262, 3, 1, photometric),
        (273, 4, 1, 0),
        (277, 3, 1, 1),
        (278, 3, 1, rows or h),
        (279, 4, 1, counts if counts is not None else len(pixels)),
    ]
    entries = [e for e in entries if e[0] not in drop] + list(extra)
    entries.sort(key=lambda e: e[0])
    ifd_size = 2 + 12 * len(entries) + 4
    data_at = 8 + ifd_size + len(gap)
    # A value of -1 stands for the strip's offset.
    strip = strip_at if strip_at is not None else data_at
    entries = [(t, ty, c, strip if t == 273 or v == -1 else v) for t, ty, c, v in entries]
    return b'II*\0' + struct.pack('<I', 8) + ifd(entries, next_offset) + gap + pixels + trailing


def exif_block(ifd0=(), exif=(), gps=(), thumb=None, loop=False, order='<'):
    """A TIFF structure as EXIF holds it. Values are inline numbers."""
    mark = b'II*\0' if order == '<' else b'MM\0*'
    ifd0 = list(ifd0)
    head = 8
    ifd0_count = len(ifd0) + (1 if exif else 0) + (1 if gps else 0)
    ifd0_size = 2 + 12 * ifd0_count + 4
    exif_at = head + ifd0_size
    exif_size = 2 + 12 * len(exif) + 4 if exif else 0
    gps_at = exif_at + exif_size
    gps_size = 2 + 12 * len(gps) + 4 if gps else 0
    ifd1_at = gps_at + gps_size
    entries = list(ifd0)
    if exif:
        entries.append((34665, 4, 1, exif_at))
    if gps:
        entries.append((34853, 4, 1, gps_at))
    entries.sort(key=lambda e: e[0])
    next0 = head if loop else (ifd1_at if thumb is not None else 0)
    out = mark + struct.pack(order + 'I', head) + ifd(entries, next0, order=order)
    if exif:
        out += ifd(list(exif), 0, order=order)
    if gps:
        out += ifd(list(gps), 0, order=order)
    if thumb is not None:
        ifd1 = [(259, 3, 1, 6), (513, 4, 1, 0), (514, 4, 1, len(thumb))]
        thumb_at = ifd1_at + 2 + 12 * len(ifd1) + 4
        ifd1 = [(t, ty, c, thumb_at if t == 513 else v) for t, ty, c, v in ifd1]
        out += ifd(ifd1, 0, order=order) + thumb
    return out


GPS_ENTRIES = [(0, 1, 4, 0x00000302), (1, 2, 2, ord('N')), (3, 2, 2, ord('E'))]

# ---------- GIF building blocks ----------


def lzw_codes(pixels, m, extra_codes=()):
    """Codes for `pixels` as literals, with a clear code often enough that the code size never grows."""
    clear = 1 << m
    codes = [clear]
    k = 0
    for px in pixels:
        codes.append(px)
        k += 1
        if k == clear - 2:
            codes.append(clear)
            k = 0
    codes += list(extra_codes)
    return codes


def pack_codes(codes, width):
    out = bytearray()
    bits = 0
    n = 0
    for c in codes:
        bits |= c << n
        n += width
        while n >= 8:
            out.append(bits & 0xFF)
            bits >>= 8
            n -= 8
    if n:
        out.append(bits & 0xFF)
    return bytes(out)


def sub_blocks(data):
    return b''.join(bytes([len(data[i:i + 255])]) + data[i:i + 255] for i in range(0, len(data), 255)) + b'\0'


def gif(w=4, h=4, frames=None, gct_bits=1, extensions=b'', trailer=b'\x3b', after=b'', screen=None):
    """frames: list of (left, top, w, h, pixels, m, extra_codes, tail_bytes, local_bits)."""
    sw, sh = screen or (w, h)
    head = b'GIF89a' + struct.pack('<HHBBB', sw, sh, (0x80 | (gct_bits - 1)) if gct_bits else 0, 0, 0)
    if gct_bits:
        head += bytes(range(3 * 2 ** gct_bits))[: 3 * 2 ** gct_bits]
    body = extensions
    for left, top, fw, fh, pixels, m, extra, tail, local in frames or [(0, 0, w, h, [i % 2 for i in range(w * h)], 2, (), b'', 0)]:
        body += b'\x2c' + struct.pack('<HHHHB', left, top, fw, fh, (0x80 | (local - 1)) if local else 0)
        if local:
            body += bytes(3 * 2 ** local)
        clear = 1 << m
        codes = lzw_codes(pixels, m, extra) + [clear + 1]
        body += bytes([m]) + sub_blocks(pack_codes(codes, m + 1) + tail)
    return head + body + trailer + after


# ---------- WebP building blocks ----------


def riff_chunk(kind, data, pad=b'\0'):
    return kind + struct.pack('<I', len(data)) + data + (pad if len(data) % 2 else b'')


def webp(*chunks, size_delta=0, after=b''):
    body = b'WEBP' + b''.join(chunks)
    return b'RIFF' + struct.pack('<I', len(body) + size_delta) + body + after


def vp8x(flags, w, h):
    return riff_chunk(b'VP8X', bytes([flags, 0, 0, 0]) + (w - 1).to_bytes(3, 'little') + (h - 1).to_bytes(3, 'little'))


def webp_chunks(data):
    p, out = 12, []
    while p < len(data):
        kind = data[p:p + 4]
        n = struct.unpack('<I', data[p + 4:p + 8])[0]
        out.append((kind, data[p + 8:p + 8 + n]))
        p += 8 + n + (n & 1)
    return out


# ---------- BMP and ICO building blocks ----------


def bmp_info(w, h, bpp, compression=0, colors=0, size=40, extra=b''):
    return struct.pack('<IiiHHIIiiII', size, w, h, 1, bpp, compression, 0, 2835, 2835, colors, 0) + extra


def bmp_file(info, palette=b'', pixels=b'', gap=b'', after=b'', profile=b''):
    offset = 14 + len(info) + len(palette) + len(gap)
    total = offset + len(pixels) + len(profile)
    return b'BM' + struct.pack('<IHHI', total, 0, 0, offset) + info + palette + gap + pixels + profile + after


def v5_info(w, h, cs_type, profile_offset, profile_size, bpp=24):
    head = bmp_info(w, h, bpp, size=124)
    masks = struct.pack('<IIII', 0, 0, 0, 0)
    rest = struct.pack('<I', cs_type) + bytes(36) + bytes(12) + struct.pack('<IIII', 4, profile_offset, profile_size, 0)
    return head + masks + rest


def dib_icon(w, h, bpp=32):
    stride = ((w * bpp + 31) // 32) * 4
    mask = ((w + 31) // 32) * 4
    return bmp_info(w, h * 2, bpp) + bytes([0x40]) * (stride * h) + bytes(mask * h)


def ico(images, kind=1, gap=b'', after=b'', entries=None, hotspots=None):
    """images: list of (w, h, bytes)."""
    n = len(images)
    offset = 6 + 16 * n + len(gap)
    dir_bytes = b''
    data = b''
    for i, (w, h, blob) in enumerate(images):
        e = entries[i] if entries else (w % 256, h % 256, offset + len(data), len(blob))
        hx, hy = hotspots[i] if hotspots else (1, 32)
        dir_bytes += struct.pack('<BBBBHHII', e[0], e[1], 0, 0, hx, hy, e[3], e[2])
        data += blob
    return struct.pack('<HHH', 0, kind, n) + dir_bytes + gap + data + after


def tiny_zip():
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        z.writestr('payload.txt', 'This archive rides inside an image.\n')
    return b.getvalue()


# ======================================================================
# clean


def clean():
    write('clean/png/rgb.png', save(picture(), 'PNG'))
    write('clean/png/rgba.png', save(picture(mode='RGBA'), 'PNG'))
    write('clean/png/palette.png', save(picture(mode='P'), 'PNG', bits=4))
    write('clean/png/gray1.png', save(picture(mode='1'), 'PNG'))
    gray16 = Image.new('I;16', (32, 24))
    gray16.putdata([(x * 2000 + y * 300) % 65536 for y in range(24) for x in range(32)])
    write('clean/png/gray16.png', save(gray16, 'PNG'))
    picture().save(tmp('src.png'))
    run('convert', tmp('src.png'), '-strip', '-interlace', 'PNG', 'PNG24:' + tmp('interlaced.png'))
    shutil.copy(tmp('interlaced.png'), path('clean/png/interlaced.png'))
    frames = [picture(), picture().rotate(90, expand=False), picture().transpose(Image.Transpose.FLIP_LEFT_RIGHT)]
    for i, f in enumerate(frames):
        f.save(tmp(f'frame{i}.png'))
    write('clean/png/apng.png', save(frames[0], 'PNG', save_all=True, append_images=frames[1:], duration=100, loop=0))
    write('clean/png/apng-default.png', save(frames[0], 'PNG', save_all=True, append_images=frames[1:], duration=100, default_image=True))
    write('clean/png/apng-hand.png', apng())

    write('clean/jpeg/baseline.jpg', base_jpeg())
    write('clean/jpeg/progressive.jpg', base_jpeg(progressive=True))
    write('clean/jpeg/gray.jpg', save(picture(mode='L'), 'JPEG', quality=85))
    write('clean/jpeg/cmyk.jpg', save(picture(mode='CMYK'), 'JPEG', quality=85))
    picture().save(tmp('src.ppm'))
    run('cjpeg', '-arithmetic', '-outfile', path('clean/jpeg/arithmetic.jpg'), tmp('src.ppm'))
    run('cjpeg', '-restart', '1B', '-outfile', path('clean/jpeg/restart.jpg'), tmp('src.ppm'))
    run('cjpeg', '-progressive', '-restart', '1', '-outfile', path('clean/jpeg/progressive-restart.jpg'), tmp('src.ppm'))

    write('clean/gif/still.gif', save(picture(mode='P'), 'GIF'))
    write('clean/gif/anim.gif', save(frames[0].convert('P'), 'GIF', save_all=True, append_images=[f.convert('P') for f in frames[1:]], duration=100, loop=0))
    run('gifsicle', '--interlace', path('clean/gif/still.gif'), '-o', path('clean/gif/interlaced.gif'))
    run('gifsicle', '-O3', '--colors', '64', path('clean/gif/anim.gif'), '-o', path('clean/gif/optimized.gif'))
    write('clean/gif/hand.gif', gif())

    picture(mode='RGBA').save(tmp('alpha.png'))
    run('cwebp', '-quiet', '-q', '80', tmp('src.png'), '-o', path('clean/webp/lossy.webp'))
    run('cwebp', '-quiet', '-lossless', tmp('src.png'), '-o', path('clean/webp/lossless.webp'))
    run('cwebp', '-quiet', '-q', '80', tmp('alpha.png'), '-o', path('clean/webp/alpha.webp'))
    run('img2webp', '-loop', '0', '-lossy', tmp('frame0.png'), tmp('frame1.png'), tmp('frame2.png'), '-o', path('clean/webp/anim.webp'))
    run('gif2webp', '-quiet', path('clean/gif/anim.gif'), '-o', path('clean/webp/from-gif.webp'))

    write('clean/tiff/none.tif', save(picture(), 'TIFF'))
    write('clean/tiff/lzw.tif', save(picture(), 'TIFF', compression='tiff_lzw'))
    write('clean/tiff/deflate.tif', save(picture(), 'TIFF', compression='tiff_adobe_deflate'))
    write('clean/tiff/packbits.tif', save(picture(), 'TIFF', compression='packbits'))
    write('clean/tiff/jpeg.tif', save(picture(), 'TIFF', compression='jpeg'))
    write('clean/tiff/palette.tif', save(picture(mode='P'), 'TIFF'))
    run('convert', tmp('frame0.png'), tmp('frame1.png'), tmp('frame2.png'), '-compress', 'none', 'TIFF:' + path('clean/tiff/multipage.tif'))
    run('convert', tmp('src.png'), '-define', 'tiff:tile-geometry=16x16', '-compress', 'none', 'TIFF:' + path('clean/tiff/tiled.tif'))
    run('convert', tmp('src.png'), '-compress', 'none', 'TIFF64:' + path('clean/tiff/bigtiff.tif'))
    run('convert', tmp('src.png'), '-interlace', 'plane', '-compress', 'none', 'TIFF:' + path('clean/tiff/planar.tif'))
    write('clean/tiff/hand.tif', gray_tiff())
    write('clean/tiff/hand-mm.tif', b'MM\0*' + struct.pack('>I', 8) + ifd(
        [(256, 3, 1, 4), (257, 3, 1, 2), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1), (273, 4, 1, 8 + 2 + 9 * 12 + 4), (277, 3, 1, 1), (278, 3, 1, 2), (279, 4, 1, 8)], 0, order='>') + bytes(range(8)))

    write('clean/bmp/rgb24.bmp', save(picture(), 'BMP'))
    write('clean/bmp/pal8.bmp', save(picture(mode='P'), 'BMP'))
    write('clean/bmp/mono.bmp', save(picture(mode='1'), 'BMP'))
    run('convert', tmp('src.png'), '-colors', '16', '-type', 'Palette', '-compress', 'RLE', 'BMP3:' + path('clean/bmp/rle8.bmp'))
    run('convert', tmp('src.png'), 'BMP2:' + path('clean/bmp/core.bmp'))
    run('convert', tmp('alpha.png'), 'BMP:' + path('clean/bmp/v5-alpha.bmp'))
    run('convert', tmp('src.png'), '-define', 'bmp:subtype=RGB565', 'BMP:' + path('clean/bmp/rgb565.bmp'))
    write('clean/bmp/topdown.bmp', bmp_file(bmp_info(2, -2, 24), pixels=bytes(range(16))))

    write('clean/ico/png.ico', save(picture(32, 32), 'ICO', sizes=[(16, 16), (32, 32)]))
    run('convert', tmp('src.png'), '-define', 'icon:auto-resize=16,32', 'ICO:' + path('clean/ico/bmp.ico'))
    small_png = save(picture(16, 16), 'PNG')
    write('clean/ico/mixed.ico', ico([(16, 16, small_png), (16, 16, dib_icon(16, 16))]))
    write('clean/ico/cursor.cur', ico([(16, 16, dib_icon(16, 16))], kind=2, hotspots=[(3, 4)]))


# ======================================================================
# meta


def meta():
    thumb = base_jpeg(8, 6)
    shutil.copy(path('clean/jpeg/baseline.jpg'), tmp('meta.jpg'))
    open(tmp('thumb.jpg'), 'wb').write(thumb)
    run('exiftool', '-q', '-overwrite_original', '-Make=FixtureCam', '-Model=One', '-GPSLatitude=45.5', '-GPSLatitudeRef=N', '-GPSLongitude=73.5', '-GPSLongitudeRef=W',
        '-ThumbnailImage<=' + tmp('thumb.jpg'), tmp('meta.jpg'))
    shutil.copy(tmp('meta.jpg'), path('meta/jpeg/exif-gps-thumb.jpg'))
    shutil.copy(path('clean/jpeg/baseline.jpg'), tmp('meta2.jpg'))
    run('exiftool', '-q', '-overwrite_original', '-XMP-dc:Title=Fixture', '-IPTC:Keywords=fixture', '-Comment=A comment', tmp('meta2.jpg'))
    shutil.copy(tmp('meta2.jpg'), path('meta/jpeg/xmp-iptc-comment.jpg'))
    write('meta/jpeg/icc.jpg', save(picture(), 'JPEG', quality=85, icc_profile=SRGB))

    info = PngImagePlugin.PngInfo()
    info.add_text('Title', 'Fixture')
    info.add_text('Comment', 'compressed ' * 20, zip=True)
    info.add_itxt('Description', 'international', lang='en', tkey='Beschreibung', zip=True)
    write('meta/png/text.png', save(picture(), 'PNG', pnginfo=info))
    xmp = PngImagePlugin.PngInfo()
    xmp.add_itxt('XML:com.adobe.xmp', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>')
    write('meta/png/xmp.png', save(picture(), 'PNG', pnginfo=xmp))
    write('meta/png/icc.png', save(picture(), 'PNG', icc_profile=SRGB))
    exif = Image.Exif()
    exif[0x010F] = 'FixtureCam'
    exif[0x8825] = {1: 'N', 2: (45.0, 30.0, 0.0)}
    write('meta/png/exif.png', save(picture(), 'PNG', exif=exif))
    write('meta/png/time.png', gray_png(extra_before=[chunk(b'tIME', struct.pack('>HBBBBB', 2026, 10, 10, 12, 0, 0))]))

    write('meta/gif/comment.gif', save(picture(mode='P'), 'GIF', comment=b'A comment'))
    shutil.copy(path('clean/gif/still.gif'), tmp('xmp.gif'))
    run('exiftool', '-q', '-overwrite_original', '-XMP-dc:Title=Fixture', tmp('xmp.gif'))
    shutil.copy(tmp('xmp.gif'), path('meta/gif/xmp.gif'))

    open(tmp('srgb.icc'), 'wb').write(SRGB)
    open(tmp('exif.bin'), 'wb').write(exif_block(ifd0=[(0x0112, 3, 1, 6)], gps=GPS_ENTRIES))
    open(tmp('xmp.xml'), 'wb').write(b'<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
    run('webpmux', '-set', 'icc', tmp('srgb.icc'), path('clean/webp/alpha.webp'), '-o', tmp('m1.webp'))
    run('webpmux', '-set', 'exif', tmp('exif.bin'), tmp('m1.webp'), '-o', tmp('m2.webp'))
    run('webpmux', '-set', 'xmp', tmp('xmp.xml'), tmp('m2.webp'), '-o', path('meta/webp/meta.webp'))

    shutil.copy(path('clean/tiff/none.tif'), tmp('meta.tif'))
    run('exiftool', '-q', '-overwrite_original', '-Artist=Fixture', '-XMP-dc:Title=Fixture', '-GPSLatitude=45.5', '-GPSLatitudeRef=N', '-ExifIFD:ISO=100', tmp('meta.tif'))
    shutil.copy(tmp('meta.tif'), path('meta/tiff/meta.tif'))

    pixels = bytes(16)
    info5 = v5_info(2, 2, 0x4D424544, 124 + len(pixels), len(SRGB))
    write('meta/bmp/icc.bmp', bmp_file(info5, pixels=pixels, profile=SRGB))


# ======================================================================
# hostile


def hostile():
    # PNG
    good = gray_png()
    ihdr_crc = good[:29] + bytes([good[29] ^ 0xFF]) + good[30:]
    write('hostile/png/bad-crc.png', ihdr_crc)
    write('hostile/png/truncated.png', good[:60])
    write('hostile/png/no-iend.png', good[:-12])
    write('hostile/png/trailing-html.png', good + b'<html><script>alert(1)</script></html>')
    write('hostile/png/trailing-zip.png', good + tiny_zip())
    write('hostile/png/pixels.png', png(ihdr(100000, 100000), chunk(b'IDAT', zlib.compress(b'\0' * 100))))
    write('hostile/png/decoded.png', png(ihdr(16000, 16000, 16, 6), chunk(b'IDAT', zlib.compress(b'\0' * 100))))
    write('hostile/png/zlib-bomb.png', png(ihdr(100, 100), chunk(b'IDAT', zlib.compress(b'\0' * 50_000_000, 9))))
    write('hostile/png/short-data.png', png(ihdr(8, 8), chunk(b'IDAT', zlib.compress(gray_rows(8, 4)))))
    write('hostile/png/bad-filter.png', png(ihdr(8, 8), chunk(b'IDAT', zlib.compress(gray_rows(8, 8, filt=7)))))
    write('hostile/png/after-stream.png', png(ihdr(8, 8), chunk(b'IDAT', zlib.compress(gray_rows(8, 8)) + b'HIDDEN')))
    write('hostile/png/ztxt-bomb.png', gray_png(extra_after=[chunk(b'zTXt', b'Comment\0\0' + zlib.compress(b'\0' * 20_000_000, 9))]))
    write('hostile/png/critical.png', gray_png(extra_before=[chunk(b'CRIT', b'x')]))
    write('hostile/png/private.png', gray_png(extra_before=[chunk(b'prVt', b'secret')]))
    write('hostile/png/two-gama.png', gray_png(extra_before=[chunk(b'gAMA', struct.pack('>I', 45455)), chunk(b'gAMA', struct.pack('>I', 100000))]))
    write('hostile/png/late-gama.png', gray_png(extra_after=[chunk(b'gAMA', struct.pack('>I', 45455))]))
    idat = zlib.compress(gray_rows(8, 8))
    write('hostile/png/split-idat.png', png(ihdr(8, 8), chunk(b'IDAT', idat[:10]), chunk(b'tEXt', b'a\0b'), chunk(b'IDAT', idat[10:])))
    write('hostile/png/xmp-doctype.png', gray_png(extra_before=[chunk(b'iTXt', b'XML:com.adobe.xmp\0\0\0\0\0<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')]))
    write('hostile/png/pdf-text.png', gray_png(extra_before=[chunk(b'tEXt', b'Comment\0%PDF-1.7\n1 0 obj << >> endobj\n')]))
    zip_blob = tiny_zip()
    write('hostile/png/zip-chunk.png', gray_png(extra_after=[chunk(b'ziPd', zip_blob)]))
    # Stored deflate blocks keep the row bytes as written, so a PDF header lands in the image data.
    rows = b'\0' + b'%PDF-1.4' + b'\0' + bytes(8)
    write('hostile/png/pdf-pixels.png', png(ihdr(8, 2), chunk(b'IDAT', zlib.compress(rows, 0))))
    write('hostile/png/apng-sequence.png', apng(seq_fault=True))
    write('hostile/png/apng-outside.png', apng(outside=True))
    write('hostile/png/apng-no-actl.png', apng(actl=False))
    exif_loop = exif_block(ifd0=[(0x0112, 3, 1, 1)], loop=True)
    write('hostile/png/exif-loop.png', gray_png(extra_before=[chunk(b'eXIf', exif_loop)]))

    # JPEG
    j = base_jpeg()
    write('hostile/jpeg/truncated.jpg', j[: len(j) - 40])
    write('hostile/jpeg/trailing-php.jpg', j + b'<?php system($_GET["c"]); ?>')
    write('hostile/jpeg/trailing-zip.jpg', j + tiny_zip())
    segs, rest = jpeg_segments(j)
    write('hostile/jpeg/hidden.jpg', j[:2] + b''.join(s for _, s in segs[:1]) + b'HIDDENDATA' + b''.join(s for _, s in segs[1:]) + rest)
    sof = [s for m, s in segs if m == 0xC0][0]
    big_sof = sof[:5] + struct.pack('>HH', 65535, 65535) + sof[9:]
    write('hostile/jpeg/pixels.jpg', j.replace(sof, big_sof))
    write('hostile/jpeg/sof5.jpg', j.replace(sof, b'\xff\xc5' + sof[2:]))
    write('hostile/jpeg/unknown-marker.jpg', after_soi(j, seg(0xC8, b'x')))
    write('hostile/jpeg/app15.jpg', after_soi(j, seg(0xEF, b'private data')))
    bad_dht = seg(0xC4, bytes([0x00]) + bytes([3] + [0] * 15) + b'\x00\x01\x02')
    write('hostile/jpeg/huffman.jpg', after_soi(j, bad_dht))
    r = read('clean/jpeg/restart.jpg')
    rst = r.index(b'\xff\xd1')
    write('hostile/jpeg/restart-order.jpg', r[:rst] + b'\xff\xd5' + r[rst + 2:])
    write('hostile/jpeg/exif-loop.jpg', after_soi(j, seg(0xE1, b'Exif\0\0' + exif_loop)))
    html = b'<html><script>alert(1)</script></html>'
    write('hostile/jpeg/exif-html-thumb.jpg', after_soi(j, seg(0xE1, b'Exif\0\0' + exif_block(ifd0=[(0x0112, 3, 1, 1)], thumb=html))))
    write('hostile/jpeg/two-exif.jpg', after_soi(j, seg(0xE1, b'Exif\0\0' + exif_block(ifd0=[(0x0112, 3, 1, 1)])), seg(0xE1, b'Exif\0\0' + exif_block(ifd0=[(0x0112, 3, 1, 3)]))))
    write('hostile/jpeg/xmp-doctype.jpg', after_soi(j, seg(0xE1, b'http://ns.adobe.com/xap/1.0/\0<!DOCTYPE x [<!ENTITY e SYSTEM "http://example.invalid/">]><x/>')))
    half = len(SRGB) // 2
    write('hostile/jpeg/icc-order.jpg', after_soi(j, seg(0xE2, b'ICC_PROFILE\0\x01\x02' + SRGB[:half]), seg(0xE2, b'ICC_PROFILE\0\x01\x02' + SRGB[half:])))
    write('hostile/jpeg/com-pdf.jpg', after_soi(j, seg(0xFE, b'%PDF-1.7\n1 0 obj << >> endobj\n')))
    second = base_jpeg(16, 12)

    def mpf(after_images, extra=b''):
        # MPF offsets count from the byte after "MPF\0", which sits 8 bytes into the segment after SOI.
        n = 2
        entries_at = 8 + 2 + 3 * 12 + 4
        index = struct.pack('>HHII', 0xB000, 7, 4, 0x30313030) + struct.pack('>HHII', 0xB001, 4, 1, n) + struct.pack('>HHII', 0xB002, 7, 16 * n, entries_at)
        payload_len = 4 + 8 + 2 + len(index) + 4 + 16 * n
        primary_len = len(j) + 4 + payload_len
        base = 2 + 4 + 4
        entries = struct.pack('>IIIHH', 0x20030000, primary_len, 0, 0, 0) + struct.pack('>IIIHH', 0x00020002, len(after_images), primary_len - base, 0, 0)
        payload = b'MPF\0' + b'MM\0*' + struct.pack('>I', 8) + struct.pack('>H', 3) + index + struct.pack('>I', 0) + entries
        assert len(payload) == payload_len
        return after_soi(j, seg(0xE2, payload)) + after_images + extra

    write('hostile/jpeg/mpf.jpg', mpf(second))
    write('hostile/jpeg/mpf-trailing.jpg', mpf(second, b'MOTIONPHOTOVIDEO'))
    thumb = base_jpeg(8, 6)
    header = struct.pack('>IIIIIIHH', 1, 8, 6, 24, 144, len(thumb), 24, 1)
    res = b'8BIM' + struct.pack('>H', 0x040C) + b'\0\0' + struct.pack('>I', 28 + len(thumb)) + header + thumb
    res += b'\0' if len(res) % 2 else b''
    res += b'8BIM' + struct.pack('>H', 0x0404) + b'\0\0' + struct.pack('>I', 6) + b'\x1c\x02\x00\x00\x00\x00'
    write('hostile/jpeg/photoshop-thumb.jpg', after_soi(j, seg(0xED, b'Photoshop 3.0\0' + res)))

    # GIF
    write('hostile/gif/trailing.gif', gif(after=b'<?php echo 1; ?>'))
    write('hostile/gif/truncated.gif', gif(trailer=b''))
    write('hostile/gif/bad-code.gif', gif(frames=[(0, 0, 4, 4, [0] * 4, 2, (7,), b'', 0)]))
    write('hostile/gif/too-many.gif', gif(frames=[(0, 0, 4, 4, [1] * 20, 2, (), b'', 0)]))
    write('hostile/gif/too-few.gif', gif(frames=[(0, 0, 4, 4, [1] * 10, 2, (), b'', 0)]))
    write('hostile/gif/after-end.gif', gif(frames=[(0, 0, 4, 4, [1] * 16, 2, (), b'HIDDEN', 0)]))
    write('hostile/gif/outside.gif', gif(frames=[(2, 2, 4, 4, [1] * 16, 2, (), b'', 0)]))
    write('hostile/gif/no-table.gif', gif(gct_bits=0))
    write('hostile/gif/index-past.gif', gif(frames=[(0, 0, 4, 4, [3] * 16, 2, (), b'', 0)]))
    write('hostile/gif/pixels.gif', gif(screen=(65535, 65535)))
    write('hostile/gif/plain-text.gif', gif(extensions=b'\x21\x01\x0c' + bytes(12) + b'\x05hello\0'))
    write('hostile/gif/unknown-app.gif', gif(extensions=b'\x21\xff\x0bXXXXXXXX1.0\x04data\0'))
    write('hostile/gif/xmp-doctype.gif', gif(extensions=b'\x21\xff\x0bXMP DataXMP' + b'<!DOCTYPE x [<!ENTITY e "e">]><x/>' + bytes([1]) + bytes(range(255, -1, -1)) + b'\0'))
    write('hostile/gif/bad-block.gif', gif(extensions=b'\x99'))
    write('hostile/gif/code-size.gif', gif(frames=[(0, 0, 4, 4, [1] * 16, 2, (), b'', 0)]).replace(b'\x2c\0\0\0\0\x04\0\x04\0\0\x02', b'\x2c\0\0\0\0\x04\0\x04\0\0\x0c'))
    write('hostile/gif/pdf-comment.gif', gif(extensions=b'\x21\xfe' + sub_blocks(b'%PDF-1.7\n1 0 obj << >> endobj\n')))

    # WebP
    lossless = read('clean/webp/lossless.webp')
    vp8l = webp_chunks(lossless)[0][1]
    lossy = read('clean/webp/lossy.webp')
    vp8 = webp_chunks(lossy)[0][1]
    write('hostile/webp/riff-size.webp', webp(riff_chunk(b'VP8L', vp8l), size_delta=100))
    write('hostile/webp/trailing.webp', webp(riff_chunk(b'VP8L', vp8l), after=b'<?php echo 1; ?>'))
    write('hostile/webp/simple-extra.webp', webp(riff_chunk(b'VP8L', vp8l), riff_chunk(b'ABCD', b'data')))
    write('hostile/webp/unknown-chunk.webp', webp(vp8x(0, 32, 24), riff_chunk(b'VP8L', vp8l), riff_chunk(b'ABCD', b'odd', pad=b'A')))
    write('hostile/webp/canvas.webp', webp(vp8x(0, 20000, 20000), riff_chunk(b'VP8L', vp8l)))
    write('hostile/webp/canvas-mismatch.webp', webp(vp8x(0, 64, 64), riff_chunk(b'VP8L', vp8l)))
    write('hostile/webp/icc-flag.webp', webp(vp8x(0x20, 32, 24), riff_chunk(b'VP8L', vp8l)))
    write('hostile/webp/xmp-doctype.webp', webp(vp8x(0x04, 32, 24), riff_chunk(b'VP8L', vp8l), riff_chunk(b'XMP ', b'<!DOCTYPE x [<!ENTITY e "e">]><x/>')))
    anmf = (0).to_bytes(3, 'little') * 2 + (31).to_bytes(3, 'little') + (23).to_bytes(3, 'little') + (100).to_bytes(3, 'little') + b'\0'
    write('hostile/webp/frame-outside.webp', webp(vp8x(0x02, 16, 16), riff_chunk(b'ANIM', bytes(6)), riff_chunk(b'ANMF', anmf + riff_chunk(b'VP8L', vp8l))))
    write('hostile/webp/not-keyframe.webp', webp(riff_chunk(b'VP8 ', bytes([vp8[0] | 1]) + vp8[1:])))
    write('hostile/webp/first-chunk.webp', webp(riff_chunk(b'ABCD', b'data'), riff_chunk(b'VP8L', vp8l)))

    # TIFF
    write('hostile/tiff/loop.tif', gray_tiff(next_offset=8))
    write('hostile/tiff/overlap.tif', gray_tiff(strip_at=8))
    write('hostile/tiff/truncated.tif', gray_tiff()[:150])
    write('hostile/tiff/pixels.tif', gray_tiff(w=65535, h=65535, pixels=bytes(64)))
    write('hostile/tiff/jpeg2000.tif', gray_tiff(compression=34712))
    write('hostile/tiff/cfa.tif', gray_tiff(photometric=32803))
    write('hostile/tiff/hidden.tif', gray_tiff(gap=b'HIDEHIDE'))
    write('hostile/tiff/trailing.tif', gray_tiff(trailing=b'<?php echo 1; ?>'))
    write('hostile/tiff/private-tag.tif', gray_tiff(extra=[(37724, 7, 4, 0x41414141)]))
    write('hostile/tiff/duplicate-tag.tif', gray_tiff(extra=[(305, 2, 4, 0x00414141), (305, 2, 4, 0x00424242)]))
    write('hostile/tiff/bad-type.tif', gray_tiff(extra=[(305, 99, 1, 0)]))
    write('hostile/tiff/short-strip.tif', gray_tiff(counts=32))
    write('hostile/tiff/strip-count.tif', gray_tiff(rows=4))
    write('hostile/tiff/no-counts.tif', gray_tiff(drop=(279,)))
    write('hostile/tiff/old-jpeg.tif', gray_tiff(compression=6, extra=[(513, 4, 1, -1), (514, 4, 1, 64)]))
    write('hostile/tiff/subifd-loop.tif', gray_tiff(extra=[(330, 4, 1, 8)]))

    # BMP
    b = save(picture(4, 4), 'BMP')
    write('hostile/bmp/truncated.bmp', b[:-10])
    write('hostile/bmp/trailing.bmp', b + b'<?php echo 1; ?>')
    write('hostile/bmp/hidden.bmp', bmp_file(bmp_info(4, 4, 24), pixels=b[54:], gap=b'HIDEHIDE'))
    unc = b'\\\\attacker.invalid\\share\\profile.icc\0'
    write('hostile/bmp/linked-profile.bmp', bmp_file(v5_info(2, 2, 0x4C494E4B, 124 + 16, len(unc)), pixels=bytes(16), profile=unc))
    rle_run = bytes([10, 1]) + b'\0\1'
    write('hostile/bmp/rle-outside.bmp', bmp_file(bmp_info(4, 4, 8, compression=1, colors=2), palette=bytes(8), pixels=rle_run))
    write('hostile/bmp/rle-no-end.bmp', bmp_file(bmp_info(4, 4, 8, compression=1, colors=2), palette=bytes(8), pixels=bytes([4, 1, 0, 0])))
    masks = struct.pack('<III', 0xF800, 0x0FE0, 0x001F)
    write('hostile/bmp/bitfields.bmp', bmp_file(bmp_info(2, 2, 16, compression=3), palette=masks, pixels=bytes(8)))
    write('hostile/bmp/topdown-rle.bmp', bmp_file(bmp_info(4, -4, 8, compression=1, colors=2), palette=bytes(8), pixels=b'\0\1'))
    write('hostile/bmp/pixels.bmp', bmp_file(bmp_info(100000, 100000, 24), pixels=bytes(16)))
    write('hostile/bmp/os2v2.bmp', b'BM' + struct.pack('<IHHI', 0, 0, 0, 78) + struct.pack('<I', 64) + bytes(60) + bytes(16))
    write('hostile/bmp/jpeg.bmp', bmp_file(bmp_info(2, 2, 0, compression=4), pixels=base_jpeg(2, 2)))

    # ICO
    p16 = save(picture(16, 16), 'PNG')
    d16 = dib_icon(16, 16)
    start = 6 + 32
    write('hostile/ico/overlap.ico', ico([(16, 16, p16), (16, 16, d16)], entries=[(16, 16, start, len(p16)), (16, 16, start + 8, len(d16))]))
    write('hostile/ico/past-end.ico', ico([(16, 16, p16)], entries=[(16, 16, 6 + 16, len(p16) + 100)]))
    bad = p16[:29] + bytes([p16[29] ^ 0xFF]) + p16[30:]
    write('hostile/ico/png-crc.ico', ico([(16, 16, bad)]))
    write('hostile/ico/size-mismatch.ico', ico([(16, 16, d16)], entries=[(32, 32, 6 + 16, len(d16))]))
    write('hostile/ico/hidden.ico', ico([(16, 16, p16)], gap=b'HIDEHIDE'))
    write('hostile/ico/trailing.ico', ico([(16, 16, p16)], after=b'<?php echo 1; ?>'))
    write('hostile/ico/short-dib.ico', ico([(16, 16, d16[:-40])]))


# ======================================================================
# quirks: real tool output that a rewrite changes


def quirks():
    picture().save(tmp('q.png'))
    run('convert', tmp('q.png'), '-interlace', 'GIF', tmp('q.gif'))
    shutil.copy(tmp('q.gif'), path('quirks/gif/imagemagick.gif'))
    frames = [picture(), picture().rotate(90)]
    write('quirks/tiff/pillow-multipage.tif', save(frames[0], 'TIFF', save_all=True, append_images=frames[1:]))


# ======================================================================
# detect


def detect():
    write('detect/unknown.bin', b'This is plain text, not an image.\n')
    write('detect/svg.svg', b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n')
    write('detect/heic.heic', struct.pack('>I', 24) + b'ftypheic' + bytes(12))
    write('detect/avif.avif', struct.pack('>I', 24) + b'ftypavif' + bytes(12))


# ======================================================================
# cases: one file per issue a corpus run of the package exposed, rebuilt from scratch. No corpus file, file name or
# path goes into the repository; the manifest describes each issue in its own terms.


class Vp8lBits:
    """Writes a VP8L bitstream least-significant-bit first, the way libwebp's bit reader reads it."""

    def __init__(self):
        self.v = 0
        self.n = 0
        self.out = bytearray()

    def put(self, value, nbits):
        self.v |= (value & ((1 << nbits) - 1)) << self.n
        self.n += nbits
        while self.n >= 8:
            self.out.append(self.v & 0xFF)
            self.v >>= 8
            self.n -= 8

    def bytes(self):
        out = bytearray(self.out)
        if self.n:
            out.append(self.v & 0xFF)
        return bytes(out)


def vp8l_webp(stream_bits, w=1, h=1):
    """A 1x1 lossless WebP: the 5-byte VP8L header for a w x h image, then the bitstream given."""
    head = Vp8lBits()
    head.put(0x2F, 8)
    head.put(w - 1, 14)
    head.put(h - 1, 14)
    head.put(0, 1)
    head.put(0, 3)
    return webp(riff_chunk(b'VP8L', head.bytes() + stream_bits))


def vp8l_stream(green):
    """The bits before the first prefix code (no transform, color cache or entropy image), then `green`."""
    b = Vp8lBits()
    b.put(0, 1)  # no transform
    b.put(0, 1)  # no color cache
    b.put(0, 1)  # no meta-Huffman (entropy image)
    green(b)
    return b.bytes()


def bmp_core(w, h, bpp):
    """An OS/2 1.x BITMAPCOREHEADER: 12 bytes, no palette size field."""
    return struct.pack('<IHHHH', 12, w, h, 1, bpp)


def tiled_tiff(w, h, tile, tile_entries, tile_len):
    """A tiled grayscale TIFF whose TileOffsets and TileByteCounts list `tile_entries` tiles of `tile_len` bytes."""
    tags = [(256, 3, 1, w), (257, 3, 1, h), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1), (277, 3, 1, 1), (322, 3, 1, tile), (323, 3, 1, tile), (324, 4, tile_entries, 0), (325, 4, tile_entries, 0)]
    ifd_size = 2 + 12 * len(tags) + 4
    offsets_at = 8 + ifd_size
    counts_at = offsets_at + 4 * tile_entries
    data_at = counts_at + 4 * tile_entries
    offsets = [data_at + i * tile_len for i in range(tile_entries)]
    tags = [(t, ty, c, offsets_at if t == 324 else counts_at if t == 325 else v) for t, ty, c, v in tags]
    arrays = b''.join(struct.pack('<I', o) for o in offsets) + struct.pack('<I', tile_len) * tile_entries
    return b'II*\0' + struct.pack('<I', 8) + ifd(tags, 0) + arrays + bytes(tile_len * tile_entries)


def cases():
    # 1-3. CVE-2023-4863: libwebp's lossless Huffman table construction, ported into the VP8L check.
    def green_incomplete(b):
        # A normal green code whose code lengths are {2: 2}: two codes of length 2, a tree that is not full.
        b.put(0, 1)  # not a simple code
        b.put(1, 4)  # 5 code-length codes, in the order 17, 18, 0, 1, 2
        for length in (0, 0, 0, 0, 1):
            b.put(length, 3)  # only the code-length symbol 2 is defined, so every symbol reads as a literal length of 2
        b.put(1, 1)  # read a symbol count
        b.put(0, 3)  # length_nbits selector 0
        b.put(0, 2)  # read 2 symbols, both decoded as length 2

    def green_oversubscribed(b):
        b.put(0, 1)  # not a simple code
        b.put(0, 4)  # 4 code-length codes, in the order 17, 18, 0, 1
        for _ in range(4):
            b.put(1, 3)  # four codes of length 1, which over-subscribe the one-bit space

    def green_valid(b):
        # Five simple one-symbol codes; the green literal 0 makes the single pixel trivial to decode.
        for _ in range(5):
            b.put(1, 1)  # simple code
            b.put(0, 1)  # one symbol
            b.put(0, 1)  # a 1-bit symbol index
            b.put(0, 1)  # symbol 0

    write('cases/webp-vp8l-incomplete-code.webp', vp8l_webp(vp8l_stream(green_incomplete)))
    write('cases/webp-vp8l-oversubscribed-code.webp', vp8l_webp(vp8l_stream(green_oversubscribed)))
    write('cases/webp-vp8l-valid.webp', vp8l_webp(vp8l_stream(green_valid)))

    # 4-5. PNG: a complete re-encoding of a partial image is clean; a genuine cut is caught.
    write('cases/png-partial-image.png', gray_png(16, 16))
    write('cases/png-truncated-idat.png', png(ihdr(16, 16), chunk(b'IDAT', zlib.compress(gray_rows(16, 16))))[:-30])

    # 6-9. JPEG: a bad table selector and a bad progressive refinement are rejected; a valid file and trailing data are not.
    DQT0 = seg(0xDB, bytes([0x00]) + bytes(range(1, 65)))

    def sof(marker, w, h):
        return seg(marker, bytes([8]) + struct.pack('>HH', h, w) + bytes([1, 1, 0x11, 0]))

    def sos(td, ta, ss, se, ah, al):
        return seg(0xDA, bytes([1, 1, (td << 4) | ta, ss, se, (ah << 4) | al]))

    write('cases/jpeg-ac-table-4.jpg', b'\xff\xd8' + DQT0 + sof(0xC0, 8, 8) + sos(0, 4, 0, 63, 0, 0) + b'\xff\xd9')
    write('cases/jpeg-bad-refinement.jpg', b'\xff\xd8' + DQT0 + sof(0xC2, 8, 8) + sos(0, 0, 0, 0, 2, 0) + b'\xff\xd9')
    write('cases/jpeg-valid.jpg', base_jpeg())
    write('cases/jpeg-trailing-byte.jpg', base_jpeg() + b'\x2f')

    # 10. PDF-in-PNG polyglot: the PDF rides in the compressed pixels, so no %PDF- sits in the raw file.
    pdf_rows = b''.join(b'\0' + b'%PDF-1.7 ' + bytes(7) for _ in range(16))
    write('cases/png-pdf-in-pixels.png', png(ihdr(16, 16), chunk(b'IDAT', zlib.compress(pdf_rows))))

    # 11-12. GIF LZW minimum code size: 1 is read, 0 is still refused.
    write('cases/gif-mincodesize-1.gif', gif(w=1, h=1, gct_bits=1, frames=[(0, 0, 1, 1, [0], 1, (), b'', 0)]))
    write('cases/gif-mincodesize-0.gif', gif(w=1, h=1, gct_bits=1, frames=[(0, 0, 1, 1, [0], 0, (), b'', 0)]))

    # 13-14. BMP: 2 bits per pixel (legal on Windows CE), and an OS/2 1.x header with a short palette.
    write('cases/bmp-2bpp.bmp', bmp_file(bmp_info(4, 4, 2, colors=4), palette=bytes(16), pixels=bytes(16)))
    write('cases/bmp-os2-short-palette.bmp', bmp_file(bmp_core(4, 4, 8), palette=bytes(18), pixels=bytes(16)))

    # 15-16. TIFF: strip and tile arrays longer than the grid are read; a null (type 0) IFD entry is skipped.
    write('cases/tiff-extra-tiles.tif', tiled_tiff(2, 2, 16, 2, 256))
    write('cases/tiff-null-entry.tif', gray_tiff(extra=[(0, 0, 0, 0)]))

    # 17. TIFF old-style JPEG with its quantization and Huffman tables in regions tags 519, 520 and 521 point at.
    huff = bytes([2]) + bytes(15) + bytes(2)  # 16 code-length counts (summing to 2) then 2 symbol values
    oj_tags = [(256, 3, 1, 16), (257, 3, 1, 16), (258, 3, 1, 8), (259, 3, 1, 6), (262, 3, 1, 6), (273, 4, 1, 0), (277, 3, 1, 1), (278, 3, 1, 16), (279, 4, 1, 64), (519, 4, 1, 0), (520, 4, 1, 0), (521, 4, 1, 0)]
    oj_base = 8 + 2 + 12 * len(oj_tags) + 4
    q_at, dc_at, ac_at, strip_at = oj_base, oj_base + 64, oj_base + 64 + len(huff), oj_base + 64 + 2 * len(huff)
    oj_tags = [(t, ty, c, {273: strip_at, 519: q_at, 520: dc_at, 521: ac_at}.get(t, v)) for t, ty, c, v in oj_tags]
    write('cases/tiff-old-jpeg.tif', b'II*\0' + struct.pack('<I', 8) + ifd(oj_tags, 0) + bytes(64) + huff + huff + bytes(64))

    # 18-19. PNG CRC: an ancillary chunk with a bad CRC is dropped; a critical chunk with a bad CRC is refused.
    text = chunk(b'tEXt', b'Comment\0hello')
    bad_text = text[:-1] + bytes([text[-1] ^ 0xFF])
    write('cases/png-ancillary-bad-crc.png', gray_png(extra_before=[bad_text]))
    good = gray_png()
    write('cases/png-critical-bad-crc.png', good[:29] + bytes([good[29] ^ 0xFF]) + good[30:])

    # 20-21. ICO directory dimensions: a width of 256 or more wraps to its low byte; a genuine mismatch is ambiguous.
    big_png = save(picture(300, 16), 'PNG')
    write('cases/ico-large-image.ico', ico([(300, 16, big_png)], entries=[(300 % 256, 16, 6 + 16, len(big_png))]))
    write('cases/ico-size-mismatch.ico', ico([(16, 16, dib_icon(16, 16))], entries=[(16, 32, 6 + 16, len(dib_icon(16, 16)))]))

    # 22. A deliberately broken PNG: an undefined color type.
    write('cases/png-bad-color-type.png', png(ihdr(8, 8, ctype=9), chunk(b'IDAT', zlib.compress(gray_rows(8, 8)))))

    # 23. A 32-bit icon whose doubled header height promises an AND mask the entry does not hold: truncated.
    color = bytes([0x40]) * (16 * 16 * 4)
    write('cases/ico-missing-and-mask.ico', ico([(16, 16, bmp_info(16, 32, 32) + color)], entries=[(16, 16, 6 + 16, 40 + len(color))]))

    # 24. An EXIF block holding only an orientation of 6, which stripMetadata leaves as it is.
    write('cases/jpeg-exif-orientation-only.jpg', after_soi(base_jpeg(), seg(0xE1, b'Exif\0\0' + exif_block(ifd0=[(0x0112, 3, 1, 6)]))))


# ======================================================================
# rewrite: files whose defused copy edits a structure, each built byte by byte


def tiny_icc():
    """The smallest ICC profile the inspector accepts: a 128-byte header with its size and signature, and no tags."""
    head = struct.pack('>I', 132) + bytes(32) + b'acsp' + bytes(88)
    return head + struct.pack('>I', 0)


def tiff_blocks(blocks, order='<', big=False):
    """Lays out a TIFF structure. `blocks` is a list of (name, item): bytes, or ('ifd', entries, next) where next names
    the next IFD or is None. An entry is (tag, type, count, value). A value is a number, the name of a block (its
    offset), a list of numbers and names, or bytes. A list or bytes longer than the value field goes right after the
    IFD. The header points at the first block."""
    head_size = 16 if big else 8
    count_fmt, offset_fmt = ('Q', 'Q') if big else ('H', 'I')
    entry_size = 20 if big else 12
    field = 8 if big else 4
    unit = {1: 1, 2: 1, 3: 2, 4: 4, 7: 1, 13: 4, 16: 8, 18: 8}

    def raw(typ, value):
        if isinstance(value, bytes):
            return value
        values = value if isinstance(value, list) else [value]
        fmt = {1: 'B', 2: 'B', 3: 'H', 4: 'I', 7: 'B', 13: 'I', 16: 'Q', 18: 'Q'}[typ]
        return b''.join(struct.pack(order + fmt, pos[v] if isinstance(v, str) else v) for v in values)

    def ifd_size(entries):
        size = struct.calcsize(order + count_fmt) + entry_size * len(entries) + struct.calcsize(order + offset_fmt)
        for typ, value in ((e[1], e[3]) for e in entries):
            n = len(value) if isinstance(value, bytes) else unit[typ] * (len(value) if isinstance(value, list) else 1)
            if n > field:
                size += n
        return size

    pos = {}
    at = head_size
    for name, item in blocks:
        pos[name] = at
        at += len(item) if isinstance(item, bytes) else ifd_size(item[1])
    first = blocks[0][0]
    out = bytearray((b'II' if order == '<' else b'MM') + struct.pack(order + 'H', 43 if big else 42))
    out += struct.pack(order + 'HHQ', 8, 0, pos[first]) if big else struct.pack(order + 'I', pos[first])
    for name, item in blocks:
        assert len(out) == pos[name], name
        if isinstance(item, bytes):
            out += item
            continue
        _, entries, nxt = item
        entries = sorted(entries, key=lambda e: e[0])
        after = bytearray()
        after_at = pos[name] + struct.calcsize(order + count_fmt) + entry_size * len(entries) + struct.calcsize(order + offset_fmt)
        out += struct.pack(order + count_fmt, len(entries))
        for tag, typ, count, value in entries:
            data = raw(typ, value)
            if len(data) > field:
                out += struct.pack(order + ('HHQQ' if big else 'HHII'), tag, typ, count, after_at + len(after))
                after += data
            else:
                out += struct.pack(order + ('HHQ' if big else 'HHI'), tag, typ, count) + data.ljust(field, b'\0')
        out += struct.pack(order + offset_fmt, pos[nxt] if nxt else 0) + after
    return bytes(out)


def rewrite():
    j = base_jpeg()
    thumb = base_jpeg(8, 6)

    # An APNG whose second frame has non-zero bytes after its zlib stream, filling a whole fdAT chunk. Dropping that
    # chunk moves every later sequence number down by one.
    w, h = 8, 8
    stream = zlib.compress(gray_rows(w, h, 0x40))
    write('rewrite/png-apng-stream-tail.png', png(
        ihdr(w, h),
        chunk(b'acTL', struct.pack('>II', 3, 0)),
        fctl(0, w, h),
        chunk(b'IDAT', zlib.compress(gray_rows(w, h))),
        fctl(1, w, h),
        chunk(b'fdAT', struct.pack('>I', 2) + stream),
        chunk(b'fdAT', struct.pack('>I', 3) + b'TAILBYTES'),
        fctl(4, w, h),
        chunk(b'fdAT', struct.pack('>I', 5) + zlib.compress(gray_rows(w, h, 0x60))),
    ))

    # A PNG with an EXIF block holding a GPS IFD and a JPEG thumbnail, a text chunk and a color profile.
    exif = exif_block(ifd0=[(0x0112, 3, 1, 1)], gps=GPS_ENTRIES, thumb=thumb)
    write('rewrite/png-exif-thumbnail.png', gray_png(extra_before=[chunk(b'iCCP', b'icc\0\0' + zlib.compress(tiny_icc())), chunk(b'eXIf', exif)], extra_after=[chunk(b'tEXt', b'Comment\0kept unless stripped')]))

    # A PNG where removing an unknown chunk brings a PDF header in a later text chunk into the first 1024 bytes.
    write('rewrite/png-shifted-pdf.png', gray_png(extra_before=[chunk(b'prVt', bytes(range(256)) * 2 + bytes(188))], extra_after=[chunk(b'tEXt', b'Comment\0' + b'.' * 300 + b'%PDF-1.7\n')]))

    # A JPEG with an MPF index naming two images after EOI, an image UID list, an attribute IFD after the index, and
    # dependent image numbers.
    second, third = base_jpeg(16, 12), base_jpeg(8, 6)
    n = 3
    payload_len = 4 + 240
    primary_len = len(j) + 4 + payload_len
    base = 2 + 4 + 4
    uids = b''.join(bytes([0x30 + i]) * 32 + b'\0' for i in range(n))
    entries = struct.pack('>IIIHH', 0x20030000, primary_len, 0, 2, 3)
    entries += struct.pack('>IIIHH', 0x00020002, len(second), primary_len - base, 0, 0)
    entries += struct.pack('>IIIHH', 0x00020002, len(third), primary_len + len(second) - base, 0, 0)
    index = struct.pack('>H', 4) + struct.pack('>HHI4s', 0xB000, 7, 4, b'0100') + struct.pack('>HHII', 0xB001, 4, 1, n) + struct.pack('>HHII', 0xB002, 7, 16 * n, 62) + struct.pack('>HHII', 0xB003, 7, 33 * n, 110) + struct.pack('>I', 210)
    attributes = struct.pack('>H', 2) + struct.pack('>HHI4s', 0xB000, 7, 4, b'0100') + struct.pack('>HHII', 0xB101, 4, 1, 1) + struct.pack('>I', 0)
    tiff = b'MM\0*' + struct.pack('>I', 8) + index + entries + uids + b'\0' + attributes
    assert len(tiff) == 240
    write('rewrite/jpeg-mpf-two-images.jpg', after_soi(j, seg(0xE2, b'MPF\0' + tiff)) + second + third)

    # A JPEG whose EXIF holds a camera name, an orientation of 6, an EXIF IFD, a GPS IFD and a JPEG thumbnail.
    exif = exif_block(ifd0=[(0x010F, 2, 4, int.from_bytes(b'Cam\0', 'little')), (0x0112, 3, 1, 6)], exif=[(0x9000, 7, 4, int.from_bytes(b'0230', 'little'))], gps=GPS_ENTRIES, thumb=thumb)
    write('rewrite/jpeg-exif-orientation-thumb.jpg', after_soi(j, seg(0xE1, b'Exif\0\0' + exif)))

    # A JPEG with Photoshop resources: IPTC, a JPEG thumbnail, and a resource after the thumbnail.
    header = struct.pack('>IIIIIIHH', 1, 8, 6, 24, 144, len(thumb), 24, 1)

    def resource(rid, data):
        r = b'8BIM' + struct.pack('>H', rid) + b'\0\0' + struct.pack('>I', len(data)) + data
        return r + (b'\0' if len(data) % 2 else b'')

    resources = resource(0x0404, b'\x1c\x02\x00\x00\x00') + resource(0x040C, header + thumb) + resource(0x0425, bytes(range(16)))
    write('rewrite/jpeg-photoshop-thumbnail.jpg', after_soi(j, seg(0xED, b'Photoshop 3.0\0' + resources)))

    # A JPEG with a JFIF header holding a 2 x 1 raw thumbnail, an ICC profile split over two APP2 segments, XMP,
    # extended XMP in two segments, and a comment.
    segs, rest = jpeg_segments(j)
    # The segments after SOI, without Pillow's own JFIF header.
    body = b''.join(s for m, s in segs if m != 0xE0) + rest
    jfif = seg(0xE0, b'JFIF\0\x01\x01\0\0\x01\0\x01\x02\x01' + bytes(range(6)))
    icc = tiny_icc()
    icc1 = seg(0xE2, b'ICC_PROFILE\0\x01\x02' + icc[:66])
    icc2 = seg(0xE2, b'ICC_PROFILE\0\x02\x02' + icc[66:])
    xmp = seg(0xE1, b'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
    guid = b'0123456789ABCDEF0123456789ABCDEF'
    ext = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><!-- extended --></x:xmpmeta>'
    ext1 = seg(0xE1, b'http://ns.adobe.com/xmp/extension/\0' + guid + struct.pack('>II', len(ext), 0) + ext[:30])
    ext2 = seg(0xE1, b'http://ns.adobe.com/xmp/extension/\0' + guid + struct.pack('>II', len(ext), 30) + ext[30:])
    com = seg(0xFE, b'a comment')
    write('rewrite/jpeg-icc-xmp-thumbnail.jpg', b'\xff\xd8' + jfif + icc1 + icc2 + xmp + ext1 + ext2 + com + body)

    # A GIF with a graphic control extension before a plain text extension, another before the image, bytes after
    # the image's LZW end code, and a comment.
    netscape = b'\x21\xff\x0bNETSCAPE2.0\x03\x01\0\0\0'

    def control(delay):
        return b'\x21\xf9\x04\x04' + struct.pack('<H', delay) + b'\0\0'

    plain = b'\x21\x01\x0c' + bytes(12) + b'\x05hello\0'
    g = gif(extensions=netscape + control(10) + plain + control(20), frames=[(0, 0, 4, 4, [i % 2 for i in range(16)], 2, (), b'TAIL', 0)])
    write('rewrite/gif-control-plain-text.gif', g[:-1] + b'\x21\xfe' + sub_blocks(b'a comment') + b'\x3b')

    # An extended WebP with an ICC profile, EXIF with a JPEG thumbnail, odd-sized XMP padded with a byte that is not
    # zero, and an unknown chunk.
    lossless = read('clean/webp/lossless.webp')
    vp8l = webp_chunks(lossless)[0][1]
    exif = exif_block(ifd0=[(0x0112, 3, 1, 1)], thumb=thumb)
    write('rewrite/webp-extended-meta.webp', webp(vp8x(0x2C, 32, 24), riff_chunk(b'ICCP', tiny_icc()), riff_chunk(b'VP8L', vp8l), riff_chunk(b'EXIF', exif), riff_chunk(b'XMP ', b'<x:xmpmeta xmlns:x="adobe:ns:meta/"/>!', pad=b'P'), riff_chunk(b'ABCD', b'data')))

    # An animated WebP whose first frame holds an unknown chunk after its image.
    anmf = (0).to_bytes(3, 'little') * 2 + (31).to_bytes(3, 'little') + (23).to_bytes(3, 'little') + (100).to_bytes(3, 'little') + b'\0'
    write('rewrite/webp-anim-inner-chunk.webp', webp(vp8x(0x02, 32, 24), riff_chunk(b'ANIM', bytes(6)), riff_chunk(b'ANMF', anmf + riff_chunk(b'VP8L', vp8l) + riff_chunk(b'ABCD', b'inner')), riff_chunk(b'ANMF', anmf + riff_chunk(b'VP8L', vp8l))))

    # A TIFF with odd-length text values, an EXIF IFD, a GPS IFD, a private tag, bytes hidden between its parts, an
    # uncompressed strip holding bytes past its rows, and trailing bytes.
    strip0 = bytes(range(32)) + b'XTRA'
    strip1 = bytes(range(32, 64))
    write('rewrite/tiff-gaps-exif-gps.tif', tiff_blocks([
        ('ifd0', ('ifd', [
            (256, 3, 1, 8), (257, 3, 1, 8), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1),
            (270, 2, 13, b'a picture of\0'), (273, 4, 2, ['strip0', 'strip1']), (277, 3, 1, 1), (278, 3, 1, 4),
            (279, 4, 2, [len(strip0), len(strip1)]), (305, 2, 5, b'tool\0'), (34665, 4, 1, 'exif'), (34853, 4, 1, 'gps'),
            (37724, 7, 7, b'private'),
        ], None)),
        ('hidden', b'HIDE'),
        ('exif', ('ifd', [(0x9000, 7, 4, b'0230')], None)),
        ('gps', ('ifd', [(0, 1, 4, b'\x02\x03\0\0'), (1, 2, 2, b'N\0'), (2, 5, 3, bytes(24))], None)),
        ('strip0', strip0),
        ('strip1', strip1),
        ('trailing', b'TRAILING'),
    ]))

    # A BigTIFF with a SubIFD holding a second image, and bytes hidden between the first IFD and its strip.
    write('rewrite/tiff-big-subifd.tif', tiff_blocks([
        ('ifd0', ('ifd', [(256, 3, 1, 4), (257, 3, 1, 4), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1), (273, 16, 1, 'strip0'), (277, 3, 1, 1), (279, 16, 1, 16), (330, 18, 1, 'sub')], None)),
        ('hidden', b'HIDDEN!!'),
        ('strip0', bytes(range(16))),
        ('sub', ('ifd', [(254, 4, 1, 1), (256, 3, 1, 2), (257, 3, 1, 2), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1), (273, 16, 1, 'strip1'), (277, 3, 1, 1), (279, 16, 1, 4)], None)),
        ('strip1', bytes([1, 2, 3, 4])),
    ], big=True))

    # A TIFF whose Photoshop resources hold IPTC and a JPEG thumbnail.
    write('rewrite/tiff-photoshop-thumbnail.tif', tiff_blocks([
        ('ifd0', ('ifd', [(256, 3, 1, 8), (257, 3, 1, 8), (258, 3, 1, 8), (259, 3, 1, 1), (262, 3, 1, 1), (273, 4, 1, 'strip'), (277, 3, 1, 1), (279, 4, 1, 64), (34377, 7, len(resources), resources)], None)),
        ('strip', bytes(range(64))),
    ]))

    # A V5 BMP with an embedded color profile after the pixels, and bytes hidden between them.
    pixels = bytes(16)
    gap = b'GAPGAP'
    profile = tiny_icc()
    write('rewrite/bmp-v5-profile-gap.bmp', bmp_file(v5_info(2, 2, 0x4D424544, 124 + len(pixels) + len(gap), len(profile)), pixels=pixels + gap, profile=profile))

    # An ICO with a PNG image holding a text chunk and bytes after its IEND, and a DIB image with bytes after its AND
    # mask, each inside its own entry.
    p16 = png(ihdr(16, 16), chunk(b'tEXt', b'Comment\0icon text'), chunk(b'IDAT', zlib.compress(gray_rows(16, 16)))) + b'AFTERIEND'
    write('rewrite/ico-png-text-hidden.ico', ico([(16, 16, p16), (16, 16, dib_icon(16, 16) + b'AFTERMASK')]))


# ======================================================================
# JPEG 2000: clean files from Pillow's OpenJPEG, metadata from exiftool, and files built byte by byte


UUID_XMP = bytes.fromhex('be7acfcb97a942e89c71999491e3afac')
UUID_EXIF = b'JpgTiffExif->JP2'
UUID_PHOTOSHOP = bytes.fromhex('2c4c0100850440b9a03e562148d6dfeb')
UUID_GEOJP2 = bytes.fromhex('b14bf8bd083d4b43a5ae8cd7d5a6ce03')


def box(kind, data):
    return struct.pack('>I', 8 + len(data)) + kind + data


def boxes_of(data):
    """The boxes in data, as (type, content) pairs."""
    out, p = [], 0
    while p < len(data):
        n, kind = struct.unpack('>I4s', data[p:p + 8])
        n = n or len(data) - p
        out.append((kind, data[p + 8:p + n]))
        p += n
    return out


def join_boxes(boxes):
    return b''.join(box(k, d) for k, d in boxes)


def j2k_split(cs):
    """A codestream as the segments of its main header after SOC, SIZ first, as (marker, payload) pairs, and the rest
    from the first SOT."""
    segs, p = [], 2
    while struct.unpack('>H', cs[p:p + 2])[0] != 0xFF90:
        m, n = struct.unpack('>HH', cs[p:p + 4])
        segs.append((m, cs[p + 4:p + 2 + n]))
        p += 2 + n
    return segs, cs[p:]


def j2k_join(segs, rest):
    return b'\xff\x4f' + b''.join(struct.pack('>HH', m, len(d) + 2) + d for m, d in segs) + rest


def j2k_parts(rest):
    """The tile-parts of a codestream's body, each from its SOT, and what follows the last one."""
    parts, p = [], 0
    while struct.unpack('>H', rest[p:p + 2])[0] == 0xFF90:
        psot = struct.unpack('>I', rest[p + 6:p + 10])[0]
        parts.append(rest[p:p + psot])
        p += psot
    return parts, rest[p:]


def siz_with(segs, **fields):
    """The segments with SIZ's named 32-bit fields changed."""
    names = ['xsiz', 'ysiz', 'xo', 'yo', 'xt', 'yt', 'xto', 'yto']
    out = []
    for m, d in segs:
        if m == 0xFF51:
            values = list(struct.unpack('>8I', d[2:34]))
            for k, v in fields.items():
                values[names.index(k)] = v
            d = d[:2] + struct.pack('>8I', *values) + d[34:]
        out.append((m, d))
    return out


def jpeg2000():
    rgb = save(picture(), 'JPEG2000')
    gray = save(picture(mode='L'), 'JPEG2000')
    cs = save(picture(), 'JPEG2000', no_jp2=True)
    tiled = save(picture(), 'JPEG2000', no_jp2=True, tile_size=(16, 16))
    write('clean/jp2/rgb.jp2', rgb)
    write('clean/jp2/gray.jp2', gray)
    write('clean/jp2/rgba.jp2', save(picture(mode='RGBA'), 'JPEG2000'))
    write('clean/jp2/tiled.jp2', save(picture(), 'JPEG2000', tile_size=(16, 16)))
    write('clean/jp2/layers.jp2', save(picture(), 'JPEG2000', irreversible=True, quality_mode='rates', quality_layers=[40, 20, 10], plt=True))
    write('clean/jp2/codestream.j2c', cs)
    write('clean/jp2/tiled.j2c', tiled)

    sig, ftyp, jp2h, jp2c = boxes_of(rgb)
    ihdr_rgb = boxes_of(jp2h[1])[0][1]
    srgb = box(b'colr', struct.pack('>BBBI', 1, 0, 0, 16))

    def with_header(*inner, codestream=jp2c):
        return join_boxes([sig, ftyp, (b'jp2h', box(b'ihdr', ihdr_rgb) + b''.join(inner)), codestream])

    # A palette image: the gray codestream's one component indexes 256 RGB entries.
    gsig, gftyp, gjp2h, gjp2c = boxes_of(gray)
    ihdr_gray = boxes_of(gjp2h[1])[0][1]
    pclr = struct.pack('>HB', 256, 3) + b'\x07\x07\x07' + b''.join(bytes((i, 255 - i, (i * 7) % 256)) for i in range(256))

    def palette(columns):
        cmap = b''.join(struct.pack('>HBB', 0, 1, c) for c in columns)
        return join_boxes([gsig, gftyp, (b'jp2h', box(b'ihdr', ihdr_gray) + srgb + box(b'pclr', pclr) + box(b'cmap', cmap)), gjp2c])

    write('clean/jp2/palette.jp2', palette([0, 1, 2]))

    shutil.copy(path('clean/jp2/rgb.jp2'), tmp('meta.jp2'))
    run('exiftool', '-q', '-overwrite_original', '-Make=FixtureCam', '-GPSLatitude=45.5', '-GPSLatitudeRef=N', '-XMP-dc:Title=Fixture', '-IPTC:Keywords=fixture', tmp('meta.jp2'))
    shutil.copy(tmp('meta.jp2'), path('meta/jp2/exif-iptc-xmp.jp2'))
    write('meta/jp2/icc.jp2', with_header(box(b'colr', b'\x02\0\0' + SRGB)))
    write('meta/jp2/geojp2-xml.jp2', rgb + box(b'uuid', UUID_GEOJP2 + exif_block(ifd0=[(256, 3, 1, 1), (257, 3, 1, 1)])) + box(b'xml ', b'<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml"/>'))

    write('hostile/jp2/trailing.jp2', rgb + b'TRAILING DATA')
    write('hostile/jp2/hidden-after-eoc.jp2', join_boxes([sig, ftyp, jp2h, (b'jp2c', jp2c[1] + b'HIDDEN AFTER EOC')]))
    write('hostile/jp2/zip-after-eoc.jp2', join_boxes([sig, ftyp, jp2h, (b'jp2c', jp2c[1] + tiny_zip())]))
    write('hostile/jp2/pdf-in-xml.jp2', join_boxes([sig, ftyp, (b'xml ', b'<!-- %PDF-1.7 -->'), jp2h, jp2c]))
    write('hostile/jp2/doctype-xmp.jp2', rgb + box(b'uuid', UUID_XMP + b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x:xmpmeta xmlns:x="adobe:ns:meta/">&e;</x:xmpmeta>'))
    write('hostile/jp2/size-mismatch.jp2', join_boxes([sig, ftyp, (b'jp2h', box(b'ihdr', struct.pack('>IIHBBBB', 24, 64, 3, 7, 7, 0, 0)) + srgb), jp2c]))
    write('hostile/jp2/jpx-brand.jp2', join_boxes([sig, (b'ftyp', b'jpx \0\0\0\0jpx '), jp2h, jp2c]))
    write('hostile/jp2/data-reference.jp2', rgb + box(b'dtbl', struct.pack('>H', 1) + box(b'url ', b'\0\0\0\0http://203.0.113.9/remote.j2c\0')))
    write('hostile/jp2/bad-icc.jp2', with_header(box(b'colr', b'\x02\0\0not a profile')))
    write('hostile/jp2/cmap-column.jp2', palette([0, 1, 5]))
    write('hostile/jp2/second-codestream.jp2', rgb + box(b'jp2c', jp2c[1]))
    write('hostile/jp2/no-header.jp2', join_boxes([sig, ftyp, jp2c]))

    segs, rest = j2k_split(cs)
    write('hostile/jp2/no-eoc.j2c', cs[:-2])
    cod = [(m, d[:5] + b'\x21' + d[6:] if m == 0xFF52 else d) for m, d in segs]
    write('hostile/jp2/levels.j2c', j2k_join(cod, rest))
    write('hostile/jp2/huge.j2c', j2k_join(siz_with(segs, xsiz=100000, ysiz=100000, xt=100000, yt=100000), rest))
    write('hostile/jp2/many-tiles.j2c', j2k_join(siz_with(segs, xsiz=512, ysiz=256, xt=1, yt=1), rest))
    write('hostile/jp2/unknown-marker.j2c', j2k_join(segs + [(0xFF7F, b'private')], rest))

    tsegs, trest = j2k_split(tiled)
    parts, tail = j2k_parts(trest)
    # Tile 0's tile-part numbered 1 where 0 must come first.
    first = parts[0][:10] + b'\x01' + parts[0][11:]
    write('hostile/jp2/tile-part-order.j2c', j2k_join(tsegs, first + b''.join(parts[1:]) + tail))

    def tlm(lengths):
        return b'\x00\x50' + b''.join(struct.pack('>BI', i, n) for i, n in enumerate(lengths))

    wrong = [len(x) for x in parts]
    wrong[2] += 1
    write('hostile/jp2/tlm-wrong.j2c', j2k_join(tsegs + [(0xFF55, tlm(wrong))], trest))

    # A tiled codestream with TLM and a comment in tile-part 1's header, which the rewrite takes out with stripMetadata.
    text = b'A tile-part comment'
    com = struct.pack('>HHH', 0xFF64, 4 + len(text), 1) + text
    p1 = parts[1]
    p1 = p1[:6] + struct.pack('>I', len(p1) + len(com)) + p1[10:12] + com + p1[12:]
    with_com = [parts[0], p1] + parts[2:]
    write('rewrite/jp2-tile-comment-tlm.j2c', j2k_join(tsegs + [(0xFF55, tlm([len(x) for x in with_com]))], b''.join(with_com) + tail))

    # A JP2 with Photoshop resources (IPTC, a JPEG thumbnail, and a resource after it) and EXIF with GPS and a JPEG
    # thumbnail, each in a UUID box.
    thumb = base_jpeg(8, 6)

    def resource(rid, data):
        r = b'8BIM' + struct.pack('>H', rid) + b'\0\0' + struct.pack('>I', len(data)) + data
        return r + (b'\0' if len(data) % 2 else b'')

    resources = resource(0x0404, b'\x1c\x02\x00\x00\x00') + resource(0x040C, struct.pack('>IIIIIIHH', 1, 8, 6, 24, 144, len(thumb), 24, 1) + thumb) + resource(0x0425, bytes(range(16)))
    exif = exif_block(ifd0=[(0x010F, 2, 4, int.from_bytes(b'Cam\0', 'little'))], gps=GPS_ENTRIES, thumb=thumb)
    write('rewrite/jp2-photoshop-exif.jp2', join_boxes([sig, ftyp, jp2h, (b'uuid', UUID_PHOTOSHOP + resources), (b'uuid', UUID_EXIF + exif), jp2c]))
    # A JP2 header holding a colour profile that does not parse, and a box JP2 does not define there.
    write('rewrite/jp2-header-edits.jp2', with_header(box(b'colr', b'\x02\0\0' + tiny_icc()[:100]), box(b'priv', b'private data')))


# ======================================================================
# JPEG XL: codestream headers written bit by bit, since the inspector does not read frames, and metadata from exiftool


JXL_SIG = b'\0\0\0\x0cJXL \r\n\x87\n'
JXL_DIMENSION = [(9, 1), (13, 1), (18, 1), (30, 1)]


def jxl_u32(b, distributions, value):
    """Writes value with the first of four U32 distributions that holds it: a constant, or (bits, offset)."""
    for selector, d in enumerate(distributions):
        if isinstance(d, int):
            if value == d:
                b.put(selector, 2)
                return
        elif d[1] <= value < d[1] + (1 << d[0]):
            b.put(selector, 2)
            b.put(value - d[1], d[0])
            return
    raise ValueError(value)


def jxl_codestream(w, h, bits=8, extra=0, animation=False, tail=bytes(range(32))):
    """A JPEG XL codestream's signature, size header and image header up to its count of extra channels, then `tail`
    where the rest of the header and the frames would be."""
    b = Vp8lBits()
    small = w % 8 == 0 and h % 8 == 0 and w <= 256 and h <= 256
    b.put(small, 1)
    if small:
        b.put(h // 8 - 1, 5)
    else:
        jxl_u32(b, JXL_DIMENSION, h)
    b.put(0, 3)  # no fixed aspect ratio, so the width follows
    if small:
        b.put(w // 8 - 1, 5)
    else:
        jxl_u32(b, JXL_DIMENSION, w)
    if bits == 8 and extra == 0 and not animation:
        b.put(1, 1)  # all_default
    else:
        b.put(0, 1)
        b.put(1 if animation else 0, 1)  # extra_fields
        if animation:
            b.put(0, 3)  # orientation 1
            b.put(0, 1)  # no intrinsic size
            b.put(0, 1)  # no preview
            b.put(1, 1)  # animation: 100 ticks a second, looping forever, no timecodes
            jxl_u32(b, [100, 1000, (10, 1), (30, 1)], 100)
            jxl_u32(b, [1, 1001, (8, 1), (10, 1)], 1)
            jxl_u32(b, [0, (3, 0), (16, 0), (32, 0)], 0)
            b.put(0, 1)
        b.put(0, 1)  # integer samples
        jxl_u32(b, [8, 10, 12, (6, 1)], bits)
        b.put(1, 1)  # 16-bit buffers suffice
        jxl_u32(b, [0, 1, (4, 2), (12, 1)], extra)
    return b'\xff\x0a' + b.bytes() + tail


def jxl_file(*boxes):
    return JXL_SIG + box(b'ftyp', b'jxl \0\0\0\0jxl ') + b''.join(boxes)


def jpegxl():
    small = jxl_codestream(64, 48)
    write('clean/jxl/bare.jxl', small)
    write('clean/jxl/bare-animated.jxl', jxl_codestream(150, 100, bits=16, extra=1, animation=True))
    write('clean/jxl/container.jxl', jxl_file(box(b'jxll', b'\x05'), box(b'jxlc', small)))
    write('clean/jxl/partial.jxl', jxl_file(box(b'jxlp', struct.pack('>I', 0) + small[:3]), box(b'jxlp', struct.pack('>I', 0x80000001) + small[3:])))
    container = read('clean/jxl/container.jxl')

    shutil.copy(path('clean/jxl/container.jxl'), tmp('meta.jxl'))
    run('exiftool', '-q', '-overwrite_original', '-Make=FixtureCam', '-GPSLatitude=45.5', '-GPSLatitudeRef=N', '-XMP-dc:Title=Fixture', tmp('meta.jxl'))
    shutil.copy(tmp('meta.jxl'), path('meta/jxl/exif-xmp.jxl'))
    shutil.copy(path('clean/jxl/container.jxl'), tmp('brob.jxl'))
    run('exiftool', '-q', '-overwrite_original', '-api', 'Compress=1', '-Make=FixtureCam', '-GPSLatitude=45.5', '-GPSLatitudeRef=N', '-XMP-dc:Title=Fixture', tmp('brob.jxl'))
    shutil.copy(tmp('brob.jxl'), path('meta/jxl/brotli.jxl'))
    write('meta/jxl/jumbf.jxl', container + box(b'jumb', box(b'jumd', bytes(16) + b'\x03c2pa\0')))

    thumb = base_jpeg(8, 6)
    write('hostile/jxl/trailing.jxl', container + b'TRAILING DATA')
    write('hostile/jxl/zip-trailing.jxl', container + tiny_zip())
    write('hostile/jxl/jbrd.jxl', container + box(b'jbrd', bytes(range(64))))
    write('hostile/jxl/doctype-xmp.jxl', container + box(b'xml ', b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x:xmpmeta xmlns:x="adobe:ns:meta/">&e;</x:xmpmeta>'))
    exif_thumb = exif_block(ifd0=[(0x010F, 2, 4, int.from_bytes(b'Cam\0', 'little'))], thumb=thumb)
    write('hostile/jxl/brotli-thumbnail.jxl', container + box(b'brob', b'Exif' + brotli.compress(struct.pack('>I', 0) + exif_thumb)))
    write('hostile/jxl/brotli-bomb.jxl', container + box(b'brob', b'xml ' + brotli.compress(b' ' * (9 << 20))))
    write('hostile/jxl/brotli-corrupt.jxl', container + box(b'brob', b'xml not Brotli data'))
    write('hostile/jxl/huge.jxl', jxl_codestream(65536, 65536))
    write('hostile/jxl/deep-samples.jxl', jxl_codestream(64, 48, bits=40))
    write('hostile/jxl/cut-header.jxl', b'\xff\x0a\x00')
    write('hostile/jxl/jxlp-order.jxl', jxl_file(box(b'jxlp', struct.pack('>I', 1) + small[:3]), box(b'jxlp', struct.pack('>I', 0x80000000) + small[3:])))
    write('hostile/jxl/jxlp-unfinished.jxl', jxl_file(box(b'jxlp', struct.pack('>I', 0) + small)))
    write('hostile/jxl/jxlc-and-jxlp.jxl', jxl_file(box(b'jxlc', small), box(b'jxlp', struct.pack('>I', 0x80000000) + small)))
    write('hostile/jxl/no-codestream.jxl', jxl_file(box(b'xml ', b'<x/>')))

    # A gain map: version 0, no metadata, colour encoding or ICC profile, then a bare codestream.
    write('rewrite/jxl-gain-map.jxl', container + box(b'jhgm', b'\0' + struct.pack('>H', 0) + b'\0' + struct.pack('>I', 0) + jxl_codestream(32, 24)))
    # EXIF with a camera name, a GPS IFD and a JPEG thumbnail.
    exif = exif_block(ifd0=[(0x010F, 2, 4, int.from_bytes(b'Cam\0', 'little'))], gps=GPS_ENTRIES, thumb=thumb)
    write('rewrite/jxl-exif-thumbnail.jxl', container + box(b'Exif', struct.pack('>I', 0) + exif))



# ======================================================================
# photoshop: PSD and PSB (Adobe Photoshop File Format)


def packbits(row):
    """PackBits as Photoshop writes RLE rows: literal runs of up to 128 bytes."""
    out = bytearray()
    for i in range(0, len(row), 128):
        piece = row[i:i + 128]
        out += bytes([len(piece) - 1]) + piece
    return bytes(out)


def psd_header(w, h, channels=3, depth=8, mode=3, version=1, reserved=bytes(6)):
    return b'8BPS' + struct.pack('>H', version) + reserved + struct.pack('>HIIHH', channels, h, w, depth, mode)


def psd_resource(rid, data, sig=b'8BIM'):
    """An image resource block with an empty name."""
    return sig + struct.pack('>H', rid) + b'\0\0' + struct.pack('>I', len(data)) + data + (b'\0' if len(data) % 2 else b'')


def psd_tagged(key, data, length_size=4, sig=b'8BIM'):
    return sig + key + struct.pack('>Q' if length_size == 8 else '>I', len(data)) + data


def psd_unicode(text):
    """A Photoshop Unicode string: a count of UTF-16 units, the trailing NUL included, then the units."""
    return struct.pack('>I', len(text) + 1) + text.encode('utf-16-be') + b'\0\0'


def psd_key(k):
    return struct.pack('>I', 0) + k if len(k) == 4 else struct.pack('>I', len(k)) + k


def psd_descriptor(items, cls=b'null'):
    """A descriptor: a name, a class ID, then (key, type, value) items."""
    return psd_unicode('') + psd_key(cls) + struct.pack('>I', len(items)) + b''.join(psd_key(k) + t + v for k, t, v in items)


def psd_descriptor_block(items):
    return struct.pack('>I', 16) + psd_descriptor(items)


def psd_layer(rect, channels, name=b'Layer', blocks=b'', mask=b'', big=False):
    """A layer record: its rectangle, (channel id, data length) pairs, blend mode, and the extra data."""
    top, left, bottom, right = rect
    r = struct.pack('>iiiiH', top, left, bottom, right, len(channels))
    for cid, n in channels:
        r += struct.pack('>h', cid) + struct.pack('>Q' if big else '>I', n)
    r += b'8BIMnorm' + bytes([255, 0, 8, 0])
    pascal = bytes([len(name)]) + name
    pascal += bytes(-len(pascal) % 4)
    extra = struct.pack('>I', len(mask)) + mask + struct.pack('>I', 0) + pascal + blocks
    return r + struct.pack('>I', len(extra)) + extra


def psd_channel(w, h, value, compression=0):
    """One layer channel's image data: its compression code and the rows."""
    rows = [bytes([value]) * w for _ in range(h)]
    if compression == 1:
        packed = [packbits(row) for row in rows]
        return struct.pack('>H', 1) + b''.join(struct.pack('>H', len(x)) for x in packed) + b''.join(packed)
    return struct.pack('>H', 0) + b''.join(rows)


def psd_layer_info(layers, count=None):
    """Layer info: a count, the records, then each layer's channel data, padded to an even length. `layers` holds
    (record arguments, channel data list) pairs; the records get their channel lengths from the data."""
    records = b''
    data = b''
    for args, channels in layers:
        rect, ids = args['rect'], args['ids']
        records += psd_layer(rect, list(zip(ids, [len(c) for c in channels])), **{k: v for k, v in args.items() if k not in ('rect', 'ids')})
        data += b''.join(channels)
    body = struct.pack('>h', len(layers) if count is None else count) + records + data
    return body + bytes(len(body) % 2)


def psd_file(w, h, planes, channels=3, depth=8, mode=3, resources=b'', layer_info=None, blocks=b'', colour=b'', compression=1,
             big=False, version=None, reserved=bytes(6), after=b'', global_mask=True):
    """A Photoshop document. `planes` is the composite's planar data, which goes in raw, RLE or ZIP."""
    out = psd_header(w, h, channels, depth, mode, version or (2 if big else 1), reserved)
    out += struct.pack('>I', len(colour)) + colour
    out += struct.pack('>I', len(resources)) + resources
    lm = b''
    if layer_info is not None or blocks:
        li = layer_info or b''
        lm = (struct.pack('>Q' if big else '>I', len(li)) + li) + (struct.pack('>I', 0) if global_mask else b'') + blocks
    out += struct.pack('>Q' if big else '>I', len(lm)) + lm
    row = (w * depth + 7) // 8
    if compression == 0:
        out += struct.pack('>H', 0) + planes
    elif compression == 1:
        rows = [packbits(planes[i:i + row]) for i in range(0, len(planes), row)]
        out += struct.pack('>H', 1) + b''.join(struct.pack('>I' if big else '>H', len(x)) for x in rows) + b''.join(rows)
    else:
        out += struct.pack('>H', compression) + zlib.compress(planes)
    return out + after


def psd_planes(w, h, channels=3):
    return b''.join(bytes(((x * 8 + y * 3 + c * 50) & 0xFF) for y in range(h) for x in range(w)) for c in range(channels))


def psd_linked(kind, version, name, ftype, data=b'', open_items=None, file_items=None):
    """An item of a linked layer block, with its length and its padding to four bytes."""
    body = kind + struct.pack('>I', version) + bytes([4]) + b'uid1' + psd_unicode(name) + ftype + b'8BIM' + struct.pack('>Q', len(data))
    body += (b'\x01' + psd_descriptor_block(open_items)) if open_items is not None else b'\x00'
    if kind == b'liFE':
        body += psd_descriptor_block(file_items or [])
        if version > 3:
            body += struct.pack('>IBBBBd', 2026, 10, 11, 12, 0, 0.0)
        body += struct.pack('>Q', len(data))
        if version > 2:
            body += data
    elif kind == b'liFA':
        body += bytes(8)
    else:
        body += data
    if version >= 5:
        body += psd_unicode('child')
    if version >= 6:
        body += struct.pack('>d', 0.0)
    if version >= 7:
        body += b'\0'
    return struct.pack('>Q', len(body)) + body + bytes(-len(body) % 4)


def photoshop():
    picture().save(tmp('src.png'))
    picture(mode='RGBA').save(tmp('alpha.png'))
    run('convert', tmp('src.png'), path('clean/psd/flat.psd'))
    run('convert', tmp('src.png'), tmp('src.png'), tmp('alpha.png'), path('clean/psd/layers.psd'))
    run('convert', tmp('src.png'), '-colorspace', 'gray', path('clean/psd/gray.psd'))
    run('convert', tmp('src.png'), '-colors', '16', '-type', 'Palette', path('clean/psd/palette.psd'))
    run('convert', tmp('src.png'), '-colorspace', 'CMYK', path('clean/psd/cmyk.psd'))
    run('convert', tmp('src.png'), '-depth', '16', path('clean/psd/depth16.psd'))
    run('convert', tmp('src.png'), 'PSB:' + path('clean/psd/flat.psb'))
    planes = psd_planes(32, 24)
    write('clean/psd/raw.psd', psd_file(32, 24, planes, compression=0))
    write('clean/psd/zip.psd', psd_file(32, 24, planes, compression=2))
    # Two layers with RLE and raw channels, one of them off the canvas, and a negative count for merged transparency.
    layers = psd_layer_info([
        ({'rect': (0, 0, 24, 32), 'ids': [-1, 0, 1, 2], 'blocks': psd_tagged(b'luni', psd_unicode('Back'))},
         [psd_channel(32, 24, 255, 1), psd_channel(32, 24, 10, 1), psd_channel(32, 24, 20, 1), psd_channel(32, 24, 30, 1)]),
        ({'rect': (-4, -4, 8, 12), 'ids': [0, 1, 2], 'name': b'Offset'}, [psd_channel(16, 12, 40), psd_channel(16, 12, 50), psd_channel(16, 12, 60)]),
    ], count=-2)
    write('clean/psd/hand-layers.psd', psd_file(32, 24, planes, layer_info=layers, blocks=psd_tagged(b'Patt', b'')))
    # 16-bit layers go in an Lr16 block, and the section's own layer info is empty.
    lr16 = psd_layer_info([({'rect': (0, 0, 2, 2), 'ids': [0, 1, 2]}, [psd_channel(4, 2, 7)] * 3)])
    write('clean/psd/lr16.psd', psd_file(32, 24, psd_planes(64, 24), depth=16, layer_info=b'', blocks=psd_tagged(b'Lr16', lr16), compression=0))

    flat = read('clean/psd/flat.psd')
    shutil.copy(path('clean/psd/flat.psd'), tmp('meta.psd'))
    run('exiftool', '-q', '-overwrite_original', '-Make=FixtureCam', '-GPSLatitude=45.5', '-GPSLatitudeRef=N', '-XMP-dc:Title=Fixture', '-IPTC:Keywords=fixture',
        tmp('meta.psd'))
    shutil.copy(tmp('meta.psd'), path('meta/psd/exif-iptc-xmp.psd'))
    thumb = base_jpeg(8, 6)
    thumb_resource = struct.pack('>IIIIIIHH', 1, 8, 6, 24, 144, len(thumb), 24, 1) + thumb
    write('meta/psd/resources.psd', psd_file(32, 24, planes, resources=b''.join([
        psd_resource(0x03ED, struct.pack('>IHHIHH', 72 << 16, 1, 1, 72 << 16, 1, 1)),
        psd_resource(0x040F, tiny_icc()),
        psd_resource(0x03F0, b'\x07Caption'),
        psd_resource(0x041E, struct.pack('>I', 1) + struct.pack('>II', 0, 1) + psd_unicode('http://203.0.113.9/')),
        psd_resource(0x041A, struct.pack('>I', 6) + bytes(16) + psd_unicode('slices') + struct.pack('>I', 0)),
    ])))
    write('meta/psd/annotations.psd', psd_file(32, 24, planes, layer_info=b'', blocks=psd_tagged(b'Anno', struct.pack('>HHI', 2, 1, 0))))

    write('hostile/psd/trailing.psd', flat + b'<html><script>alert(1)</script></html>')
    write('hostile/psd/zip-trailing.psd', flat + tiny_zip())
    write('hostile/psd/version.psd', psd_file(32, 24, planes, version=3))
    write('hostile/psd/reserved.psd', psd_file(32, 24, planes, reserved=b'HIDDEN'))
    write('hostile/psd/channels.psd', psd_file(32, 24, b'', channels=57))
    write('hostile/psd/huge.psd', psd_header(30000, 30000) + bytes(14))
    write('hostile/psd/indexed-no-palette.psd', psd_file(32, 24, psd_planes(32, 24, 1), channels=1, mode=2))
    write('hostile/psd/negative-rectangle.psd', psd_file(32, 24, planes, layer_info=psd_layer_info([({'rect': (10, 0, 2, 4), 'ids': [0]}, [psd_channel(4, 1, 0)])])))
    write('hostile/psd/channel-compression.psd', psd_file(32, 24, planes, layer_info=psd_layer_info([({'rect': (0, 0, 1, 1), 'ids': [0]}, [struct.pack('>H', 7) + b'\0'])])))
    long_channel = psd_layer_info([({'rect': (0, 0, 1, 1), 'ids': [0]}, [psd_channel(1, 1, 0)])])
    long_channel = long_channel.replace(struct.pack('>hI', 0, 3), struct.pack('>hI', 0, 3000), 1)
    write('hostile/psd/channel-length.psd', psd_file(32, 24, planes, layer_info=long_channel))
    write('hostile/psd/huge-layer.psd', psd_file(32, 24, planes, layer_info=psd_layer_info([({'rect': (0, 0, 70000, 70000), 'ids': [0]}, [b''])])))
    write('hostile/psd/zip-bomb.psd', psd_header(32, 24) + bytes(12) + struct.pack('>H', 2) + zlib.compress(bytes(10_000_000), 9))
    write('hostile/psd/rle-short.psd', psd_file(32, 24, planes)[:-40])
    write('hostile/psd/unknown-block.psd', psd_file(32, 24, planes, layer_info=b'', blocks=psd_tagged(b'zzzz', b'private data')))
    hidden = psd_layer_info([({'rect': (0, 0, 1, 1), 'ids': [0]}, [psd_channel(1, 1, 0)])]) + b'HIDDEN'
    write('hostile/psd/hidden-layer-info.psd', psd_file(32, 24, planes, layer_info=hidden))
    write('hostile/psd/doctype-xmp.psd', psd_file(32, 24, planes, resources=psd_resource(0x0424, b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x:xmpmeta xmlns:x="adobe:ns:meta/">&e;</x:xmpmeta>')))
    write('hostile/psd/bad-icc.psd', psd_file(32, 24, planes, resources=psd_resource(0x040F, b'not a profile')))
    write('hostile/psd/pdf-in-caption.psd', psd_file(32, 24, planes, resources=psd_resource(0x03F0, b'\x20%PDF-1.7 1 0 obj << >> endobj')))

    # Linked files: an embedded PNG, a link to a file outside, and an alias, with descriptors of the types Photoshop
    # writes; and a block whose descriptor holds a type no reader defines.
    png_file = save(picture(8, 6), 'PNG')
    open_items = [(b'compInfo', b'Objc', psd_descriptor([(b'compID', b'long', struct.pack('>i', -1)), (b'originalCompID', b'long', struct.pack('>i', -1))])),
                  (b'Wdth', b'UntF', b'#Pxl' + struct.pack('>d', 8.0)), (b'Rslt', b'doub', struct.pack('>d', 72.0)), (b'Lyrs', b'bool', b'\x01'),
                  (b'Nm  ', b'TEXT', psd_unicode('open')), (b'Md  ', b'enum', psd_key(b'Md  ') + psd_key(b'RGBC')),
                  (b'list', b'VlLs', struct.pack('>I', 2) + b'long' + struct.pack('>i', 1) + b'TEXT' + psd_unicode('x')),
                  (b'raw ', b'tdta', struct.pack('>I', 3) + b'abc'), (b'big ', b'comp', struct.pack('>q', 1)),
                  (b'ref ', b'obj ', struct.pack('>I', 1) + b'Enmr' + psd_unicode('') + psd_key(b'Lyr ') + psd_key(b'Ordn') + psd_key(b'Trgt'))]
    file_items = [(b'fullPath', b'TEXT', psd_unicode('/Users/someone/linked.png')), (b'relPath', b'TEXT', psd_unicode('linked.png'))]
    items = (psd_linked(b'liFD', 7, 'embedded.png', b'PNG ', png_file, open_items=open_items)
             + psd_linked(b'liFE', 7, 'linked.png', b'PNG ', b'', file_items=file_items)
             + psd_linked(b'liFA', 2, 'alias.png', b'PNG ', b''))
    write('rewrite/psd-linked.psd', psd_file(32, 24, planes, layer_info=b'', blocks=psd_tagged(b'lnk2', items) + psd_tagged(b'Patt', b'')))
    odd = psd_linked(b'liFD', 3, 'embedded.png', b'PNG ', png_file, open_items=[(b'odd ', b'XXXX', b'')])
    write('hostile/psd/linked-unknown-type.psd', psd_file(32, 24, planes, layer_info=b'', blocks=psd_tagged(b'lnk2', odd)))
    write('rewrite/psd-thumbnail.psd', psd_file(32, 24, planes, resources=psd_resource(0x040C, thumb_resource)))
    # EXIF with a JPEG thumbnail, which goes to the plugins, and EXIF whose thumbnail pointer has 0 bytes, as Photoshop
    # writes it.
    exif = exif_block(ifd0=[(0x010F, 2, 4, int.from_bytes(b'Cam\0', 'little'))], thumb=thumb)
    write('hostile/psd/exif-thumbnail.psd', psd_file(32, 24, planes, resources=psd_resource(0x03ED, bytes(16)) + psd_resource(0x0422, exif)))
    empty = exif_block(ifd0=[(0x010F, 2, 4, int.from_bytes(b'Cam\0', 'little'))], thumb=b'')
    write('hostile/psd/exif-empty-thumbnail.psd', psd_file(32, 24, planes, resources=psd_resource(0x03ED, bytes(16)) + psd_resource(0x0422, empty)))



# ======================================================================
# metafile: EMF with EMF+ ([MS-EMF], [MS-EMFPLUS]) and WMF ([MS-WMF]), built record by record


def emr(kind, payload):
    """An EMF record: its type, its size padded to four bytes, and its parameters."""
    size = 8 + len(payload)
    pad = -size % 4
    return struct.pack('<II', kind, size + pad) + payload + bytes(pad)


def emf_header(frame=(0, 0, 1693, 1270), description=None, records=0, total=0, size=108):
    """EMR_HEADER with both extensions: a 64 x 48 picture at 96 pixels an inch, and an optional description."""
    desc = description.encode('utf-16-le') if description is not None else b''
    off = size if desc else 0
    body = struct.pack('<4i4i', 0, 0, 63, 47, *frame) + b' EMF' + struct.pack('<IIIHHIII', 0x10000, total, records, 1, 0, len(desc) // 2, off, 0)
    body += struct.pack('<4i', 1920, 1080, 508, 286) + struct.pack('<III', 0, 0, 0) + struct.pack('<II', 508000, 285750)
    rec = struct.pack('<II', 1, 0) + body
    rec = rec[:size] + desc
    rec += bytes(-len(rec) % 4)
    return rec[:4] + struct.pack('<I', len(rec)) + rec[8:]


EMF_EOF = emr(0x0E, struct.pack('<III', 0, 16, 20))


def emf_file(records, description=None, nbytes=None, nrecords=None, after=b'', eof=EMF_EOF):
    """An EMF of the records given between its header and EMR_EOF, with the header's byte and record counts."""
    body = b''.join(records) + eof
    head = emf_header(description=description)
    total = len(head) + len(body)
    head = emf_header(description=description, records=len(records) + 2 if nrecords is None else nrecords, total=total if nbytes is None else nbytes)
    return head + body + after


def emr_rectangle(l=4, t=4, r=40, b=30):
    return emr(0x2B, struct.pack('<4i', l, t, r, b))


def dib(w, h, bpp=24, compression=0, bits=None, colors=b''):
    """A BITMAPINFOHEADER, a color table and bits; uncompressed bits fill every row when not given."""
    stride = (w * bpp + 31) // 32 * 4
    data = bits if bits is not None else bytes(((x * 7) & 0xFF) for x in range(stride * h))
    head = struct.pack('<IiiHHIIiiII', 40, w, h, 1, bpp, compression, len(data), 2835, 2835, len(colors) // 4, 0)
    return head + colors, data


def emr_stretchdibits(w, h, bpp=24, compression=0, bits=None, colors=b''):
    head, data = dib(w, h, bpp, compression, bits, colors)
    fixed = struct.pack('<4i', 0, 0, w - 1, h - 1) + struct.pack('<6i', 0, 0, 0, 0, w, h)
    fixed += struct.pack('<IIII', 80, len(head), 80 + len(head), len(data)) + struct.pack('<IIii', 0, 0x00CC0020, w, h)
    return emr(0x51, fixed + head + data)


def emf_plus(*records):
    """An EMR_COMMENT holding EMF+ records."""
    data = b'EMF+' + b''.join(records)
    return emr(0x46, struct.pack('<I', len(data)) + data)


def emfp(kind, flags, data):
    pad = -len(data) % 4
    return struct.pack('<HHII', kind, flags, 12 + len(data) + pad, len(data) + pad) + data + bytes(pad)


EMFP_HEADER = emfp(0x4001, 1, struct.pack('<IIII', 0xDBC01002, 1, 96, 96))
EMFP_EOF = emfp(0x4002, 0, b'')


def emfp_image(object_id, file, metafile_type=None):
    """An EmfPlusObject holding an image: a compressed bitmap, or a metafile of the type given."""
    if metafile_type is None:
        payload = struct.pack('<II', 0xDBC01002, 1) + struct.pack('<iiiII', 0, 0, 0, 0, 1) + file
    else:
        payload = struct.pack('<II', 0xDBC01002, 2) + struct.pack('<II', metafile_type, len(file)) + file
    return payload


def emfp_continued(object_id, payload, part):
    """The payload of an image object split into continued EmfPlusObject records of `part` bytes."""
    out = []
    for at in range(0, len(payload), part):
        piece = payload[at:at + part]
        out.append(emfp(0x4008, 0x8000 | (5 << 8) | object_id, struct.pack('<I', len(payload)) + piece))
    return out


def emr_comment_public(kind, data):
    body = b'GDIC' + struct.pack('<I', kind) + data
    return emr(0x46, struct.pack('<I', len(body)) + body)


def wmr(fn, params=b''):
    """A WMF record: its size in words, its function, and its parameters."""
    params += bytes(len(params) % 2)
    return struct.pack('<IH', 3 + len(params) // 2, fn) + params


def wmf_file(records, objects=1, placeable=True, size=None, largest=None, after=b'', eof=None, checksum=None, key=0x9AC6CDD7):
    body = b''.join(records) + (eof if eof is not None else wmr(0))
    sizes = []
    p = 0
    while p < len(body):
        n = struct.unpack_from('<I', body, p)[0]
        sizes.append(n)
        p += n * 2
    words = (18 + len(body)) // 2
    head = struct.pack('<HHHIHIH', 1, 9, 0x300, words if size is None else size, objects, max(sizes) if largest is None else largest, 0)
    out = head + body + after
    if placeable:
        pl = struct.pack('<IH4hHI', key, 0, 0, 0, 64, 48, 96, 0)
        sum_ = 0
        for i in range(10):
            sum_ ^= struct.unpack_from('<H', pl, i * 2)[0]
        out = pl + struct.pack('<H', sum_ if checksum is None else checksum) + out
    return out


WMF_DRAW = [wmr(0x020B, struct.pack('<hh', 0, 0)), wmr(0x020C, struct.pack('<hh', 48, 64)), wmr(0x02FC, struct.pack('<HIH', 0, 0x00336699, 0)),
            wmr(0x012D, struct.pack('<H', 0)), wmr(0x041B, struct.pack('<4h', 30, 40, 4, 4)), wmr(0x01F0, struct.pack('<H', 0))]


def wmr_stretchdib(w, h, bpp=24, compression=0, bits=None, colors=b''):
    head, data = dib(w, h, bpp, compression, bits, colors)
    return wmr(0x0F43, struct.pack('<IH8h', 0x00CC0020, 0, h, w, 0, 0, h, w, 0, 0) + head + data)


def wmr_bitblt16(w, h, bpp=1, short=0):
    stride = ((w * bpp + 15) >> 4) << 1
    bits = bytes(stride * h - short)
    return wmr(0x0922, struct.pack('<I6h', 0x00CC0020, 0, 0, h, w, 0, 0) + struct.pack('<hhhhBB', 0, w, h, stride, 1, bpp) + bits)


def metafile():
    # Real tool output, which a rewrite changes: Inkscape writes private comments into EMF and an escape into WMF.
    with open(tmp('d.svg'), 'w') as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect x="4" y="4" width="40" height="30" fill="#3a6"/>'
                '<circle cx="40" cy="30" r="12" fill="#c33"/></svg>')
    run('inkscape', '--export-type=emf', '--export-filename=' + path('quirks/inkscape.emf'), tmp('d.svg'))
    run('inkscape', '--export-type=wmf', '--export-filename=' + path('quirks/inkscape.wmf'), tmp('d.svg'))

    png_file = save(picture(8, 6), 'PNG')
    write('clean/emf/rectangle.emf', emf_file([emr_rectangle()]))
    write('clean/emf/description.emf', emf_file([emr_rectangle()], description='Fixture\0Picture\0\0'))
    write('clean/emf/dib.emf', emf_file([emr_stretchdibits(8, 6)]))
    rle = bytes([4, 1, 4, 2, 0, 0]) * 6 + bytes([0, 1])
    write('clean/emf/dib-rle8.emf', emf_file([emr_stretchdibits(8, 6, bpp=8, compression=1, bits=rle, colors=bytes(range(16)))]))
    write('clean/emf/groups.emf', emf_file([emr_comment_public(2, struct.pack('<4iI', 0, 0, 63, 47, 0)), emr_rectangle(), emr_comment_public(3, b'')]))
    fill = emfp(0x400A, 0x8000, struct.pack('<II', 0xFF336699, 1) + struct.pack('<4f', 4, 4, 36, 26))
    write('clean/emf/emfplus.emf', emf_file([emf_plus(EMFP_HEADER, fill), emr_rectangle(), emf_plus(EMFP_EOF)]))
    write('clean/wmf/rectangle.wmf', wmf_file(WMF_DRAW))
    write('clean/wmf/plain.wmf', wmf_file(WMF_DRAW, placeable=False))
    write('clean/wmf/dib.wmf', wmf_file(WMF_DRAW + [wmr_stretchdib(8, 6)]))
    write('clean/wmf/bitmap16.wmf', wmf_file(WMF_DRAW + [wmr_bitblt16(16, 4)]))

    rect = read('clean/emf/rectangle.emf')
    wmf = read('clean/wmf/rectangle.wmf')
    write('hostile/emf/trailing.emf', rect + b'<?php system($_GET["c"]); ?>')
    write('hostile/emf/zip-trailing.emf', rect + tiny_zip())
    write('hostile/emf/escapes.emf', emf_file([emr(0x6A, struct.pack('<II', 0x1013, 4) + b'%!PS'), emr(0x69, struct.pack('<II', 0x0013, 4) + b'data'),
                                              emr(0x6E, struct.pack('<III', 0x1013, 8, 4) + 'drv\0'.encode('utf-16-le') + b'data'), emr_rectangle()]))
    lcs = b'PSOC' + struct.pack('<IIII', 0x400, 588, 0, 4) + bytes(36) + struct.pack('<III', 0, 0, 0) + '\\\\203.0.113.9\\share\\x.icc'.encode('utf-16-le').ljust(520, b'\0')
    profile_name = b'\\\\203.0.113.9\\share\\y.icc\0'
    write('hostile/emf/linked-profile.emf', emf_file([emr(0x7A, struct.pack('<I', 1) + lcs + struct.pack('<II', 0, 0)),
                                                     emr(0x70, struct.pack('<III', 0, len(profile_name), 0) + profile_name), emr_rectangle()]))
    write('hostile/emf/unknown-record.emf', emf_file([emr(0x75, b'private'), emr_rectangle()]))
    write('hostile/emf/private-comment.emf', emf_file([emr(0x46, struct.pack('<I', 8) + b'APPXdata'), emr_rectangle()]))
    # An EMFSPOOL comment, identifier 0, whose spool data a printer's spooler reads and a viewer never draws.
    write('hostile/emf/spool-comment.emf', emf_file([emr(0x46, struct.pack('<II', 16, 0) + b'spool record'), emr_rectangle()]))
    write('hostile/emf/no-eof.emf', rect[:-20])
    write('hostile/emf/record-size.emf', emf_file([struct.pack('<II', 0x2B, 26) + bytes(18)]))
    write('hostile/emf/second-header.emf', emf_file([emf_header()]))
    write('hostile/emf/dib-short.emf', emf_file([emr_stretchdibits(8, 6, bits=bytes(40))]))
    write('hostile/emf/dib-huge.emf', emf_file([emr_stretchdibits(70000, 70000, bpp=1, bits=bytes(4), colors=bytes(8))]))
    write('hostile/emf/rle-outside.emf', emf_file([emr_stretchdibits(8, 6, bpp=8, compression=1, bits=bytes([20, 1, 0, 1]), colors=bytes(16))]))
    write('hostile/emf/bytes-short.emf', emf_file([emr_rectangle(), emr_rectangle()], nbytes=120))
    write('hostile/emf/records-short.emf', emf_file([emr_rectangle(), emr_rectangle()], nrecords=2))
    write('hostile/emf/counts-long.emf', emf_file([emr_rectangle()], nrecords=99, nbytes=99999))
    html = b'<html><script>alert(1)</script></html>'
    write('hostile/emf/emfplus-html.emf', emf_file([emf_plus(EMFP_HEADER), emf_plus(emfp(0x4008, (5 << 8) | 1, emfp_image(1, html))), emf_plus(EMFP_EOF)]))
    payload = emfp_image(2, png_file)
    parts = emfp_continued(2, payload, 100)
    write('hostile/emf/emfplus-unfinished.emf', emf_file([emf_plus(EMFP_HEADER), emf_plus(*parts[:-1]), emr_rectangle(), emf_plus(EMFP_EOF)]))
    write('hostile/emf/emfplus-unknown.emf', emf_file([emf_plus(EMFP_HEADER, emfp(0x4100, 0, b'xxxx'), EMFP_EOF)]))
    pdf = b'%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'
    formats = struct.pack('<4iI', 0, 0, 63, 47, 1) + struct.pack('<IIII', 0x50444620, 0, len(pdf), 44) + pdf
    write('hostile/emf/multiformats-pdf.emf', emf_file([emr_comment_public(0x40000004, formats), emr_rectangle()]))
    inner = read('clean/wmf/plain.wmf')
    write('hostile/emf/windows-metafile.emf', emf_file([emr_comment_public(0x80000001, struct.pack('<HHIII', 0x300, 0, 0, 0, len(inner)) + inner), emr_rectangle()]))

    write('hostile/wmf/trailing.wmf', wmf + b'<?php system($_GET["c"]); ?>')
    write('hostile/wmf/abort-proc.wmf', wmf_file(WMF_DRAW + [wmr(0x0626, struct.pack('<HH', 9, 4) + b'\x90\x90\x90\xc3')]))
    write('hostile/wmf/escape.wmf', wmf_file(WMF_DRAW + [wmr(0x0626, struct.pack('<HH', 0x0F, 4) + b'data')]))
    write('hostile/wmf/unknown-function.wmf', wmf_file(WMF_DRAW + [wmr(0x0999, b'xx')]))
    write('hostile/wmf/size-short.wmf', wmf_file(WMF_DRAW, size=20))
    write('hostile/wmf/objects.wmf', wmf_file(WMF_DRAW[:3] + WMF_DRAW[2:3], objects=1))
    write('hostile/wmf/counts.wmf', wmf_file(WMF_DRAW, size=999, largest=2, checksum=0x1234))
    write('hostile/wmf/eof-hidden.wmf', wmf_file(WMF_DRAW, eof=struct.pack('<IH', 6, 0) + b'HIDDEN'))
    write('hostile/wmf/header-size.wmf', wmf[:24] + b'\x08' + wmf[25:])
    write('hostile/wmf/no-eof.wmf', wmf[:-6])
    write('hostile/wmf/bitmap16-short.wmf', wmf_file(WMF_DRAW + [wmr_bitblt16(16, 4, short=4)]))
    write('hostile/wmf/rle-outside.wmf', wmf_file(WMF_DRAW + [wmr_stretchdib(8, 6, bpp=8, compression=1, bits=bytes([20, 1, 0, 1]), colors=bytes(16))]))

    # EMF+ images a plugin can rewrite: one in a single record and one continued over three records, and a metafile.
    write('rewrite/emfplus-images.emf', emf_file([emf_plus(EMFP_HEADER), emf_plus(emfp(0x4008, (5 << 8) | 0, emfp_image(0, png_file))),
                                                 emf_plus(parts[0]), emf_plus(*parts[1:]), emf_plus(emfp(0x4021, 0, b'')),
                                                 emf_plus(emfp(0x4008, (5 << 8) | 3, emfp_image(3, inner, metafile_type=1))), emr_rectangle(), emf_plus(EMFP_EOF)]))


GROUPS = {'jpeg2000': jpeg2000, 'jpegxl': jpegxl, 'photoshop': photoshop, 'metafile': metafile}


def main():
    # One named group rebuilds over the fixtures already there, so the rest keep their bytes.
    if len(sys.argv) > 1:
        try:
            for name in sys.argv[1:]:
                GROUPS[name]()
        finally:
            shutil.rmtree(TMP, ignore_errors=True)
        return
    # The cases manifest is hand-kept (it records the pre-fix verdict, which this script cannot recompute), so carry it
    # across the rebuild rather than lose it to the rmtree.
    manifest_path = os.path.join(OUT, 'cases', 'manifest.json')
    manifest = open(manifest_path, 'rb').read() if os.path.isfile(manifest_path) else None
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    try:
        clean()
        meta()
        hostile()
        quirks()
        detect()
        cases()
        rewrite()
        jpeg2000()
        jpegxl()
        photoshop()
        metafile()
        if manifest is not None:
            write('cases/manifest.json', manifest)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    count = sum(len(files) for _, _, files in os.walk(OUT))
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, files in os.walk(OUT) for f in files)
    print(f'{count} fixtures, {size // 1024} kB, in {OUT}')


if __name__ == '__main__':
    main()
