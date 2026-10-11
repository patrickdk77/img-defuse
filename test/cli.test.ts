import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'chai';
import { disarmImage } from '../src';
import { chunk, fixture, fixtures, grayPng, output, runCli } from './helpers/util';

/** The fields of `--json` output the tests read. */
interface InspectJson {
  status: string;
  findings: Array<{ category: string; detail: string; action: string }>;
}

const at = (...parts: string[]) => path.join(fixtures, ...parts);

describe('command-line tool', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-defuse-cli-'));
    fs.writeFileSync(path.join(dir, 'keep.js'), "module.exports = { plugins: [{ kind: 'file', name: 'keepall', accepts: () => true, process: async () => 'passed' }] };\n");
    fs.writeFileSync(path.join(dir, 'config.js'), "module.exports = { actionOverrides: [{ category: 'STRUCTURE', detail: 'TRAILING_DATA', action: 'reject' }], limits: { pixels: 4 } };\n");
    fs.writeFileSync(path.join(dir, 'script.js'), "module.exports = { plugins: [{ kind: 'script', name: 'x', accepts: () => true, process: async () => ({ result: 'passed' }) }] };\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('inspects with exit codes 0, 1 and 2', () => {
    expect(runCli(['inspect', at('clean', 'png', 'rgb.png')]).status).to.equal(0);
    const trailing = runCli(['inspect', at('hostile', 'png', 'trailing-html.png')]);
    expect(trailing.status).to.equal(1);
    expect(trailing.stdout.toString().split('\n').slice(0, 2)).to.deep.equal([
      'inspection: strippable, risk LOW (score 10), PNG 8 x 8, 1 images',
      '  strip  STRUCTURE/TRAILING_DATA [offset 71]: Data after the end of the image',
    ]);
    expect(runCli(['inspect', at('hostile', 'png', 'bad-crc.png')]).status).to.equal(2);
  });

  it('prints JSON', () => {
    const r = JSON.parse(runCli(['inspect', at('hostile', 'png', 'trailing-html.png'), '--json']).stdout.toString()) as InspectJson;
    expect([r.status, r.findings.map(f => f.detail)]).to.deep.equal(['strippable', ['TRAILING_DATA']]);
  });

  it('defuses to a file and to stdout, reading stdin', async () => {
    const out = path.join(dir, 'out.png');
    const r = runCli(['defuse', at('hostile', 'png', 'trailing-html.png'), out]);
    expect([r.status, r.stdout.toString().split('\n')[0]]).to.deep.equal([1, 'result: defused']);
    expect(Buffer.compare(fs.readFileSync(out), grayPng())).to.equal(0);
    const piped = runCli(['defuse', '-', '-'], { input: fixture('hostile', 'png', 'trailing-html.png') });
    expect([piped.status, Buffer.compare(piped.stdout, grayPng())]).to.deep.equal([1, 0]);
    // The report goes to stderr when the image goes to stdout.
    expect(piped.stderr.toString().split('\n')[0]).to.equal('result: defused');
    const clean = runCli(['defuse', at('clean', 'jpeg', 'gray.jpg'), path.join(dir, 'gray.jpg')]);
    expect([clean.status, Buffer.compare(fs.readFileSync(path.join(dir, 'gray.jpg')), output(await disarmImage(fixture('clean', 'jpeg', 'gray.jpg'))))]).to.deep.equal([0, 0]);
  });

  it('exits 2 for a rejected defuse and writes no output file', () => {
    const out = path.join(dir, 'rejected.png');
    expect(runCli(['defuse', at('hostile', 'png', 'bad-crc.png'), out]).status).to.equal(2);
    expect(fs.existsSync(out)).to.equal(false);
  });

  it('loads file plugins, and keeps thumbnails with --defuse-thumbnails', () => {
    const details = (args: string[]) =>
      (JSON.parse(runCli(['inspect', at('rewrite', 'jpeg-exif-orientation-thumb.jpg'), ...args, '--json']).stdout.toString()) as InspectJson).findings
        .filter(f => f.category === 'EMBEDDED_IMAGE')
        .map(f => f.detail);
    expect(details([])).to.deep.equal(['NO_PLUGIN']);
    expect(details(['--defuse-thumbnails'])).to.deep.equal(['PLUGIN_PASSED']);
    expect(details(['--plugin', path.join(dir, 'keep.js')])).to.deep.equal(['PLUGIN_PASSED']);
    const script = runCli(['inspect', at('clean', 'png', 'rgb.png'), '--plugin', path.join(dir, 'script.js')]);
    expect([script.status, script.stderr.toString().split('\n')[0]]).to.deep.equal([3, 'A plugin module must export plugins with kind "file"']);
  });

  it('strips metadata with --strip-metadata', () => {
    const inspect = (args: string[]) => {
      const r = runCli(['inspect', at('meta', 'png', 'text.png'), ...args, '--json']);
      return { status: r.status, metadata: [...new Set((JSON.parse(r.stdout.toString()) as InspectJson).findings.filter(f => f.category === 'METADATA').map(f => `${f.detail}:${f.action}`))] };
    };
    expect(inspect([])).to.deep.equal({ status: 0, metadata: ['TEXT:info'] });
    expect(inspect(['--strip-metadata'])).to.deep.equal({ status: 1, metadata: ['TEXT:info', 'STRIPPED:info'] });
    const out = path.join(dir, 'stripped.png');
    expect(runCli(['defuse', at('meta', 'png', 'text.png'), out, '--strip-metadata']).status).to.equal(1);
    expect(fs.readFileSync(out).includes('tEXt')).to.equal(false);
  });

  it('loads a config module and parses limits, the flags applying on top', () => {
    const rejects = (args: string[]) => {
      const r = runCli(['inspect', at('hostile', 'png', 'trailing-html.png'), '--config', path.join(dir, 'config.js'), ...args, '--json']);
      return { status: r.status, rejects: (JSON.parse(r.stdout.toString()) as InspectJson).findings.filter(f => f.action === 'reject').map(f => `${f.category}/${f.detail}`) };
    };
    expect(rejects([])).to.deep.equal({ status: 2, rejects: ['LIMIT/PIXELS'] });
    expect(rejects(['--limit', 'pixels=100'])).to.deep.equal({ status: 2, rejects: ['STRUCTURE/TRAILING_DATA'] });
    expect(runCli(['inspect', at('hostile', 'png', 'trailing-html.png'), '--limit', 'fileSize=1kb']).status).to.equal(1);
    expect(runCli(['inspect', at('hostile', 'png', 'trailing-html.png'), '--limit', 'fileSize=10']).status).to.equal(2);
    const big = runCli(['inspect', '-', '--limit', 'fileSize=10', '--json'], { input: fixture('clean', 'png', 'rgb.png') });
    expect((JSON.parse(big.stdout.toString()) as InspectJson).findings.map(f => f.detail)).to.deep.equal(['FILE_SIZE']);
  });

  it('exits 3 on usage errors and I/O errors', () => {
    expect(runCli([]).status).to.equal(3);
    expect(runCli(['inspect']).status).to.equal(3);
    // A clean input, so an ignored option would exit 0, and the message tells it apart from a stray positional.
    const bogus = runCli(['inspect', at('clean', 'png', 'rgb.png'), '--bogus=secret']);
    expect([bogus.status, bogus.stderr.toString().split('\n')[0]]).to.deep.equal([3, 'Unknown option --bogus=...']);
    expect(runCli(['inspect', at('clean', 'png', 'rgb.png'), '--limit', 'pixels=many']).status).to.equal(3);
    expect(runCli(['inspect', at('clean', 'png', 'rgb.png'), '--limit', 'colors=4']).status).to.equal(3);
    expect(runCli(['defuse', path.join(dir, 'missing.png'), path.join(dir, 'x.png')]).status).to.equal(3);
    const same = path.join(dir, 'same.png');
    fs.writeFileSync(same, fixture('clean', 'png', 'rgb.png'));
    const r = runCli(['defuse', same, same]);
    expect([r.status, r.stderr.toString().split('\n')[0], fs.readFileSync(same).length]).to.deep.equal([3, 'The input and the output are the same file', fixture('clean', 'png', 'rgb.png').length]);
  });

  it('shows control characters from the image as escapes, in text and in JSON', () => {
    const file = path.join(dir, 'escape.png');
    // A text keyword holding ESC and the C1 control CSI, which a terminal can run as commands.
    fs.writeFileSync(file, grayPng([chunk('tEXt', Buffer.from('k\x1b[31m\x9b2J\0v', 'latin1'))]));
    const text = runCli(['inspect', file]).stdout.toString('latin1');
    expect([text.includes('\x1b'), text.includes('\x9b')]).to.deep.equal([false, false]);
    const json = runCli(['inspect', file, '--json']).stdout.toString('latin1');
    expect([json.includes('\\u001b[31m'), json.includes('\\u009b2J'), json.includes('\x9b')]).to.deep.equal([true, true, false]);
  });
});
