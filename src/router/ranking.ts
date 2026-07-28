/**
 * Rerank engine — the part of the router that decides what actually matters.
 *
 * Fan-out is easy. Choosing well from what came back is the hard part, and it is
 * where a multi-store memory layer either earns its keep or doesn't. Four signals,
 * each independently explainable:
 *
 *   specificity  — IDF-weighted BM25 over the candidate pool, so a rare, precise
 *                  term outweighs a common one instead of every query token
 *                  counting the same
 *   recency      — exponential half-life decay per store, with a floor so an old
 *                  but strongly relevant memory is never buried outright
 *   corroboration— the same memory found independently in two stores is stronger
 *                  evidence than one copy, so agreement boosts rather than being
 *                  thrown away by de-duplication
 *   trust        — content a human curated outranks content the agent wrote about
 *                  itself, all else equal
 *
 * Every one of them is a multiplier on a 0–1 relevance base, and every one of
 * them is reported back in the score breakdown. No black boxes.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import {
  DEFAULT_RANKING,
  type ConflictKind,
  type ConflictNote,
  type CorroborationInfo,
  type MemoryEntry,
  type Provenance,
  type RankedEntry,
  type RankingConfig,
  type RelevanceSignals,
  type ScoreBreakdown,
  type StoreType,
} from '../types.js';

// ─── Tuning constants ─────────────────────────────────────────────────────────

/** BM25 term-frequency saturation. */
const K1 = 1.2;
/** BM25 length normalization. */
const B = 0.75;
/** Floor on IDF so a term every candidate shares still carries a little weight. */
const IDF_FLOOR = 0.25;
/** Share of the lexical score reserved for a verbatim phrase hit. */
const PHRASE_WEIGHT = 0.15;
/** Minimum subject overlap before two claims are even considered contradictory. */
const CONFLICT_SUBJECT_SIM = 0.5;
/** Bound the O(n²) conflict scan and the noise it can produce. */
const CONFLICT_SCAN = 12;
/** Sentences examined per memory. Past this a note is prose, not a claim sheet. */
const CLAIMS_PER_ENTRY = 6;
const MAX_CONFLICTS = 5;
/** Longest claim quoted back in a conflict note before it is elided. */
const CLAIM_QUOTE = 90;

const MS_PER_DAY = 86_400_000;

// ─── Text utilities ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'so',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'you', 'your',
]);

/**
 * Split text into comparable tokens. Keeps digits, decimals, currency and
 * percent markers intact — those are exactly the tokens that distinguish two
 * memories that otherwise say the same thing.
 *
 * Digit-grouping commas are fused first, so "$12,500.50" survives as one token
 * and "12,500" and "12500" compare equal. Two memories that write the same
 * number differently are not a contradiction, and the tokenizer is the only
 * place that can know that.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const fused = text.toLowerCase().replace(/(\d),(?=\d)/g, '$1');
  for (const raw of fused.split(/[^a-z0-9'._$%-]+/)) {
    const t = raw.replace(/^[-._']+/, '').replace(/[-._']+$/, '');
    if (t) out.push(t);
  }
  return out;
}

/** Tokens minus stopwords — what the scorer and the conflict detector actually compare. */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

