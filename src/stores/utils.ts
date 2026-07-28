/**
 * Shared store utilities.
 * Copyright Old Cart Technology LLC — MIT License
 */

import { randomUUID } from 'crypto';
import type { AccessMode, StoreType } from '../types.js';

/**
 * Throw a clear, consistent error when a write is attempted on a read-only store.
 * Call at the top of every store()/mutating method.
 */
export function assertWritable(type: StoreType, access: AccessMode): void {
  if (access === 'read') {
    throw new Error(
      `The ${type} store is read-only. Enable read/write for it in the dashboard to allow the agent to store here.`
    );
  }
}

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 when either vector is empty (no embedding available).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Simple BM25-flavoured keyword score: fraction of query tokens present
 * in the content, case-insensitive. Used by stores without vector support.
 */
export function keywordScore(content: string, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const lower = content.toLowerCase();
  const hits = tokens.filter((t) => lower.includes(t)).length;
  return hits / tokens.length;
}
