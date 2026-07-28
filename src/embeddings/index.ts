/**
 * Embedding provider factory.
 * Tries OpenAI first; falls back to local if no API key is found.
 * Copyright Old Cart Technology LLC — MIT License
 */

export type { EmbeddingProvider } from './base.js';
export { OpenAIEmbeddingProvider } from './openai.js';
export { LocalEmbeddingProvider } from './local.js';

import type { EmbeddingProvider } from './base.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import { LocalEmbeddingProvider } from './local.js';

/**
 * Keyword-only mode — no embeddings at all. Returns empty vectors so the router
 * and stores fall back to keyword scoring. Useful for privacy, zero API cost,
 * fully offline operation, and fast deterministic tests (no model download).
 * Enabled with MMIND_EMBEDDINGS=none.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly dimensions = 0;
  async embed(): Promise<number[]> {
    return [];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

export function createEmbeddingProvider(apiKey?: string): EmbeddingProvider {
  if ((process.env['MMIND_EMBEDDINGS'] ?? '').toLowerCase() === 'none') {
    console.error('[mmind] MMIND_EMBEDDINGS=none — keyword-only mode (no embeddings)');
    return new NullEmbeddingProvider();
  }
  const key = apiKey ?? process.env['OPENAI_API_KEY'];
  if (key) {
    return new OpenAIEmbeddingProvider(key);
  }
  console.error(
    '[mmind] OPENAI_API_KEY not set — using local embedding model (first run downloads ~23MB)'
  );
  return new LocalEmbeddingProvider();
}
