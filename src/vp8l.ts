/**
 * Reads the structure of a VP8L (lossless WebP) bitstream the way libwebp's vp8l_dec.c does, and builds every prefix
 * code the way its huffman_utils.c builds them, so a stream libwebp refuses is refused here too. That covers
 * CVE-2023-4863: code lengths that made libwebp's table construction write past its fixed-size buffer.
 *
 * The image's own pixels are never decoded. The small images the bitstream carries before the prefix codes are: the
 * predictor, cross-color and color-indexing transform data, and the entropy image that picks a code group for each
 * block. Each is decoded symbol by symbol, since nothing else says where it ends, and only the entropy image's values
 * are used. A ring buffer of at most 2^20 values covers every distance a backward reference can reach.
 */

const NUM_LITERAL_CODES = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const MAX_ALLOWED_CODE_LENGTH = 15;
const HUFFMAN_TABLE_BITS = 8;
const LENGTHS_TABLE_BITS = 7;
const NUM_CODE_LENGTH_CODES = 19;
const MAX_CACHE_BITS = 11;

/** The five codes of a group: green with length prefixes and cache indexes, red, blue, alpha, distance prefixes. */
const ALPHABET = [NUM_LITERAL_CODES + NUM_LENGTH_CODES, NUM_LITERAL_CODES, NUM_LITERAL_CODES, NUM_LITERAL_CODES, NUM_DISTANCE_CODES];
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const REPEAT_EXTRA_BITS = [2, 3, 7];
const REPEAT_OFFSETS = [3, 3, 11];

/**
 * The largest lookup table one group's five codes can need when each code is complete, by color cache bits. libwebp
 * sized a fixed buffer from these before CVE-2023-4863 was fixed. Computed with zlib's enough.c for 8-bit root tables.
 */
const FIXED_TABLE_SIZE = 630 * 3 + 410;
const TABLE_SIZE = [654, 656, 658, 662, 670, 686, 718, 782, 912, 1168, 1680, 2704].map(n => FIXED_TABLE_SIZE + n);

/** Distance codes 1 to 120 name a nearby pixel by row and column offset. */
const CODE_TO_PLANE = [
  0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a, 0x26, 0x2a, 0x38, 0x05, 0x37, 0x39, 0x15, 0x1b, 0x36, 0x3a, 0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b, 0x46, 0x4a, 0x24,
  0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03, 0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d, 0x44, 0x4c, 0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e, 0x66, 0x6a, 0x22, 0x2e, 0x54, 0x5c,
  0x43, 0x4d, 0x65, 0x6b, 0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f, 0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b, 0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e, 0x00, 0x74, 0x7c,
  0x41, 0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f, 0x40, 0x72, 0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
];

/** Why the stream is refused. */
class Vp8lError extends Error {}

function fail(reason: string): never {
  throw new Vp8lError(reason);
}

/** Bits read least significant first from a stream fetched in windows. Bits past the end read as 0, as in libwebp. */
class Bits {
  private window: Uint8Array = new Uint8Array(0);
  private windowAt = 0;
  /** Bits consumed from the start of the stream. */
  at = 0;

  constructor(
    private readonly readAt: (offset: number, length: number) => Promise<Uint8Array>,
    readonly length: number,
  ) {}

  /** Set once more bits have been consumed than the stream holds. libwebp calls this end of stream and refuses. */
  get ended(): boolean {
    return this.at > this.length * 8;
  }

  /** Bits left, negative past the end. */
  get left(): number {
    return this.length * 8 - this.at;
  }

  /** Loads the next window when fewer than 32 bytes of it lie ahead and the stream has more. */
  async need(): Promise<void> {
    const byte = Math.floor(this.at / 8);
    const windowEnd = this.windowAt + this.window.length;
    if (byte + 32 <= windowEnd || windowEnd >= this.length || byte >= this.length) return;
    this.windowAt = byte;
    this.window = await this.readAt(byte, 65536);
  }

