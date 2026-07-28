/**
 * Retrieval evaluation harness — `npm run eval`.
 *
 * Runs every case in the corpus through both rankers and prints them side by
 * side: `baselineRank`, the score-sort-and-dedupe this release replaces, versus
 * `rerank`, the router. Same candidates, same limit, same labels. The only
 * difference is the algorithm.
 *
 * It exits non-zero when the router loses, so it works as a gate and not just
 * as a report. A ranking change that improves the average while quietly
 * wrecking one case is still a regression, so per-case losses fail too.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import {
  baselineRank,
  rerank,
  resolveRanking,
  type Candidate,
} from '../src/router/ranking.js';
import type { ConflictNote, RankedEntry } from '../src/types.js';
import {
  CORPUS,
  EVAL_NOW,
  candidatesOf,
  factsOf,
  idealGrades,
  labelsOf,
  type EvalCase,
} from './corpus.js';

// ─── Settings ─────────────────────────────────────────────────────────────────

const LIMIT = 5;
const NDCG_K = 5;
const PRECISION_K = 3;
/** Graded relevance at or above this counts as "a right answer" for MRR / P@k. */
const RELEVANT = 2;
/**
 * How far a single case may drop before it is called a regression. Ranking is
 * a trade-off engine — a change that helps eight cases and shaves a hair off a
 * ninth is fine. A change that costs a case a whole position is not.
 */
const CASE_TOLERANCE = 0.02;

// ─── Metrics ──────────────────────────────────────────────────────────────────

/** Ground truth for one case: a grade per document, and which fact each states. */
interface Truth {
  labels: Map<string, number>;
  facts: Map<string, string>;
  ideal: number[];
}

/**
 * Grade a ranked list, crediting each distinct fact once.
 *
 * The second and later copies of a fact score zero. Without that, a list padded
 * with restatements of its own first result measures as excellent, and the
 * ranker that collapses them measures as worse — which is backwards.
 */
function gradesOf(ranked: RankedEntry[], truth: Truth): number[] {
  const seen = new Set<string>();
  return ranked.map((r) => {
    const fact = truth.facts.get(r.entry.id) ?? r.entry.id;
    if (seen.has(fact)) return 0;
    seen.add(fact);
    return truth.labels.get(r.entry.id) ?? 0;
  });
}

/** Discounted cumulative gain with the usual 2^rel − 1 gain. */
function dcg(rels: number[]): number {
  return rels.reduce((sum, rel, i) => sum + (2 ** rel - 1) / Math.log2(i + 2), 0);
}

/**
 * nDCG@k. Graded, position-weighted, and normalized against the best ordering
 * this pool allows — so a case whose pool holds no good answer cannot drag the
 * average down for a reason the ranker had no control over.
 */
function ndcg(grades: number[], truth: Truth, k: number): number {
  const got = dcg(grades.slice(0, k));
  const ideal = dcg(truth.ideal.slice(0, k));
  return ideal === 0 ? 0 : got / ideal;
}

/** Reciprocal rank of the first genuinely right answer. Rewards getting it first. */
function reciprocalRank(grades: number[]): number {
  const at = grades.findIndex((g) => g >= RELEVANT);
  return at === -1 ? 0 : 1 / (at + 1);
}

/** Share of the top-k that an agent could actually act on. */
function precisionAt(grades: number[], k: number): number {
  const head = grades.slice(0, k);
  if (head.length === 0) return 0;
  return head.filter((g) => g >= RELEVANT).length / head.length;
}

interface Metrics {
  ndcg: number;
  mrr: number;
  precision: number;
}

