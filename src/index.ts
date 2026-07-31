#!/usr/bin/env node
/**
 * Multimode Mind — MCP server entry point.
 * Copyright Old Cart Technology LLC — MIT License
 *
 * Usage:
 *   MMIND_VAULT_PATH=/path/to/vault npx mmind
 *
 * All paths can also be set via environment variables (see MultimodeMindConfig).
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createEmbeddingProvider } from './embeddings/index.js';
import { RetrieveRouter } from './router/index.js';
import { resolveRanking } from './router/ranking.js';
import {
  SqliteStore,
  LevelDbStore,
  MarkdownStore,
  FilesStore,
  VectorStore,
  AuditStore,
  PostgresStore,
  PgVectorStore,
  createPgPool,
  safeConnLabel,
  disconnectedClient,
  type SqlClient,
  type SqlPool,
} from './stores/index.js';
import type { MemoryStore } from './stores/base.js';
import { registerRetrieveTool } from './tools/retrieve.js';
import { registerStoreTool } from './tools/store.js';
import { registerSourcesTool } from './tools/sources.js';
import {
  DEFAULT_ACCESS,
  DEFAULT_BACKENDS,
  DEFAULT_RANKING,
  type AccessMode,
  type BackendConfig,
  type MultimodeMindConfig,
  type Provenance,
  type RankingConfig,
  type StoreType,
} from './types.js';

// ─── Config from environment ──────────────────────────────────────────────────

// Store data lives under ~/.mmind by default so the server works no matter
// which directory it is launched from (MCP clients set an arbitrary cwd).
const HOME_MMIND = join(homedir(), '.mmind');

/** Read version from package.json so server + dashboard never drift. */
function pkgVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf-8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Load per-store access modes. Precedence (lowest → highest):
 *   built-in defaults  →  ~/.mmind/config.json  →  MMIND_ACCESS_<STORE> env vars
 * Env overrides let an MCP client config (or a deterministic test) pin
 * permissions regardless of what the dashboard has saved.
 */
