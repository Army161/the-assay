// One tiny query interface over two engines: postgres.js against DATABASE_URL in production,
// PGlite (in-process Postgres) when no DATABASE_URL is set, which is what the tests and local dev use.

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>;
  close(): Promise<void>;
}

import { SCHEMA_SQL } from "./schema";
const SCHEMA = () => SCHEMA_SQL;

let instance: Promise<Db> | null = null;

async function makePostgres(url: string): Promise<Db> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 4, idle_timeout: 20, connect_timeout: 10, prepare: false, transform: { undefined: null } });
  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      if (params.length === 0 && /;\s*\S/.test(text)) { await sql.unsafe(text).simple(); return [] as T[]; }
      return (await sql.unsafe(text, params as never)) as unknown as T[];
    },
    async one<T>(text: string, params: unknown[] = []) {
      const rows = await db.query<T>(text, params);
      return rows[0] ?? null;
    },
    async close() {
      await sql.end();
    },
  };
  return db;
}

async function makePglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      // multi-statement scripts (the schema) must go through the simple protocol
      if (params.length === 0 && /;\s*\S/.test(text)) { await pg.exec(text); return [] as T[]; }
      const r = await pg.query<T>(text, params);
      return r.rows;
    },
    async one<T>(text: string, params: unknown[] = []) {
      const rows = await db.query<T>(text, params);
      return rows[0] ?? null;
    },
    async close() {
      await pg.close();
    },
  };
  return db;
}

/** Shared handle. Applies the schema once per process. */
export function getDb(): Promise<Db> {
  if (!instance) {
    instance = (async () => {
      const url = process.env.DATABASE_URL;
      const db = url ? await makePostgres(url) : await makePglite(process.env.PGLITE_DIR || undefined);
      await db.query(SCHEMA());
      return db;
    })();
  }
  return instance;
}

/** Tests: a fresh in-memory database. */
export async function freshDb(): Promise<Db> {
  const db = await makePglite();
  await db.query(SCHEMA());
  return db;
}

export const kv = {
  async get<T>(db: Db, k: string): Promise<T | null> {
    const r = await db.one<{ v: T }>("select v from kv where k = $1", [k]);
    return r ? r.v : null;
  },
  async set(db: Db, k: string, v: unknown) {
    await db.query(
      "insert into kv (k, v, updated_at) values ($1, $2::jsonb, now()) on conflict (k) do update set v = excluded.v, updated_at = now()",
      [k, JSON.stringify(v)],
    );
  },
};
