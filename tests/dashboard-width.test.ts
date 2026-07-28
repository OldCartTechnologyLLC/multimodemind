import { describe, it, expect } from 'vitest';
import {
  buildDashboardLines,
  buildLogLines,
  buildTuningLines,
  applyKnob,
  KNOBS,
  type Knob,
} from '../src/cli/dashboard.js';
import type { DashboardConfig } from '../src/cli/config.js';
import { resolveRanking } from '../src/router/ranking.js';
import type { RankingConfig, SourceInfo } from '../src/types.js';
import type { AuditEvent } from '../src/stores/audit.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Annotated rather than inferred on purpose: a new required field on
// DashboardConfig should break this file at compile time, which is how the
// missing `ranking` key was caught.
// Held separately because `DashboardConfig.vaultPath` is nullable — a store row
// takes a plain `string | undefined`, and reading it back off the annotated
// config would drag the null through.
const VAULT_PATH = '/Volumes/SAMSUNG USB-C/MultimodeMind/really/long/vault/path/that/overflows/badly/notes';

const cfg: DashboardConfig = {
  sqlitePath: '.mmind/memory.db',
  leveldbPath: '.mmind/leveldb',
  filesPath: '.mmind/files',
  vectorIndexPath: '.mmind/vector-index',
  vaultPath: VAULT_PATH,
  access: {
    markdown: 'read', sqlite: 'readwrite', leveldb: 'readwrite',
    files: 'readwrite', vector: 'readwrite', audit: 'read',
  },
  backends: { structured: 'sqlite', vector: 'vectra' },
  ranking: resolveRanking(),
};

const infos: SourceInfo[] = [
  { type: 'markdown',name: 'm', available: true,  access: 'read',      path: VAULT_PATH, entryCount: 128 },
  { type: 'sqlite',  name: 's', available: true,  access: 'readwrite', path: cfg.sqlitePath, entryCount: 42, sizeBytes: 20480 },
  { type: 'leveldb', name: 'l', available: true,  access: 'readwrite', path: '/a/very/long/leveldb/path/that/definitely/exceeds/the/column/limit', entryCount: 7, sizeBytes: 4096 },
  { type: 'files',   name: 'f', available: false, access: 'readwrite', path: cfg.filesPath, error: 'boom' },
  { type: 'vector',  name: 'v', available: true,  access: 'readwrite', path: cfg.vectorIndexPath, entryCount: 0 },
  { type: 'audit',   name: 'a', available: true,  access: 'read',      path: '.mmind/audit.log', entryCount: 1432, sizeBytes: 204800 },
];

describe('dashboard layout', () => {
  it('every box-drawing line is exactly 74 columns wide', () => {
    const lines = buildDashboardLines(infos, cfg, 'Saved sqlitePath.');
    const misaligned: string[] = [];
    for (const ln of lines) {
      const plain = strip(ln);
      if (/^[╔╠╟║╚]/.test(plain) && plain.length !== 74) {
        misaligned.push(`width=${plain.length}: ${plain}`);
      }
    }
    expect(misaligned).toEqual([]);
  });

  it('long paths are truncated, not overflowed', () => {
    const lines = buildDashboardLines(infos, cfg);
    // The overflowing leveldb path must appear ellipsized
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('…');
  });

  it('renders the ACCESS column (RO / R/W / LOG) and audit row, aligned', () => {
    const lines = buildDashboardLines(infos, cfg, 'ok');
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain(' RO '); // markdown read-only
    expect(joined).toContain('R/W');  // a managed store
    expect(joined).toContain('LOG');  // audit store
    expect(joined).toContain('audit');
    for (const ln of lines) {
      const plain = strip(ln);
      if (/^[╔╠╟║╚]/.test(plain)) expect(plain.length).toBe(74);
    }
  });

  it('renders an unconfigured markdown vault as NOT SET, first-class and aligned', () => {
    const noVault: SourceInfo[] = [
      { type: 'markdown', name: 'm', available: false, unconfigured: true },
      { type: 'sqlite',  name: 's', available: true, path: cfg.sqlitePath, entryCount: 3, sizeBytes: 1024 },
      { type: 'leveldb', name: 'l', available: true, path: cfg.leveldbPath, entryCount: 1 },
      { type: 'files',   name: 'f', available: true, path: cfg.filesPath, entryCount: 0 },
      { type: 'vector',  name: 'v', available: true, path: cfg.vectorIndexPath, entryCount: 1 },
    ];
    const lines = buildDashboardLines(noVault, { ...cfg, vaultPath: null });
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('○ NOT SET');
    expect(joined).toContain('markdown');
    for (const ln of lines) {
      const plain = strip(ln);
      if (/^[╔╠╟║╚]/.test(plain)) expect(plain.length).toBe(74);
    }
  });

  it('renders a LOCKED store distinctly and stays aligned', () => {
    const locked: SourceInfo[] = [
      { type: 'sqlite',  name: 's', available: true,  path: cfg.sqlitePath, entryCount: 3, sizeBytes: 1024 },
      { type: 'leveldb', name: 'l', available: true,  locked: true, path: cfg.leveldbPath },
      { type: 'files',   name: 'f', available: true,  path: cfg.filesPath, entryCount: 0 },
      { type: 'vector',  name: 'v', available: true,  path: cfg.vectorIndexPath, entryCount: 1 },
    ];
    const lines = buildDashboardLines(locked, cfg);
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('◐ LOCKED');
    for (const ln of lines) {
      const plain = strip(ln);
      if (/^[╔╠╟║╚]/.test(plain)) expect(plain.length).toBe(74);
    }
  });
});

