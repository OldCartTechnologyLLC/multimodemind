/**
 * Rerank engine tests.
 *
 * Each block pins one claim the ranking makes about itself. If a claim here
 * stops holding, the README is lying and the test says so.
 */

import { describe, it, expect } from 'vitest';
import {
  tokenize,
  contentTokens,
  jaccard,
  buildLexicalScorer,
  recencyFactor,
  trustFactor,
  trustTier,
  detectConflicts,
  resolveRanking,
  rerank,
  baselineRank,
  type Candidate,
} from '../src/router/ranking.js';
import { DEFAULT_RANKING, type MemoryEntry, type StoreType } from '../src/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-07-01T00:00:00.000Z');
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function entry(id: string, content: string, ageDays = 0): MemoryEntry {
  const stamp = daysAgo(ageDays);
  return { id, content, metadata: {}, storeType: 'sqlite', createdAt: stamp, updatedAt: stamp };
}

function candidate(
  id: string,
  content: string,
  opts: {
    store?: StoreType;
    ageDays?: number;
    semantic?: number;
    lexical?: number;
    hasEmbedding?: boolean;
    score?: number;
    source?: string;
  } = {}
): Candidate {
  const store = opts.store ?? 'sqlite';
  const semantic = opts.semantic ?? 0;
  const lexical = opts.lexical ?? 0;
  const hasEmbedding = opts.hasEmbedding ?? semantic > 0;
  const e = entry(id, content, opts.ageDays ?? 0);
  e.storeType = store;
  return {
    entry: e,
    score: opts.score ?? (hasEmbedding ? semantic * 0.7 + lexical * 0.3 : lexical),
    source: opts.source ?? `${store}:test`,
    signals: { semantic, lexical, hasEmbedding },
    storeType: store,
  };
}

// ─── Text utilities ───────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('keeps numbers, decimals, currency and percent intact', () => {
    // Digit-grouping commas are fused, so the whole amount survives as one token.
    expect(tokenize('Budget is $12,500.50 or 30% of Q3')).toContain('$12500.50');
    expect(tokenize('Budget is $12,500.50 or 30% of Q3')).toContain('30%');
  });

  it('treats a comma-grouped number and its bare form as the same token', () => {
    // Writing the same figure two ways is a style choice, not a contradiction.
    expect(tokenize('the cap is 12,500 units')).toEqual(tokenize('the cap is 12500 units'));
  });

  it('still splits on commas that separate words', () => {
    expect(tokenize('sqlite, leveldb, vector')).toEqual(['sqlite', 'leveldb', 'vector']);
  });

  it('strips leading and trailing punctuation without eating internals', () => {
    expect(tokenize('...pg_vector-ish,')).toEqual(['pg_vector-ish']);
  });

  it('drops stopwords from content tokens but not from raw tokens', () => {
    expect(tokenize('the router is the differentiator')).toContain('the');
    expect(contentTokens('the router is the differentiator')).toEqual(['router', 'differentiator']);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets, 0 when either side is empty', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
});

// ─── Specificity ──────────────────────────────────────────────────────────────

