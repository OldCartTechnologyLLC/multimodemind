/**
 * Retrieval evaluation corpus.
 *
 * Every case is a small, hand-labeled retrieval problem plus a stated reason it
 * exists. The reason matters more than the score: when a case regresses, the
 * harness prints the reason, so a failing number tells you which idea broke
 * rather than just that a number moved.
 *
 * Three honesty rules govern this file, because an eval you wrote to flatter
 * your own algorithm is worse than no eval at all:
 *
 *  1. The baseline is the real thing. Candidate `score` values are produced by
 *     the actual store formulas — `keywordScore()` straight out of
 *     src/stores/utils.ts, blended the way sqlite/leveldb/files blend it. The
 *     baseline is not a strawman written to lose.
 *  2. Cases the baseline already gets right stay in the corpus. If every case
 *     shows a gain, the corpus was selected, not measured.
 *  3. Semantic scores are hand-authored stand-ins for what an embedding model
 *     would report, and are labeled as such below. This harness evaluates the
 *     *router*, not the embedder — running real embeddings here would make the
 *     result depend on an API key and stop being reproducible. Where a case
 *     turns on semantics (a paraphrase sharing no keywords) the stand-in is the
 *     whole point; where it does not, the value is set from plain overlap.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import { keywordScore } from '../src/stores/utils.js';
import type { Candidate } from '../src/router/ranking.js';
import type { MemoryEntry, StoreType } from '../src/types.js';

/**
 * Fixed reference time. Recency decay is a function of "now", so an eval that
 * read the wall clock would drift a little every day and could not be used as
 * a regression gate. Every timestamp below is relative to this instant.
 */
export const EVAL_NOW = Date.parse('2026-07-15T12:00:00.000Z');

const MS_PER_DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(EVAL_NOW - n * MS_PER_DAY).toISOString();
}

/** Graded relevance, the usual four-point scale used for nDCG. */
export const REL = {
  /** Wrong, or actively misleading if the agent acts on it. */
  irrelevant: 0,
  /** Same topic, does not answer the question. */
  related: 1,
  /** Answers the question. */
  relevant: 2,
  /** The single best answer available in this pool. */
  ideal: 3,
} as const;

export interface Doc {
  id: string;
  store: StoreType;
  content: string;
  ageDays: number;
  /**
   * Stand-in for the cosine similarity a real embedding model would report.
   * Omit for stores that hold no vectors (markdown) or when the case is not
   * about semantics — the builder then derives it from plain term overlap.
   */
  semantic?: number;
  /** Graded relevance label, 0–3. This is the ground truth. */
  rel: number;
  /**
   * Which distinct fact this document states. Copies of one fact in different
   * stores share a fact id.
   *
   * This exists so the metric does not punish a ranker for doing its job. If the
   * same sentence sits in three stores and each copy is labeled a perfect
   * answer, the "ideal" top-5 is three copies of one sentence — and a ranker
   * that collapses them into one result and fills the freed slots with other
   * useful notes measures as worse while behaving better. Credit is given once
   * per fact, so the ideal ordering is the best set of *answers* rather than
   * the best set of *rows*. Defaults to the doc id, i.e. one fact per doc.
   */
  fact?: string;
  /** Override the source label; defaults to `<store>:eval`. */
  source?: string;
}

export interface EvalCase {
  id: string;
  query: string;
  /** What this case is testing, printed whenever it regresses. */
  probe: string;
  docs: Doc[];
  /** Conflict kinds this case is expected to surface, if any. */
  expectConflicts?: Array<'numeric' | 'temporal' | 'negation'>;
}

// ─── Candidate construction ───────────────────────────────────────────────────

/** Stores that hold vectors and blend them with their own keyword score. */
const HYBRID: StoreType[] = ['sqlite', 'leveldb', 'files'];

