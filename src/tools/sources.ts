/**
 * MCP tool: sources
 * Returns health and metadata for all configured stores.
 * Copyright Old Cart Technology LLC — MIT License
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from '../stores/base.js';

export function registerSourcesTool(server: McpServer, stores: MemoryStore[]): void {
  server.tool(
    'sources',
    'List all configured memory stores, their availability, and entry counts.',
    {}, // no input params
    async () => {
      const results = await Promise.allSettled(stores.map((s) => s.sources()));

      const lines: string[] = ['# Memory sources\n'];

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const store = stores[i]!;

        if (result.status === 'fulfilled') {
          const info = result.value;
          const status = info.available ? '✓' : '✗';
          const access = info.access
            ? ` | ${info.access === 'read' ? 'read-only' : 'read/write'}`
            : '';
          const count = info.entryCount !== undefined ? ` | ${info.entryCount} entries` : '';
          const size = info.sizeBytes !== undefined
            ? ` | ${(info.sizeBytes / 1024).toFixed(1)}KB`
            : '';
          const path = info.path ? ` | path: ${info.path}` : '';
          const err = info.error ? ` | error: ${info.error}` : '';
          lines.push(`${status} **${info.type}** (${info.name})${access}${count}${size}${path}${err}`);
        } else {
          lines.push(`✗ **${store.type}** — failed to query: ${String(result.reason)}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );
}
