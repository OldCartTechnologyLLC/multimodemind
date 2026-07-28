import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { PostgresStore } from '../src/stores/postgres/structured.js';
import { PgVectorStore } from '../src/stores/postgres/pgvector.js';
import { disconnectedClient, type SqlClient } from '../src/stores/postgres/client.js';

// One embedded Postgres shared by both stores — mirrors "one connection covers both".
let db: SqlClient;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } }) as unknown as SqlClient;
});

describe('PostgresStore (structured slot)', () => {
  it('stores, retrieves by keyword, and reports sources', async () => {
    const s = new PostgresStore(db, 'readwrite', 'localhost/test');
    expect(await s.isAvailable()).toBe(true);

    const id = await s.store({ content: 'The router is the differentiator, not the stores.', metadata: { tag: 'thesis' }, storeType: 'sqlite' });
    expect(id).toBeTruthy();

    const hits = await s.search('router differentiator', [], 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.content).toContain('router');
    expect(hits[0].source).toContain('postgres');

    const got = await s.get(id);
    expect(got?.metadata.tag).toBe('thesis');

    const src = await s.sources();
    expect(src.available).toBe(true);
    expect(src.backend).toBe('postgres');
    expect(src.entryCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses writes when read-only', async () => {
    const ro = new PostgresStore(db, 'read', 'localhost/test');
    await expect(ro.store({ content: 'x', metadata: {}, storeType: 'sqlite' })).rejects.toThrow(/read-only/i);
  });
});

describe('PgVectorStore (vector slot)', () => {
  it('stores an embedding and finds it by cosine similarity', async () => {
    const v = new PgVectorStore(db, 'readwrite', 'localhost/test');
    expect(await v.isAvailable()).toBe(true);

    await v.store({ content: 'apple', metadata: {}, storeType: 'vector', embedding: [1, 0, 0] });
    await v.store({ content: 'banana', metadata: {}, storeType: 'vector', embedding: [0, 1, 0] });

    const hits = await v.search('fruit', [0.9, 0.1, 0], 2);
    expect(hits.length).toBe(2);
    expect(hits[0].entry.content).toBe('apple');   // nearest to [0.9,0.1,0]
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].source).toContain('pgvector');
  });

  it('requires an embedding and enforces read-only', async () => {
    const v = new PgVectorStore(db, 'readwrite', 'localhost/test');
    await expect(v.store({ content: 'x', metadata: {}, storeType: 'vector' })).rejects.toThrow(/embedding/i);
    const ro = new PgVectorStore(db, 'read', 'localhost/test');
    await expect(ro.store({ content: 'x', metadata: {}, storeType: 'vector', embedding: [1, 2, 3] })).rejects.toThrow(/read-only/i);
  });
});

describe('unconfigured Postgres (selected but no connection)', () => {
  it('reports its backend label and an unconfigured (not failed) status', async () => {
    const dc = disconnectedClient('MMIND_POSTGRES_URL not set');
    const pg = new PostgresStore(dc, 'readwrite', 'postgres', false);
    const pv = new PgVectorStore(dc, 'readwrite', 'postgres', false);
    const s = await pg.sources();
    const v = await pv.sources();
    expect(s.backend).toBe('postgres');
    expect(s.available).toBe(false);
    expect(s.unconfigured).toBe(true);
    expect(s.path).toMatch(/MMIND_POSTGRES_URL/);
    expect(v.backend).toBe('pgvector');
    expect(v.unconfigured).toBe(true);
  });
});