describe('specificity (IDF-weighted lexical scoring)', () => {
  it('rewards the rare query term over the ubiquitous one', () => {
    // "memory" is in every document and discriminates nothing; "pgvector" is in one.
    const docs = [
      'memory layer notes about pgvector and cosine distance',
      'memory layer notes about scheduling',
      'memory layer notes about logging',
      'memory layer notes about backups',
    ];
    const tokens = docs.map((d) => contentTokens(d));
    const score = buildLexicalScorer('memory pgvector', tokens);

    const rare = score(tokens[0]!, docs[0]!);
    const common = score(tokens[1]!, docs[1]!);
    expect(rare).toBeGreaterThan(common * 2);
  });

  it('does not collapse every score when a query term matches nothing', () => {
    const docs = ['the router is the differentiator'];
    const tokens = docs.map((d) => contentTokens(d));
    const withMiss = buildLexicalScorer('router zzzznonexistent', tokens)(tokens[0]!, docs[0]!);
    const withoutMiss = buildLexicalScorer('router', tokens)(tokens[0]!, docs[0]!);
    expect(withMiss).toBeCloseTo(withoutMiss, 5);
  });

  it('gives a verbatim phrase hit an edge over the same words scattered', () => {
    const docs = [
      'agent memory is an architecture problem not a storage problem',
      'memory problem architecture agent storage words in another order entirely',
    ];
    const tokens = docs.map((d) => contentTokens(d));
    const score = buildLexicalScorer('agent memory is an architecture problem', tokens);
    expect(score(tokens[0]!, docs[0]!)).toBeGreaterThan(score(tokens[1]!, docs[1]!));
  });

  it('returns 0 when no query term appears anywhere', () => {
    const docs = ['completely unrelated content'];
    const tokens = docs.map((d) => contentTokens(d));
    expect(buildLexicalScorer('zzzz qqqq', tokens)(tokens[0]!, docs[0]!)).toBe(0);
  });
});

// ─── Recency ──────────────────────────────────────────────────────────────────

describe('recency', () => {
  it('halves toward the floor after exactly one half-life', () => {
    const cfg = DEFAULT_RANKING;
    const half = cfg.halfLifeDays.leveldb; // 30 days
    const { multiplier } = recencyFactor(entry('a', 'x', half), 'leveldb', cfg, NOW);
    const expected = cfg.recencyFloor + (1 - cfg.recencyFloor) * 0.5;
    expect(multiplier).toBeCloseTo(expected, 6);
  });

  it('never falls below the configured floor', () => {
    const { multiplier } = recencyFactor(entry('a', 'x', 100_000), 'leveldb', DEFAULT_RANKING, NOW);
    expect(multiplier).toBeGreaterThanOrEqual(DEFAULT_RANKING.recencyFloor);
    expect(multiplier).toBeLessThan(DEFAULT_RANKING.recencyFloor + 0.001);
  });

  it('ages scratch memory far faster than the vault', () => {
    const scratch = recencyFactor(entry('a', 'x', 60), 'leveldb', DEFAULT_RANKING, NOW).multiplier;
    const vault = recencyFactor(entry('b', 'x', 60), 'markdown', DEFAULT_RANKING, NOW).multiplier;
    expect(vault).toBeGreaterThan(scratch);
  });

  it('does not penalize an entry whose timestamp is unreadable', () => {
    const broken = { ...entry('a', 'x'), createdAt: 'not-a-date', updatedAt: '' };
    expect(recencyFactor(broken, 'sqlite', DEFAULT_RANKING, NOW).multiplier).toBe(1);
  });

  it('tilts but does not decide: a strong old note beats a weak new one', () => {
    const { entries } = rerank({
      query: 'router differentiator architecture',
      candidates: [
        candidate('old', 'the router is the differentiator in a memory architecture', {
          store: 'sqlite', ageDays: 900, lexical: 1, semantic: 0.95,
        }),
        candidate('new', 'unrelated grocery list with the word router mentioned once', {
          store: 'sqlite', ageDays: 0, lexical: 0.1, semantic: 0.12,
        }),
      ],
      limit: 5,
      now: NOW,
    });
    expect(entries[0]!.entry.id).toBe('old');
  });

  it('breaks a genuine tie in favour of the newer memory', () => {
    const { entries } = rerank({
      query: 'quarterly planning cadence',
      candidates: [
        candidate('older', 'quarterly planning cadence is set by finance', { ageDays: 400, semantic: 0.8, lexical: 0.8 }),
        candidate('newer', 'quarterly planning cadence gets set by finance', { ageDays: 5, semantic: 0.8, lexical: 0.8 }),
      ],
      limit: 5,
      now: NOW,
    });
    expect(entries[0]!.entry.id).toBe('newer');
  });
});

