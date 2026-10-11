/**
 * A GIF LZW decoder that counts its output instead of storing it. Each code's string length, first index and largest
 * index are known from the table, so a code costs the same whatever it expands to.
 */
export class LzwCounter {
  private readonly length = new Uint32Array(4096);
  private readonly first = new Uint8Array(4096);
  private readonly largest = new Uint8Array(4096);
  private readonly clear: number;
  private readonly end: number;
  private next = 0;
  private codeSize = 0;
  private prev = -1;
  private bits = 0;
  private bitCount = 0;
  /** Pixels decoded so far. */
  produced = 0;
  /** The largest color index decoded so far. */
  maxIndex = 0;
  /** Set once the end code has been read. */
  ended = false;
  /** Input bytes after the byte that held the end code's last bit. */
  after = 0;
  /** Set when any of those bytes is not zero. Zero bytes there are padding. */
  afterNonZero = false;
  /** The index, in the bytes last fed, of the byte that held the end code's last bit. */
  endIndex = -1;

  constructor(
    readonly minCodeSize: number,
    readonly pixels: number,
  ) {
    this.clear = 1 << minCodeSize;
    this.end = this.clear + 1;
    for (let i = 0; i < this.clear; i++) {
      this.length[i] = 1;
      this.first[i] = i;
      this.largest[i] = i;
    }
    this.reset();
  }

  private reset(): void {
    this.next = this.end + 1;
    this.codeSize = this.minCodeSize + 1;
    this.prev = -1;
  }

  /** Decodes the bytes of one sub-block. Returns a reason when the data is invalid. */
  feed(bytes: Uint8Array): string | undefined {
    for (let i = 0; i < bytes.length; i++) {
      if (this.ended) {
        this.after++;
        if (bytes[i] !== 0) this.afterNonZero = true;
        continue;
      }
      this.bits |= bytes[i] << this.bitCount;
      this.bitCount += 8;
      while (!this.ended && this.bitCount >= this.codeSize) {
        const code = this.bits & ((1 << this.codeSize) - 1);
        this.bits >>>= this.codeSize;
        this.bitCount -= this.codeSize;
        const why = this.code(code);
        if (why) return why;
        if (this.ended) this.endIndex = i;
      }
    }
    return undefined;
  }

  private code(code: number): string | undefined {
    if (code === this.clear) {
      this.reset();
      return undefined;
    }
    if (code === this.end) {
      this.ended = true;
      return undefined;
    }
    let len: number;
    let largest: number;
    if (this.prev === -1) {
      if (code >= this.clear) return `code ${code} before any string is defined`;
      len = 1;
      largest = code;
    } else if (code < this.next) {
      len = this.length[code];
      largest = this.largest[code];
      this.add(this.first[code]);
    } else if (code === this.next && this.next < 4096) {
      // The string of the previous code plus its own first index.
      this.add(this.first[this.prev]);
      len = this.length[code];
      largest = this.largest[code];
    } else {
      return `code ${code} is past the table's ${this.next} entries`;
    }
    this.produced += len;
    if (largest > this.maxIndex) this.maxIndex = largest;
    this.prev = code;
    if (this.produced > this.pixels) return `more than the frame's ${this.pixels} pixels`;
    return undefined;
  }

  /** Adds the previous code's string plus `index` to the table, as GIF's deferred-clear rules allow. */
  private add(index: number): void {
    if (this.next >= 4096) return;
    const p = this.prev;
    this.length[this.next] = this.length[p] + 1;
    this.first[this.next] = this.first[p];
    this.largest[this.next] = Math.max(this.largest[p], index);
    this.next++;
    if (this.next === 1 << this.codeSize && this.codeSize < 12) this.codeSize++;
  }
}
