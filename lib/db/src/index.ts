import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// ⚠️ CONNECTION BUDGET — read this before changing the pool size.
// Multi-facility Phase 2 (2026-08-28) gives every request its own database
// connection for its whole life, because the facility a request is acting for is
// announced to Postgres as a session setting and row-level security reads it back
// on that same connection. That is what makes the scoping impossible to forget —
// but it means a slow request holds a connection while it waits, including the
// screens that sit on a METRC call for several seconds.
//
// The old default was 10, which is fine when a connection is held for the length
// of one query and much too tight when it is held for the length of a request.
// If the app ever starts HANGING rather than erroring, look here first: that is
// what running out of pooled connections looks like.
const MAX_POOL = Number(process.env["DATABASE_POOL_MAX"] ?? 30);

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: MAX_POOL });

/** The pool-backed handle. Used at boot, in background jobs, and as the fallback. */
const rootDb = drizzle(pool, { schema });

export type AppDatabase = NodePgDatabase<typeof schema>;

/**
 * The request's own database handle, bound to one connection.
 *
 * Set by the facility-context middleware in the api-server. Anything running
 * outside a request — boot, the digest scheduler, a seed — simply has no store
 * and falls through to the pool, unscoped, which is correct: those are not acting
 * on behalf of a person at a facility.
 */
export const dbContext = new AsyncLocalStorage<{ db: AppDatabase }>();

/**
 * ⛔ `db` IS A PROXY, AND THAT IS THE WHOLE POINT.
 *
 * Fifty files already `import { db } from "@workspace/db"` and query it directly.
 * Making the facility scoping opt-in — a different handle, a helper every query
 * has to remember to use — would mean a single forgotten import shows a Michigan
 * operator a Missouri batch, which is a compliance incident rather than a bug.
 *
 * So the existing handle is what changes behaviour instead. Inside a request it
 * resolves to that request's connection, the one that has been told which facility
 * it is acting for; outside a request it is the ordinary pool. No route file needs
 * to know, and none of them can forget.
 */
export const db: AppDatabase = new Proxy(rootDb, {
  get(target, prop, receiver) {
    const scoped = dbContext.getStore()?.db;
    if (scoped) return Reflect.get(scoped, prop, scoped);
    return Reflect.get(target, prop, receiver);
  },
}) as AppDatabase;

export * from "./schema";

// The table map itself, for anywhere that needs to build a second drizzle handle
// over a specific connection (the facility-context middleware does exactly that).
export { schema };
