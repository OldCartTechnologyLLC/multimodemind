/**
 * Local embedding provider — @huggingface/transformers fallback.
 * Model: Xenova/all-MiniLM-L6-v2 — 384 dimensions, Apache-2.0.
 *
 * Downloads ~23MB model on first use. Subsequent calls use the cache.
 * Activated automatically when OPENAI_API_KEY is not set.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import type { EmbeddingProvider } from './base.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly dimensions = DIMENSIONS;

  // Lazily loaded to avoid import-time cost
  private pipeline: unknown = null;

  private async getPipeline() {
    if (this.pipeline) return this.pipeline;

    // Dynamic import keeps the heavy transformer bundle out of the main path
    const { pipeline, env } = await import('@huggingface/transformers');

    // Use WASM backend — avoids onnxruntime-node native binary requirement
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env.backends.onnx as any).wasm = { proxy: false };

    this.pipeline = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'fp32',
    });
    return this.pipeline;
  }

  async embed(text: string): Promise<number[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractor = (await this.getPipeline()) as any;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
