/**
 * Markdown vault store adapter.
 * Reads existing .md files non-destructively; treats each file as one entry.
 * Vault-agnostic — Obsidian is the reference case but any folder works.
 * Copyright Old Cart Technology LLC — MIT License
 */

import { readFileSync, statSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import matter from 'gray-matter';
import fg from 'fast-glob';
import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo } from '../types.js';
import type { MemoryStore } from './base.js';
import { keywordScore, cosineSimilarity, assertWritable } from './utils.js';

export class MarkdownStore implements MemoryStore {
  readonly type = 'markdown' as const;
  readonly name: string;

  private readonly vaultPath: string;
  readonly access: AccessMode;

  constructor(vaultPath: string | null, access: AccessMode = 'read') {
    this.vaultPath = vaultPath ?? '';
    this.access = access;
    this.name = this.vaultPath ? `markdown:${this.vaultPath}` : 'markdown:(no vault)';
  }

  /** True once a vault path has actually been set. */
  private get configured(): boolean {
    return this.vaultPath !== '';
  }

  async isAvailable(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      statSync(this.vaultPath);
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, embedding: number[], limit: number): Promise<RankedEntry[]> {
    if (!this.configured) return [];
    const files = await fg('**/*.md', {
      cwd: this.vaultPath,
      ignore: ['.obsidian/**', '.trash/**', 'node_modules/**'],
      absolute: true,
    });

    const results: RankedEntry[] = [];

    for (const filePath of files) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const { data: frontmatter, content } = matter(raw);
        const fullText = [
          frontmatter['title'] ?? '',
          frontmatter['tags'] ? String(frontmatter['tags']) : '',
          content,
        ].join(' ');

        // Markdown files carry no stored embeddings — lexical only, and the
        // store says so rather than reporting a zero semantic score the router
        // would mistake for "compared and found unrelated".
        const lexical = keywordScore(fullText, query);
        const score = lexical;

        if (score > 0) {
          const relPath = relative(this.vaultPath, filePath);
          const entry: MemoryEntry = {
            id: `md:${relPath}`,
            content: content.slice(0, 4000), // cap for context window
            metadata: { ...frontmatter, filePath, relPath },
            storeType: this.type,
            createdAt: statSync(filePath).birthtime.toISOString(),
            updatedAt: statSync(filePath).mtime.toISOString(),
          };
          results.push({
            entry,
            score,
            source: `${this.name}/${relPath}`,
            signals: { semantic: 0, lexical, hasEmbedding: false },
          });
        }
      } catch {
        // Skip unreadable files silently
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * store() appends a new .md file to the vault.
   * Never modifies existing files.
   */
  async store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    assertWritable(this.type, this.access);
    if (!this.configured) {
      throw new Error('Markdown store has no vault configured — set a vault path first.');
    }
    const { writeFileSync, mkdirSync } = await import('fs');
    const now = new Date();
    const slug = now.toISOString().replace(/[:.]/g, '-');
    const filename = `mmind-${slug}.md`;
    const filePath = join(this.vaultPath, filename);

    const frontmatter = {
      created: now.toISOString(),
      source: 'multimodemind',
      ...entry.metadata,
    };
    const yamlLines = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    const fileContent = `---\n${yamlLines}\n---\n\n${entry.content}\n`;

    mkdirSync(this.vaultPath, { recursive: true });
    writeFileSync(filePath, fileContent, 'utf-8');
    return `md:${filename}`;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    if (!this.configured) return null;
    // id format: "md:<relPath>"
    const relPath = id.startsWith('md:') ? id.slice(3) : id;
    const filePath = join(this.vaultPath, relPath);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const { data: frontmatter, content } = matter(raw);
      const stat = statSync(filePath);
      return {
        id,
        content,
        metadata: { ...frontmatter, filePath, relPath },
        storeType: this.type,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async sources(): Promise<SourceInfo> {
    if (!this.configured) {
      // First-class but not yet pointed at a vault — a neutral, actionable state,
      // not a failure. This is the store that embodies "wrap what you already have."
      return { type: this.type, name: this.name, available: false, unconfigured: true, access: this.access };
    }
    try {
      const files = await fg('**/*.md', {
        cwd: this.vaultPath,
        ignore: ['.obsidian/**', '.trash/**'],
      });
      return {
        type: this.type,
        name: this.name,
        available: true,
        access: this.access,
        path: this.vaultPath,
        entryCount: files.length,
      };
    } catch (err) {
      return { type: this.type, name: this.name, available: false, error: String(err) };
    }
  }

  async close(): Promise<void> {
    // No open handles — nothing to close
  }
}
