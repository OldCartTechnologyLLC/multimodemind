/**
 * Retrieve router — the differentiator.
 *
 * Fanning out to every store is the easy half. The half that matters is deciding
 * what comes back: which memories are actually specific to the question, which
 * are stale, which two stores independently agree on, and which two flatly
 * contradict each other. That judgment lives in ./ranking.ts; this file is the
 * plumbing around it — fan out, tag each hit with the slot it came from, audit
 * every access, hand the pile to the reranker, return one bundle with full
 * provenance.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import type { EmbeddingProvider } from '../embeddings/index.js';
import type { MemoryStore } from '../stores/base.js';
import type { AuditStore } from '../stores/audit.js';
import { DEFAULT_RANKING, type RankingConfig, type RetrieveResult, type StoreType } from '../types.js';
import { rerank, type Candidate } from './ranking.js';

export interface RouterOptions {
  /** How many results to return after merging across stores */
  limit?: number;
  /** Only query these store types (default: all available) */
  stores?: StoreType[];
  /** Per-store candidate fetch multiplier before final ranking */
  candidateMultiplier?: number;
  /** Attach the full score derivation to every returned entry. */
  explain?: boolean;
  /** Reference time for recency decay. Injectable so tests are deterministic. */
  now?: number;
}

export class RetrieveRouter {
  private readonly ranking: RankingConfig;

  constructor(
    private readonly stores: MemoryStore[],
    private readonly embedder: EmbeddingProvider,
    private readonly audit?: AuditStore,
    ranking: RankingConfig = DEFAULT_RANKING
  ) {
    this.ranking = ranking;
  }

  async retrieve(query: string, opts: RouterOptions = {}): Promise<RetrieveResult> {
    const limit = opts.limit ?? 10;
    const candidatePer = limit * (opts.candidateMultiplier ?? 3);

    // Filter to requested store types
    const activeStores = opts.stores
      ? this.stores.filter((s) => opts.stores!.includes(s.type))
      : this.stores;

    // Generate query embedding once, reuse across all stores
    let embedding: number[] = [];
    try {
      embedding = await this.embedder.embed(query);
    } catch (err) {
      // Degraded mode: embedding failed, fall back to keyword-only
      console.warn('[mmind:router] Embedding failed, using keyword-only scoring:', err);
    }

    // Fan out to all stores in parallel
    const storeResults = await Promise.allSettled(
      activeStores.map((store) =>
        store.search(query, embedding, candidatePer)
      )
    );

    const storesQueried: StoreType[] = [];
    const candidates: Candidate[] = [];

    for (let i = 0; i < storeResults.length; i++) {
      const result = storeResults[i]!;
      const store = activeStores[i]!;
      if (result.status === 'fulfilled') {
        storesQueried.push(store.type);
        // Tag every hit with its slot. The reranker needs it for half-life,
        // trust tier and corroboration; the store's own `source` string is for
        // humans and is not a reliable key.
        for (const hit of result.value) {
          candidates.push({ ...hit, storeType: store.type });
        }
        // Audit each store read individually
        this.audit?.logRead(store.type, query, result.value.length);
      } else {
        console.warn(`[mmind:router] Store ${store.name} failed:`, result.reason);
      }
    }

    // Central rerank: specificity, recency, corroboration, trust — then conflicts.
    const { entries, conflicts } = rerank({
      query,
      candidates,
      limit,
      config: this.ranking,
      explain: opts.explain,
      now: opts.now,
    });

    // Audit the overall query
    this.audit?.logQuery(query, storesQueried, entries.length);

    return {
      entries,
      query,
      totalCandidates: candidates.length,
      storesQueried,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
  }
}
