/**
 * Audit self-test — run locally to prove the audit log works end to end on your
 * machine. Fires a known, deterministic burst of traffic at a freshly-spawned
 * server and verifies the audit log grew by exactly the expected events.
 *
 * It writes to your REAL audit log (~/.mmind/audit.log by default), so after it
 * passes you can open `npm run dashboard`, press `l`, and see the very events
 * it just wrote.
 *
 *   npm run test:audit        (builds first, then runs this)
 *   node tests/audit-selftest.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

const G = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m' };

// Your real audit log — not overridden, so the dashboard reflects this run.
const AUDIT_PATH = process.env.MMIND_AUDIT_PATH || join(homedir(), '.mmind', 'audit.log');
const countEvents = () => {
  try { return readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
};

// Self-contained fixtures: a throwaway vault + isolated memory stores in /tmp.
const ROOT = join(tmpdir(), 'mmind-audit-selftest');
rmSync(ROOT, { recursive: true, force: true });
const VAULT = join(ROOT, 'vault');
mkdirSync(VAULT, { recursive: true });
for (const [f, body] of [
  ['router', 'Agent memory is an architecture problem, not a storage problem.'],
  ['ownership', 'Models are rebar. The moat is the data you already own.'],
  ['measured', 'Measure twice, cut once. Pick one pain point and integrate deeply.'],
]) writeFileSync(join(VAULT, `${f}.md`), `---\ntitle: ${f}\n---\n${body}\n`);

const env = {
  ...process.env,
  MMIND_EMBEDDINGS: 'none',                       // keyword-only: fast + deterministic
  MMIND_SQLITE_PATH: join(ROOT, 'memory.db'),
  MMIND_LEVELDB_PATH: join(ROOT, 'leveldb'),
  MMIND_FILES_PATH: join(ROOT, 'files'),
  MMIND_VECTOR_PATH: join(ROOT, 'vector-index'),
  // Pin access so the result never depends on your saved dashboard config:
  // vault read-only (expect 3 denials), the rest writable (expect 9 writes).
  MMIND_ACCESS_MARKDOWN: 'read',
  MMIND_ACCESS_SQLITE: 'readwrite',
  MMIND_ACCESS_LEVELDB: 'readwrite',
  MMIND_ACCESS_FILES: 'readwrite',
  MMIND_ACCESS_VECTOR: 'readwrite',
  // MMIND_AUDIT_PATH intentionally NOT set → writes to your real ~/.mmind/audit.log
};

const QUERIES = [
  'router thesis', 'own your data', 'measured adoption', 'vault notes', 'architecture memory',
  'commodity models', 'wrap dont migrate', 'keep the deed', 'five percent', 'thirty years',
];
const WRITE_STORES = ['sqlite', 'leveldb', 'files'];

const EXPECT = { query: 10, read: 50, write: 9, denied: 3 }; // 10 retrieves*5 reads, 9 writes, 3 denials
const EXPECT_TOTAL = 72;

const before = countEvents();
console.log(`${G.b}Audit self-test${G.r}`);
console.log(`  audit log : ${AUDIT_PATH}`);
console.log(`  baseline  : ${before} events\n`);

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js', VAULT], env, stderr: 'inherit' });
const client = new Client({ name: 'audit-selftest', version: '1.0.0' });
const call = (name, args) => client.callTool({ name, arguments: args }).catch((e) => ({ error: String(e) }));

await client.connect(transport);
console.log('\nfiring deterministic traffic (10 retrieves, 9 writes, 3 denied)...');
for (const q of QUERIES) await call('retrieve', { query: q, limit: 3 });
for (let i = 0; i < 9; i++) await call('store', { content: `selftest fact ${i}`, store: WRITE_STORES[i % 3] });
for (let i = 0; i < 3; i++) await call('store', { content: `attempted vault write ${i}`, store: 'markdown' });
await client.close();

const after = countEvents();
const delta = after - before;
const newLines = readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean).slice(before);
const byOp = {};
for (const l of newLines) { try { const e = JSON.parse(l); byOp[e.op] = (byOp[e.op] || 0) + 1; } catch { /* skip */ } }

console.log(`\n${G.b}Result${G.r}: ${delta} new audit events (expected ${EXPECT_TOTAL})\n`);
let ok = delta === EXPECT_TOTAL;
for (const [op, want] of Object.entries(EXPECT)) {
  const got = byOp[op] || 0;
  const pass = got === want;
  ok = ok && pass;
  console.log(`  ${pass ? G.ok + 'PASS' : G.bad + 'FAIL'}${G.r}  ${op.padEnd(7)} ${got}  ${G.dim}(expected ${want})${G.r}`);
}

console.log('');
if (ok) {
  console.log(`${G.ok}${G.b}✓ AUDIT SELF-TEST PASSED${G.r} — the log works on your machine.`);
  console.log(`${G.dim}  Now run:  npm run dashboard   then press  l   to see these events.${G.r}`);
} else {
  console.log(`${G.bad}${G.b}✗ AUDIT SELF-TEST FAILED${G.r} — the audit log did not grow as expected.`);
  console.log(`${G.dim}  Check the '[mmind] audit log:' line above for where it tried to write.${G.r}`);
}
process.exit(ok ? 0 : 1);