function loadAccess(): Record<StoreType, AccessMode> {
  const map: Record<StoreType, AccessMode> = { ...DEFAULT_ACCESS };
  try {
    const p = join(HOME_MMIND, 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf-8')) as { access?: Partial<Record<StoreType, AccessMode>> };
    Object.assign(map, cfg.access ?? {});
  } catch {
    /* no config — keep defaults */
  }
  for (const st of Object.keys(map) as StoreType[]) {
    const v = process.env[`MMIND_ACCESS_${st.toUpperCase()}`];
    if (v === 'read' || v === 'readwrite') map[st] = v;
  }
  return map;
}

/**
 * Which engine backs each pluggable slot. Precedence:
 *   defaults → ~/.mmind/config.json → MMIND_BACKEND_* env vars.
 */
function loadBackends(): BackendConfig {
  const b: BackendConfig = { ...DEFAULT_BACKENDS };
  try {
    const p = join(HOME_MMIND, 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf-8')) as { backends?: Partial<BackendConfig> };
    Object.assign(b, cfg.backends ?? {});
  } catch {
    /* defaults */
  }
  const s = process.env['MMIND_BACKEND_STRUCTURED'];
  if (s === 'sqlite' || s === 'postgres') b.structured = s;
  const v = process.env['MMIND_BACKEND_VECTOR'];
  if (v === 'vectra' || v === 'pgvector') b.vector = v;
  return b;
}

/**
 * Retrieval ranking knobs. Same precedence as everything else:
 *   defaults → ~/.mmind/config.json (`ranking`) → MMIND_RANK_* env vars.
 * The dashboard's [t] panel writes the config.json half; env vars exist so a
 * test or an MCP client entry can pin the ranking regardless of what is saved.
 */
function loadRanking(): RankingConfig {
  let saved: Partial<RankingConfig> | undefined;
  try {
    const p = join(HOME_MMIND, 'config.json');
    saved = (JSON.parse(readFileSync(p, 'utf-8')) as { ranking?: Partial<RankingConfig> }).ranking;
  } catch {
    /* no config — keep defaults */
  }
  const cfg = resolveRanking(saved);

  const num = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  cfg.semanticWeight = num('MMIND_RANK_SEMANTIC_WEIGHT') ?? cfg.semanticWeight;
  cfg.lexicalWeight = num('MMIND_RANK_LEXICAL_WEIGHT') ?? cfg.lexicalWeight;
  cfg.recencyFloor = num('MMIND_RANK_RECENCY_FLOOR') ?? cfg.recencyFloor;
  cfg.corroborationBoost = num('MMIND_RANK_CORROBORATION_BOOST') ?? cfg.corroborationBoost;
  cfg.corroborationCap = num('MMIND_RANK_CORROBORATION_CAP') ?? cfg.corroborationCap;
  cfg.duplicateThreshold = num('MMIND_RANK_DUPLICATE_THRESHOLD') ?? cfg.duplicateThreshold;

  for (const st of Object.keys(cfg.halfLifeDays) as StoreType[]) {
    const v = num(`MMIND_RANK_HALFLIFE_${st.toUpperCase()}`);
    if (v !== undefined) cfg.halfLifeDays[st] = v;
  }
  for (const tier of ['curated', 'generated'] as Provenance[]) {
    const v = num(`MMIND_RANK_TRUST_${tier.toUpperCase()}`);
    if (v !== undefined) cfg.trust[tier] = v;
  }

  const conflicts = process.env['MMIND_RANK_CONFLICT_DETECTION'];
  if (conflicts !== undefined) {
    cfg.conflictDetection = !/^(0|false|off|no)$/i.test(conflicts.trim());
  }
  return cfg;
}

function loadConfig(): MultimodeMindConfig {
  // Vault path may be passed as the first positional argument, e.g.
  //   mmind "/path/to/vault"
  // The MMIND_VAULT_PATH env var takes precedence if both are provided.
  const positionalVault = process.argv[2];

  return {
    vaultPath:      process.env['MMIND_VAULT_PATH'] ?? positionalVault,
    filesPath:      process.env['MMIND_FILES_PATH']      ?? join(HOME_MMIND, 'files'),
    sqlitePath:     process.env['MMIND_SQLITE_PATH']     ?? join(HOME_MMIND, 'memory.db'),
    leveldbPath:    process.env['MMIND_LEVELDB_PATH']    ?? join(HOME_MMIND, 'leveldb'),
    vectorIndexPath: process.env['MMIND_VECTOR_PATH']   ?? join(HOME_MMIND, 'vector-index'),
    openAiApiKey:   process.env['OPENAI_API_KEY'],
    retrieveLimit:  Number(process.env['MMIND_RETRIEVE_LIMIT'] ?? 10),
  };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // `mmind dashboard` launches the interactive TUI instead of the MCP server.
  // This is the only invocation that diverges: every other form — including
  // `mmind "/path/to/vault"` and the bare, no-argument stdio case — falls
  // through to the server below untouched, so the MCP stdio protocol path is
  // never disturbed. The dashboard is imported lazily so its store handles and
  // readline setup are only paid for when it is actually requested.
  if (process.argv[2] === 'dashboard') {
    const { runDashboard } = await import('./cli/dashboard.js');
    await runDashboard();
    return;
  }

  const config = loadConfig();
  const access = loadAccess();
  const backends = loadBackends();
  const ranking = loadRanking();

  // If a Postgres-backed slot is selected, open ONE shared pool that both the
  // structured and vector stores reuse — "one connection covers both". If it
  // can't connect we do NOT silently fall back to a local DB (that would split
  // your data); the selected backend shows as not-connected instead.
  let pgPool: SqlPool | undefined;
  let pgClient: SqlClient | undefined;
  let pgLabel = 'postgres';
  let pgConfigured = false;
  const needsPg = backends.structured === 'postgres' || backends.vector === 'pgvector';
  if (needsPg) {
    const url = process.env['MMIND_POSTGRES_URL'];
    if (url) {
      pgLabel = safeConnLabel(url);
      pgConfigured = true;
      try {
        pgPool = await createPgPool(url);
        pgClient = pgPool;
        console.error(`[mmind] postgres: connected to ${pgLabel}`);
      } catch (err) {
        pgClient = disconnectedClient(`postgres connection failed: ${String(err)}`);
        console.error('[mmind] postgres: failed to connect —', err);
      }
    } else {
      pgClient = disconnectedClient('MMIND_POSTGRES_URL not set');
      console.error('[mmind] a postgres backend is selected but MMIND_POSTGRES_URL is not set');
    }
  }

  // Structured slot: Postgres if selected (connected or not), else local SQLite.
  const structuredStore: MemoryStore = backends.structured === 'postgres'
    ? new PostgresStore(pgClient!, access.sqlite, pgLabel, pgConfigured)
    : new SqliteStore(config.sqlitePath, access.sqlite);

  // Vector slot: pgvector if selected (connected or not), else local Vectra.
  const vectorStore: MemoryStore = backends.vector === 'pgvector'
    ? new PgVectorStore(pgClient!, access.vector, pgLabel, pgConfigured)
    : new VectorStore(config.vectorIndexPath, access.vector);

  const stores: MemoryStore[] = [
    structuredStore,
    new LevelDbStore(config.leveldbPath, access.leveldb),
    new FilesStore(config.filesPath!, access.files),
    vectorStore,
  ];

  if (config.vaultPath) {
    stores.push(new MarkdownStore(config.vaultPath, access.markdown));
  }

  // Probe availability (non-fatal — stores log their own warnings)
  const checks = await Promise.allSettled(stores.map((s) => s.isAvailable()));
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    const store = stores[i]!;
    if (check.status === 'rejected' || (check.status === 'fulfilled' && !check.value)) {
      console.warn(`[mmind] Store unavailable at startup: ${store.name}`);
    }
  }

  const embedder = createEmbeddingProvider(config.openAiApiKey);

  // Append-only audit log — records every query, read, and write. System-managed;
  // not part of the retrievable store set and never writable by the agent.
  // Path is overridable via MMIND_AUDIT_PATH and printed at startup for debugging.
  const auditPath = process.env['MMIND_AUDIT_PATH'] ?? join(HOME_MMIND, 'audit.log');
  const audit = new AuditStore(auditPath);
  console.error(`[mmind] audit log: ${audit.path}`);

  const router = new RetrieveRouter(stores, embedder, audit, ranking);
  if (ranking !== DEFAULT_RANKING) {
    console.error(
      `[mmind] ranking: semantic ${ranking.semanticWeight} / lexical ${ranking.lexicalWeight}, ` +
      `recency floor ${ranking.recencyFloor}, conflicts ${ranking.conflictDetection ? 'on' : 'off'}`
    );
  }

  // ─── MCP server setup ───────────────────────────────────────────────────────

  const server = new McpServer({
    name: 'multimodemind',
    version: pkgVersion(),
  });

  registerRetrieveTool(server, router);
  registerStoreTool(server, stores, embedder, audit);
  // Include audit in `sources` so the agent knows it is being logged
  registerSourcesTool(server, [...stores, audit]);

  // ─── Transport ──────────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[mmind] Multimode Mind MCP server running (stdio)');

  // Graceful shutdown
  const shutdown = async () => {
    await Promise.allSettled(stores.map((s) => s.close()));
    if (pgPool) await pgPool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[mmind] Fatal startup error:', err);
  process.exit(1);
});
