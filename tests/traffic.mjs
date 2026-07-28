/**
 * Audit load test — throws a big burst of mixed MCP traffic at the 0.2.0 server
 * and lets the append-only audit log record all of it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const VAULT = '/tmp/mmtraffic/vault';
const env = {
  ...process.env,
  MMIND_SQLITE_PATH: '/tmp/mmtraffic/memory.db',
  MMIND_LEVELDB_PATH: '/tmp/mmtraffic/leveldb',
  MMIND_FILES_PATH: '/tmp/mmtraffic/files',
  MMIND_VECTOR_PATH: '/tmp/mmtraffic/vector-index',
};

const QUERIES = [
  'router differentiator architecture', 'own your data moat', 'measured adoption pilots',
  'Haddam relocation Connecticut', 'woodworking measure twice', 'agent memory storage',
  'models are rebar commodity', 'wrap dont migrate', 'keep the deed to your mine',
  'thirty years IT leadership', 'the five percent that worked', 'vault notes obsidian',
];
const WRITE_STORES = ['sqlite', 'leveldb', 'files', 'vector'];
const FACTS = [
  'Ben is a VP of IT with 30+ years experience.', 'St. Augustine FL, relocating to Haddam CT.',
  'Plays guitar, bass, and drums.', 'Studied AI Strategy at MIT.',
  'Old Cart Technology LLC owns Multimode Mind.', 'MIT license, ships and stays alive.',
  'Router is the differentiator, not the stores.', 'Markdown vault is read-only by default.',
];

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js', VAULT], env, stderr: 'ignore' });
const client = new Client({ name: 'traffic-gen', version: '1.0.0' });

const call = (name, args) => client.callTool({ name, arguments: args }).catch((e) => ({ error: String(e) }));

const t0 = Date.now();
await client.connect(transport);
console.log('connected; firing traffic...');

let retrieves = 0, writes = 0, deniedAttempts = 0, sources = 0, errors = 0;

// 6 waves of concurrent mixed traffic
for (let wave = 0; wave < 6; wave++) {
  const batch = [];
  // 12 retrieves per wave
  for (let i = 0; i < QUERIES.length; i++) {
    batch.push(call('retrieve', { query: QUERIES[(i + wave) % QUERIES.length], limit: 5 }).then((r) => { if (r.error) errors++; else retrieves++; }));
  }
  // 8 writes to writable stores per wave
  for (let i = 0; i < FACTS.length; i++) {
    const store = WRITE_STORES[(i + wave) % WRITE_STORES.length];
    batch.push(call('store', { content: `[w${wave}] ${FACTS[i]}`, store, metadata: { wave } }).then((r) => {
      if (r.error) errors++; else if (r.isError) deniedAttempts++; else writes++;
    }));
  }
  // 2 attempts to write the read-only markdown vault per wave (should be denied)
  for (let i = 0; i < 2; i++) {
    batch.push(call('store', { content: `attempted vault write w${wave}`, store: 'markdown' }).then((r) => {
      if (r.isError) deniedAttempts++; else if (r.error) errors++; else writes++;
    }));
  }
  // 1 sources call per wave
  batch.push(call('sources', {}).then((r) => { if (r.error) errors++; else sources++; }));
  await Promise.all(batch);
  process.stdout.write(`  wave ${wave + 1}/6 done\n`);
}

await client.close();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const totalCalls = retrieves + writes + deniedAttempts + sources + errors;
console.log(JSON.stringify({ totalCalls, retrieves, writes, deniedAttempts, sources, errors, seconds: Number(secs) }));
