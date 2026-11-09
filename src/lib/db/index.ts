// One tiny query interface over two engines: postgres.js against DATABASE_URL (or POSTGRES_URL) in production,
// PGlite (in-process Postgres) when no DATABASE_URL is set, which is what the tests and local dev use.

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>;
  close(): Promise<void>;
}

import { randomUUID } from "node:crypto";
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
      // DATABASE_URL, or POSTGRES_URL as the Supabase/Neon Vercel integrations name it
      const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
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
  /**
   * Takes `k` if it was last taken more than `everyMs` ago, in one atomic statement: of many concurrent callers,
   * exactly one gets true. A throttle: it is never released, it just expires. For mutual exclusion use `lease`.
   */
  async claim(db: Db, k: string, everyMs: number): Promise<boolean> {
    const rows = await db.query<{ k: string }>(
      `insert into kv (k, v, updated_at) values ($1, '{}'::jsonb, now())
         on conflict (k) do update set updated_at = now()
         where kv.updated_at < now() - ($2 || ' milliseconds')::interval
       returning k`,
      [k, String(everyMs)],
    );
    return rows.length > 0;
  },
  /**
   * Takes the lease `k` for `ttlMs` if it is free or has expired, in one atomic statement. Returns a token that
   * names this holder, or null when someone else holds it. Only the token's holder can renew or release it, so a
   * run that outlived its lease cannot end the lease of the run that took over.
   */
  async lease(db: Db, k: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const rows = await db.query<{ k: string }>(
      `insert into kv (k, v, updated_at) values ($1, jsonb_build_object('owner', $3::text), now())
         on conflict (k) do update set v = excluded.v, updated_at = now()
         where kv.updated_at < now() - ($2 || ' milliseconds')::interval
       returning k`,
      [k, String(ttlMs), token],
    );
    return rows.length > 0 ? token : null;
  },
  /**
   * Extends a lease this holder still has and returns true; returns false once it has passed to someone else.
   * Long runs call it before each write so a run that lost its lease stops instead of writing over a newer one.
   */
  async renew(db: Db, k: string, token: string): Promise<boolean> {
    const rows = await db.query<{ k: string }>("update kv set updated_at = now() where k = $1 and v->>'owner' = $2 returning k", [k, token]);
    return rows.length > 0;
  },
  /** Ends a lease taken with `lease`, if this holder still has it, so the next caller does not wait for it to expire. */
  async release(db: Db, k: string, token: string) {
    await db.query("update kv set updated_at = 'epoch'::timestamptz where k = $1 and v->>'owner' = $2", [k, token]);
  },
  async del(db: Db, k: string) {
    await db.query("delete from kv where k = $1", [k]);
  },
};
