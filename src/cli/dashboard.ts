#!/usr/bin/env node
/**
 * Multimode Mind — Terminal Dashboard
 * Store status panel + interactive configuration.
 * Zero new dependencies — pure Node.js readline + ANSI.
 * Matrix-green phosphor theme (truecolor).
 * Copyright Old Cart Technology LLC — MIT License
 *
 * Usage: npm run dashboard
 */

import * as readline from 'readline';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig, saveConfig, type DashboardConfig } from './config.js';
import { resolveRanking } from '../router/ranking.js';
import { SqliteStore } from '../stores/sqlite.js';
import { LevelDbStore } from '../stores/leveldb.js';
import { FilesStore } from '../stores/files.js';
import { VectorStore } from '../stores/vector.js';
import { MarkdownStore } from '../stores/markdown.js';
import { AuditStore, type AuditEvent, type AuditOp } from '../stores/audit.js';
import { PostgresStore } from '../stores/postgres/structured.js';
import { PgVectorStore } from '../stores/postgres/pgvector.js';
import { createPgPool, safeConnLabel, disconnectedClient, type SqlClient, type SqlPool } from '../stores/postgres/client.js';
import type { MemoryStore } from '../stores/base.js';
import type {
  AccessMode,
  Provenance,
  RankingConfig,
  SourceInfo,
  StoreType,
  StructuredBackend,
  VectorBackend,
} from '../types.js';

// ─── Matrix-green palette (truecolor ANSI) ─────────────────────────────────────

const G = {
  bright: '\x1b[38;2;0;255;65m',    // #00FF41 — lead / highlights
  mid:    '\x1b[38;2;0;204;51m',    // #00CC33 — primary text
  green:  '\x1b[38;2;0;153;38m',    // #009926 — labels
  dim:    '\x1b[38;2;0;102;25m',    // #006619 — borders / secondary
  dark:   '\x1b[38;2;0;59;0m',      // #003B00 — deepest
  down:   '\x1b[38;2;255;70;70m',   // alert red — DOWN state only
  amber:  '\x1b[38;2;255;191;0m',   // #FFBF00 — LOCKED (healthy, in use)
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  // Clear screen + scrollback + home cursor — robust across terminals so no
  // npm banner or prior output lingers behind the dashboard.
  clear:  '\x1b[2J\x1b[3J\x1b[H',
  hideCur:'\x1b[?25l',
  showCur:'\x1b[?25h',
};

const execFileP = promisify(execFile);

const PKG_NAME = 'multimodemind';

/** Audit log path — honors MMIND_AUDIT_PATH so the dashboard reads exactly what
 *  the server writes. Undefined lets AuditStore use its ~/.mmind default. */
const AUDIT_PATH = process.env['MMIND_AUDIT_PATH'];
const makeAudit = () => (AUDIT_PATH ? new AuditStore(AUDIT_PATH) : new AuditStore());

/** Read the running package version from package.json (works from src or dist). */
function getVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = getVersion();

