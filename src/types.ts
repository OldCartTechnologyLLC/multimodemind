/**
 * Core types for Multimode Mind
 * Copyright Old Cart Technology LLC — MIT License
 */

// ─── Store taxonomy ──────────────────────────────────────────────────────────

export type StoreType = 'sqlite' | 'leveldb' | 'markdown' | 'files' | 'vector' | 'audit';

// ─── Access control ───────────────────────────────────────────────────────────

/** Whether the agent may only read a store, or also write to it. */
export type AccessMode = 'read' | 'readwrite';

/**
 * Conservative defaults: the agent does NOT get to change your data by default.
 * The Markdown vault (your existing notes) is read-only; mmind's own memory
 * stores are writable because storing new memories is their purpose. Every
 * store is user-configurable from the dashboard.
 */
export const DEFAULT_ACCESS: Record<StoreType, AccessMode> = {
  markdown: 'read',
  sqlite: 'readwrite',
  leveldb: 'readwrite',
  files: 'readwrite',
  vector: 'readwrite',
  audit: 'read', // append-only, system-managed; the agent can never write to it
};

// ─── Pluggable backends ───────────────────────────────────────────────────────

/** Engine backing the structured slot. */
export type StructuredBackend = 'sqlite' | 'postgres';
/** Engine backing the semantic (vector) slot. */
export type VectorBackend = 'vectra' | 'pgvector';

export interface BackendConfig {
  structured: StructuredBackend;
  vector: VectorBackend;
}

/** Local-first defaults — file-based, zero-config, nothing leaves the machine. */
export const DEFAULT_BACKENDS: BackendConfig = {
  structured: 'sqlite',
  vector: 'vectra',
};

// ─── Memory entry ─────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  storeType: StoreType;
  createdAt: string; // ISO 8601
  updatedAt: string;
  embedding?: number[];
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

/**
 * Raw relevance signals reported by a store, kept separate on purpose.
 *
 * Stores used to hand back one pre-blended number the router could neither
 * re-weight nor explain. Reporting the components lets the router blend them
 * centrally with configurable weights, recompute lexical match with corpus-wide
 * IDF, and show its work.
 */
export interface RelevanceSignals {
  /** Cosine similarity against the query embedding, 0–1. 0 when unavailable. */
  semantic: number;
  /** The store's own lexical match, 0–1. The router normally recomputes this. */
  lexical: number;
  /** True when this store actually had an embedding to compare against. */
  hasEmbedding: boolean;
}

/** Stores that independently returned the same memory. Agreement is evidence. */
export interface CorroborationInfo {
  /** Distinct store slots that produced this content. */
  stores: StoreType[];
  /** Provenance strings for every supporting hit, strongest first. */
  sources: string[];
  /** How many candidates were merged (can exceed stores.length). */
  hits: number;
}

/** Why an entry ranked where it did. Every factor is shown; nothing is hidden. */
export interface ScoreBreakdown {
  /** Embedding similarity component, 0–1. */
  semantic: number;
  /** IDF-weighted lexical component, 0–1. */
  lexical: number;
  /** Blended relevance before any multipliers, 0–1. */
  relevance: number;
  /** Half-life decay multiplier, between recencyFloor and 1. */
  recency: number;
  /** Trust multiplier for the source store's provenance tier. */
  trust: number;
  /** Agreement multiplier, ≥ 1, growing with independent corroborating stores. */
  corroboration: number;
  /** relevance × recency × trust × corroboration, before clamping. */
  raw: number;
  /** Age of the entry in days at query time. */
  ageDays: number;
}

export interface RankedEntry {
  entry: MemoryEntry;
  /** 0–1, higher is more relevant */
  score: number;
  /** Human-readable provenance: "sqlite:notes", "markdown:vault/ideas.md" */
  source: string;
  /** Per-store signals behind this candidate, before central re-ranking. */
  signals?: RelevanceSignals;
  /** Set when more than one store independently returned this same content. */
  corroboration?: CorroborationInfo;
  /** Full score derivation — populated when the caller asks to explain. */
  explain?: ScoreBreakdown;
}

export interface RetrieveResult {
  entries: RankedEntry[];
  query: string;
  totalCandidates: number;
  storesQueried: StoreType[];
  /** Memories that appear to contradict each other. Empty when none detected. */
  conflicts?: ConflictNote[];
}

/** How two memories disagree. */
export type ConflictKind = 'numeric' | 'temporal' | 'negation';

