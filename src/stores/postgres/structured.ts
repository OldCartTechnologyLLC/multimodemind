/**
 * Postgres-backed structured store — an alternative to the local SQLite file.
 * Point it at your existing Postgres and mmind wraps it in place: read under
 * permissions you set, every access audited, nothing migrated.
 *
 * Occupies the 'sqlite' (structured) slot, so permissions/audit key on it
 * exactly as the SQLite store would.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../../types.js';
import type { MemoryStore } from '../base.js';
import type { SqlClient } from './client.js';
import { newId, nowIso, cosineSimilarity, keywordScore, assertWritable } from '../utils.js';

const TABLE = 'mmind_entries';

export class PostgresStore implements MemoryStore {
  readonly type = 'sqlite' as const; // structured slot
  readonly name: string;
  readonly access: AccessMode;

  private ready = false;

  constructor(
    private readonly db: SqlClient,
    access: AccessMode = 'readwrite',
    private readonly label = 'postgres',
    private readonly configured = true
  ) {
    this.access = access;
    this.name = `postgres:${label}`;
  }

  private async ensure(): Promise<void> {
    if (this.ready) return;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id          text PRIMARY KEY,
        content     text NOT NULL,
        metadata    jsonb NOT NULL DEFAULT '{}',
        store_type  text NOT NULL DEFAULT 'sqlite',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        embedding   jsonb
      )`);
    this.ready = true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.db.query('SELECT 1');
      await this.ensure();
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT * FROM ${TABLE} ORDER BY created_at DESC LIMIT $1`,
      [Math.min(limit * 10, 500)]
    );
    return rows
      .map((row) => {
        const entry = rowToEntry(row);
        const hasEmbedding = embedding.length > 0 && !!entry.embedding;
        const semantic = hasEmbedding ? cosineSimilarity(embedding, entry.embedding!) : 0;
        const lexical = keywordScore(entry.content, query);
        // Store-local blend for shortlisting only; the router re-scores from signals.
        const score = hasEmbedding ? semantic * 0.7 + lexical * 0.3 : lexical;
        return { entry, score, source: this.name, signals: { semantic, lexical, hasEmbedding } };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    await this.ensure();
    const id = newId();
    const now = nowIso();
    await this.db.query(
      `INSERT INTO ${TABLE} (id, content, metadata, store_type, created_at, updated_at, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        entry.content,
        JSON.stringify(entry.metadata),
        entry.storeType,
        now,
        now,
        entry.embedding ? JSON.stringify(entry.embedding) : null,
      ]
    );
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensure();
    const { rows } = await this.db.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async sources(): Promise<SourceInfo> {
    if (!this.configured) {
      return {
        type: this.type, name: this.name, available: false, unconfigured: true,
        access: this.access, backend: 'postgres', path: 'set MMIND_POSTGRES_URL',
      };
    }
    try {
      await this.ensure();
      const { rows } = await this.db.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
      return {
        type: this.type,
        name: this.name,
        available: true,
        access: this.access,
        backend: 'postgres',
        path: this.label,
        entryCount: rows[0].n,
      };
    } catch (err) {
      return { type: this.type, name: this.name, available: false, backend: 'postgres', path: this.label, error: String(err) };
    }
  }

  async close(): Promise<void> {
    // Pool lifecycle is owned by the caller (shared across stores).
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(r: any): MemoryEntry {
  const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
  const emb = r.embedding == null
    ? undefined
    : (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: r.id,
    content: r.content,
    metadata: meta as Record<string, unknown>,
    storeType: r.store_type as MemoryEntry['storeType'],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    embedding: emb as number[] | undefined,
  };
}