// ─── Trust ────────────────────────────────────────────────────────────────────

describe('trust tiers', () => {
  it('treats the vault and filed documents as curated, agent memory as generated', () => {
    expect(trustTier('markdown', DEFAULT_RANKING)).toBe('curated');
    expect(trustTier('files', DEFAULT_RANKING)).toBe('curated');
    expect(trustTier('sqlite', DEFAULT_RANKING)).toBe('generated');
    expect(trustFactor('markdown', DEFAULT_RANKING)).toBeGreaterThan(
      trustFactor('sqlite', DEFAULT_RANKING)
    );
  });

  it('prefers the human-authored copy when relevance and age are equal', () => {
    const { entries } = rerank({
      query: 'deployment runbook steps',
      candidates: [
        candidate('gen', 'deployment runbook steps for the nightly job', { store: 'sqlite', semantic: 0.8, lexical: 0.8 }),
        candidate('cur', 'deployment runbook steps for a nightly job', { store: 'markdown', semantic: 0, lexical: 0.8, hasEmbedding: false }),
      ],
      limit: 5,
      now: NOW,
      config: { ...DEFAULT_RANKING, semanticWeight: 0, lexicalWeight: 1 },
    });
    expect(entries[0]!.entry.id).toBe('cur');
  });
});

// ─── Corroboration ────────────────────────────────────────────────────────────

