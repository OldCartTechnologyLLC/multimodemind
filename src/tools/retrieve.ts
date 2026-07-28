/**
 * MCP tool: retrieve
 * Returns a ranked context bundle for an agent query.
 *
 * The bundle is deliberately legible: every result can carry the arithmetic that
 * put it where it is, agreement between stores is stated rather than silently
 * folded away, and detected contradictions are surfaced instead of resolved
 * behind the agent's back.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RetrieveRouter } from '../router/index.js';
import type { ConflictNote, RankedEntry, StoreType } from '../types.js';

const STORE_TYPES: [StoreType, ...StoreType[]] = ['sqlite', 'leveldb', 'markdown', 'files', 'vector'];

const RetrieveInput = z.object({
  query: z.string().min(1).describe('Natural language query to search memory'),
  limit: z.number().int().min(1).max(50).optional().default(10)
    .describe('Maximum number of results to return'),
  stores: z.array(z.enum(STORE_TYPES)).optional()
    .describe('Restrict search to these store types (default: all)'),
  explain: z.boolean().optional().default(false)
    .describe('Show why each result ranked where it did: relevance, recency, trust and corroboration multipliers'),
});

export function registerRetrieveTool(server: McpServer, router: RetrieveRouter): void {
  server.tool(
    'retrieve',
    'Search agent memory across all configured stores and return a ranked context bundle with provenance, cross-store corroboration, and any detected contradictions.',
    RetrieveInput.shape,
    async ({ query, limit, stores, explain }) => {
      const result = await router.retrieve(query, {
        limit,
        stores: stores as StoreType[] | undefined,
        explain,
      });

      const lines: string[] = [
        `# Memory retrieval: "${query}"`,
        `Searched: ${result.storesQueried.join(', ') || 'none'} | Candidates: ${result.totalCandidates} | Returned: ${result.entries.length}`,
        '',
      ];

      for (const ranked of result.entries) {
        const { entry, score, source } = ranked;
        lines.push(`## [${(score * 100).toFixed(0)}%] ${source}`);
        lines.push(`*id: ${entry.id} | stored: ${entry.createdAt}*`);

        const corroboration = corroborationLine(ranked);
        if (corroboration) lines.push(corroboration);

        const derivation = explainLine(ranked);
        if (derivation) lines.push(derivation);

        lines.push('');
        lines.push(entry.content.slice(0, 2000));
        lines.push('');
      }

      if (result.entries.length === 0) {
        lines.push('No relevant memories found.');
        lines.push('');
      }

      if (result.conflicts && result.conflicts.length > 0) {
        lines.push('## ⚠ Conflicting memories');
        lines.push(
          'These retrieved memories cover the same subject but disagree. ' +
          'Nothing was discarded — decide with the user, or prefer the one noted below.'
        );
        lines.push('');
        for (const conflict of result.conflicts) {
          lines.push(conflictLine(conflict));
        }
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }
  );
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/** "Two stores independently returned this" is evidence — say so out loud. */
function corroborationLine(ranked: RankedEntry): string | null {
  const c = ranked.corroboration;
  if (!c || c.stores.length < 2) return null;
  const others = c.sources.filter((s) => s !== ranked.source);
  const also = others.length > 0 ? ` — also in ${others.join(', ')}` : '';
  return `*corroborated: found independently in ${c.stores.length} stores (${c.stores.join(', ')})${also}*`;
}

/** The full arithmetic, so a wrong ranking is a diagnosable bug and not a vibe. */
function explainLine(ranked: RankedEntry): string | null {
  const e = ranked.explain;
  if (!e) return null;
  const parts = [
    `relevance ${e.relevance.toFixed(3)} (semantic ${e.semantic.toFixed(3)}, lexical ${e.lexical.toFixed(3)})`,
    `recency ×${e.recency.toFixed(3)} (${e.ageDays}d old)`,
    `trust ×${e.trust.toFixed(2)}`,
    `corroboration ×${e.corroboration.toFixed(2)}`,
  ];
  return `*ranking: ${parts.join(' · ')} = ${e.raw.toFixed(3)}*`;
}

function conflictLine(c: ConflictNote): string {
  const kind = c.kind ? `**${c.kind}**` : '**conflict**';
  const ids = c.entryIds.join(' ↔ ');
  const where = c.sources ? ` [${c.sources.join(' ↔ ')}]` : '';
  const pick = c.preferred ? ` Router would trust \`${c.preferred}\`${c.reason ? ` (${c.reason})` : ''}.` : '';
  return `- ${kind}: ${c.description} \`${ids}\`${where}.${pick}`;
}