function uniq(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Whitespace- and case-normalized text, for exact-phrase and exact-duplicate checks. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── Specificity: IDF-weighted lexical scoring ────────────────────────────────

/**
 * Build a BM25 scorer over the candidate pool.
 *
 * The old scorer was "fraction of query tokens present", which rated a match on
 * "the" exactly as highly as a match on "pgvector". IDF fixes that: a term that
 * shows up in every candidate discriminates nothing and is weighted down toward
 * the floor, while a term that shows up in one dominates.
 *
 * IDF is computed over the retrieved pool rather than a global corpus — the
 * stores don't share an index, and pool-local IDF is what re-rankers use anyway.
 * Terms no candidate contains are dropped from the normalizer instead of
 * crushing every score toward zero.
 *
 * `docContents` is what lets the verbatim-phrase bonus stay honest: the phrase
 * term only enters the blend when some candidate in the pool actually contains
 * the phrase. If none do, it discriminates nothing, so applying it would just
 * shave a flat percentage off every multi-word query for no information.
 */
export function buildLexicalScorer(
  query: string,
  docTokens: string[][],
  docContents: string[] = []
): (tokens: string[], content: string) => number {
  const queryTerms = uniq(contentTokens(query));
  const docCount = Math.max(1, docTokens.length);

  const df = new Map<string, number>();
  for (const doc of docTokens) {
    const present = new Set(doc);
    for (const term of queryTerms) {
      if (present.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // Only terms something actually matched participate in scoring or normalizing.
  const liveTerms = queryTerms.filter((t) => (df.get(t) ?? 0) > 0);
  const idf = new Map<string, number>();
  for (const term of liveTerms) {
    const n = df.get(term)!;
    idf.set(term, Math.max(IDF_FLOOR, Math.log(1 + (docCount - n + 0.5) / (n + 0.5))));
  }

  const totalLength = docTokens.reduce((sum, d) => sum + d.length, 0);
  const avgDocLength = totalLength / docCount || 1;
  // Calibrate against a realistic strong match, not BM25's asymptote.
  //
  // The obvious normalizer is Σ idf·(K1+1) — the value BM25 approaches as term
  // frequency runs to infinity. Nothing ever gets there, so dividing by it puts
  // every real document in the bottom half of the range: a document of average
  // length containing every query term once, which is what "a good keyword
  // match" means, scores 1/(K1+1) ≈ 0.45. Blend that against a cosine, where the
  // same quality of match reads 0.8, and the lexical side silently carries half
  // the weight the config says it does — which penalizes exactly the store that
  // has nothing else to offer, the markdown vault.
  //
  // So the divisor is Σ idf: every query term present once at average length
  // scores 1.0, and repetition beyond that saturates against the clamp. That is
  // the same judgement K1 already makes inside the sum — past a point, saying a
  // word more times is density, not aboutness.
  const ceiling = liveTerms.reduce((sum, t) => sum + idf.get(t)!, 0) || 1;

  const phrase = normalizeText(query);
  const phraseEligible =
    phrase.length >= 4 &&
    phrase.includes(' ') &&
    docContents.some((c) => normalizeText(c).includes(phrase));

  return (tokens: string[], content: string): number => {
    if (liveTerms.length === 0) return 0;

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const docLength = tokens.length || 1;

    let bm25 = 0;
    for (const term of liveTerms) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const norm = freq + K1 * (1 - B + (B * docLength) / avgDocLength);
      bm25 += idf.get(term)! * ((freq * (K1 + 1)) / norm);
    }

    const lexical = clamp01(bm25 / ceiling);
    if (!phraseEligible) return lexical;

    // A verbatim phrase hit is a strong precision signal that bag-of-words misses.
    const exact = normalizeText(content).includes(phrase) ? 1 : 0;
    return clamp01(lexical * (1 - PHRASE_WEIGHT) + exact * PHRASE_WEIGHT);
  };
}

// ─── Recency ──────────────────────────────────────────────────────────────────

/**
 * Exponential half-life decay, floored.
 *
 * The floor is the important part: relevance still decides, recency only tilts.
 * A three-year-old note that nails the query beats a fresh one that barely
 * mentions it — which is the behavior you want from notes, and the opposite of
 * what a naive "sort by newest" would do.
 */
export function recencyFactor(
  entry: MemoryEntry,
  storeType: StoreType,
  cfg: RankingConfig,
  now: number
): { multiplier: number; ageDays: number } {
  const stamp = Date.parse(entry.updatedAt || entry.createdAt || '');
  if (!Number.isFinite(stamp)) return { multiplier: 1, ageDays: 0 };

  const ageDays = Math.max(0, (now - stamp) / MS_PER_DAY);
  const halfLife = cfg.halfLifeDays[storeType];
  if (!halfLife || halfLife <= 0) return { multiplier: 1, ageDays };

  const decay = Math.pow(0.5, ageDays / halfLife);
  const floor = clamp01(cfg.recencyFloor);
  return { multiplier: floor + (1 - floor) * decay, ageDays };
}

// ─── Trust ────────────────────────────────────────────────────────────────────

export function trustTier(storeType: StoreType, cfg: RankingConfig): Provenance {
  return cfg.provenance[storeType] ?? 'generated';
}

export function trustFactor(storeType: StoreType, cfg: RankingConfig): number {
  return cfg.trust[trustTier(storeType, cfg)] ?? 1;
}

// ─── Candidates ───────────────────────────────────────────────────────────────

/** A store hit tagged with the slot it came from, so the router never has to guess. */
export interface Candidate extends RankedEntry {
  storeType: StoreType;
}

interface Scored {
  candidate: Candidate;
  tokens: string[];
  tokenSet: Set<string>;
  normalized: string;
  semantic: number;
  lexical: number;
  relevance: number;
  recency: number;
  ageDays: number;
  trust: number;
  /** relevance × recency × trust, before corroboration. */
  base: number;
}

/**
 * Stores that predate signals reporting hand back one opaque number. Treat it as
 * the semantic signal and let the router compute lexical fresh — degraded, but
 * never silently wrong.
 */
function signalsOf(c: Candidate): RelevanceSignals {
  return c.signals ?? { semantic: c.score, lexical: 0, hasEmbedding: true };
}

// ─── Corroboration clustering ─────────────────────────────────────────────────

interface Cluster {
  members: Scored[];
  tokenSet: Set<string>;
  normalized: string;
}

/**
 * Group near-identical memories.
 *
 * The old de-duplication kept whichever copy happened to arrive first and threw
 * the rest away — losing both the better-scoring copy and the fact that two
 * independent stores agreed. Here duplicates cluster, the strongest member
 * represents the cluster, and independent agreement becomes a score boost.
 */
function clusterCandidates(scored: Scored[], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  const exact = new Map<string, Cluster>();

  // Strongest first, so the cluster representative is the best copy, not the first.
  const ordered = [...scored].sort((a, b) => b.base - a.base);

  for (const item of ordered) {
    const hit = exact.get(item.normalized);
    if (hit) {
      hit.members.push(item);
      continue;
    }

    let matched: Cluster | undefined;
    for (const cluster of clusters) {
      if (jaccard(item.tokenSet, cluster.tokenSet) >= threshold) {
        matched = cluster;
        break;
      }
    }

    if (matched) {
      matched.members.push(item);
      continue;
    }

    const created: Cluster = {
      members: [item],
      tokenSet: item.tokenSet,
      normalized: item.normalized,
    };
    clusters.push(created);
    exact.set(item.normalized, created);
  }

  return clusters;
}

/**
 * How close two members of a cluster have to be in score before the tie is
 * broken on provenance instead. Cluster members already say the same thing, so
 * a few percent between them reflects how each store happened to index the
 * text, not which copy is more worth citing.
 */
const REPRESENTATIVE_TIE_BAND = 0.03;

/**
 * Which copy of a clustered fact the bundle should cite.
 *
 * Highest score wins, except among copies that are effectively tied, where the
 * human-authored one is preferred. If the same sentence sits in the user's vault
 * and in an agent's scratch note, the citation should point at the vault — that
 * is the copy they can open and check, and the trust tier would be a strange
 * thing to apply to scoring but not to attribution.
 */
function representativeOf(cluster: Cluster, cfg: RankingConfig): Scored {
  return cluster.members.reduce((best, m) => {
    if (m.base > best.base * (1 + REPRESENTATIVE_TIE_BAND)) return m;
    if (best.base > m.base * (1 + REPRESENTATIVE_TIE_BAND)) return best;
    const mCurated = trustTier(m.candidate.storeType, cfg) === 'curated';
    const bestCurated = trustTier(best.candidate.storeType, cfg) === 'curated';
    if (mCurated !== bestCurated) return mCurated ? m : best;
    return m.base > best.base ? m : best;
  });
}

function corroborationOf(cluster: Cluster): { info?: CorroborationInfo; distinctStores: number } {
  const stores: StoreType[] = [];
  const sources: string[] = [];
  for (const m of cluster.members) {
    if (!stores.includes(m.candidate.storeType)) stores.push(m.candidate.storeType);
    if (!sources.includes(m.candidate.source)) sources.push(m.candidate.source);
  }
  if (stores.length < 2) return { distinctStores: stores.length };
  return {
    distinctStores: stores.length,
    info: { stores, sources, hits: cluster.members.length },
  };
}

// ─── Conflict detection ───────────────────────────────────────────────────────

const NEGATIONS = new Set([
  'not', 'no', 'never', 'cannot', 'cant', 'dont', 'doesnt', 'isnt', 'arent',
  'wasnt', 'werent', 'wont', 'without', 'removed', 'deprecated', 'discontinued',
  'cancelled', 'canceled', 'denied', 'disabled', 'revoked', 'stopped', 'dropped',
]);

const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

const NUMERIC_RE = /^\$?-?\d[\d,]*(\.\d+)?%?$/;
const YEAR_RE = /^(19|20)\d{2}$/;
const ISO_DATE_RE = /^(19|20)\d{2}-\d{2}(-\d{2})?$/;

function isDateToken(t: string): boolean {
  return YEAR_RE.test(t) || ISO_DATE_RE.test(t) || MONTHS.has(t);
}

function isNumericToken(t: string): boolean {
  return NUMERIC_RE.test(t) && !isDateToken(t);
}

function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (!b.has(t)) return true;
  for (const t of b) if (!a.has(t)) return true;
  return false;
}

function listOf(s: Set<string>, max = 3): string {
  return [...s].slice(0, max).join(', ');
}

function stampOf(entry: MemoryEntry): number {
  const t = Date.parse(entry.updatedAt || entry.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

/** One sentence of one memory, reduced to the parts a conflict can turn on. */
interface Claim {
  ranked: RankedEntry;
  /** The sentence itself, for quoting back to the caller. */
  text: string;
  subject: Set<string>;
  numbers: Set<string>;
  dates: Set<string>;
  negated: boolean;
  normalized: string;
}

/**
 * Split into independent clauses: sentence punctuation, hard line breaks, and
 * semicolons. A semicolon joins two statements that could each stand alone, and
 * a note that says "the agent can never write to it; audit is excluded from the
 * tool list" is making two separate claims. Decimals and ISO dates stay intact.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s*;\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Reduce a memory to the claims it makes.
 *
 * Conflicts are a property of sentences, not documents. Two notes about the
 * retention window disagree in one clause and then go their separate ways —
 * one explains the rotation schedule, the other names the compliance ask. Judged
 * whole-document those two look like different topics and the disagreement is
 * missed; judged sentence by sentence the contested claim lines up cleanly.
 *
 * Every sentence is kept, including ones carrying no number, date or negation of
 * their own. Filtering those out looks like a cheap way to shrink the pairwise
 * scan, and it silently breaks negation detection: a negation conflict needs one
 * side that negates and one side that plainly asserts, and the plain assertion is
 * exactly what such a filter throws away. The discriminating signal is a property
 * of the *pair*, so it is required at the comparison and not here.
 */
function claimsOf(ranked: RankedEntry): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of sentencesOf(ranked.entry.content)) {
    if (claims.length >= CLAIMS_PER_ENTRY) break;
    const tokens = contentTokens(sentence);
    const numbers = new Set(tokens.filter(isNumericToken));
    const dates = new Set(tokens.filter(isDateToken));
    const negated = tokens.some((t) => NEGATIONS.has(t));
    const subject = new Set(
      tokens.filter((t) => !numbers.has(t) && !dates.has(t) && !NEGATIONS.has(t))
    );
    if (subject.size === 0) continue;
    claims.push({
      ranked,
      text: sentence,
      subject,
      numbers,
      dates,
      negated,
      normalized: normalizeText(sentence),
    });
  }
  return claims;
}

/**
 * Does one side name the other's value and then replace it?
 *
 * "The retention window is 90 days, not 30" against "the retention window is 30
 * days" is a correction, not a polarity flip — the newer note quotes the figure
 * it is superseding. That shape is the most common real disagreement in an
 * agent's memory, because it is what writing down a changed policy looks like,
 * and reporting it as `numeric` with both figures tells the caller more than
 * reporting it as `negation` because the word "not" appeared.
 */
function corrects(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0 || small.size === large.size) return false;
  for (const v of small) if (!large.has(v)) return false;
  return true;
}

function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= CLAIM_QUOTE ? clean : `${clean.slice(0, CLAIM_QUOTE - 1)}…`;
}