describe('corroboration', () => {
  const text = 'The vault lives at /Users/ben/Obsidian and is mounted read only';

  it('merges duplicates across stores and reports every source', () => {
    const { entries } = rerank({
      query: 'where does the vault live',
      candidates: [
        candidate('a', text, { store: 'sqlite', semantic: 0.7, lexical: 0.7, source: 'sqlite:memory.db' }),
        candidate('b', text, { store: 'markdown', lexical: 0.7, hasEmbedding: false, source: 'markdown:vault/setup.md' }),
        candidate('c', text, { store: 'vector', semantic: 0.7, source: 'vector:index' }),
      ],
      limit: 5,
      now: NOW,
    });

    expect(entries).toHaveLength(1);
    const c = entries[0]!.corroboration!;
    expect(c.hits).toBe(3);
    expect(c.stores.sort()).toEqual(['markdown', 'sqlite', 'vector']);
    expect(c.sources).toHaveLength(3);
  });

  it('boosts an agreed-upon memory over an equally relevant lone one', () => {
    const agreed = 'the retention window is ninety days for archived sessions';
    const lone = 'the retention window covers ninety days of archived sessions data';
    const { entries } = rerank({
      query: 'retention window archived sessions',
      candidates: [
        candidate('lone', lone, { store: 'sqlite', semantic: 0.8, lexical: 0.8 }),
        candidate('agreed-1', agreed, { store: 'sqlite', semantic: 0.8, lexical: 0.8 }),
        candidate('agreed-2', agreed, { store: 'vector', semantic: 0.8, lexical: 0.8 }),
      ],
      limit: 5,
      now: NOW,
      config: { ...DEFAULT_RANKING, duplicateThreshold: 0.99 }, // keep the two texts distinct
    });
    expect(entries[0]!.entry.id).toMatch(/^agreed/);
    expect(entries[0]!.corroboration!.stores).toHaveLength(2);
    expect(entries[1]!.corroboration).toBeUndefined();
  });

  it('does not claim corroboration when the same store returns a memory twice', () => {
    const { entries } = rerank({
      query: 'vault location',
      candidates: [
        candidate('a', text, { store: 'sqlite', lexical: 0.6 }),
        candidate('b', text, { store: 'sqlite', lexical: 0.6 }),
      ],
      limit: 5,
      now: NOW,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.corroboration).toBeUndefined();
  });

  it('keeps the strongest copy as the representative, not the first one seen', () => {
    const { entries } = rerank({
      query: 'vault location',
      candidates: [
        candidate('weak', text, { store: 'sqlite', semantic: 0.2, lexical: 0.2, source: 'sqlite:weak' }),
        candidate('strong', text, { store: 'vector', semantic: 0.95, lexical: 0.9, source: 'vector:strong' }),
      ],
      limit: 5,
      now: NOW,
    });
    expect(entries[0]!.source).toBe('vector:strong');
  });

  it('caps the boost so agreement can never outrun relevance entirely', () => {
    const same = 'identical text repeated across every configured store';
    const stores: StoreType[] = ['sqlite', 'leveldb', 'markdown', 'files', 'vector'];
    const { entries } = rerank({
      query: 'identical text',
      candidates: stores.map((s, i) => candidate(`s${i}`, same, { store: s, semantic: 0.9, lexical: 0.9 })),
      limit: 5,
      now: NOW,
    });
    expect(entries[0]!.explain).toBeUndefined();
    const withExplain = rerank({
      query: 'identical text',
      candidates: stores.map((s, i) => candidate(`s${i}`, same, { store: s, semantic: 0.9, lexical: 0.9 })),
      limit: 5,
      now: NOW,
      explain: true,
    });
    expect(withExplain.entries[0]!.explain!.corroboration).toBeLessThanOrEqual(
      DEFAULT_RANKING.corroborationCap
    );
  });
});

// ─── Explain ──────────────────────────────────────────────────────────────────

describe('explain', () => {
  it('publishes a breakdown whose factors reproduce the raw score', () => {
    const { entries } = rerank({
      query: 'postgres pgvector backend selection',
      candidates: [
        candidate('a', 'postgres with pgvector can back both the structured and vector slots', {
          store: 'markdown', ageDays: 45, lexical: 0.9, hasEmbedding: false,
        }),
      ],
      limit: 5,
      now: NOW,
      explain: true,
    });

    const e = entries[0]!.explain!;
    expect(e.raw).toBeCloseTo(e.relevance * e.recency * e.trust * e.corroboration, 3);
    expect(e.ageDays).toBeCloseTo(45, 1);
    expect(e.trust).toBeCloseTo(DEFAULT_RANKING.trust.curated, 5);
  });

  it('omits the breakdown unless explicitly asked, and clamps the shown score', () => {
    const opts = {
      query: 'x',
      candidates: [candidate('a', 'x marks the spot', { store: 'markdown', lexical: 1, hasEmbedding: false })],
      limit: 5,
      now: NOW,
    };
    const plain = rerank(opts);
    expect(plain.entries[0]!.explain).toBeUndefined();
    expect(plain.entries[0]!.score).toBeLessThanOrEqual(1);
  });

  it('sorts on the unclamped score so the 1.0 ceiling never flattens ordering', () => {
    // Drive relevance entirely from the semantic side: BM25 normalized by its
    // own ceiling only approaches 1 asymptotically, so the lexical path alone
    // can never push `raw` past 1 and the clamp would never be exercised.
    // Semantic 1.0 × trust 1.15 does. Both entries clamp to 1.0 for display;
    // the curated one must still come out on top.
    const cfg = {
      ...DEFAULT_RANKING,
      semanticWeight: 1,
      lexicalWeight: 0,
      recencyFloor: 1,
    };
    const { entries } = rerank({
      query: 'ceiling test content',
      candidates: [
        candidate('gen', 'ceiling test content alpha', {
          store: 'sqlite', semantic: 1, lexical: 0, hasEmbedding: true,
        }),
        candidate('cur', 'ceiling test content beta', {
          store: 'files', semantic: 1, lexical: 0, hasEmbedding: true,
        }),
      ],
      limit: 5,
      now: NOW,
      explain: true,
      config: cfg,
    });
    expect(entries[0]!.entry.id).toBe('cur');
    expect(entries[0]!.explain!.raw).toBeGreaterThan(1);
    expect(entries[0]!.score).toBe(1);
    // Both display as a perfect match — the ordering is the only thing that
    // still carries the trust difference, which is exactly the point.
    expect(entries[1]!.score).toBe(1);
  });
});

// ─── Conflicts ────────────────────────────────────────────────────────────────

describe('conflict detection', () => {
  const cfg = DEFAULT_RANKING;

  /**
   * `detectConflicts` is handed the list the router already ranked, so these
   * fixtures are written in ranked order — best first. That is not decoration:
   * the note's `preferred` is defined as the higher-ranked side, and the reason
   * string only names the signal that separated the two. Listing the memory the
   * ranker would have buried at position one would be testing an input the
   * router cannot produce.
   */
  function ranked(id: string, content: string, ageDays: number, store: StoreType = 'sqlite') {
    const e = entry(id, content, ageDays);
    e.storeType = store;
    return { entry: e, score: 0.8, source: `${store}:test` };
  }

  it('flags two memories that state different numbers for the same fact', () => {
    const notes = detectConflicts(
      [
        ranked('b', 'The nightly export retention window is 90 days for archived agent sessions', 5),
        ranked('a', 'The nightly export retention window is 30 days for archived agent sessions', 200),
      ],
      cfg
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('numeric');
    expect(notes[0]!.preferred).toBe('b');
    expect(notes[0]!.reason).toMatch(/newer/);
  });

  it('flags a negation present on exactly one side', () => {
    const notes = detectConflicts(
      [
        ranked('b', 'The markdown vault is not writable by the agent during nightly consolidation runs', 1),
        ranked('a', 'The markdown vault is writable by the agent during nightly consolidation runs', 10),
      ],
      cfg
    );
    expect(notes[0]!.kind).toBe('negation');
    expect(notes[0]!.preferred).toBe('b');
  });

  it('flags differing dates for the same subject', () => {
    const notes = detectConflicts(
      [
        ranked('b', 'The Haddam construction permit review is scheduled for August 2027 with the town office', 2),
        ranked('a', 'The Haddam construction permit review is scheduled for March 2027 with the town office', 30),
      ],
      cfg
    );
    expect(notes[0]!.kind).toBe('temporal');
  });

  it('credits provenance ahead of recency when it names its reason', () => {
    // A human-authored note outranking a fresher generated one is the ranker
    // working as designed, so the note has to say provenance and not shrug at
    // the dates.
    const notes = detectConflicts(
      [
        ranked('vault', 'The nightly export retention window is 30 days', 400, 'markdown'),
        ranked('agent', 'The nightly export retention window is 90 days', 2),
      ],
      cfg
    );
    expect(notes[0]!.preferred).toBe('vault');
    expect(notes[0]!.reason).toMatch(/human-authored/);
  });

  it('admits out loud when it keeps the older memory', () => {
    // The one call a reader is most likely to want to check for themselves. With
    // provenance equal, the winner is older — and "prefers agent-old" must not be
    // left to read as "and it is also the newer one".
    const notes = detectConflicts(
      [
        ranked('agent-old', 'The nightly export retention window is 30 days', 400),
        ranked('agent-new', 'The nightly export retention window is 90 days', 2),
      ],
      cfg
    );
    expect(notes[0]!.preferred).toBe('agent-old');
    expect(notes[0]!.reason).toMatch(/older but ranked higher/);
  });

  it('stays quiet on unrelated memories', () => {
    expect(
      detectConflicts(
        [
          ranked('a', 'The retention window is 30 days', 1),
          ranked('b', 'Guitar strings should be changed every 8 weeks', 1),
        ],
        cfg
      )
    ).toEqual([]);
  });

  it('stays quiet on paraphrases of the same statement', () => {
    expect(
      detectConflicts(
        [
          ranked('a', 'The retention window is thirty days for archived sessions', 1),
          ranked('b', 'The retention window is thirty days for archived sessions', 1),
        ],
        cfg
      )
    ).toEqual([]);
  });

  it('can be switched off entirely', () => {
    const notes = detectConflicts(
      [
        ranked('a', 'The nightly export retention window is 30 days for archived agent sessions', 200),
        ranked('b', 'The nightly export retention window is 90 days for archived agent sessions', 5),
      ],
      { ...cfg, conflictDetection: false }
    );
    expect(notes).toEqual([]);
  });

  it('reaches the caller through rerank(), with both source labels attached', () => {
    const { conflicts } = rerank({
      query: 'retention window archived sessions',
      candidates: [
        candidate('a', 'The nightly export retention window is 30 days for archived agent sessions', {
          store: 'sqlite', ageDays: 200, lexical: 0.9, source: 'sqlite:memory.db',
        }),
        candidate('b', 'The nightly export retention window is 90 days for archived agent sessions', {
          store: 'markdown', ageDays: 5, lexical: 0.9, hasEmbedding: false, source: 'markdown:vault/ops.md',
        }),
      ],
      limit: 5,
      now: NOW,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.sources).toHaveLength(2);
    expect(conflicts[0]!.entryIds.sort()).toEqual(['a', 'b']);
  });
});

// ─── Config resolution ────────────────────────────────────────────────────────

describe('resolveRanking', () => {
  it('merges the nested per-store maps instead of replacing them', () => {
    const cfg = resolveRanking({ halfLifeDays: { leveldb: 7 } as never, semanticWeight: 0.5 });
    expect(cfg.halfLifeDays.leveldb).toBe(7);
    expect(cfg.halfLifeDays.markdown).toBe(DEFAULT_RANKING.halfLifeDays.markdown);
    expect(cfg.semanticWeight).toBe(0.5);
    expect(cfg.trust.curated).toBe(DEFAULT_RANKING.trust.curated);
  });

  it('returns the defaults untouched when given nothing', () => {
    expect(resolveRanking()).toEqual(DEFAULT_RANKING);
  });
});

// ─── Degraded inputs ──────────────────────────────────────────────────────────

describe('degraded inputs', () => {
  it('handles a store that reports no signals at all', () => {
    const legacy: Candidate = {
      entry: entry('legacy', 'a memory from a store that never learned to report signals'),
      score: 0.66,
      source: 'sqlite:legacy',
      storeType: 'sqlite',
    };
    const { entries } = rerank({ query: 'memory store', candidates: [legacy], limit: 5, now: NOW, explain: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.explain!.semantic).toBeCloseTo(0.66, 5);
  });

  it('returns an empty bundle for an empty candidate pool', () => {
    expect(rerank({ query: 'anything', candidates: [], limit: 5, now: NOW })).toEqual({
      entries: [],
      conflicts: [],
    });
  });

  it('scores lexical-only stores without pretending they had an embedding', () => {
    const { entries } = rerank({
      query: 'obsidian vault notes',
      candidates: [
        candidate('md', 'obsidian vault notes about the router design', {
          store: 'markdown', lexical: 0.9, hasEmbedding: false,
        }),
      ],
      limit: 5,
      now: NOW,
      explain: true,
    });
    expect(entries[0]!.explain!.semantic).toBe(0);
    expect(entries[0]!.explain!.relevance).toBeGreaterThan(0);
  });
});

// ─── Baseline parity ──────────────────────────────────────────────────────────

describe('baselineRank (the ranking this release replaces)', () => {
  it('keeps first-seen duplicates and sorts on the raw store score', () => {
    const text = 'the same memory returned by two different stores';
    const out = baselineRank(
      [
        candidate('first', text, { store: 'sqlite', score: 0.2 }),
        candidate('second', text, { store: 'vector', score: 0.9 }),
        candidate('other', 'a different memory entirely', { store: 'sqlite', score: 0.5 }),
      ],
      5
    );
    // The better copy is discarded because the weaker one arrived first —
    // exactly the bug the new clustering fixes.
    expect(out.map((r) => r.entry.id)).toEqual(['other', 'first']);
  });
});
