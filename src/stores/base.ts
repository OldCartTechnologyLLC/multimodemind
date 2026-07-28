/**
 * MemoryStore — the contract every store adapter must implement.
 * Copyright Old Cart Technology LLC — MIT License
 */

import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo, StoreType } from '../types.js';

export interface MemoryStore {
  readonly type: StoreType;
  readonly name: string;
  /** Whether the agent may write to this store ('readwrite') or only read ('read'). */
  readonly access: AccessMode;

  /**
   * Returns true if the store is reachable and ready.
   * Called at startup and by the `sources` tool.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Search this store for entries relevant to the query.
   *
   * @param query     Natural-language query (for text/BM25 stores)
   * @param embedding Query vector (for vector-capable stores; may be empty [])
   * @param limit     Max entries to return
   */
  search(
    query: string,
    embedding: number[],
    limit: number
  ): Promise<RankedEntry[]>;

  /**
   * Persist a memory entry and return its generated ID.
   * Callers pass the full entry minus auto-assigned fields.
   */
  store(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<string>;

  /**
   * Fetch a single entry by ID, or null if not found.
   */
  get(id: string): Promise<MemoryEntry | null>;

  /**
   * Return health/metadata for the `sources` tool.
   */
  sources(): Promise<SourceInfo>;

  /**
   * Graceful shutdown — close file handles, DB connections, etc.
   */
  close(): Promise<void>;
}
