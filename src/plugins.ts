import { RUN_OPTIONS, type RunContext } from './context';
import { detect } from './detect';
import { disarmAtDepth } from './engine';
import { weightOf } from './score';
import type { ContainedFilePlugin, ImageOptions } from './types';

/**
 * Defuses images inside other files, with `options` when given. Without them, it takes the options of the img-defuse
 * run that found the image, or none when another package found it. It accepts a file whose first bytes are a format
 * img-defuse reads, whatever its name or declared type says. `limits.nestingDepth` applies to the depth in the
 * context. The image's findings go into the containing file's report, and its output's findings into the output's
 * report, each with its `weight`.
 */
export function imagePlugin(options?: ImageOptions): ContainedFilePlugin {
  return {
    kind: 'file',
    name: 'image',
    async accepts(file) {
      return detect(await file.source.read(0, 64)) !== undefined;
    },
    async process(file, sink, context) {
      const run = options ?? (context as RunContext)[RUN_OPTIONS] ?? {};
      const r = await disarmAtDepth(file.source, sink, run, context.depth, context.deadline);
      // A container in another package scores these by the weights this run used.
      for (const f of [...r.before.findings, ...(r.after?.findings ?? [])]) f.weight = weightOf(f, run);
      const findings = r.before.findings;
      // The sink holds the rewrite.
      if (r.status === 'clean') return { result: 'passed', findings, outputFindings: r.after?.findings };
      if (r.status === 'defused') return { result: 'scrubbed', findings, outputFindings: r.after?.findings };
      return { result: 'removed', findings };
    },
  };
}
