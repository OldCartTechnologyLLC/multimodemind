/**
 * MCP tool: store
 * Persists a memory entry, generates an embedding, routes to the target store.
 * Copyright Old Cart Technology LLC — MIT License
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from '../stores/base.js';
import type { AuditStore } from '../stores/audit.js';
import type { EmbeddingProvider } from '../embeddings/base.js';
import type { StoreType } from '../types.js';

// Note: 'audit' is intentionally excluded — the agent cannot write to the audit log.
const STORE_TYPES: [StoreType, ...StoreType[]] = ['sqlite', 'leveldb', 'markdown', 'files', 'vector'];

const StoreInput = z.object({
  content: z.string().min(1).describe('The text content to store in memory'),
  metadata: z.record(z.string(), z.unknown()).optional()
    .describe('Arbitrary key-value metadata to attach to this entry'),
  store: z.enum(STORE_TYPES).optional()
    .describe('Target store type. Omit to use auto-routing (sqlite by default in v1)'),
});

export function registerStoreTool(
  server: McpServer,
  stores: MemoryStore[],
  embedder: EmbeddingProvider,
  audit?: AuditStore
): void {
  server.tool(
    'store',
    'Persist content to agent memory with optional metadata and target store.',
    StoreInput.shape,
    async ({ content, metadata = {}, store: storeType }) => {
      // Auto-route: in v1, default to sqlite; v2 will classify content type
      const targetType: StoreType = storeType ?? 'sqlite';
      const target = stores.find((s) => s.type === targetType);

      if (!target) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: store type "${targetType}" is not configured.`,
          }],
          isError: true,
        };
      }

      // Respect read-only stores — the agent may not change data it wasn't granted write to.
      // A denied attempt is recorded in the audit log — the knock on the locked door matters.
      if (target.access === 'read') {
        audit?.logDenied(targetType, 'store is read-only', content);
        return {
          content: [{
            type: 'text' as const,
            text: `The ${targetType} store is read-only. The user has not granted write access to it. Nothing was stored.`,
          }],
          isError: true,
        };
      }

      // Generate embedding
      let embedding: number[] | undefined;
      try {
        embedding = await embedder.embed(content);
      } catch (err) {
        console.warn('[mmind:store] Embedding failed, storing without vector:', err);
      }

      // Any failure to persist is also audited as a denied write
      let id: string;
      try {
        id = await target.store({
          content,
          metadata: metadata as Record<string, unknown>,
          storeType: targetType,
          embedding,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        audit?.logDenied(targetType, reason, content);
        return {
          content: [{ type: 'text' as const, text: `Could not store to ${targetType}: ${reason}` }],
          isError: true,
        };
      }

      audit?.logWrite(targetType, id, content);

      return {
        content: [{
          type: 'text' as const,
          text: `Stored to ${targetType} (id: ${id})`,
        }],
      };
    }
  );
}
