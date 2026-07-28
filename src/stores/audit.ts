/**
 * Audit store — an append-only log of every query, read, and write.
 *
 * This is the accountability layer: nothing the agent does with your data goes
 * unrecorded. It is system-managed and read-only to the agent — the agent can
 * never write to it or retrieve from it. You own the log.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

import { appendFileSync, existsSync, mkdirSync, statSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { AccessMode, MemoryEntry, RankedEntry, SourceInfo, StoreType } from '../types.js';
import type { MemoryStore } from './base.js';
import { nowIso } from './utils.js';

const DEFAULT_PATH = join(homedir(), '.mmind', 'audit.log');

export type AuditOp = 'query' | 'read' | 'write' | 'denied';

export interface AuditEvent {
  ts: string;             // ISO 8601
  op: AuditOp;
  store?: StoreType;      // which store was touched (reads/writes/denials)
  query?: string;         // the query text (queries/reads)
  count?: number;         // results returned / matched
  id?: string;            // new entry id (writes)
  preview?: string;       // short content preview (writes/denials)
  reason?: string;        // why a write was denied (denials)
}

export class AuditStore implements MemoryStore {
  readonly type = 'audit' as const;
  readonly name: string;
  // Append-only and system-managed. From the agent's perspective it is read-only;
  // in practice the agent can neither write to nor retrieve from it.
  readonly access: AccessMode = 'read';

  private readonly logPath: string;
  private warnedOnFailure = false;

  constructor(logPath = DEFAULT_PATH) {
    this.logPath = logPath;
    this.name = `audit:${logPath}`;
  }

  /** Absolute path this store logs to — surfaced at server startup for debugging. */
  get path(): string {
    return this.logPath;
  }

  private append(ev: AuditEvent): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, JSON.stringify(ev) + '\n', 'utf-8');
    } catch (err) {
      // Auditing must never break the primary operation — but a silent failure
      // is a debugging nightmare, so surface it once to stderr.
      if (!this.warnedOnFailure) {
        this.warnedOnFailure = true;
        console.error(`[mmind] WARNING: could not write audit log at ${this.logPath}:`, err);
      }
    }
  }

  logQuery(query: string, stores: StoreType[], count: number): void {
    this.append({ ts: nowIso(), op: 'query', query: clip(query), count, store: undefined });
    void stores; // per-store detail is captured by logRead()
  }

  logRead(store: StoreType, query: string, count: number): void {
    this.append({ ts: nowIso(), op: 'read', store, query: clip(query), count });
  }

  logWrite(store: StoreType, id: string, preview: string): void {
    this.append({ ts: nowIso(), op: 'write', store, id, preview: clip(preview) });
  }

  /** Record a write that was refused — a read-only store or a failed write.
   *  A denied attempt is more security-relevant than a successful read. */
  logDenied(store: StoreType, reason: string, preview?: string): void {
    this.append({ ts: nowIso(), op: 'denied', store, reason: clip(reason), preview: preview ? clip(preview) : undefined });
  }

  /** Most recent N events, oldest→newest. For the dashboard / `audit` inspection. */
  recent(n = 20): AuditEvent[] {
    try {
      const lines = readFileSync(this.logPath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => JSON.parse(l) as AuditEvent);
    } catch {
      return [];
    }
  }

  // ─── MemoryStore interface — audit is neither retrievable nor agent-writable ──

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(): Promise<RankedEntry[]> {
    return []; // the audit log is not a memory source the agent can search
  }

  async store(): Promise<string> {
    throw new Error('The audit log is append-only and system-managed; it cannot be written to directly.');
  }

  async get(): Promise<MemoryEntry | null> {
    return null;
  }

  async sources(): Promise<SourceInfo> {
    let entryCount = 0;
    let sizeBytes: number | undefined;
    try {
      if (existsSync(this.logPath)) {
        const raw = readFileSync(this.logPath, 'utf-8');
        entryCount = raw ? raw.trimEnd().split('\n').filter(Boolean).length : 0;
        sizeBytes = statSync(this.logPath).size;
      }
    } catch {
      /* ok */
    }
    return {
      type: this.type,
      name: this.name,
      available: true,
      access: this.access,
      path: this.logPath,
      entryCount,
      sizeBytes,
    };
  }

  async close(): Promise<void> {
    // Nothing to close — appends are flushed per write.
  }
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? one.slice(0, 117) + '…' : one;
}
