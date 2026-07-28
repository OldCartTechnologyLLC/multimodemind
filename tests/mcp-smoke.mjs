/**
 * End-to-end MCP protocol smoke test.
 * Spawns the built server over stdio and exercises all three tools
 * exactly as a real MCP client (Claude Desktop) would.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Self-contained fixture — works on any machine, no external setup needed.
const ROOT = join(tmpdir(), 'mmind-mcp-smoke');
rmSync(ROOT, { recursive: true, force: true });
const VAULT = join(ROOT, 'vault');
mkdirSync(VAULT, { recursive: true });
writeFileSync(join(VAULT, 'router-thesis.md'),
  '---\ntitle: The Router Thesis\ntags: [architecture, memory]\n---\n' +
  'Agent memory is an architecture problem, not a storage problem.\n' +
  'The differentiator is the router, not the stores.\n');
const env = {
  ...process.env,
  MMIND_SQLITE_PATH: join(ROOT, 'memory.db'),
  MMIND_LEVELDB_PATH: join(ROOT, 'leveldb'),
  MMIND_FILES_PATH: join(ROOT, 'files'),
  MMIND_VECTOR_PATH: join(ROOT, 'vector-index'),
};

const pass = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); process.exitCode = 1; };

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', VAULT],
  env,
  stderr: 'pipe',
});

const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });

try {
  console.log('\n1. Initialize handshake');
  await client.connect(transport);
  const info = client.getServerVersion();
  info?.name === 'multimodemind'
    ? pass(`connected to ${info.name} v${info.version}`)
    : fail(`unexpected server identity: ${JSON.stringify(info)}`);

  console.log('\n2. tools/list');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const want = ['retrieve', 'sources', 'store'];
  JSON.stringify(names) === JSON.stringify(want)
    ? pass(`exposes exactly: ${names.join(', ')}`)
    : fail(`tool list mismatch: got ${names.join(', ')}`);

  console.log('\n3. call sources');
  const src = await client.callTool({ name: 'sources', arguments: {} });
  const srcText = src.content?.[0]?.text ?? '';
  /markdown|sqlite/.test(srcText)
    ? pass('sources returned a store health report')
    : fail('sources returned no recognizable content');

  console.log('\n4. call store');
  const stored = await client.callTool({
    name: 'store',
    arguments: { content: 'Haddam CT land purchase — relocation target 12-24 months.', metadata: { tag: 'test' } },
  });
  const storeText = stored.content?.[0]?.text ?? '';
  /Stored to/.test(storeText)
    ? pass(`store confirmed: "${storeText.trim()}"`)
    : fail(`store did not confirm: ${storeText}`);

  console.log('\n5. call retrieve (vault note, keyword path)');
  const got = await client.callTool({
    name: 'retrieve',
    arguments: { query: 'router differentiator architecture', limit: 5 },
  });
  const gotText = got.content?.[0]?.text ?? '';
  /router|architecture/i.test(gotText)
    ? pass('retrieve found the vault note')
    : fail(`retrieve returned nothing relevant:\n${gotText.slice(0, 200)}`);

  console.log('\n6. retrieve the just-stored memory');
  const got2 = await client.callTool({
    name: 'retrieve',
    arguments: { query: 'Haddam CT relocation', limit: 5 },
  });
  const got2Text = got2.content?.[0]?.text ?? '';
  /Haddam/i.test(got2Text)
    ? pass('retrieve found the stored memory')
    : fail(`stored memory not retrieved:\n${got2Text.slice(0, 200)}`);

  await client.close();
  console.log(process.exitCode ? '\n\x1b[31mMCP SMOKE TEST FAILED\x1b[0m\n' : '\n\x1b[32mMCP SMOKE TEST PASSED — server is responding\x1b[0m\n');
} catch (err) {
  fail('protocol error: ' + (err?.message ?? String(err)));
  try { await client.close(); } catch { /* ignore */ }
  process.exit(1);
}
