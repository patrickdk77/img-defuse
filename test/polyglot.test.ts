import { expect } from 'chai';
import { inspectImage } from '../src';
import { chunk, fixture, grayPng, inspectFixture, kinds, of, summary } from './helpers/util';

describe('polyglots', () => {
  it('strips the block that holds a PDF header in the first 1024 bytes', async () => {
    expect(summary(await inspectFixture({}, 'hostile', 'png', 'pdf-text.png'))).to.deep.equal({ status: 'strippable', score: 50, kinds: ['METADATA/TEXT', 'POLYGLOT/PDF'] });
    expect(summary(await inspectFixture({}, 'hostile', 'jpeg', 'com-pdf.jpg'))).to.deep.equal({ status: 'strippable', score: 50, kinds: ['METADATA/COMMENT', 'POLYGLOT/PDF'] });
    expect(summary(await inspectFixture({}, 'hostile', 'gif', 'pdf-comment.gif'))).to.deep.equal({ status: 'strippable', score: 50, kinds: ['METADATA/COMMENT', 'POLYGLOT/PDF'] });
  });

  it('looks only where PDF readers look', async () => {
    const late = grayPng([chunk('tEXt', `Pad\0${'x'.repeat(1100)}`), chunk('tEXt', 'Comment\0%PDF-1.7')]);
    expect(kinds(await inspectImage(late))).to.not.include('POLYGLOT/PDF');
  });

  it('rejects a signature in data the image needs, which the rewrite cannot drop', async () => {
    const r = await inspectFixture({}, 'hostile', 'png', 'pdf-pixels.png');
    expect([r.status, r.score, kinds(r), r.findings[0].data?.kind]).to.deep.equal(['rejected', 60, ['POLYGLOT/IMAGE_DATA'], 'PDF']);
  });

  it('finds a ZIP end record whose directory is where it says, in trailing data or in a chunk', async () => {
    const trailing = await inspectFixture({}, 'hostile', 'png', 'trailing-zip.png');
    expect(summary(trailing)).to.deep.equal({ status: 'strippable', score: 73, kinds: ['STRUCTURE/TRAILING_DATA', 'POLYGLOT/ZIP'] });
    const inChunk = await inspectFixture({}, 'hostile', 'png', 'zip-chunk.png');
    expect(summary(inChunk)).to.deep.equal({ status: 'strippable', score: 73, kinds: ['STRUCTURE/EXTRA_BLOCK', 'POLYGLOT/ZIP'] });
  });

  it('ignores an end record signature with no central directory behind it', async () => {
    const fake = Buffer.concat([fixture('clean', 'png', 'rgb.png'), Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(18)]);
    const r = await inspectImage(fake);
    expect([r.status, kinds(r)]).to.deep.equal(['strippable', ['STRUCTURE/TRAILING_DATA']]);
    expect(of(r, 'POLYGLOT/ZIP')).to.deep.equal([]);
  });
});