/**
 * Find memories that cover the same subject but state incompatible things.
 *
 * Deliberately conservative and deliberately not an LLM call. It fires on three
 * mechanical signals — a differing number, a differing date, a negation present
 * on exactly one side — and only where two sentences from different memories are
 * plainly about the same thing. A retrieval layer that cried wolf would be worse
 * than one that stayed quiet, so every gate here errs toward silence.
 *
 * What it therefore cannot catch, and does not pretend to: a disagreement
 * carried entirely by a value word. "Vault access is read" against "vault access
 * is readwrite" is a flat contradiction that no number, date or negation marks,
 * and the only way to see it mechanically is a lexicon of domain antonyms — which
 * would need to know that read and readwrite are exclusive without deciding that
 * oak and walnut are. Those conflicts are left to the caller, which is why the
 * bundle ships every corroborating source rather than only the winner.
 */
export function detectConflicts(
  entries: RankedEntry[],
  cfg: RankingConfig
): ConflictNote[] {
  if (!cfg.conflictDetection) return [];

  const scope = entries.slice(0, CONFLICT_SCAN).map(claimsOf);
  const notes: ConflictNote[] = [];
  // One note per pair of memories. The first contested claim is the report;
  // listing five variations on the same disagreement is noise, not diligence.
  const reported = new Set<string>();

  outer: for (let i = 0; i < scope.length; i++) {
    for (let j = i + 1; j < scope.length; j++) {
      for (const a of scope[i]!) {
        for (const b of scope[j]!) {
          if (notes.length >= MAX_CONFLICTS) break outer;
          if (a.ranked.entry.id === b.ranked.entry.id) continue;

          const pair = `${a.ranked.entry.id}|${b.ranked.entry.id}`;
          if (reported.has(pair)) continue;

          // Identical sentences cannot disagree with each other.
          if (a.normalized === b.normalized) continue;

          // `subject` deliberately excludes the numbers, dates and negations
          // that would differ, so a genuine contradiction scores NEAR 1.0 here.
          // High similarity is the signal, not a disqualifier — an upper bound
          // would throw out exactly the case this function exists to find.
          if (jaccard(a.subject, b.subject) < CONFLICT_SUBJECT_SIM) continue;

          let kind: ConflictKind | undefined;
          let detail = '';

          // An explicit correction is classified by the value it corrects, even
          // though it usually carries a negation too. Order matters: the figure
          // is the disagreement, the "not" is only how it was written down.
          if (corrects(a.numbers, b.numbers)) {
            kind = 'numeric';
            detail = `values differ (${listOf(a.numbers)} vs ${listOf(b.numbers)})`;
          } else if (corrects(a.dates, b.dates)) {
            kind = 'temporal';
            detail = `dates differ (${listOf(a.dates)} vs ${listOf(b.dates)})`;
          } else if (a.negated !== b.negated) {
            kind = 'negation';
            detail = 'one states it, the other negates it';
          } else if (setsDiffer(a.numbers, b.numbers)) {
            kind = 'numeric';
            detail = `values differ (${listOf(a.numbers)} vs ${listOf(b.numbers)})`;
          } else if (setsDiffer(a.dates, b.dates)) {
            kind = 'temporal';
            detail = `dates differ (${listOf(a.dates)} vs ${listOf(b.dates)})`;
          }

          if (!kind) continue;

          reported.add(pair);
          // `entries` arrives sorted, and j > i, so `a` is the memory the router
          // already ranked higher. That is the verdict; nothing is re-litigated.
          notes.push({
            entryIds: [a.ranked.entry.id, b.ranked.entry.id],
            kind,
            description: `Same subject, ${detail} — "${quote(a.text)}" vs "${quote(b.text)}".`,
            sources: [a.ranked.source, b.ranked.source],
            preferred: a.ranked.entry.id,
            reason: preferenceReason(a.ranked, b.ranked, cfg),
          });
        }
      }
    }
  }

  return notes;
}

