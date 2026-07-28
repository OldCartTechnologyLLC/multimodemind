/**
 * Minimal SQL client abstraction shared by the Postgres-backed stores.
 *
 * Both `pg` (node-postgres, production — connects to your real Postgres server)
 * and pglite (embedded Postgres, used in tests) satisfy this interface, so one
 * adapter works against either.
 *
 * Copyright Old Cart Technology LLC — MIT License
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** A closable pool (production pg). */
export interface SqlPool extends SqlClient {
  end(): Promise<void>;
}

/**
 * Build a production Postgres connection pool from a connection string.
 * The connection string is read from the MMIND_POSTGRES_URL environment
 * variable — never stored on disk — so database credentials stay out of config.
 */
export async function createPgPool(connectionString: string): Promise<SqlPool> {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 8000 });
  return pool as unknown as SqlPool;
}

/**
 * A client that rejects every query with a fixed reason. Used when a Postgres
 * backend is selected but no connection is available yet, so the store still
 * appears (as its selected backend) and reports why it isn't up — rather than
 * silently falling back to a different local database.
 */
export function disconnectedClient(reason: string): SqlClient {
  return { query: () => Promise.reject(new Error(reason)) };
}

/** Redact credentials from a connection string for display (host/db only). */
export function safeConnLabel(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    const db = u.pathname.replace(/^\//, '');
    return `${u.hostname}${u.port ? ':' + u.port : ''}/${db || '?'}`;
  } catch {
    return 'postgres';
  }
}
