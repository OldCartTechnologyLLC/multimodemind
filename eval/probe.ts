/**
 * Score derivation for a single case — `npm run eval:explain [case-id]`.
 *
 * `npm run eval` answers "is the router better than what it replaced". This
 * answers "why did it order them that way", which is the question you actually
 * have when a weight moves and something you expected at the top isn't there.
 * It prints every factor for every candidate — the two relevance signals, the
 * blend, then the recency, trust and corroboration multipliers that scale it —
 * so a ranking argument can be settled with numbers instead of intuition.
 *
 * It reads the same resolved config the server does, `MMIND_RANK_*` env vars
 * included, so it doubles as a way to see what a proposed tuning does before
 * committing it from the dashboard's [t] panel:
 *
 *   MMIND_RANK_SEMANTIC_WEIGHT=0.5 npm run eval:explain -- curated-over-generated
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import { rerank, resolveRanking, contentTokens } from '../src/router/ranking.js';
import { CORPUS, EVAL_NOW, candidatesOf, labelsOf } from './corpus.js';

const COLOR = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (code: string, s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bright = (s: string) => paint('38;2;0;255;65', s);
const dim = (s: string) => paint('38;2;0;102;25', s);
const amber = (s: string) => paint('38;2;255;191;0', s);

const want = process.argv[2];
const cases = CORPUS.filter((c) => want === undefined || c.id === want);

if (cases.length === 0) {
  console.error(`No case named "${want}". Known cases:`);
  for (const c of CORPUS) console.error(`  ${c.id}`);
  process.exit(1);
}

const config = resolveRanking();
const f3 = (n: number) => n.toFixed(3).padStart(6);

console.log('');
console.log(bright('  MULTIMODE MIND — ranking derivation'));
console.log(
  dim(
    `  weights ${config.semanticWeight}/${config.lexicalWeight} · recency floor ` +
      `${config.recencyFloor} · trust ${config.trust.curated}/${config.trust.generated} · ` +
      `dup ${config.duplicateThreshold}`
  )
);

for (const c of cases) {
  const labels = labelsOf(c);
  const { entries, conflicts } = rerank({
    query: c.query,
    candidates: candidatesOf(c),
    limit: 10,
    config,
    now: EVAL_NOW,
    explain: true,
  });

  console.log('');
  console.log(bright(`▸ ${c.id}`) + dim(`   "${c.query}"`));
  console.log(dim(`  query tokens: ${contentTokens(c.query).join(' ')}`));
  console.log('');
  console.log(dim('  id                       rel   = sem    lex   × rec  × tr  × corr  = raw   age  label'));

  for (const e of entries) {
    const x = e.explain!;
    // Graded relevance is printed last on purpose: read the derivation first,
    // then find out whether it landed where the corpus says it should.
    const label = labels.get(e.entry.id) ?? 0;
    console.log(
      `  ${e.entry.id.padEnd(22)} ${f3(x.relevance)} = ${f3(x.semantic)} ${f3(x.lexical)} ` +
        `× ${x.recency.toFixed(2)} × ${x.trust.toFixed(2)} × ${x.corroboration.toFixed(2)} ` +
        `= ${x.raw.toFixed(4)} ${String(x.ageDays).padStart(4)}d  ${label}`
    );
    if (e.corroboration !== undefined) {
      console.log(dim(`    corroborated by ${e.corroboration.stores.join(', ')}`));
    }
  }

  for (const n of conflicts) {
    console.log(amber(`  ⚠ ${n.kind}: prefers ${n.preferred ?? '?'} (${n.reason ?? 'n/a'})`));
  }
}

console.log('');