/**
 * Why the router put the memory it kept ahead of the one it contradicts.
 *
 * This does not re-decide anything. `won` is whichever entry already ranked
 * higher, and the job here is only to name the signal that separated them. An
 * earlier version ran its own recency-first preference chain, which could and
 * did disagree with the ranking printed directly above it — the bundle would
 * lead with the curated note and then announce that it preferred the other one.
 * A retrieval layer that argues with itself is worse than one that says nothing,
 * so there is exactly one verdict and this explains it.
 *
 * The order below mirrors what the ranker actually weighs: independent agreement
 * first, then provenance, then recency, then plain relevance.
 */
function preferenceReason(won: RankedEntry, lost: RankedEntry, cfg: RankingConfig): string {
  const corrWon = won.corroboration?.stores.length ?? 1;
  const corrLost = lost.corroboration?.stores.length ?? 1;
  if (corrWon > corrLost) return `corroborated by ${corrWon} stores`;

  const wonCurated = trustTier(won.entry.storeType, cfg) === 'curated';
  const lostCurated = trustTier(lost.entry.storeType, cfg) === 'curated';
  if (wonCurated && !lostCurated) return `human-authored (${won.entry.storeType})`;

  const stampWon = stampOf(won.entry);
  const stampLost = stampOf(lost.entry);
  if (stampWon > stampLost && stampLost > 0) {
    return `newer (${won.entry.updatedAt.slice(0, 10)})`;
  }
  if (stampWon < stampLost && stampWon > 0) {
    // Worth saying out loud. The router is knowingly keeping the older memory,
    // and that is the one call a reader is most likely to want to check.
    return `older but ranked higher (${won.entry.updatedAt.slice(0, 10)})`;
  }

  return 'higher relevance';
}