/**
 * A detected contradiction between two retrieved memories.
 * The router surfaces the disagreement rather than silently picking a side —
 * but it does say which one it would trust, and why.
 */
export interface ConflictNote {
  entryIds: [string, string];
  description: string;
  kind?: ConflictKind;
  /** Provenance strings, in the same order as entryIds. */
  sources?: [string, string];
  /** The entry id the router would trust. */
  preferred?: string;
  /** Why that one won: 'newer', 'corroborated by more stores', 'higher trust'. */
  reason?: string;
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Two-tier trust. `curated` is content a human wrote or filed on purpose;
 * `generated` is whatever the agent decided to write down about itself.
 * Deliberately two tiers rather than a per-store knob soup — it is a distinction
 * you can defend in one sentence, and misconfiguring it is hard.
 */
export type Provenance = 'curated' | 'generated';

export interface RankingConfig {
  /** Weight on embedding similarity when an embedding is available. */
  semanticWeight: number;
  /** Weight on IDF-weighted lexical match. */
  lexicalWeight: number;
  /** Days for a store's recency multiplier to fall halfway toward the floor. */
  halfLifeDays: Record<StoreType, number>;
  /** Floor on the recency multiplier, so an old but strongly relevant memory still surfaces. */
  recencyFloor: number;
  /** Added to the corroboration multiplier per additional agreeing store. */
  corroborationBoost: number;
  /** Ceiling on the corroboration multiplier. */
  corroborationCap: number;
  /** Trust tier each store belongs to. */
  provenance: Record<StoreType, Provenance>;
  /** Multiplier per trust tier. */
  trust: Record<Provenance, number>;
  /** Token-overlap threshold above which two memories are treated as the same one. */
  duplicateThreshold: number;
  /** Detect and report contradictory memories. */
  conflictDetection: boolean;
}

/**
 * Defaults tuned for the local-first case: your own notes are treated as
 * long-lived and trustworthy; the agent's scratch memory ages fast and carries
 * no trust bonus. Every value is adjustable from the dashboard's [t] panel.
 */
export const DEFAULT_RANKING: RankingConfig = {
  semanticWeight: 0.7,
  lexicalWeight: 0.3,
  halfLifeDays: {
    markdown: 1095, // 3 years — hand-written notes don't go stale on a schedule
    files: 1095,
    sqlite: 180,
    vector: 365,
    leveldb: 30, // session/state scratch — ages fast by design
    audit: 30, // not retrievable; present so the record is total
  },
  recencyFloor: 0.4,
  corroborationBoost: 0.12,
  corroborationCap: 1.36,
  provenance: {
    markdown: 'curated', // your vault
    files: 'curated', // documents you filed
    sqlite: 'generated',
    leveldb: 'generated',
    vector: 'generated',
    audit: 'generated',
  },
  trust: { curated: 1.15, generated: 1.0 },
  duplicateThreshold: 0.82,
  conflictDetection: true,
};

// ─── Store health / sources ───────────────────────────────────────────────────

export interface SourceInfo {
  type: StoreType;
  name: string;
  available: boolean;
  /** Store exists and is healthy but is held open by another process
   *  (e.g. the live MCP server holding the single-writer LevelDB lock). */
  locked?: boolean;
  /** Store is available in principle but has not been configured yet
   *  (e.g. the Markdown vault before a vault path is set). Neutral, not a failure. */
  unconfigured?: boolean;
  /** Whether the agent may write to this store, or only read from it. */
  access?: AccessMode;
  /** Concrete engine behind this store slot (e.g. 'sqlite', 'postgres',
   *  'vectra', 'pgvector', 'leveldb'). Lets the dashboard show what's really
   *  running while the slot's type stays stable for permissions/audit. */
  backend?: string;
  path?: string;
  entryCount?: number;
  sizeBytes?: number;
  error?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MultimodeMindConfig {
  /** Absolute path to the Markdown vault directory */
  vaultPath?: string;
  /** Absolute path to the general files directory */
  filesPath?: string;
  /** Absolute path to the SQLite database file */
  sqlitePath?: string;
  /** Absolute path to the LevelDB directory */
  leveldbPath?: string;
  /** Absolute path to persist the Vectra vector index */
  vectorIndexPath?: string;
  /** OpenAI API key — falls back to OPENAI_API_KEY env var */
  openAiApiKey?: string;
  /** Max results returned by retrieve() across all stores */
  retrieveLimit?: number;
}
