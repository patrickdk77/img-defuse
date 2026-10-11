import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'chai';
import { allFindingSpecs, ImageCategory as C, COMBINATIONS, ImageDetail as D, DEFAULT_BANDS, type DefuseFinding, ImageRisk, scoreFindings } from '../src';
import { FindingFactory } from '../src/findings';
import { riskFor } from '../src/score';
import { inspectFixture, kinds, root } from './helpers/util';

const f = new FindingFactory();

describe('findings and scoring', () => {
  it('has a description, default action and weight for every pair it makes', () => {
    const specs = allFindingSpecs();
    expect(specs.length).to.be.greaterThan(40);
    for (const s of specs) {
      expect(Object.values(C)).to.include(s.category);
      expect(Object.values(D)).to.include(s.detail);
      expect(s.description).to.match(/^[A-Z<]/);
      expect(s.description).to.match(/^[\x20-\x7e]+$/);
      expect(['reject', 'strip', 'info']).to.include(s.action);
      expect(s.weight).to.be.within(0, 100);
    }
    // Every detail the source names must have a spec, and so must every category and detail named together.
    const known = new Set(specs.map(s => `${s.category}/${s.detail}`));
    const details = new Set<string>(specs.map(s => s.detail));
    const category = new Map<string, string>(Object.entries(C));
    const detail = new Map<string, string>(Object.entries(D));
    const missing: string[] = [];
    let pairs = 0;
    const src = path.join(root, 'src');
    for (const name of fs.readdirSync(src).filter(n => n.endsWith('.ts') && n !== 'types.ts')) {
      for (const line of fs.readFileSync(path.join(src, name), 'utf8').split('\n')) {
        for (const part of line.split(/(?=\bC\.\w)/)) {
          const c = /^C\.(\w+)/.exec(part);
          for (const m of part.matchAll(/\bD\.(\w+)/g)) {
            const d = detail.get(m[1]) ?? m[1];
            if (!details.has(d)) missing.push(`${name}: D.${m[1]}`);
            if (!c) continue;
            pairs++;
            if (!known.has(`${category.get(c[1])}/${d}`)) missing.push(`${name}: C.${c[1]} with D.${m[1]}`);
          }
        }
      }
    }
    expect({ missing, scanned: pairs > 40 }).to.deep.equal({ missing: [], scanned: true });
  });

  it('every detail in the enum is made by some spec', () => {
    const used = new Set<string>(allFindingSpecs().map(s => s.detail));
    expect(Object.values(D).filter(d => !used.has(d))).to.deep.equal([]);
  });

  it('gives stopping refusals and limits weight 0, and only polyglots in image data reject with a weight', () => {
    const rejecting = allFindingSpecs().filter(s => s.action === 'reject' && s.weight > 0);
    expect(rejecting.map(s => `${s.category}/${s.detail}`)).to.deep.equal(['POLYGLOT/IMAGE_DATA']);
    expect(
      allFindingSpecs()
        .filter(s => s.category === C.Metadata && s.action === 'info')
        .every(s => s.weight === 0),
    ).to.equal(true);
  });

  it('fills placeholders and choices from data, and shows no control characters from the file', () => {
    expect(f.make(C.External, D.LinkedProfile, undefined, { target: 'C:\\x.icc' }).description).to.equal('The image loads its color profile from C:\\x.icc');
    expect(f.make(C.External, D.LinkedProfile).description).to.equal('The image loads its color profile from a file outside it');
    expect(f.make(C.Metadata, D.Text, undefined, { keyword: 'a\u001b[2Jb' }).description).to.equal('Descriptive text: a?[2Jb');
    expect(f.make(C.Format, D.Unsupported, undefined, { format: 'jxl' }).description).to.equal('The file is jxl, which this version does not read');
    expect(f.make(C.EmbeddedImage, D.TypeMismatch, undefined, { declared: 'image/jpeg', sniffed: '' }).description).to.equal(
      'An image inside the image is declared image/jpeg but its content is not recognized',
    );
  });

  it('applies overrides by category and by category and detail', () => {
    const o = new FindingFactory([
      { category: C.Structure, action: 'reject' },
      { category: C.Structure, detail: D.TrailingData, action: 'info' },
    ]);
    expect(o.make(C.Structure, D.TrailingData).action).to.equal('info');
    expect(o.make(C.Structure, D.HiddenData).action).to.equal('reject');
    expect(o.make(C.Metadata, D.Exif).action).to.equal('info');
  });

  it('counts the highest weight in full and a quarter of each other kind, once per kind', () => {
    const findings = [f.make(C.Polyglot, D.Pdf), f.make(C.Structure, D.HiddenData), f.make(C.Structure, D.HiddenData), f.make(C.Metadata, D.Exif)];
    // 50, a quarter of 20, and the combination's 20.
    expect(scoreFindings(findings, {})).to.deep.equal({ score: 75, risk: ImageRisk.High });
    expect(scoreFindings([f.make(C.Structure, D.HiddenData)], {})).to.deep.equal({ score: 20, risk: ImageRisk.Low });
    expect(scoreFindings([], {})).to.deep.equal({ score: 0, risk: ImageRisk.None });
  });

  it('adds the combination only when another format sits beside data the image does not use', () => {
    expect(COMBINATIONS.map(c => c.weight)).to.deep.equal([20]);
    const score = (...list: DefuseFinding[]) => scoreFindings(list, {}).score;
    expect(score(f.make(C.Polyglot, D.Zip), f.make(C.Structure, D.TrailingData))).to.equal(Math.round(50 + 10 / 4 + 20));
    expect(score(f.make(C.Polyglot, D.Zip), f.make(C.Structure, D.ExtraBlock))).to.equal(Math.round(50 + 10 / 4 + 20));
    expect(score(f.make(C.Polyglot, D.Zip), f.make(C.Metadata, D.Comment))).to.equal(50);
  });

  it('takes weight and band overrides, and scores a finding from another package at its own weight', () => {
    const hidden = f.make(C.Structure, D.HiddenData);
    expect(scoreFindings([hidden], { scoreWeights: [{ category: C.Structure, weight: 5 }] }).score).to.equal(5);
    expect(
      scoreFindings([hidden], {
        scoreWeights: [
          { category: C.Structure, detail: D.HiddenData, weight: 3 },
          { category: C.Structure, weight: 5 },
        ],
      }).score,
    ).to.equal(3);
    expect(scoreFindings([hidden], { scoreBands: { low: 1, medium: 2, high: 3, critical: 100 } }).risk).to.equal(ImageRisk.High);
    const foreign: DefuseFinding = { category: 'JAVASCRIPT', detail: 'OPEN_ACTION', description: 'x', action: 'strip', weight: 70 };
    expect(scoreFindings([foreign], {}).score).to.equal(70);
    expect(scoreFindings([{ ...foreign, weight: undefined }], {}).score).to.equal(0);
    expect(riskFor(25, DEFAULT_BANDS)).to.equal(ImageRisk.Medium);
  });

  it('applies action overrides to a whole inspection, and info changes nothing but the finding', async () => {
    const base = await inspectFixture({}, 'hostile', 'png', 'trailing-html.png');
    expect(base.status).to.equal('strippable');
    const info = await inspectFixture({ actionOverrides: [{ category: C.Structure, detail: D.TrailingData, action: 'info' }] }, 'hostile', 'png', 'trailing-html.png');
    expect([info.status, info.score, kinds(info)]).to.deep.equal(['clean', base.score, kinds(base)]);
    const reject = await inspectFixture({ actionOverrides: [{ category: C.Structure, detail: D.TrailingData, action: 'reject' }] }, 'hostile', 'png', 'trailing-html.png');
    expect([reject.status, reject.score, reject.risk]).to.deep.equal(['rejected', base.score, base.risk]);
    const meta = await inspectFixture({ actionOverrides: [{ category: C.Metadata, detail: D.Text, action: 'strip' }] }, 'meta', 'png', 'text.png');
    expect(meta.status).to.equal('strippable');
  });

  it('rejects a run that stopped whatever the overrides say about the finding that stopped it', async () => {
    const r = await inspectFixture({ actionOverrides: [{ category: C.Structure, action: 'info' }] }, 'hostile', 'png', 'bad-crc.png');
    expect([r.status, r.score, r.risk, r.findings[0].action]).to.deep.equal(['rejected', null, 'UNKNOWN', 'info']);
    const limit = await inspectFixture({ actionOverrides: [{ category: C.Limit, action: 'info' }] }, 'hostile', 'png', 'pixels.png');
    expect([limit.status, limit.score, limit.risk]).to.deep.equal(['rejected', null, 'UNKNOWN']);
  });
});
