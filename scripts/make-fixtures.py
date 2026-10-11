#!/usr/bin/env python3
"""Rebuilds test/fixtures.

clean/ holds images from Pillow, ImageMagick's convert, cjpeg, gifsicle and the libwebp tools.
meta/ holds images with metadata added by exiftool, Pillow and webpmux.
quirks/ holds real tool output that a rewrite would change: ImageMagick's own GIF extension, and
the stray TIFF header Pillow leaves between pages.
hostile/ holds files built byte by byte: bombs, bad checksums, truncation, trailing and hidden
data, polyglots, loops, overlaps and huge dimensions.
detect/ holds the signatures of formats this version recognizes but does not read.

Run it with `python3 -I scripts/make-fixtures.py`. It needs Pillow, convert, cjpeg, gifsicle,
cwebp, img2webp, gif2webp, webpmux and exiftool on the PATH.
"""

import io
import os
import shutil
import struct
import subprocess
import tempfile
import zipfile
import zlib

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
    write('detect/jp2.jp2', b'\0\0\0\x0cjP  \r\n\x87\n' + bytes(20))
    write('detect/j2k.j2k', b'\xff\x4f\xff\x51' + bytes(20))
    write('detect/jxl.jxl', b'\xff\x0a' + bytes(20))
    write('detect/jxl-box.jxl', b'\0\0\0\x0cJXL \r\n\x87\n' + bytes(20))
    write('detect/psd.psd', b'8BPS\0\x01' + bytes(30))
    write('detect/emf.emf', struct.pack('<II', 1, 108) + bytes(32) + b' EMF' + bytes(64))
    write('detect/wmf.wmf', b'\xd7\xcd\xc6\x9a' + bytes(40))
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


def main():
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
        if manifest is not None:
            write('cases/manifest.json', manifest)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    count = sum(len(files) for _, _, files in os.walk(OUT))
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, files in os.walk(OUT) for f in files)
    print(f'{count} fixtures, {size // 1024} kB, in {OUT}')


if __name__ == '__main__':
    main()