  private byte(i: number): number {
    if (i >= this.length) return 0;
    const j = i - this.windowAt;
    if (j < 0 || j >= this.window.length) throw new Error('the VP8L reader read outside its window');
    return this.window[j];
  }

  /** The next `n` bits, at most 24, without consuming them. */
  peek(n: number): number {
    const i = Math.floor(this.at / 8);
    const v = (this.byte(i) | (this.byte(i + 1) << 8) | (this.byte(i + 2) << 16) | (this.byte(i + 3) << 24)) >>> (this.at & 7);
    return v & ((1 << n) - 1);
  }

  skip(n: number): void {
    this.at += n;
  }

  read(n: number): number {
    const v = this.peek(n);
    this.at += n;
    return v;
  }
}

/** A lookup table as libwebp builds it: an 8-bit (or 7-bit) root table, then second-level tables. */
interface Table {
  bits: Uint8Array;
  value: Uint16Array;
}

/** Returns reverse(reverse(key, len) + 1, len): the next code of length `len`, bit-reversed. */
function nextKey(key: number, len: number): number {
  let step = 1 << (len - 1);
  while (key & step) step >>= 1;
  return step ? (key & (step - 1)) + step : key;
}

/** Stores the entry at table[at], table[at + step], ... below table[at + end]. */
function replicate(t: Table, at: number, step: number, end: number, bits: number, value: number): void {
  for (let i = end - step; i >= 0; i -= step) {
    t.bits[at + i] = bits;
    t.value[at + i] = value;
  }
}

/** The width in bits of the next second-level table. */
function nextTableBits(count: Int32Array, length: number, rootBits: number): number {
  let len = length;
  let left = 1 << (len - rootBits);
  while (len < MAX_ALLOWED_CODE_LENGTH) {
    left -= count[len];
    if (left <= 0) break;
    len++;
    left <<= 1;
  }
  return len - rootBits;
}

/**
 * libwebp's BuildHuffmanTable. Returns the size of the lookup table the code lengths make, or why they make no valid
 * prefix code: no symbol, more codes of a length than the length allows (over-subscribed), or a tree that is not full
 * (incomplete). One symbol alone is valid at any length. With `table`, it also fills the table, which must hold the
 * size a call without one returned.
 */
function buildTable(rootBits: number, lengths: Uint8Array, size: number, table?: Table): number | string {
  const count = new Int32Array(MAX_ALLOWED_CODE_LENGTH + 1);
  const offset = new Int32Array(MAX_ALLOWED_CODE_LENGTH + 1);
  for (let s = 0; s < size; s++) count[lengths[s]]++;
  if (count[0] === size) return 'has no symbols';
  for (let len = 1; len < MAX_ALLOWED_CODE_LENGTH; len++) {
    if (count[len] > 1 << len) return 'is over-subscribed';
    offset[len + 1] = offset[len] + count[len];
  }
  const sorted = new Uint16Array(table ? size : 0);
  for (let s = 0; s < size; s++) {
    const len = lengths[s];
    if (len > 0) {
      if (table) sorted[offset[len]] = s;
      offset[len]++;
    }
  }
  let totalSize = 1 << rootBits;
  if (offset[MAX_ALLOWED_CODE_LENGTH] === 1) {
    if (table) replicate(table, 0, 1, totalSize, 0, sorted[0]);
    return totalSize;
  }
  let low = -1;
  const mask = totalSize - 1;
  let key = 0;
  let nodes = 1;
  let open = 1;
  let tableAt = 0;
  let tableBits = rootBits;
  let tableSize = 1 << tableBits;
  let symbol = 0;
  for (let len = 1, step = 2; len <= rootBits; len++, step <<= 1) {
    open <<= 1;
    nodes += open;
    open -= count[len];
    if (open < 0) return 'is over-subscribed';
    if (!table) continue;
    for (; count[len] > 0; count[len]--) {
      replicate(table, key, step, tableSize, len, sorted[symbol++]);
      key = nextKey(key, len);
    }
  }
  for (let len = rootBits + 1, step = 2; len <= MAX_ALLOWED_CODE_LENGTH; len++, step <<= 1) {
    open <<= 1;
    nodes += open;
    open -= count[len];
    if (open < 0) return 'is over-subscribed';
    for (; count[len] > 0; count[len]--) {
      if ((key & mask) !== low) {
        tableAt += tableSize;
        tableBits = nextTableBits(count, len, rootBits);
        tableSize = 1 << tableBits;
        totalSize += tableSize;
        low = key & mask;
        if (table) {
          table.bits[low] = tableBits + rootBits;
          table.value[low] = tableAt - low;
        }
      }
      if (table) replicate(table, tableAt + (key >>> rootBits), step, tableSize, len - rootBits, sorted[symbol++]);
      key = nextKey(key, len);
    }
  }
  if (nodes !== 2 * offset[MAX_ALLOWED_CODE_LENGTH] - 1) return 'is incomplete';
  return totalSize;
}

