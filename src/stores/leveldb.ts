/**
 * LevelDB store adapter — fast key-value memory for agent session state.
 * Copyright Old Cart Technology LLC — MIT License
 */

import { Level } from 'level';
import { statSync, existsSync } from 'fs';
import { join } from 'path';
import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../types.js';
import type { MemoryStore } from './base.js';
import { newId, nowIso, cosineSimilarity, keywordScore, assertWritable } from './utils.js';

const DEFAULT_PATH = '.mmind/leveldb';

/**
 * Distinguish "held by another process" from "genuinely broken".
 * An initialized LevelDB always has a CURRENT manifest pointer; if that exists
 * but we still can't open the DB, another process (e.g. the live MCP server)
 * holds the single-writer lock — a healthy state, not a failure.
 */
function looksInitialized(dbPath: string): boolean {
  return existsSync(join(dbPath, 'CURRENT'));
}

export class LevelDbStore implements MemoryStore {
  readonly type = 'leveldb' as const;
  readonly name: string;

  private db: Level<string, string> | null = null;
  private readonly dbPath: string;
  readonly access: AccessMode;

  constructor(dbPath = DEFAULT_PATH, access: AccessMode = 'readwrite') {
    this.dbPath = dbPath;
    this.access = access;
    this.name = `leveldb:${dbPath}`;
  }

  private async getDb(): Promise<Level<string, string>> {
    if (!this.db) {
      const db = new Level<string, string>(this.dbPath, { valueEncoding: 'utf8' });
      try {
        await db.open();
      } catch (err) {
        // Don't cache a handle that failed to open (e.g. lock contention) —
        // otherwise a later call after the lock frees would never retry.
        this.db = null;
        throw err;
      }
      this.db = db;
    }
    return this.db;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getDb();
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    const db = await this.getDb();
    const results: RankedEntry[] = [];

    for await (const value of db.values()) {
      const entry = JSON.parse(value) as MemoryEntry;
      const hasEmbedding = embedding.length > 0 && !!entry.embedding;
      const semantic = hasEmbedding ? cosineSimilarity(embedding, entry.embedding!) : 0;
      const lexical = keywordScore(entry.content, query);
      // Store-local blend for shortlisting only; the router re-scores from signals.
      const score = hasEmbedding ? semantic * 0.7 + lexical * 0.3 : lexical;

      if (score > 0) {
        results.push({ entry, score, source: this.name, signals: { semantic, lexical, hasEmbedding } });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    const db = await this.getDb();
    const id = newId();
    const now = nowIso();
    const full: MemoryEntry = { ...entry, id, createdAt: now, updatedAt: now };
    await db.put(id, JSON.stringify(full));
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const db = await this.getDb();
    try {
      const raw = await db.get(id);
      return JSON.parse(raw) as MemoryEntry;
    } catch {
      return null;
    }
  }

  async sources(): Promise<SourceInfo> {
    try {
      const db = await this.getDb();
      let count = 0;
      for await (const _ of db.keys()) count++;
      let sizeBytes: number | undefined;
      try { sizeBytes = statSync(this.dbPath).size; } catch { /* dir, not file */ }
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
      // Can't open — but if the DB is initialized on disk, it's locked by
      // another process (the live server), not broken. Report that distinctly.
      if (looksInitialized(this.dbPath)) {
        return {
          type: this.type,
          name: this.name,
          available: true,
          locked: true,
          access: this.access,
          path: this.dbPath,
        };
      }
      return { type: this.type, name: this.name, available: false, error: String(err) };
    }
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }
}
