/**
 * Files directory store adapter — general-purpose file memory with a JSON metadata index.
 * Stores arbitrary content as flat files; maintains a sidecar index for fast lookup.
 * Copyright Old Cart Technology LLC — MIT License
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
} from 'fs';
import { join, relative } from 'path';
import fg from 'fast-glob';
import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../types.js';
import type { MemoryStore } from './base.js';
import { newId, nowIso, keywordScore, cosineSimilarity, assertWritable } from './utils.js';

const INDEX_FILENAME = '.mmind-index.json';

interface IndexEntry {
  id: string;
  filename: string;
  metadata: Record<string, unknown>;
  storeType: string;
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
}

export class FilesStore implements MemoryStore {
  readonly type = 'files' as const;
  readonly name: string;

  private readonly filesPath: string;
  private readonly indexPath: string;
  readonly access: AccessMode;

  constructor(filesPath: string, access: AccessMode = 'readwrite') {
    this.filesPath = filesPath;
    this.access = access;
    this.indexPath = join(filesPath, INDEX_FILENAME);
    this.name = `files:${filesPath}`;
  }

  private readIndex(): Record<string, IndexEntry> {
    if (!existsSync(this.indexPath)) return {};
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf-8')) as Record<string, IndexEntry>;
    } catch {
      return {};
    }
  }

  private writeIndex(index: Record<string, IndexEntry>): void {
    mkdirSync(this.filesPath, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  async isAvailable(): Promise<boolean> {
    try {
      mkdirSync(this.filesPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    const index = this.readIndex();
    const results: RankedEntry[] = [];

    for (const [id, meta] of Object.entries(index)) {
      const filePath = join(this.filesPath, meta.filename);
      let content = '';
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const hasEmbedding = embedding.length > 0 && !!meta.embedding;
      const semantic = hasEmbedding ? cosineSimilarity(embedding, meta.embedding!) : 0;
      const lexical = keywordScore(content, query);
      // Store-local blend for shortlisting only; the router re-scores from signals.
      const score = hasEmbedding ? semantic * 0.7 + lexical * 0.3 : lexical;

      if (score > 0) {
        const entry: MemoryEntry = {
          id,
          content,
          metadata: meta.metadata,
          storeType: this.type,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          embedding: meta.embedding,
        };
        results.push({
          entry,
          score,
          source: `${this.name}/${meta.filename}`,
          signals: { semantic, lexical, hasEmbedding },
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    mkdirSync(this.filesPath, { recursive: true });
    const id = newId();
    const now = nowIso();
    const filename = `${id}.txt`;
    const filePath = join(this.filesPath, filename);

    writeFileSync(filePath, entry.content, 'utf-8');

    const index = this.readIndex();
    index[id] = {
      id,
      filename,
      metadata: entry.metadata,
      storeType: entry.storeType,
      createdAt: now,
      updatedAt: now,
      embedding: entry.embedding,
    };
    this.writeIndex(index);
    return id;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const index = this.readIndex();
    const meta = index[id];
    if (!meta) return null;
    const filePath = join(this.filesPath, meta.filename);
    try {
      const content = readFileSync(filePath, 'utf-8');
      return {
        id,
        content,
        metadata: meta.metadata,
        storeType: this.type,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        embedding: meta.embedding,
      };
    } catch {
      return null;
    }
  }

  async sources(): Promise<SourceInfo> {
    try {
      const index = this.readIndex();
      let sizeBytes = 0;
      try { sizeBytes = statSync(this.filesPath).size; } catch { /* ok */ }
      return {
        type: this.type,
        name: this.name,
        available: true,
        access: this.access,
        path: this.filesPath,
        entryCount: Object.keys(index).length,
        sizeBytes,
      };
    } catch (err) {
      return { type: this.type, name: this.name, available: false, error: String(err) };
    }
  }

  async close(): Promise<void> {
    // No open handles
  }
}