describe('audit log viewer', () => {
  const events: AuditEvent[] = [
    { ts: '2026-07-19T19:47:25.000Z', op: 'query',  count: 5, query: 'router differentiator architecture that is quite long indeed and overflows' },
    { ts: '2026-07-19T19:47:25.000Z', op: 'read',   store: 'markdown', count: 1, query: 'own your data' },
    { ts: '2026-07-19T19:47:25.000Z', op: 'write',  store: 'sqlite', id: 'bb37595d-aaaa', preview: 'Ben is a VP of IT with 30+ years experience and this preview is long' },
    { ts: '2026-07-19T19:47:25.000Z', op: 'denied', store: 'markdown', reason: 'store is read-only', preview: 'attempted vault write' },
  ];

  it('renders recent events, all lines exactly 74 wide', () => {
    const lines = buildLogLines(events);
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('AUDIT LOG');
    expect(joined).toContain('denied');
    expect(joined).toContain('write');
    for (const ln of lines) {
      const plain = strip(ln);
      if (/^[╔╠╟║╚]/.test(plain)) expect(plain.length).toBe(74);
    }
  });

  it('handles an empty log gracefully', () => {
    const lines = buildLogLines([]);
    const joined = lines.map(strip).join('\n');
    expect(joined).toContain('no audit events yet');
    for (const ln of lines) {
      const plain = strip(ln);
      if (/^[╔╠╟║╚]/.test(plain)) expect(plain.length).toBe(74);
    }
  });
});

