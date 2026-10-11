import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { expect } from 'chai';
import { crc32, tableCrc32 } from '../src/crc32';

describe('CRC-32', () => {
  it('uses zlib.crc32 when Node has it', () => {
    const native = (zlib as { crc32?: unknown }).crc32;
    expect(crc32).to.equal(native ?? tableCrc32);
  });

  it('gives the check value of the ZIP CRC-32 from the table', () => {
    expect(tableCrc32(Buffer.from('123456789'))).to.equal(0xcbf43926);
    expect(crc32(Buffer.from('123456789'))).to.equal(0xcbf43926);
    expect(tableCrc32(new Uint8Array(0))).to.equal(0);
  });

  it('gives the same value from the table and from crc32, whole and continued across pieces', () => {
    for (const size of [1, 7, 1000, 65537]) {
      const data = crypto.randomBytes(size);
      const cut = Math.floor(size / 3);
      expect(tableCrc32(data), `size ${size}`).to.equal(crc32(data));
      expect(tableCrc32(data.subarray(cut), tableCrc32(data.subarray(0, cut))), `size ${size}`).to.equal(crc32(data));
    }
  });
});