/** Builds the table for code lengths libwebp's first pass has accepted. */
function filledTable(rootBits: number, lengths: Uint8Array, size: number, total: number): Table {
  const table: Table = { bits: new Uint8Array(total), value: new Uint16Array(total) };
  buildTable(rootBits, lengths, size, table);
  return table;
}

/** Decodes one symbol with a table of 8-bit root, as libwebp's ReadSymbol. */
function readSymbol(t: Table, br: Bits): number {
  const val = br.peek(MAX_ALLOWED_CODE_LENGTH);
  let i = val & 0xff;
  const extra = t.bits[i] - HUFFMAN_TABLE_BITS;
  if (extra > 0) {
    br.skip(HUFFMAN_TABLE_BITS);
    i += t.value[i] + ((val >>> HUFFMAN_TABLE_BITS) & ((1 << extra) - 1));
  }
  br.skip(t.bits[i]);
  return t.value[i];
}

/** A length or distance from its prefix symbol and extra bits. */
function copyDistance(symbol: number, br: Bits): number {
  if (symbol < 4) return symbol + 1;
  const extra = (symbol - 2) >> 1;
  return ((2 + (symbol & 1)) << extra) + br.read(extra) + 1;
}

function planeToDistance(width: number, code: number): number {
  if (code > CODE_TO_PLANE.length) return code - CODE_TO_PLANE.length;
  const plane = CODE_TO_PLANE[code - 1];
  const dist = (plane >> 4) * width + 8 - (plane & 0xf);
  return dist >= 1 ? dist : 1;
}

const subSample = (size: number, bits: number) => (size + (1 << bits) - 1) >> bits;

class Stream {
  /** Code lengths of one code. Sized for the largest alphabet, and at least 256 for a simple code's 8-bit symbol. */
  private readonly lengths = new Uint8Array(ALPHABET[0] + (1 << MAX_CACHE_BITS));
  private ticks = 0;

  constructor(
    readonly br: Bits,
    private readonly tick: () => void,
  ) {}

  private async bit(): Promise<number> {
    await this.br.need();
    return this.br.read(1);
  }