describe('retrieval tuning panel', () => {
  const widthOf = (lines: string[]) =>
    lines.map(strip).filter((p) => /^[╔╠╟║╚]/.test(p));

  it('every box-drawing line is exactly 74 columns wide', () => {
    // Both states, because the message tail is appended outside the box and has
    // been the thing that shifted a border before.
    for (const lines of [buildTuningLines(cfg), buildTuningLines(cfg, 'Curated trust set to 1.4.')]) {
      const misaligned = widthOf(lines)
        .filter((p) => p.length !== 74)
        .map((p) => `width=${p.length}: ${p}`);
      expect(misaligned).toEqual([]);
    }
  });

  it('shows every tunable store with its half-life and tier, and never the audit log', () => {
    const joined = buildTuningLines(cfg).map(strip).join('\n');
    for (const store of ['markdown', 'sqlite', 'leveldb', 'files', 'vector']) {
      expect(joined).toContain(store);
    }
    // The audit log is system-managed and unretrievable, so there is nothing
    // here to tune. Its appearing would mean the panel is offering to weight a
    // store the router is never allowed to return.
    expect(joined).not.toContain('audit');
    expect(joined).toContain('curated');
    expect(joined).toContain('generated');
    expect(joined).toContain(`${cfg.ranking.halfLifeDays.leveldb} d`);
  });

  it('lists every knob with its current value', () => {
    const joined = buildTuningLines(cfg).map(strip).join('\n');
    for (const k of KNOBS) {
      expect(joined).toContain(`[${k.key}] `);
      expect(joined).toContain(k.label);
      expect(joined).toContain(k.read(cfg.ranking).toFixed(2));
    }
    expect(joined).toContain('Conflict detection');
    expect(joined).toContain('ON');
  });

  it('reserves its dispatch keys — no knob shadows a store row or a toggle', () => {
    // The panel reads one character and decides what it meant. `1`–`5` pick a
    // store, `x` toggles conflicts, `z` restores defaults, `q`/esc back out. A
    // knob keyed with any of those would be unreachable, and the only symptom
    // would be a key that quietly does the other thing.
    const reserved = new Set(['1', '2', '3', '4', '5', 'x', 'z', 'q']);
    const collisions = KNOBS.filter((k) => reserved.has(k.key)).map((k) => k.key);
    expect(collisions).toEqual([]);
    expect(new Set(KNOBS.map((k) => k.key)).size).toBe(KNOBS.length);
  });

  it('still draws when the config predates the ranking field', () => {
    // A config.json written by 0.3.x has no `ranking` key at all. Same failure
    // the `backends` row hit once: the panel must fall back to defaults rather
    // than throw on the user's first run after upgrading.
    const stale = { ...cfg, ranking: undefined } as unknown as DashboardConfig;
    const lines = buildTuningLines(stale);
    expect(lines.map(strip).join('\n')).toContain('Semantic weight');
    for (const p of widthOf(lines)) expect(p.length).toBe(74);
  });
});

describe('knob validation', () => {
  /** An in-range value that is not the knob's current one, so an alias shows up. */
  function probe(k: Knob, r: RankingConfig): number {
    const mid = Math.round(((k.min + k.max) / 2) * 100) / 100;
    if (mid !== k.read(r)) return mid;
    const alt = Math.round(((mid + k.max) / 2) * 100) / 100;
    return alt !== k.read(r) ? alt : k.min;
  }

  it('accepts a value inside the range', () => {
    const r = resolveRanking();
    const result = applyKnob(r, KNOBS[0]!, '0.55');
    expect(result.ok).toBe(true);
    expect(r.semanticWeight).toBe(0.55);
  });

  it('rejects a value outside the range and leaves the old one in place', () => {
    const r = resolveRanking();
    const before = r.semanticWeight;
    const result = applyKnob(r, KNOBS[0]!, '4');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/between 0 and 1/);
    expect(r.semanticWeight).toBe(before);
  });

  it('rejects text and an empty answer', () => {
    const r = resolveRanking();
    const before = r.recencyFloor;
    const floor = KNOBS.find((k) => k.label === 'Recency floor')!;
    for (const bad of ['high', '', '   ']) {
      const result = applyKnob(r, floor, bad);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Not a number/);
    }
    expect(r.recencyFloor).toBe(before);
  });

  it('refuses to zero both blend weights, and puts back the one it just wrote', () => {
    // Neither value is out of bounds alone — it is the pair that is unusable,
    // and the rollback is the part worth pinning: a rejected edit that still
    // mutated the config would leave the panel showing a number nobody chose.
    const r = resolveRanking();
    const semantic = KNOBS.find((k) => k.label === 'Semantic weight')!;
    const lexical = KNOBS.find((k) => k.label === 'Lexical weight')!;

    expect(applyKnob(r, lexical, '0').ok).toBe(true);
    expect(r.lexicalWeight).toBe(0);

    const before = r.semanticWeight;
    const result = applyKnob(r, semantic, '0');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot both be zero/);
    expect(r.semanticWeight).toBe(before);
  });

  it('every knob writes its own field and nothing else', () => {
    // The knob table is data, which is exactly what makes a copy-paste alias
    // easy to introduce and invisible to read: two rows pointing at the same
    // field would look like one weight that refuses to move.
    const baseline = resolveRanking();
    for (const k of KNOBS) {
      const r = resolveRanking();
      const v = probe(k, r);
      expect(applyKnob(r, k, String(v)).ok).toBe(true);
      expect(k.read(r)).toBe(v);
      for (const other of KNOBS) {
        if (other.key === k.key) continue;
        expect(`${other.key}=${other.read(r)}`).toBe(`${other.key}=${other.read(baseline)}`);
      }
    }
  });
});
