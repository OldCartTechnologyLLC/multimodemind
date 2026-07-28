/**
 * Vector store adapter — local HNSW index via Vectra (pure TypeScript, MIT).
 * Primary semantic search backend; other stores fall back to keyword scoring.
 *
 * Vectra metadata only allows string | number | boolean, so the full MemoryEntry
 * is serialized as a JSON string in a single `data` field.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import { LocalIndex } from 'vectra';
import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../types.js';
import type { MemoryStore } from './base.js';
import { newId, nowIso, assertWritable } from './utils.js';

const DEFAULT_PATH = '.mmind/vector-index';

// Vectra requires Record<string, MetadataTypes> where MetadataTypes = string|number|boolean
// We serialize the full MemoryEntry as a JSON string to fit that constraint.
type VectraPayload = Record<string, string>; // { data: "<json>" }

export class VectorStore implements MemoryStore {
  readonly type = 'vector' as const;
  readonly name: string;

  private index: LocalIndex<VectraPayload> | null = null;
  private readonly indexPath: string;
  readonly access: AccessMode;

  constructor(indexPath = DEFAULT_PATH, access: AccessMode = 'readwrite') {
    this.indexPath = indexPath;
    this.access = access;
    this.name = `vector:${indexPath}`;
  }

  private async getIndex(): Promise<LocalIndex<VectraPayload>> {
    if (this.index) return this.index;
    this.index = new LocalIndex<VectraPayload>(this.indexPath);
    if (!(await this.index.isIndexCreated())) {
      await this.index.createIndex();
    }
    return this.index;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getIndex();
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    if (embedding.length === 0) return []; // vector store requires an embedding

    const idx = await this.getIndex();
    // Vectra signature: queryItems(vector, queryText, topK)
    // We pass the natural-language query for potential BM25 hybrid; topK = limit
    const results = await idx.queryItems(embedding, query, limit);

    return results
      .map((r): RankedEntry | null => {
        try {
          const entry = JSON.parse(r.item.metadata['data']!) as MemoryEntry;
          // Pure semantic backend — no lexical opinion to offer. The router
          // computes the lexical side itself with pool-wide IDF.
          return {
            entry,
            score: r.score,
            source: this.name,
            signals: { semantic: r.score, lexical: 0, hasEmbedding: true },
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is RankedEntry => r !== null);
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    if (!entry.embedding || entry.embedding.length === 0) {
      throw new Error('VectorStore requires an embedding to store an entry');
    }
    const id = newId();
    const now = nowIso();
    const full: MemoryEntry = { ...entry, id, createdAt: now, updatedAt: now };
    const idx = await this.getIndex();
    await idx.insertItem({
      id,
      vector: entry.embedding,
      metadata: { data: JSON.stringify(full) },
    });
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const idx = await this.getIndex();
    const item = await idx.getItem(id);
    if (!item) return null;
    try {
      return JSON.parse(item.metadata['data']!) as MemoryEntry;
    } catch {
      return null;
    }
  }

  async sources(): Promise<SourceInfo> {
    try {
      const idx = await this.getIndex();
      const stats = await idx.listItems();
      return {
        type: this.type,
        name: this.name,
        available: true,
        access: this.access,
        path: this.indexPath,
        entryCount: stats.length,
      };
    } catch (err) {
      return { type: this.type, name: this.name, available: false, error: String(err) };
    }
  }

  async close(): Promise<void> {
    this.index = null;
  }
}