// ─── Rerank ───────────────────────────────────────────────────────────────────

export interface RerankOptions {
  query: string;
  candidates: Candidate[];
  limit: number;
  config?: RankingConfig;
  /** Reference time for recency. Injectable so tests are deterministic. */
  now?: number;
  /** Attach the full score derivation to each returned entry. */
  explain?: boolean;
}

export interface RerankResult {
  entries: RankedEntry[];
  conflicts: ConflictNote[];
}

/**
 * Merge a partial config over the defaults, including the nested per-store maps.
 *
 * Always returns a fresh object, even given no input. Handing back
 * `DEFAULT_RANKING` itself is the cheap thing to do and it is a trap: the
 * server's env-var pass and the dashboard's tuning panel both assign onto the
 * result, so the shared constant would quietly take on one caller's settings for
 * the rest of the process — and the symptom would show up somewhere else
 * entirely, as a ranking that ignores the config it was handed.
 */
export function resolveRanking(partial?: Partial<RankingConfig>): RankingConfig {
  return {
    ...DEFAULT_RANKING,
    ...(partial ?? {}),
    halfLifeDays: { ...DEFAULT_RANKING.halfLifeDays, ...(partial?.halfLifeDays ?? {}) },
    provenance: { ...DEFAULT_RANKING.provenance, ...(partial?.provenance ?? {}) },
    trust: { ...DEFAULT_RANKING.trust, ...(partial?.trust ?? {}) },
  };
}