  /**
   * libwebp's ReadHuffmanCode: reads one code's lengths into `this.lengths` and returns the size of its lookup table,
   * or refuses the stream.
   */
  private async code(alphabet: number, what: string): Promise<number> {
    const br = this.br;
    const lengths = this.lengths;
    await br.need();
    lengths.fill(0, 0, alphabet);
    if (br.read(1)) {
      // A simple code: one or two symbols, each of length 1. A symbol past the alphabet counts for nothing.
      const two = br.read(1);
      lengths[br.read(br.read(1) ? 8 : 1)] = 1;
      if (two) lengths[br.read(8)] = 1;
    } else {
      const codeLengths = new Uint8Array(NUM_CODE_LENGTH_CODES);
      const n = br.read(4) + 4;
      for (let i = 0; i < n; i++) codeLengths[CODE_LENGTH_ORDER[i]] = br.read(3);
      const size = buildTable(LENGTHS_TABLE_BITS, codeLengths, NUM_CODE_LENGTH_CODES);
      if (typeof size === 'string') return fail(`the code length code of ${what} ${size}`);
      const table = filledTable(LENGTHS_TABLE_BITS, codeLengths, NUM_CODE_LENGTH_CODES, size);
      let maxSymbol = alphabet;
      if (br.read(1)) {
        maxSymbol = 2 + br.read(2 + 2 * br.read(3));
        if (maxSymbol > alphabet) fail(`the code lengths of ${what} name ${maxSymbol} symbols for an alphabet of ${alphabet}`);
      }
      let symbol = 0;
      let previous = 8;
      while (symbol < alphabet && maxSymbol-- > 0) {
        await br.need();
        const i = br.peek(LENGTHS_TABLE_BITS);
        br.skip(table.bits[i]);
        const len = table.value[i];
        if (len < 16) {
          lengths[symbol++] = len;
          if (len !== 0) previous = len;
          continue;
        }
        const slot = len - 16;
        const repeat = br.read(REPEAT_EXTRA_BITS[slot]) + REPEAT_OFFSETS[slot];
        if (symbol + repeat > alphabet) fail(`a code length repeat of ${what} runs past its alphabet`);
        lengths.fill(len === 16 ? previous : 0, symbol, symbol + repeat);
        symbol += repeat;
      }
    }
    if (br.ended) fail(`the VP8L data ends inside ${what}`);
    const size = buildTable(HUFFMAN_TABLE_BITS, lengths, alphabet);
    if (typeof size === 'string') return fail(`${what} ${size}`);
    return size;
  }

  /**
   * libwebp's ReadHuffmanCodesHelper for `groups` groups of five codes. Each group's tables must fit the fixed bound
   * for the color cache size, which every group of complete codes does. Returns the tables of the last group when
   * `keep` is set, for a stream with one group whose data is then decoded.
   */
  private async groups(groups: number, cacheBits: number, keep: boolean): Promise<Table[]> {
    // libwebp's own early check: each group's five codes take at least 20 bits.
    if (this.br.left + 64 < groups * 20) fail(`the VP8L data is too short for its ${groups} prefix code groups`);
    let tables: Table[] = [];
    for (let g = 0; g < groups; g++) {
      if ((g & 255) === 255) this.tick();
      let total = 0;
      tables = [];
      for (let j = 0; j < ALPHABET.length; j++) {
        const alphabet = ALPHABET[j] + (j === 0 && cacheBits > 0 ? 1 << cacheBits : 0);
        const what = `prefix code ${j + 1} of group ${g + 1}`;
        const size = await this.code(alphabet, `a VP8L ${what}`);
        total += size;
        if (keep) tables.push(filledTable(HUFFMAN_TABLE_BITS, this.lengths, alphabet, size));
      }
      if (total > TABLE_SIZE[cacheBits]) fail(`VP8L prefix code group ${g + 1} needs ${total} table entries, past libwebp's fixed bound of ${TABLE_SIZE[cacheBits]}`);
    }
    return tables;
  }