function entryOf(doc: Doc): MemoryEntry {
  const stamp = daysAgo(doc.ageDays);
  return {
    id: doc.id,
    content: doc.content,
    metadata: {},
    storeType: doc.store,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Turn a labeled doc into the exact `Candidate` shape a live store would hand
 * the router — including the `score` the store would have computed, which is
 * what `baselineRank` sorts on.
 */
export function candidateOf(doc: Doc, query: string): Candidate {
  const entry = entryOf(doc);
  const lexical = keywordScore(doc.content, query);
  const source = doc.source ?? `${doc.store}:eval`;

  if (doc.store === 'markdown') {
    // Vault files carry no stored embeddings — lexical only, and the store says
    // so rather than reporting a zero the router would read as "compared and
    // found unrelated".
    return {
      entry,
      score: lexical,
      source,
      signals: { semantic: 0, lexical, hasEmbedding: false },
      storeType: doc.store,
    };
  }

  if (doc.store === 'vector') {
    const semantic = doc.semantic ?? lexical;
    return {
      entry,
      score: semantic,
      source,
      signals: { semantic, lexical: 0, hasEmbedding: true },
      storeType: doc.store,
    };
  }

  const hasEmbedding = HYBRID.includes(doc.store) && doc.semantic !== undefined;
  const semantic = hasEmbedding ? doc.semantic! : 0;
  // The blend the hybrid stores actually use when shortlisting.
  const score = hasEmbedding ? semantic * 0.7 + lexical * 0.3 : lexical;
  return {
    entry,
    score,
    source,
    signals: { semantic, lexical, hasEmbedding },
    storeType: doc.store,
  };
}

export function candidatesOf(c: EvalCase): Candidate[] {
  return c.docs.map((d) => candidateOf(d, c.query));
}

export function labelsOf(c: EvalCase): Map<string, number> {
  return new Map(c.docs.map((d) => [d.id, d.rel]));
}

/** doc id → fact id, for crediting a repeated fact once. */
export function factsOf(c: EvalCase): Map<string, string> {
  return new Map(c.docs.map((d) => [d.id, d.fact ?? d.id]));
}

/**
 * The best achievable grade for each distinct fact in the pool — the ideal
 * ordering a ranker could actually produce once duplicates are collapsed.
 */
export function idealGrades(c: EvalCase): number[] {
  const best = new Map<string, number>();
  for (const d of c.docs) {
    const key = d.fact ?? d.id;
    best.set(key, Math.max(best.get(key) ?? 0, d.rel));
  }
  return [...best.values()].sort((a, b) => b - a);
}

// ─── The corpus ───────────────────────────────────────────────────────────────

export const CORPUS: EvalCase[] = [
  {
    id: 'recency-supersedes',
    query: 'audit log retention window',
    probe:
      'A policy was changed. Both statements are still in memory and read almost ' +
      'identically, so keyword scoring cannot separate them. The current one must win.',
    docs: [
      {
        id: 'ret-old',
        store: 'sqlite',
        ageDays: 400,
        semantic: 0.88,
        rel: REL.irrelevant,
        content:
          'The audit log retention window is 30 days. Older entries are rotated out ' +
          'of audit.log automatically at the start of each month.',
      },
      {
        id: 'ret-new',
        store: 'sqlite',
        ageDays: 9,
        semantic: 0.86,
        rel: REL.ideal,
        content:
          'Updated policy: the audit log retention window is 90 days, not 30. ' +
          'Compliance asked for a full quarter of query history.',
      },
      {
        id: 'ret-noise',
        store: 'leveldb',
        ageDays: 60,
        semantic: 0.41,
        rel: REL.related,
        content:
          'The audit log records every query, read, write and denied write as one ' +
          'JSONL line. It is append-only and the agent can never write to it.',
      },
    ],
    expectConflicts: ['numeric'],
  },

  {
    id: 'strong-old-beats-weak-new',
    query: 'why is the router the differentiator not the store',
    probe:
      'The counterweight to recency. A fresh but weakly-related note must not ' +
      'displace an old note that actually answers the question — decay is a ' +
      'multiplier on relevance, never a sort key of its own.',
    docs: [
      {
        id: 'thesis-old',
        store: 'markdown',
        ageDays: 520,
        rel: REL.ideal,
        content:
          'Agent memory is an architecture problem, not a storage problem. Every ' +
          'vendor ships a store; almost nobody ships the router that decides which ' +
          'store to believe. The differentiator is the router, not the stores.',
      },
      {
        id: 'standup-new',
        store: 'leveldb',
        ageDays: 1,
        semantic: 0.44,
        rel: REL.irrelevant,
        content:
          'Standup note: the router refactor is on the board for next sprint, ' +
          'nobody has picked it up yet.',
      },
      {
        id: 'store-note',
        store: 'sqlite',
        ageDays: 30,
        semantic: 0.52,
        rel: REL.related,
        content:
          'The store slot stays stable for permissions and audit; the backend is ' +
          'the concrete engine, and the dashboard shows the backend.',
      },
    ],
  },

  {
    id: 'corroboration',
    query: 'markdown vault default access mode',
    probe:
      'Three stores independently say the vault is read-only; one stale note says ' +
      'otherwise. Agreement across independent stores is evidence and should ' +
      'outrank a single unsupported claim that scores slightly higher on keywords.',
    // No `expectConflicts` on purpose, and the reason is worth recording rather
    // than quietly omitting. "read" against "readwrite" is a real contradiction
    // and the detector misses it: it is not a number, not a date, and not a
    // negation, so nothing mechanical marks it. Catching it would take a lexicon
    // of domain antonyms, which is a maintenance burden that fires on the wrong
    // things. The case still earns its place — it is named for corroboration and
    // that is what it measures. Written down here so the gap stays a known
    // limitation instead of turning into a surprise later.
    docs: [
      {
        id: 'vault-a',
        fact: 'vault-readonly',
        store: 'markdown',
        ageDays: 120,
        rel: REL.ideal,
        content:
          'The markdown vault default access mode is read. The agent may search ' +
          'your notes and may not edit them.',
      },
      {
        id: 'vault-b',
        fact: 'vault-readonly',
        store: 'sqlite',
        ageDays: 95,
        semantic: 0.83,
        rel: REL.ideal,
        content:
          'The markdown vault default access mode is read. The agent may search ' +
          'your notes and may not edit them.',
      },
      {
        id: 'vault-c',
        fact: 'vault-readonly',
        store: 'vector',
        ageDays: 88,
        semantic: 0.81,
        rel: REL.ideal,
        content:
          'The markdown vault default access mode is read — the agent may search ' +
          'your notes, and may not edit them.',
      },
      {
        id: 'vault-wrong',
        store: 'leveldb',
        ageDays: 210,
        semantic: 0.9,
        rel: REL.irrelevant,
        content:
          'Markdown vault default access mode: readwrite, so the agent can file ' +
          'its own notes into the vault directly.',
      },
    ],
  },

  {
    id: 'specificity',
    query: 'pgvector cosine operator class',
    probe:
      'One rare term carries the whole question. Embeddings are topical, so the ' +
      'general essay about distance operators reads as the closer match and the ' +
      'terse note that actually names the operator class scores lower. Pool-wide ' +
      'IDF is what notices that only one candidate says "pgvector".',
    docs: [
      {
        id: 'spec-hit',
        store: 'sqlite',
        ageDays: 40,
        // Terse and code-shaped: lower topical similarity than the essay below,
        // which is exactly how a real embedder behaves here.
        semantic: 0.62,
        rel: REL.ideal,
        content:
          'Create the index with vector_cosine_ops — that is the pgvector operator ' +
          'class for cosine distance, and it must match the operator used in the ' +
          'ORDER BY or the index is ignored.',
      },
      {
        id: 'spec-common-1',
        store: 'leveldb',
        ageDays: 25,
        semantic: 0.74,
        rel: REL.related,
        content:
          'The cosine similarity helper lives in stores/utils.ts. Any store class ' +
          'that holds vectors can call it; it is the same operator everywhere.',
      },
      {
        id: 'spec-common-2',
        store: 'files',
        ageDays: 20,
        semantic: 0.81,
        // On topic and does not answer the question — a 1 by the rubric above,
        // same as spec-common-1. The case turns on the top slot, not the tail.
        rel: REL.related,
        content:
          'Cosine, dot product and Euclidean are the three distance operators worth ' +
          'knowing. Cosine is the usual class of operator for text.',
      },
    ],
  },

  {
    id: 'curated-over-generated',
    query: 'how do i want the CLI dashboard to read',
    probe:
      'Ben wrote one of these; an agent summarized the other from a transcript. ' +
      'At comparable relevance the human-authored note is the one to trust.',
    docs: [
      {
        id: 'human-note',
        store: 'markdown',
        ageDays: 45,
        rel: REL.ideal,
        content:
          'The CLI dashboard should read like a status board, not a form. Matrix ' +
          'green, fixed 74 columns, no jagged right edge, and every store visible ' +
          'without scrolling.',
      },
      {
        id: 'agent-note',
        store: 'sqlite',
        ageDays: 44,
        semantic: 0.58,
        rel: REL.relevant,
        content:
          'Summary of session: user wants the CLI dashboard to read cleanly and ' +
          'stay aligned at a fixed width.',
      },
      {
        id: 'unrelated-ui',
        store: 'leveldb',
        ageDays: 300,
        semantic: 0.3,
        rel: REL.irrelevant,
        content:
          'The website uses the same green palette as the dashboard so the project ' +
          'reads as one thing.',
      },
    ],
  },

  {
    id: 'duplicate-collapse',
    query: 'shared postgres pool for structured and vector',
    probe:
      'The same fact was written into three stores. Without clustering it eats ' +
      'three of the top five slots and pushes genuinely useful notes off the ' +
      'bundle. Collapsing it is what buys the room.',
    docs: [
      {
        id: 'pool-a',
        fact: 'shared-pool',
        store: 'sqlite',
        ageDays: 15,
        semantic: 0.87,
        rel: REL.ideal,
        content:
          'One shared Postgres pool backs both the structured and vector slots. ' +
          'One connection covers both.',
      },
      {
        id: 'pool-b',
        fact: 'shared-pool',
        store: 'vector',
        ageDays: 15,
        semantic: 0.86,
        rel: REL.ideal,
        content:
          'One shared Postgres pool backs both the structured and vector slots. ' +
          'One connection covers both.',
      },
      {
        id: 'pool-c',
        fact: 'shared-pool',
        store: 'leveldb',
        ageDays: 14,
        semantic: 0.85,
        rel: REL.ideal,
        content:
          'One shared Postgres pool backs both the structured and the vector slot — ' +
          'one connection covers both.',
      },
      {
        id: 'pool-fail',
        store: 'files',
        ageDays: 12,
        semantic: 0.72,
        rel: REL.relevant,
        content:
          'If the shared pool cannot connect there is no silent fallback to local ' +
          'SQLite. The selected backend shows as not-connected instead, because ' +
          'quietly writing somewhere else would scatter your data.',
      },
      {
        id: 'pool-env',
        store: 'files',
        ageDays: 30,
        semantic: 0.68,
        rel: REL.relevant,
        content:
          'The Postgres URL comes from MMIND_POSTGRES_URL and is never written to ' +
          'config.json — the config records which backend was chosen, not how to ' +
          'reach it.',
      },
    ],
  },

  {
    id: 'lexical-only-parity',
    query: 'haddam connecticut build timeline',
    probe:
      'The best answer sits in a vault file with no embedding. It must not be ' +
      'suppressed just because it cannot offer a semantic score — a store that ' +
      'reports no embedding is scored on lexical alone, not penalized.',
    docs: [
      {
        id: 'vault-plan',
        store: 'markdown',
        ageDays: 70,
        rel: REL.ideal,
        content:
          'Haddam Connecticut build timeline: site work and foundation next spring, ' +
          'framing that summer, relocation targeted 12 to 24 months out.',
      },
      {
        id: 'vec-near',
        store: 'vector',
        ageDays: 50,
        semantic: 0.63,
        rel: REL.related,
        content:
          'Land purchase closed. Survey and perc test are done and on file with the ' +
          'town.',
      },
      {
        id: 'vec-far',
        store: 'vector',
        ageDays: 20,
        semantic: 0.58,
        rel: REL.irrelevant,
        content:
          'St. Augustine house needs the deck resealed before listing photos.',
      },
    ],
  },

  {
    id: 'temporal-conflict',
    query: 'when does the 0.4.0 release ship',
    probe:
      'Two dates for one event. Neither should be silently dropped — the bundle ' +
      'reports the disagreement and names which one the router would trust.',
    docs: [
      {
        id: 'date-a',
        store: 'sqlite',
        ageDays: 30,
        semantic: 0.8,
        rel: REL.relevant,
        content: 'The 0.4.0 release ships 2026-08-01 per the roadmap note.',
      },
      {
        id: 'date-b',
        store: 'leveldb',
        ageDays: 3,
        semantic: 0.79,
        rel: REL.ideal,
        content: 'The 0.4.0 release ships 2026-09-15 per the roadmap note.',
      },
    ],
    expectConflicts: ['temporal'],
  },

  {
    id: 'baseline-already-right',
    query: 'which embedding model does the local provider use',
    probe:
      'A control. One document plainly answers the question and the baseline ' +
      'already ranks it first. The reranker must not invent a reason to reorder ' +
      'a pool it has nothing to add to.',
    docs: [
      {
        id: 'emb-hit',
        store: 'sqlite',
        ageDays: 60,
        semantic: 0.91,
        rel: REL.ideal,
        content:
          'The local embedding provider uses Xenova/all-MiniLM-L6-v2 at 384 ' +
          'dimensions through @huggingface/transformers. OpenAI ' +
          'text-embedding-3-small is 1536.',
      },
      {
        id: 'emb-side',
        store: 'leveldb',
        ageDays: 60,
        semantic: 0.4,
        rel: REL.related,
        content:
          'Set MMIND_EMBEDDINGS=none to run with the null provider and no model ' +
          'download at all.',
      },
      {
        id: 'emb-noise',
        store: 'files',
        ageDays: 90,
        semantic: 0.22,
        rel: REL.irrelevant,
        content: 'The CNC spoilboard needs resurfacing before the next panel run.',
      },
    ],
  },

  {
    id: 'mixed-hard',
    query: 'can the agent write to the audit log',
    probe:
      'The hard one: the wrong answer is fresher, scores higher on keywords, and ' +
      'is the kind of plausible-sounding note an agent writes about itself. The ' +
      'right answer is older and curated. No single signal settles it.',
    // This case costs P@3 and that is the correct outcome, not a bug to tune out.
    // `audit-ops` (curated, 100d, graded 1) finishes above `audit-corroborating`
    // (generated, 150d, graded 2) even though its relevance is lower — 0.55
    // against 0.65 — because provenance and a three-year half-life outweigh a
    // tenth of a point of relevance. That is precisely the trade the configured
    // weights are asking for, so the honest thing is to pay it in the metric and
    // leave the weights alone. The two answers that matter are both right: the
    // top slot and the negation conflict.
    //
    // Also worth naming, because it looks like an accident and is not: the two
    // notes here that agree with each other, `audit-truth` and
    // `audit-corroborating`, get no corroboration boost. They state the same
    // fact in different words, and the merge step keys on near-duplicate token
    // overlap — the same note copied into two stores, which is what actually
    // happens when an agent writes to scratch and the vault. Recognizing
    // agreement between differently-worded claims is a larger feature than the
    // one this release shipped, and pretending otherwise by loosening the
    // duplicate threshold would start merging notes that are merely on the same
    // topic.
    docs: [
      {
        id: 'audit-truth',
        store: 'markdown',
        ageDays: 180,
        rel: REL.ideal,
        content:
          'The audit log is system-managed and append-only. The agent can never ' +
          'write to the audit log and cannot retrieve from it; audit is excluded ' +
          'from both the store and retrieve tool store lists.',
      },
      {
        id: 'audit-wrong',
        store: 'leveldb',
        ageDays: 4,
        semantic: 0.84,
        rel: REL.irrelevant,
        content:
          'The agent can write to the audit log when it needs to record that it ' +
          'wrote to the audit log.',
      },
      {
        id: 'audit-corroborating',
        store: 'sqlite',
        ageDays: 150,
        semantic: 0.76,
        rel: REL.relevant,
        content:
          'Audit is excluded from STORE_TYPES in both tools, so the agent has no ' +
          'way to address it at all.',
      },
      {
        id: 'audit-ops',
        store: 'files',
        ageDays: 100,
        semantic: 0.6,
        rel: REL.related,
        content:
          'Audit ops are query, read, write and denied. A denied write still leaves ' +
          'a line, which is the whole point of logging it.',
      },
    ],
    expectConflicts: ['negation'],
  },
];