export function rerank(opts: RerankOptions): RerankResult {
  const cfg = opts.config ?? DEFAULT_RANKING;
  const now = opts.now ?? Date.now();
  if (opts.candidates.length === 0) return { entries: [], conflicts: [] };

  const weightSum = cfg.semanticWeight + cfg.lexicalWeight || 1;
  const wSemantic = cfg.semanticWeight / weightSum;
  const wLexical = cfg.lexicalWeight / weightSum;

  // 1 ─ Specificity: one IDF model over the whole candidate pool.
  const docTokens = opts.candidates.map((c) => contentTokens(c.entry.content));
  const docContents = opts.candidates.map((c) => c.entry.content);
  const lexicalScore = buildLexicalScorer(opts.query, docTokens, docContents);

  // 2 ─ Per-candidate relevance, recency and trust.
  //
  // Both signals are absolute 0–1 quantities on comparable scales — cosine by
  // construction, lexical by the calibration in `buildLexicalScorer` — so they
  // blend directly at the configured weights. Deliberately not normalized
  // against the best value in the pool: that would answer "which of these is
  // best" while destroying "how good is the best", and relevance has to survive
  // being multiplied by recency, trust and corroboration. Pool-relative scoring
  // promotes the strongest candidate to a perfect match even when the whole pool
  // is mediocre, and a weak vector hit would beat a decent vault hit purely
  // because rescaling inflated it.
  //
  // A candidate whose store holds no vectors is scored on lexical alone rather
  // than blended against a zero — no embedding means no opinion, not a measured
  // absence of similarity.
  const scored: Scored[] = opts.candidates.map((candidate, i) => {
    const tokens = docTokens[i]!;
    const s = signalsOf(candidate);
    const semantic = s.hasEmbedding ? clamp01(s.semantic) : 0;
    const lexical = lexicalScore(tokens, candidate.entry.content);
    const relevance = clamp01(
      s.hasEmbedding ? wSemantic * semantic + wLexical * lexical : lexical
    );

    const { multiplier: recency, ageDays } = recencyFactor(
      candidate.entry,
      candidate.storeType,
      cfg,
      now
    );
    const trust = trustFactor(candidate.storeType, cfg);

    return {
      candidate,
      tokens,
      tokenSet: new Set(tokens),
      normalized: normalizeText(candidate.entry.content),
      semantic,
      lexical,
      relevance,
      recency,
      ageDays,
      trust,
      base: relevance * recency * trust,
    };
  });

  // 3 ─ Cluster duplicates so agreement counts for instead of against.
  const clusters = clusterCandidates(scored, cfg.duplicateThreshold);

  const merged = clusters.map((cluster) => {
    const best = representativeOf(cluster, cfg);
    const { info, distinctStores } = corroborationOf(cluster);
    const corroboration = Math.min(
      cfg.corroborationCap,
      1 + cfg.corroborationBoost * Math.max(0, distinctStores - 1)
    );
    const raw = best.base * corroboration;

    const breakdown: ScoreBreakdown = {
      semantic: round4(best.semantic),
      lexical: round4(best.lexical),
      relevance: round4(best.relevance),
      recency: round4(best.recency),
      trust: round4(best.trust),
      corroboration: round4(corroboration),
      raw: round4(raw),
      ageDays: Math.round(best.ageDays * 10) / 10,
    };

    const entry: RankedEntry = {
      entry: best.candidate.entry,
      // Clamped for display; `raw` in the breakdown carries the unclamped truth
      // and the sort below uses raw, so ordering is never flattened by the clamp.
      score: clamp01(raw),
      source: best.candidate.source,
      signals: best.candidate.signals,
      ...(info ? { corroboration: info } : {}),
      ...(opts.explain ? { explain: breakdown } : {}),
    };
    return { entry, raw };
  });

  // 4 ─ Rank on the unclamped score, then cut.
  const entries: RankedEntry[] = merged
    .sort((a, b) => b.raw - a.raw)
    .slice(0, opts.limit)
    .map((m) => m.entry);

  return { entries, conflicts: detectConflicts(entries, cfg) };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ─── Baseline (pre-0.4.0) ─────────────────────────────────────────────────────

/**
 * The ranking this release replaces: trust the store's opaque score, drop any
 * duplicate the first copy already claimed, sort, cut. Kept verbatim so the eval
 * harness measures the improvement instead of asserting it.
 */
export function baselineRank(candidates: Candidate[], limit: number): RankedEntry[] {
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of candidates) {
    const fingerprint = normalizeText(candidate.entry.content).slice(0, 200);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push(candidate);
  }
  return deduped.sort((a, b) => b.score - a.score).slice(0, limit);
}
