import { findingSpec } from './findings';
import { ImageCategory as C, ImageDetail as D, type DefuseFinding, type ImageOptions, ImageRisk, type ImageScoreBands } from './types';

export const DEFAULT_BANDS: ImageScoreBands = { low: 1, medium: 25, high: 50, critical: 80 };

interface Combination {
  name: string;
  weight: number;
  test(has: (c: C, d?: D) => boolean): boolean;
}

export const COMBINATIONS: Combination[] = [
  {
    name: "another format's signature with data the image does not use",
    weight: 20,
    test: has => has(C.Polyglot) && (has(C.Structure, D.TrailingData) || has(C.Structure, D.HiddenData) || has(C.Structure, D.ExtraBlock)),
  },
];

/** The caller's weights first, then the built-in table. A kind from another package scores at the weight it carries. */
export function weightOf(f: DefuseFinding, options: ImageOptions): number {
  const w = options.scoreWeights ?? [];
  const exact = w.find(x => x.category === f.category && x.detail === f.detail);
  if (exact) return exact.weight;
  const cat = w.find(x => x.category === f.category && x.detail === undefined);
  if (cat) return cat.weight;
  return findingSpec(f.category, f.detail)?.weight ?? f.weight ?? 0;
}

/** Highest weight in full, a quarter of each other kind's weight, plus combinations, capped at 100. */
export function scoreFindings(findings: DefuseFinding[], options: ImageOptions): { score: number; risk: ImageRisk } {
  // Each kind of finding counts once, so twenty extra chunks of one kind do not add up to a critical file.
  const byKind = new Map<string, number>();
  for (const f of findings) {
    const k = `${f.category}/${f.detail}`;
    byKind.set(k, Math.max(byKind.get(k) ?? 0, weightOf(f, options)));
  }
  const weights = [...byKind.values()].sort((a, b) => b - a);
  let score = weights.length ? weights[0] + weights.slice(1).reduce((s, w) => s + w / 4, 0) : 0;
  const has = (c: C, d?: D) => findings.some(f => f.category === c && (d === undefined || f.detail === d) && weightOf(f, options) > 0);
  for (const combo of COMBINATIONS) if (combo.test(has)) score += combo.weight;
  score = Math.min(100, Math.round(score));
  return { score, risk: riskFor(score, options.scoreBands ?? DEFAULT_BANDS) };
}

export function riskFor(score: number, bands: ImageScoreBands): ImageRisk {
  if (score >= bands.critical) return ImageRisk.Critical;
  if (score >= bands.high) return ImageRisk.High;
  if (score >= bands.medium) return ImageRisk.Medium;
  if (score >= bands.low) return ImageRisk.Low;
  return ImageRisk.None;
}
