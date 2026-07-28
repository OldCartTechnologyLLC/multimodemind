/**
 * OpenAI embedding provider (default).
 * Model: text-embedding-3-small — 1536 dimensions, MIT-compatible API.
 * Copyright Old Cart Technology LLC — MIT License
 */

import OpenAI from 'openai';
import type { EmbeddingProvider } from './base.js';

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = DIMENSIONS;

  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
    });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: MODEL,
      input: text.slice(0, 8191), // token safety trim
    });
    return response.data[0]!.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: MODEL,
      input: texts.map((t) => t.slice(0, 8191)),
    });
    return response.data.map((d) => d.embedding);
  }
}