/** Numeric semver compare: returns >0 if a is newer than b. x.y.z only. */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Query the npm registry for the latest published version. Null on failure. */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Install the latest version globally. Returns a status message. */
async function installUpdate(latest: string): Promise<string> {
  try {
    await execFileP('npm', ['install', '-g', `${PKG_NAME}@${latest}`], { timeout: 120_000 });
    return `Updated to v${latest}. Restart the dashboard to load it.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `Update failed (${msg}). Try manually: npm i -g ${PKG_NAME}@latest`;
  }
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const WIDTH     = 74;              // total box width incl. borders
const INNER     = WIDTH - 2;       // fill width for header/dividers
const COL_FULL  = WIDTH - 4;       // usable content width per line (70)

// Status-table column widths — must sum to COL_FULL - 2*(cols-1)
const C_STORE = 9, C_STATUS = 9, C_ACCESS = 4, C_ENTRIES = 6, C_SIZE = 6, C_PATH = 26;
// 9+9+4+6+6+26 = 60 ; + 5 gaps*2 = 10 ; = 70 = COL_FULL ✓

// ─── Text helpers ─────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Truncate plain text (with ellipsis) and right-pad to exactly `width`. */
function fit(s: string, width: number): string {
  if (s.length > width) {
    return width <= 1 ? s.slice(0, width) : s.slice(0, width - 1) + '…';
  }
  return s + ' '.repeat(width - s.length);
}

/** Left side + right side borders, dim green. */
const SIDE = G.dim + '║' + G.reset;

/** A full-width content line: SIDE + space + <content COL_FULL wide> + space + SIDE */
function line(content: string): string {
  return SIDE + ' ' + content + ' ' + SIDE;
}

function top():    string { return G.dim + '╔' + '═'.repeat(INNER) + '╗' + G.reset; }
function bottom(): string { return G.dim + '╚' + '═'.repeat(INNER) + '╝' + G.reset; }
function rule(ch = '═'): string {
  const l = ch === '═' ? '╠' : '╟';
  const r = ch === '═' ? '╣' : '╢';
  return G.dim + l + ch.repeat(INNER) + r + G.reset;
}

function header(title: string): string {
  const left  = Math.floor((INNER - title.length) / 2);
  const right = INNER - title.length - left;
  return G.dim + '║' + G.reset +
    ' '.repeat(left) + G.bold + G.bright + title + G.reset +
    ' '.repeat(right) + G.dim + '║' + G.reset;
}

/** Centered dim sub-line (e.g. the version under the title). */
function subheader(text: string): string {
  const left  = Math.floor((INNER - text.length) / 2);
  const right = INNER - text.length - left;
  return G.dim + '║' + G.reset +
    ' '.repeat(left) + G.dim + text + G.reset +
    ' '.repeat(right) + G.dim + '║' + G.reset;
}

/** Assemble a status-table row from pre-colored cells of fixed visible width. */
function cols(cells: Array<{ text: string; width: number; color: string }>): string {
  const parts = cells.map(c => c.color + fit(c.text, c.width) + G.reset);
  return line(parts.join('  '));
}

// ─── Store status formatting ──────────────────────────────────────────────────

function fmtStatus(info: SourceInfo): string {
  if (info.unconfigured) return '○ NOT SET';
  if (info.locked) return '◐ LOCKED';
  return info.available ? '✓ UP' : '✗ DOWN';
}

function statusColor(info: SourceInfo): string {
  if (info.unconfigured) return G.dim;   // neutral — not a failure, just not set up yet
  if (info.locked) return G.amber;
  return info.available ? G.bright : G.down;
}

function fmtAccess(info: SourceInfo): string {
  if (info.type === 'audit') return 'LOG';   // append-only, system-managed
  if (!info.access) return '—';
  return info.access === 'read' ? 'RO' : 'R/W';
}

function accessColor(info: SourceInfo): string {
  if (info.type === 'audit') return G.dim;
  if (!info.access) return G.dim;
  // Green = read-only (your data is protected). Amber = writable (agent can change it).
  return info.access === 'read' ? G.green : G.amber;
}

function fmtSize(info: SourceInfo): string {
  if (info.sizeBytes === undefined) return '—';
  const b = info.sizeBytes;
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
  if (b > 1024)        return (b / 1024).toFixed(0) + 'KB';
  return b + 'B';
}

// ─── Store factory ────────────────────────────────────────────────────────────

// A Postgres pool the dashboard opens for live status when a pg backend is
// selected. Closed and rebuilt whenever the store list is rebuilt.
let dashPool: SqlPool | undefined;

async function buildStores(cfg: DashboardConfig): Promise<MemoryStore[]> {
  if (dashPool) { await dashPool.end().catch(() => {}); dashPool = undefined; }

  const a = cfg.access;
  const url = process.env['MMIND_POSTGRES_URL'];
  const needsPg = cfg.backends.structured === 'postgres' || cfg.backends.vector === 'pgvector';
  let pgClient: SqlClient | undefined;
  const pgConfigured = !!url;
  const label = url ? safeConnLabel(url) : 'postgres';
  if (needsPg) {
    if (url) {
      try { dashPool = await createPgPool(url); pgClient = dashPool; }
      catch (err) { pgClient = disconnectedClient(`connection failed: ${String(err)}`); }
    } else {
      pgClient = disconnectedClient('MMIND_POSTGRES_URL not set');
    }
  }

  // Selecting a backend always shows that backend — connected or not — rather
  // than silently reverting to a local store.
  const structured: MemoryStore = cfg.backends.structured === 'postgres'
    ? new PostgresStore(pgClient!, a.sqlite, label, pgConfigured)
    : new SqliteStore(cfg.sqlitePath, a.sqlite);
  const vec: MemoryStore = cfg.backends.vector === 'pgvector'
    ? new PgVectorStore(pgClient!, a.vector, label, pgConfigured)
    : new VectorStore(cfg.vectorIndexPath, a.vector);

  // Markdown is a first-class store, always shown — it's the one that wraps
  // your existing notes in place, so it stays visible even before a vault is set.
  return [
    new MarkdownStore(cfg.vaultPath, a.markdown),
    structured,
    new LevelDbStore(cfg.leveldbPath, a.leveldb),
    new FilesStore(cfg.filesPath, a.files),
    vec,
    makeAudit(),
  ];
}

async function fetchStatus(stores: MemoryStore[]): Promise<SourceInfo[]> {
  const results = await Promise.allSettled(stores.map(s => s.sources()));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          type: stores[i]!.type,
          name: stores[i]!.name,
          available: false,
          error: String((r as PromiseRejectedResult).reason),
        }
  );
}

// ─── Render ───────────────────────────────────────────────────────────────────

export function buildDashboardLines(infos: SourceInfo[], cfg: DashboardConfig, message = ''): string[] {
  return renderLines(infos, cfg, message);
}

function renderDashboard(infos: SourceInfo[], cfg: DashboardConfig, message = ''): void {
  process.stdout.write(G.clear + renderLines(infos, cfg, message).join('\n'));
}

function renderLines(infos: SourceInfo[], cfg: DashboardConfig, message = ''): string[] {
  const out: string[] = [];

  out.push(top());
  out.push(header('MULTIMODE MIND  ·  STORE DASHBOARD'));
  out.push(subheader(`v${VERSION}`));
  out.push(rule());

  // Column headers
  out.push(cols([
    { text: 'STORE',   width: C_STORE,   color: G.bold + G.green },
    { text: 'STATUS',  width: C_STATUS,  color: G.bold + G.green },
    { text: 'ACC',     width: C_ACCESS,  color: G.bold + G.green },
    { text: 'ITEMS',   width: C_ENTRIES, color: G.bold + G.green },
    { text: 'SIZE',    width: C_SIZE,    color: G.bold + G.green },
    { text: 'PATH',    width: C_PATH,    color: G.bold + G.green },
  ]));
  out.push(rule('─'));

  // Store rows
  for (const info of infos) {
    // Prefer a store-provided hint (e.g. "set MMIND_POSTGRES_URL"); fall back to
    // the vault hint for an unset markdown store, else the path.
    const pathCell = info.path
      ?? (info.unconfigured ? 'no vault — press [5]' : '(unset)');
    out.push(cols([
      { text: info.backend ?? info.type,          width: C_STORE,   color: G.mid },
      { text: fmtStatus(info),                    width: C_STATUS,  color: statusColor(info) },
      { text: fmtAccess(info),                    width: C_ACCESS,  color: accessColor(info) },
      { text: info.entryCount?.toString() ?? '—', width: C_ENTRIES, color: G.mid },
      { text: fmtSize(info),                      width: C_SIZE,    color: G.mid },
      { text: pathCell,                           width: C_PATH,    color: G.dim },
    ]));
  }

  // Config menu
  out.push(rule());
  out.push(header('CONFIGURATION'));
  out.push(rule('─'));

  // Ordering matches the status table above and the [a]ccess toggle (markdown first)
  const menu: Array<[string, string, string]> = [
    ['1', 'Vault path',        cfg.vaultPath ?? '(not set)'],
    ['2', 'SQLite path',       cfg.sqlitePath],
    ['3', 'LevelDB path',      cfg.leveldbPath],
    ['4', 'Files path',        cfg.filesPath],
    ['5', 'Vector index path', cfg.vectorIndexPath],
  ];

  const LABEL_W = 20;
  const VAL_W   = COL_FULL - 4 - LABEL_W; // 4 = "[n] "
  for (const [key, label, val] of menu) {
    const content =
      G.bright + `[${key}] ` + G.reset +
      G.green + fit(label, LABEL_W) + G.reset +
      G.dim   + fit(val, VAL_W)     + G.reset;
    out.push(line(content));
  }

  // Backend selection line
  const bStructured = cfg.backends?.structured ?? 'sqlite';
  const bVector = cfg.backends?.vector ?? 'vectra';
  const backendVal = `structured=${bStructured}  ·  vector=${bVector}`;
  out.push(line(
    G.bright + '[b] ' + G.reset +
    G.green + fit('Backends', LABEL_W) + G.reset +
    G.dim   + fit(backendVal, VAL_W) + G.reset
  ));

  // Retrieval tuning summary. Only the blend and the conflict switch fit here;
  // the full set of weights lives behind the key.
  const rk = cfg.ranking ?? resolveRanking();
  const rankVal =
    `semantic=${rk.semanticWeight.toFixed(2)}  ·  lexical=${rk.lexicalWeight.toFixed(2)}` +
    `  ·  conflicts ${rk.conflictDetection ? 'on' : 'off'}`;
  out.push(line(
    G.bright + '[t] ' + G.reset +
    G.green + fit('Retrieval tuning', LABEL_W) + G.reset +
    G.dim   + fit(rankVal, VAL_W) + G.reset
  ));

  out.push(rule('─'));
  const footer =
    G.bright + '[a]' + G.reset + G.green + ' Access  ' + G.reset +
    G.bright + '[l]' + G.reset + G.green + ' Log  ' + G.reset +
    G.bright + '[r]' + G.reset + G.green + ' Refresh  ' + G.reset +
    G.bright + '[u]' + G.reset + G.green + ' Update  ' + G.reset +
    G.bright + '[q]' + G.reset + G.green + ' Quit' + G.reset;
  out.push(line(footer + ' '.repeat(Math.max(0, COL_FULL - stripAnsi(footer).length))));
  out.push(bottom());

  if (message) {
    out.push('');
    out.push('  ' + G.bright + '▸ ' + G.reset + G.mid + message + G.reset);
  }
  out.push('');
  out.push('  ' + G.green + 'Choice:' + G.reset + ' ');

  return out;
}

// ─── Audit log viewer ──────────────────────────────────────────────────────────

const LOG_TIME = 8, LOG_OP = 6, LOG_STORE = 9, LOG_DETAIL = 41;
// 8+6+9+41 = 64 ; + 3 gaps*2 = 6 ; = 70 = COL_FULL ✓

function opColor(op: AuditOp): string {
  switch (op) {
    case 'query':  return G.bright;
    case 'write':  return G.green;
    case 'denied': return G.down;    // red — refused write / knock on the locked door
    default:       return G.mid;     // read
  }
}

function eventDetail(e: AuditEvent): string {
  switch (e.op) {
    case 'query':
    case 'read':   return `"${e.query ?? ''}" → ${e.count ?? 0}`;
    case 'write':  return `${(e.id ?? '').slice(0, 8)}  ${e.preview ?? ''}`;
    case 'denied': return `${e.reason ?? 'refused'}${e.preview ? ' · ' + e.preview : ''}`;
    default:       return '';
  }
}

export function buildLogLines(events: AuditEvent[]): string[] {
  const out: string[] = [];
  out.push(top());
  out.push(header('AUDIT LOG  ·  RECENT ACTIVITY'));
  out.push(rule());
  out.push(cols([
    { text: 'TIME',   width: LOG_TIME,   color: G.bold + G.green },
    { text: 'OP',     width: LOG_OP,     color: G.bold + G.green },
    { text: 'STORE',  width: LOG_STORE,  color: G.bold + G.green },
    { text: 'DETAIL', width: LOG_DETAIL, color: G.bold + G.green },
  ]));
  out.push(rule('─'));

  if (events.length === 0) {
    out.push(line(G.dim + fit('(no audit events yet — drive some traffic through the MCP server)', COL_FULL) + G.reset));
  } else {
    for (const e of events) {
      out.push(cols([
        { text: e.ts.slice(11, 19),   width: LOG_TIME,   color: G.dim },
        { text: e.op,                 width: LOG_OP,     color: opColor(e.op) },
        { text: e.store ?? '—',       width: LOG_STORE,  color: G.mid },
        { text: eventDetail(e),       width: LOG_DETAIL, color: G.dim },
      ]));
    }
  }

  out.push(rule('─'));
  out.push(line(G.green + fit(`last ${events.length} events — press any key to return`, COL_FULL) + G.reset));
  out.push(bottom());
  return out;
}

function showLog(): string[] {
  return buildLogLines(makeAudit().recent(24));
}

// ─── Retrieval tuning panel ───────────────────────────────────────────────────

/**
 * The [t] panel — every weight the ranker uses, in one screen, with what each
 * one costs you written next to it.
 *
 * The point of exposing these at all is that the right answer is personal. A
 * vault of hand-written notes and a scratch store the agent scribbles in every
 * few minutes should not age at the same rate, and only the person who owns the
 * notes knows which is which. So the knobs are here, the defaults are sane, and
 * nothing here is a black box.
 */

// Store rows: [k] + name + half-life + tier + note = 4+12+10+12+32 = 70 = COL_FULL ✓
const T_NAME = 12, T_HALF = 10, T_TIER = 12, T_HINT = 32;
// Knob rows: [k] + label + value + note = 4+22+8+36 = 70 = COL_FULL ✓
const T_LABEL = 22, T_VALUE = 8, T_NOTE = 36;

/** Right-align inside a fixed width, so a column of numbers reads as one. */
function rjust(s: string, width: number): string {
  return s.length >= width ? fit(s, width) : ' '.repeat(width - s.length) + s;
}

/** Stores the ranker can actually return. Audit is excluded — it is never retrievable. */
const TUNED_STORES: Array<[StoreType, string]> = [
  ['markdown', 'your vault — hand-written, ages slowly'],
  ['sqlite',   'structured memory the agent writes'],
  ['leveldb',  'session scratch — ages fast by design'],
  ['files',    'documents you filed yourself'],
  ['vector',   'embedded passages for semantic recall'],
];

/**
 * One scalar knob. `read`/`write` keep the render and the editor pointed at the
 * same field, so adding a knob is one entry rather than three edits that can
 * drift apart.
 */
export interface Knob {
  key: string;
  label: string;
  note: string;
  min: number;
  max: number;
  read: (r: RankingConfig) => number;
  write: (r: RankingConfig, v: number) => void;
}

export const KNOBS: Knob[] = [
  { key: 'a', label: 'Semantic weight', note: 'embedding similarity', min: 0, max: 1,
    read: r => r.semanticWeight, write: (r, v) => { r.semanticWeight = v; } },
  { key: 'b', label: 'Lexical weight', note: 'IDF-weighted keyword match', min: 0, max: 1,
    read: r => r.lexicalWeight, write: (r, v) => { r.lexicalWeight = v; } },
  { key: 'c', label: 'Recency floor', note: 'lowest an old memory decays to', min: 0, max: 1,
    read: r => r.recencyFloor, write: (r, v) => { r.recencyFloor = v; } },
  { key: 'd', label: 'Corroboration step', note: 'added per extra agreeing store', min: 0, max: 1,
    read: r => r.corroborationBoost, write: (r, v) => { r.corroborationBoost = v; } },
  { key: 'e', label: 'Corroboration cap', note: 'ceiling on the agreement bonus', min: 1, max: 3,
    read: r => r.corroborationCap, write: (r, v) => { r.corroborationCap = v; } },
  { key: 'f', label: 'Duplicate threshold', note: 'overlap that means "same note"', min: 0.5, max: 1,
    read: r => r.duplicateThreshold, write: (r, v) => { r.duplicateThreshold = v; } },
  { key: 'g', label: 'Curated trust', note: 'multiplier on human-authored', min: 1, max: 2,
    read: r => r.trust.curated, write: (r, v) => { r.trust.curated = v; } },
  { key: 'h', label: 'Generated trust', note: 'multiplier on agent-written', min: 0.5, max: 2,
    read: r => r.trust.generated, write: (r, v) => { r.trust.generated = v; } },
];

export function buildTuningLines(cfg: DashboardConfig, message = ''): string[] {
  // Same defensive read as the backends row: a config.json written by an older
  // version has no `ranking` key at all, and the panel should still draw.
  const r = cfg.ranking ?? resolveRanking();
  const out: string[] = [];

  out.push(top());
  out.push(header('RETRIEVAL TUNING  ·  HOW THE ROUTER CHOOSES'));
  out.push(rule());

  out.push(line(G.bold + G.green + fit('PER-STORE DECAY AND TRUST', COL_FULL) + G.reset));
  out.push(line(
    G.dim + '    ' + fit('STORE', T_NAME) + rjust('HALF-LIFE', T_HALF) +
    '  ' + fit('TIER', T_TIER - 2) + fit('HOLDS', T_HINT) + G.reset
  ));
  TUNED_STORES.forEach(([st, hint], i) => {
    const tier = r.provenance[st];
    out.push(line(
      G.bright + `[${i + 1}] ` + G.reset +
      G.mid   + fit(st, T_NAME) + G.reset +
      G.bright + rjust(`${r.halfLifeDays[st]} d`, T_HALF) + G.reset +
      '  ' + (tier === 'curated' ? G.green : G.dim) + fit(tier, T_TIER - 2) + G.reset +
      G.dim + fit(hint, T_HINT) + G.reset
    ));
  });

  out.push(rule('─'));
  out.push(line(G.bold + G.green + fit('SIGNAL WEIGHTS', COL_FULL) + G.reset));
  for (const k of KNOBS) {
    out.push(line(
      G.bright + `[${k.key}] ` + G.reset +
      G.green + fit(k.label, T_LABEL) + G.reset +
      G.bright + rjust(k.read(r).toFixed(2), T_VALUE) + G.reset +
      G.dim + fit('  ' + k.note, T_NOTE) + G.reset
    ));
  }

  out.push(rule('─'));
  out.push(line(
    G.bright + '[x] ' + G.reset +
    G.green + fit('Conflict detection', T_LABEL) + G.reset +
    (r.conflictDetection ? G.bright : G.dim) + rjust(r.conflictDetection ? 'ON' : 'OFF', T_VALUE) + G.reset +
    G.dim + fit('  report contradictions in results', T_NOTE) + G.reset
  ));

  out.push(rule('─'));
  const footer =
    G.bright + '[1-5]' + G.reset + G.green + ' Store  ' + G.reset +
    G.bright + '[a-h]' + G.reset + G.green + ' Weight  ' + G.reset +
    G.bright + '[z]' + G.reset + G.green + ' Defaults  ' + G.reset +
    G.bright + '[esc]' + G.reset + G.green + ' Back' + G.reset;
  out.push(line(footer + ' '.repeat(Math.max(0, COL_FULL - stripAnsi(footer).length))));
  out.push(bottom());

  if (message) {
    out.push('');
    out.push('  ' + G.bright + '▸ ' + G.reset + G.mid + message + G.reset);
  }
  out.push('');
  out.push('  ' + G.green + 'Choice:' + G.reset + ' ');
  return out;
}

/**
 * Parse and range-check one knob edit.
 *
 * Rejects rather than clamps, and says what the allowed range was. Silently
 * pinning a typo to the nearest legal value would leave the panel showing a
 * number the user did not type and cannot account for.
 */
export function applyKnob(
  r: RankingConfig,
  knob: Knob,
  raw: string
): { ok: boolean; message: string } {
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v)) {
    return { ok: false, message: `Not a number — ${knob.label} unchanged.` };
  }
  if (v < knob.min || v > knob.max) {
    return {
      ok: false,
      message: `${knob.label} must be between ${knob.min} and ${knob.max} — unchanged.`,
    };
  }
  const before = knob.read(r);
  knob.write(r, v);
  // The two blend weights are normalized by their sum, so a pair of zeroes would
  // leave every embedded candidate scoring zero relevance. Checked here rather
  // than as a per-knob range, because neither value is out of bounds on its own —
  // it is the combination that is unusable.
  if (r.semanticWeight + r.lexicalWeight <= 0) {
    knob.write(r, before);
    return {
      ok: false,
      message: 'Semantic and lexical weight cannot both be zero — unchanged.',
    };
  }
  return { ok: true, message: `${knob.label} set to ${v}.` };
}

/**
 * The tuning loop. Runs until the user backs out, then returns a status line for
 * the main dashboard.
 *
 * Saves on every change. The running MCP server reads `ranking` from config.json
 * at startup, so the message says out loud that a restart is what makes an edit
 * take effect — the alternative is a user who tunes a weight, sees no difference
 * in their agent, and concludes the feature is broken.
 */
async function tuningPanel(cfg: DashboardConfig): Promise<string> {
  let msg = '';
  let touched = false;

  while (true) {
    process.stdout.write(G.clear + buildTuningLines(cfg, msg).join('\n'));
    msg = '';
    const key = await readKey();

    // Esc, q, Ctrl-C, or Enter all mean "done here".
    if (key === '\x1b' || key === 'q' || key === '\x03' || key === '\r' || key === '\n') {
      return touched
        ? 'Ranking saved. Restart the MCP server for it to take effect.'
        : '';
    }

    const storeIdx = Number(key) - 1;
    const store = TUNED_STORES[storeIdx];
    if (store) {
      const [st] = store;
      const answer = await prompt(
        `${st} — half-life in days [${cfg.ranking.halfLifeDays[st]}], ` +
        `or c/g for tier [${cfg.ranking.provenance[st]}]:`
      );
      const lower = answer.toLowerCase();
      if (lower === 'c' || lower === 'g') {
        const tier: Provenance = lower === 'c' ? 'curated' : 'generated';
        cfg.ranking.provenance[st] = tier;
        saveConfig(cfg);
        touched = true;
        msg = `${st} is now ${tier}.`;
      } else if (answer === '') {
        msg = 'No change.';
      } else {
        const days = Number(answer);
        if (!Number.isFinite(days) || days <= 0) {
          msg = 'Half-life must be a positive number of days — unchanged.';
        } else {
          cfg.ranking.halfLifeDays[st] = days;
          saveConfig(cfg);
          touched = true;
          msg = `${st} half-life set to ${days} days.`;
        }
      }
      continue;
    }

    const knob = KNOBS.find(k => k.key === key);
    if (knob) {
      const answer = await prompt(
        `${knob.label} [${knob.read(cfg.ranking).toFixed(2)}] (${knob.min}–${knob.max}):`
      );
      if (answer === '') {
        msg = 'No change.';
      } else {
        const result = applyKnob(cfg.ranking, knob, answer);
        msg = result.message;
        if (result.ok) {
          saveConfig(cfg);
          touched = true;
        }
      }
      continue;
    }

    if (key === 'x') {
      cfg.ranking.conflictDetection = !cfg.ranking.conflictDetection;
      saveConfig(cfg);
      touched = true;
      msg = `Conflict detection ${cfg.ranking.conflictDetection ? 'on' : 'off'}.`;
      continue;
    }

    if (key === 'z') {
      const ans = await prompt('Restore every ranking weight to its default? [y/N]:');
      if (ans.toLowerCase().startsWith('y')) {
        cfg.ranking = resolveRanking();
        saveConfig(cfg);
        touched = true;
        msg = 'Ranking restored to defaults.';
      } else {
        msg = 'Left as-is.';
      }
    }
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────

function readKey(): Promise<string> {
  return new Promise(resolve => {
    const { stdin } = process;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (key: string) => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      resolve(key);
    });
  });
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\n  ' + G.bright + question + G.reset + ' ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(G.hideCur);

  const cleanup = () => {
    process.stdout.write(G.showCur + G.reset + '\n');
    if (dashPool) dashPool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  let cfg = loadConfig();
  let stores = await buildStores(cfg);
  let message = '';

  process.stdout.write(G.clear + '\n  ' + G.mid + 'Loading store status…' + G.reset + '\n');
  let infos = await fetchStatus(stores);

  const fields: Record<string, keyof DashboardConfig> = {
    '1': 'vaultPath',
    '2': 'sqlitePath',
    '3': 'leveldbPath',
    '4': 'filesPath',
    '5': 'vectorIndexPath',
  };
  const labels: Record<string, string> = {
    sqlitePath:      'SQLite database path',
    leveldbPath:     'LevelDB directory',
    filesPath:       'Files directory',
    vectorIndexPath: 'Vector index directory',
    vaultPath:       'Vault path (type - to disable)',
  };

  while (true) {
    renderDashboard(infos, cfg, message);
    message = '';

    const key = await readKey();
    if (key === 'q' || key === '\x03') { cleanup(); return; }

    if (key === 'r') {
      await Promise.allSettled(stores.map(s => s.close()));
      stores = await buildStores(cfg);
      infos = await fetchStatus(stores);
      message = 'Status refreshed.';
      continue;
    }

    if (key === 'l') {
      process.stdout.write(G.clear + showLog().join('\n'));
      await readKey();   // any key returns to the dashboard
      continue;
    }

    if (key === 't') {
      // Ranking touches no store handles — nothing to close and reopen, and
      // rebuilding them here would flash a "Loading…" for a change that only
      // affects how results are ordered.
      message = await tuningPanel(cfg);
      continue;
    }

    if (key === 'u') {
      process.stdout.write('\n  ' + G.dim + 'Checking npm for updates…' + G.reset);
      const latest = await fetchLatestVersion();
      if (!latest) {
        message = 'Could not reach npm registry (offline?).';
        continue;
      }
      if (cmpSemver(latest, VERSION) <= 0) {
        message = `Up to date — v${VERSION} is the latest.`;
        continue;
      }
      const ans = await prompt(
        `Update available: v${VERSION} → v${latest}. Install now? [y/N]:`
      );
      if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
        process.stdout.write('\n  ' + G.dim + `Installing v${latest}…` + G.reset);
        message = await installUpdate(latest);
      } else {
        message = `Update skipped (v${latest} available).`;
      }
      continue;
    }

    if (key === 'a') {
      const order: StoreType[] = ['markdown', 'sqlite', 'leveldb', 'files', 'vector'];
      const pick = await prompt(
        'Toggle access — [1]markdown [2]sqlite [3]leveldb [4]files [5]vector:'
      );
      const idx = Number(pick) - 1;
      const st = order[idx];
      if (!st) {
        message = 'No change — enter 1–5.';
        continue;
      }
      const next: AccessMode = cfg.access[st] === 'read' ? 'readwrite' : 'read';
      cfg.access[st] = next;
      saveConfig(cfg);
      await Promise.allSettled(stores.map(s => s.close()));
      stores = await buildStores(cfg);
      infos = await fetchStatus(stores);
      message = `${st} is now ${next === 'read' ? 'read-only' : 'read/write'}.`;
      continue;
    }

    if (key === 'b') {
      const sPick = await prompt('Structured backend — [1] sqlite (local)  [2] postgres:');
      if (sPick === '1' || sPick === '2') {
        cfg.backends.structured = (sPick === '2' ? 'postgres' : 'sqlite') as StructuredBackend;
      }
      const vPick = await prompt('Vector backend — [1] vectra (local)  [2] pgvector:');
      if (vPick === '1' || vPick === '2') {
        cfg.backends.vector = (vPick === '2' ? 'pgvector' : 'vectra') as VectorBackend;
      }
      saveConfig(cfg);
      await Promise.allSettled(stores.map(s => s.close()));
      stores = await buildStores(cfg);
      infos = await fetchStatus(stores);
      const usingPg = cfg.backends.structured === 'postgres' || cfg.backends.vector === 'pgvector';
      message = usingPg && !process.env['MMIND_POSTGRES_URL']
        ? 'Saved. Set MMIND_POSTGRES_URL in the server env to connect Postgres.'
        : `Saved: structured=${cfg.backends.structured}, vector=${cfg.backends.vector}.`;
      continue;
    }

    const field = fields[key];
    if (field) {
      const current = cfg[field] ?? '';
      const val = await prompt(`${labels[field]} [${current}]:`);
      if (val !== '') {
        (cfg as unknown as Record<string, string | null>)[field] =
          val === '-' || val.toLowerCase() === 'none' ? null : val;
        saveConfig(cfg);
        await Promise.allSettled(stores.map(s => s.close()));
        stores = await buildStores(cfg);
        infos = await fetchStatus(stores);
        message = `Saved ${field}.`;
      } else {
        message = 'No change.';
      }
    }
  }
}

// Only launch the interactive loop when run directly, not when imported for tests
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch(err => {
    process.stdout.write(G.showCur + G.reset + '\n');
    console.error(err);
    process.exit(1);
  });
}
