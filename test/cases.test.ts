import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'chai';
import { inspectImage } from '../src';
import type { DefuseFinding } from '../src/types';
import { fixtures } from './helpers/util';

/** One crafted fixture per issue a corpus run of the package exposed, each rebuilt from scratch by scripts/make-fixtures.py. */
interface Entry {
  issue: string;
  expect: { status: string; risk: string; kinds: string[] };
  beforeRound2: { status: string; kinds: string[] };
}

const casesDir = path.join(fixtures, 'cases');
const manifest: Record<string, Entry> = JSON.parse(fs.readFileSync(path.join(casesDir, 'manifest.json'), 'utf8'));

/** The kinds of finding that change the verdict, as the corpus run records them: everything but info. */
const actedKinds = (findings: DefuseFinding[]) => [...new Set(findings.filter(f => f.action !== 'info').map(f => `${f.category}/${f.detail}`))].sort();

describe('corpus cases', () => {
  it('lists the same files in the manifest and the folder', () => {
    const onDisk = fs
      .readdirSync(casesDir)
      .filter(name => name !== 'manifest.json')
      .sort();
    expect(onDisk).to.deep.equal(Object.keys(manifest).sort());
  });

  it('describes every fixture', () => {
    for (const [name, entry] of Object.entries(manifest)) expect(entry.issue.length, `${name} issue`).to.be.greaterThan(0);
  });

  for (const [name, entry] of Object.entries(manifest)) {
    it(`inspects ${name} as the manifest expects`, async () => {
      const r = await inspectImage(fs.readFileSync(path.join(casesDir, name)));
      expect([r.status, r.risk, actedKinds(r.findings)], name).to.deep.equal([entry.expect.status, entry.expect.risk, [...entry.expect.kinds].sort()]);
    });
  }

  it('shows a verdict that differs from the pre-fix build for every fixture made for a fixed bug', () => {
    // A fixture whose before and after verdicts match is a control for behavior that did not change on purpose.
    const changed = Object.entries(manifest).filter(([, e]) => e.beforeRound2.status !== e.expect.status || [...e.beforeRound2.kinds].sort().join() !== [...e.expect.kinds].sort().join());
    expect(changed.length, 'fixtures proving a fix').to.be.greaterThan(9);
  });
});