  /**
   * libwebp's DecodeImageStream. At level 0, the image itself, it reads the transforms, the color cache size, the
   * entropy image and every code group, and stops before the pixels. Below level 0 it reads one code group and decodes
   * the small image, returning the largest code group number its values name.
   */
  async image(width: number, height: number, level0: boolean, what: string): Promise<number> {
    const br = this.br;
    let xsize = width;
    if (level0) {
      let seen = 0;
      while (await this.bit()) {
        const type = br.read(2);
        if (seen & (1 << type)) fail('a VP8L transform appears twice');
        seen |= 1 << type;
        if (type === 0 || type === 1) {
          const bits = 2 + br.read(3);
          await this.image(subSample(xsize, bits), subSample(height, bits), false, type === 0 ? 'the VP8L predictor data' : 'the VP8L cross-color data');
        } else if (type === 3) {
          const colors = br.read(8) + 1;
          xsize = subSample(xsize, colors > 16 ? 0 : colors > 4 ? 1 : colors > 2 ? 2 : 3);
          await this.image(colors, 1, false, 'the VP8L color table');
        }
      }
    }
    let cacheBits = 0;
    if (await this.bit()) {
      cacheBits = br.read(4);
      if (cacheBits < 1 || cacheBits > MAX_CACHE_BITS) fail(`the VP8L color cache has ${cacheBits} bits`);
    }
    let groups = 1;
    if (level0 && (await this.bit())) {
      const bits = 2 + br.read(3);
      groups = (await this.image(subSample(xsize, bits), subSample(height, bits), false, 'the VP8L entropy image')) + 1;
    }
    if (br.ended) fail(`the VP8L data ends inside ${what}`);
    const tables = await this.groups(groups, cacheBits, !level0);
    if (level0) return 0;
    return this.data(xsize, height, cacheBits, tables, what);
  }

  /** libwebp's DecodeImageData for one code group. Returns the largest code group number the values name. */
  private async data(width: number, height: number, cacheBits: number, t: Table[], what: string): Promise<number> {
    const br = this.br;
    const total = width * height;
    const ringSize = Math.min(total, 1 << 20);
    const ring = new Uint32Array(ringSize);
    const cache = new Uint32Array(cacheBits > 0 ? 1 << cacheBits : 0);
    const shift = 32 - cacheBits;
    const lengthLimit = NUM_LITERAL_CODES + NUM_LENGTH_CODES;
    const cacheLimit = lengthLimit + cache.length;
    let pos = 0;
    let largest = 0;
    const put = (argb: number) => {
      ring[pos % ringSize] = argb;
      if (cacheBits > 0) cache[Math.imul(argb, 0x1e35a7bd) >>> shift] = argb;
      const group = (argb >>> 8) & 0xffff;
      if (group > largest) largest = group;
      pos++;
    };
    const ends = () => fail(`the VP8L data ends inside ${what}`);
    while (pos < total) {
      if ((++this.ticks & 0xffff) === 0) this.tick();
      await br.need();
      const code = readSymbol(t[0], br);
      if (code < NUM_LITERAL_CODES) {
        const red = readSymbol(t[1], br);
        const blue = readSymbol(t[2], br);
        const alpha = readSymbol(t[3], br);
        if (br.ended) ends();
        put(((alpha << 24) | (red << 16) | (code << 8) | blue) >>> 0);
      } else if (code < lengthLimit) {
        const length = copyDistance(code - NUM_LITERAL_CODES, br);
        const dist = planeToDistance(width, copyDistance(readSymbol(t[4], br), br));
        if (br.ended) ends();
        if (pos < dist || total - pos < length) fail(`a backward reference in ${what} leaves the image`);
        for (let i = 0; i < length; i++) put(ring[(pos - dist) % ringSize]);
      } else if (code < cacheLimit) {
        if (br.ended) ends();
        put(cache[code - lengthLimit]);
      } else {
        fail(`${what} holds a symbol past its alphabet`);
      }
    }
    if (br.ended) ends();
    return largest;
  }
}

/**
 * Checks the VP8L image stream of `length` bytes that `read` fetches, for an image of `width` x `height`: the stream
 * after the 5-byte header of a VP8L chunk, or the data of an ALPH chunk with lossless compression. Returns why libwebp
 * would refuse it, or undefined. `tick` runs now and then, so the caller can enforce its time limit.
 */
export async function checkVp8l(read: (offset: number, length: number) => Promise<Uint8Array>, length: number, width: number, height: number, tick: () => void): Promise<string | undefined> {
  const stream = new Stream(new Bits(read, length), tick);
  try {
    await stream.image(width, height, true, 'its header');
  } catch (e) {
    if (e instanceof Vp8lError) return e.message;
    throw e;
  }
  return undefined;
}