function measure(ranked: RankedEntry[], truth: Truth): Metrics {
  const grades = gradesOf(ranked, truth);
  return {
    ndcg: ndcg(grades, truth, NDCG_K),
    mrr: reciprocalRank(grades),
    precision: precisionAt(grades, PRECISION_K),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (code: string, s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bright = (s: string) => paint('38;2;0;255;65', s);
const dim = (s: string) => paint('38;2;0;102;25', s);
const amber = (s: string) => paint('38;2;255;191;0', s);
const red = (s: string) => paint('38;2;255;70;70', s);

const WIDTH = 74;
const rule = (ch = '─') => dim(ch.repeat(WIDTH));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(6);

/** Signed delta, colored by direction. Ties read as a flat dash, not a fake zero. */
function delta(before: number, after: number): string {
  const d = after - before;
  if (Math.abs(d) < 1e-9) return dim('    ——');
  const s = `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}`.padStart(6);
  return d > 0 ? bright(s) : red(s);
}

function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out;
}

/** Compact ranked list, colored by grade, so a bad ordering shows at a glance. */
function order(ranked: RankedEntry[], truth: Truth): string {
  const grades = gradesOf(ranked, truth);
  return ranked
    .map((r, i) => {
      const g = grades[i]!;
      const tag = `${i + 1}.${r.entry.id}`;
      return g >= RELEVANT ? bright(tag) : g === 1 ? dim(tag) : red(tag);
    })
    .join(' ');
}

// ─── Run ──────────────────────────────────────────────────────────────────────

interface CaseResult {
  id: string;
  probe: string;
  base: Metrics;
  next: Metrics;
  conflicts: ConflictNote[];
  missingConflicts: string[];
  regressed: boolean;
}

function runCase(c: EvalCase): CaseResult {
  const candidates: Candidate[] = candidatesOf(c);
  const truth: Truth = { labels: labelsOf(c), facts: factsOf(c), ideal: idealGrades(c) };
  const config = resolveRanking();

  const baseRanked = baselineRank(candidates, LIMIT);
  const { entries: nextRanked, conflicts } = rerank({
    query: c.query,
    candidates,
    limit: LIMIT,
    config,
    now: EVAL_NOW,
    explain: true,
  });

  const base = measure(baseRanked, truth);
  const next = measure(nextRanked, truth);

  const found = new Set(conflicts.map((n) => n.kind ?? 'unknown'));
  const missingConflicts = (c.expectConflicts ?? []).filter((k) => !found.has(k));

  console.log('');
  console.log(bright(`▸ ${c.id}`) + dim(`   "${c.query}"`));
  for (const l of wrap(c.probe, WIDTH - 4, '  ')) console.log(dim(l));
  console.log('');
  console.log(`  ${'baseline'.padEnd(10)} ${order(baseRanked, truth)}`);
  console.log(`  ${'router'.padEnd(10)} ${order(nextRanked, truth)}`);
  console.log('');
  console.log(
    dim('  metric      baseline  router    Δ') +
      '\n' +
      `  nDCG@${NDCG_K}      ${pct(base.ndcg)}    ${pct(next.ndcg)}   ${delta(base.ndcg, next.ndcg)}` +
      '\n' +
      `  MRR         ${pct(base.mrr)}    ${pct(next.mrr)}   ${delta(base.mrr, next.mrr)}` +
      '\n' +
      `  P@${PRECISION_K}         ${pct(base.precision)}    ${pct(next.precision)}   ${delta(base.precision, next.precision)}`
  );

  if (conflicts.length > 0) {
    console.log('');
    for (const n of conflicts) {
      console.log(amber(`  ⚠ ${n.kind}: ${n.description}`));
      console.log(
        dim(`    ${n.entryIds.join(' ↔ ')}  → prefers ${n.preferred ?? '?'} (${n.reason ?? 'n/a'})`)
      );
    }
  }
  for (const k of missingConflicts) {
    console.log(red(`  ✗ expected a ${k} conflict and none was reported`));
  }

  const regressed =
    next.ndcg < base.ndcg - CASE_TOLERANCE || missingConflicts.length > 0;

  return {
    id: c.id,
    probe: c.probe,
    base,
    next,
    conflicts,
    missingConflicts,
    regressed,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function main(): void {
  console.log('');
  console.log(bright('  MULTIMODE MIND — retrieval evaluation'));
  console.log(
    dim(`  ${CORPUS.length} cases · limit ${LIMIT} · reference time ${new Date(EVAL_NOW).toISOString()}`)
  );
  console.log(
    dim('  baseline = score sort + first-copy-wins dedupe (the ranking 0.4.0 replaces)')
  );
  console.log(rule());

  const results = CORPUS.map(runCase);

  const agg = {
    baseNdcg: mean(results.map((r) => r.base.ndcg)),
    nextNdcg: mean(results.map((r) => r.next.ndcg)),
    baseMrr: mean(results.map((r) => r.base.mrr)),
    nextMrr: mean(results.map((r) => r.next.mrr)),
    basePrecision: mean(results.map((r) => r.base.precision)),
    nextPrecision: mean(results.map((r) => r.next.precision)),
  };

  console.log('');
  console.log(rule('═'));
  console.log(bright('  AGGREGATE'));
  console.log(dim('  metric      baseline  router    Δ'));
  console.log(
    `  nDCG@${NDCG_K}      ${pct(agg.baseNdcg)}    ${pct(agg.nextNdcg)}   ${delta(agg.baseNdcg, agg.nextNdcg)}`
  );
  console.log(
    `  MRR         ${pct(agg.baseMrr)}    ${pct(agg.nextMrr)}   ${delta(agg.baseMrr, agg.nextMrr)}`
  );
  console.log(
    `  P@${PRECISION_K}         ${pct(agg.basePrecision)}    ${pct(agg.nextPrecision)}   ${delta(agg.basePrecision, agg.nextPrecision)}`
  );

  const wins = results.filter((r) => r.next.ndcg > r.base.ndcg + 1e-9).length;
  const ties = results.filter((r) => Math.abs(r.next.ndcg - r.base.ndcg) <= 1e-9).length;
  const losses = results.length - wins - ties;
  console.log('');
  console.log(dim(`  cases: ${wins} better · ${ties} unchanged · ${losses} worse`));

  const regressions = results.filter((r) => r.regressed);
  console.log(rule());

  if (regressions.length > 0) {
    console.log('');
    console.log(red('  FAIL — the router lost ground on:'));
    for (const r of regressions) {
      console.log(red(`    ${r.id}`));
      for (const l of wrap(r.probe, WIDTH - 6, '      ')) console.log(dim(l));
    }
    console.log('');
    process.exit(1);
  }

  if (agg.nextNdcg < agg.baseNdcg) {
    console.log('');
    console.log(red('  FAIL — aggregate nDCG is below the baseline.'));
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log(bright('  PASS') + dim(' — no case regressed and the aggregate improved.'));
  console.log('');
}

main();
