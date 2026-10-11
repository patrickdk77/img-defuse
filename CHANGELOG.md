# Changelog

## Unreleased

- `engines` now asks for Node 18 instead of 22. Nothing in the package needed 22.
- PNG chunk CRCs use zlib.crc32 where Node has it, about 50 times faster than the lookup table. Node 18 and early releases of Node 20 and 22 lack it and keep the table.

## 0.1.0 - 2026-10-10

First release.
