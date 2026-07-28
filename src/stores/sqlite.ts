/**
 * SQLite store adapter — structured, queryable memory.
 * Uses better-sqlite3 (synchronous) for simplicity and reliability.
 * Copyright Old Cart Technology LLC — MIT License
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { join } from 'path';
import { statSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../types.js';
import type { MemoryStore } from './base.js';
import { newId, nowIso, cosineSimilarity, keywordScore, assertWritable } from './utils.js';

const DEFAULT_PATH = join(process.cwd(), '.mmind', 'memory.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    store_type  TEXT NOT NULL DEFAULT 'sqlite',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    embedding   TEXT          -- JSON float array, nullable
  );
  CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
`;

export class SqliteStore implements MemoryStore {
  readonly type = 'sqlite' as const;
  readonly name: string;

  private db: DB | null = null;
  private readonly dbPath: string;
  readonly access: AccessMode;

  constructor(dbPath = DEFAULT_PATH, access: AccessMode = 'readwrite') {
    this.dbPath = dbPath;
    this.access = access;
    this.name = `sqlite:${dbPath}`;
  }

  private getDb(): DB {
    if (!this.db) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.exec(SCHEMA);
      this.db.pragma('journal_mode = WAL');
    }
    return this.db;
  }

  async isAvailable(): Promise<boolean> {
    try {
      this.getDb();
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM entries ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(limit * 10, 500)) as RawRow[];

    return rows
      .map((row) => {
        const entry = rowToEntry(row);
        const hasEmbedding = embedding.length > 0 && !!entry.embedding;
        const semantic = hasEmbedding ? cosineSimilarity(embedding, entry.embedding!) : 0;
        const lexical = keywordScore(entry.content, query);
        // `score` stays the store's own blend — it decides which candidates get
        // shortlisted here. The router re-blends from `signals` with its own
        // weights and pool-wide IDF, so nothing downstream depends on this number.
        const score = hasEmbedding ? semantic * 0.7 + lexical * 0.3 : lexical;
        return { entry, score, source: this.name, signals: { semantic, lexical, hasEmbedding } };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    const id = newId();
    const now = nowIso();
    const db = this.getDb();
    db.prepare(`
      INSERT INTO entries (id, content, metadata, store_type, created_at, updated_at, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.content,
      JSON.stringify(entry.metadata),
      entry.storeType,
      now,
      now,
      entry.embedding ? JSON.stringify(entry.embedding) : null
    );
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const db = this.getDb();
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  async sources(): Promise<SourceInfo> {
    try {
      const db = this.getDb();
      const count = (db.prepare('SELECT COUNT(*) as n FROM entries').get() as { n: number }).n;
      let sizeBytes: number | undefined;
      try { sizeBytes = statSync(this.dbPath).size; } catch { /* ok */ }
      return {
        type: this.type,
        name: this.name,
        available: true,
        access: this.access,
        path: this.dbPath,
        entryCount: count,
        sizeBytes,
      };
    } catch (err) {
      return { type: this.type, name: this.name, available: false, error: String(err) };
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  content: string;
  metadata: string;
  store_type: string;
  created_at: string;
  updated_at: string;
  embedding: string | null;
}

function rowToEntry(row: RawRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    storeType: row.store_type as MemoryEntry['storeType'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
  };
}
