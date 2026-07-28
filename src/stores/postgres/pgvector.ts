/**
 * pgvector-backed semantic store — an alternative to the local Vectra index.
 * Shares the same Postgres connection as the structured store, so one database
 * can serve both your structured memory and your embeddings.
 *
 * Occupies the 'vector' slot. Requires the pgvector extension.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../../types.js';
import type { MemoryStore } from '../base.js';
import type { SqlClient } from './client.js';
import { newId, nowIso, assertWritable } from '../utils.js';

const TABLE = 'mmind_vectors';

export class PgVectorStore implements MemoryStore {
  readonly type = 'vector' as const;
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
    this.name = `pgvector:${label}`;
  }

  private async ensure(): Promise<void> {
    if (this.ready) return;
    await this.db.query('CREATE EXTENSION IF NOT EXISTS vector');
    // Variable-dimension column so different embedding providers can coexist;
    // queries filter to matching dimensions.
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id text PRIMARY KEY, data jsonb NOT NULL, embedding vector)`
    );
    this.ready = true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensure();
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    if (embedding.length === 0) return [];
    await this.ensure();
    const vec = toVector(embedding);
    const { rows } = await this.db.query(
      `SELECT data, 1 - (embedding <=> $1) AS score
         FROM ${TABLE}
        WHERE vector_dims(embedding) = vector_dims($1::vector)
        ORDER BY embedding <=> $1
        LIMIT $2`,
      [vec, limit]
    );
    return rows.map((r) => {
      const score = Number(r.score);
      return {
        entry: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as MemoryEntry,
        score,
        source: this.name,
        // Pure semantic backend — the router supplies the lexical side.
        signals: { semantic: score, lexical: 0, hasEmbedding: true },
      };
    });
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    if (!entry.embedding || entry.embedding.length === 0) {
      throw new Error('PgVectorStore requires an embedding to store an entry');
    }
    await this.ensure();
    const id = newId();
    const now = nowIso();
    const full: MemoryEntry = { ...entry, id, createdAt: now, updatedAt: now };
    await this.db.query(
      `INSERT INTO ${TABLE} (id, data, embedding) VALUES ($1, $2, $3)`,
      [id, JSON.stringify(full), toVector(entry.embedding)]
    );
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensure();
    const { rows } = await this.db.query(`SELECT data FROM ${TABLE} WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) as MemoryEntry;
  }

  async sources(): Promise<SourceInfo> {
    if (!this.configured) {
      return {
        type: this.type, name: this.name, available: false, unconfigured: true,
        access: this.access, backend: 'pgvector', path: 'set MMIND_POSTGRES_URL',
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
        backend: 'pgvector',
        path: this.label,
        entryCount: rows[0].n,
      };
    } catch (err) {
      return { type: this.type, name: this.name, available: false, backend: 'pgvector', path: this.label, error: String(err) };
    }
  }

  async close(): Promise<void> {
    // Pool lifecycle is owned by the caller (shared across stores).
  }
}

function toVector(a: number[]): string {
  return '[' + a.join(',') + ']';
}
