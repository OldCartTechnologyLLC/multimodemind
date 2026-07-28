/**
 * EmbeddingProvider — swappable embedding interface.
 * Copyright Old Cart Technology LLC — MIT License
 */

export interface EmbeddingProvider {
  readonly name: string;
  /** Dimensionality of vectors this provider produces */
  readonly dimensions: number;

  /**
   * Embed a single string. Returns a float32 vector.
   */
  embed(text: string): Promise<number[]>;

  /**
   * Embed multiple strings in one call (batched for efficiency).
   * Default implementations may just loop over embed().
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}
