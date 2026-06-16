/**
 * `withPostgres` — injects Postgres clients at `ctx.postgres`.
 *
 * Always contributes `ctx.postgres.db`: an **RLS-scoped** client where each
 * operation runs as the caller's JWT (claims + connection role pinned to a
 * single transaction, PostgREST-style), so `auth.uid()` and RLS policies behave
 * exactly as they do through PostgREST.
 *
 * With `admin: true`, it *also* contributes `ctx.postgres.adminDb`: an
 * **RLS-bypassing** client for trusted, server-side work that must see every
 * row. The contribution type narrows to whatever the config enables — reaching
 * for `ctx.postgres.adminDb` without `admin: true` is a compile error.
 *
 * Requires an upstream middleware to provide `jwtClaims` (e.g. an auth
 * middleware) — the `In` shape makes composing it standalone a type error. The
 * `pg` import is confined to this subpath; it runs only on Node/Deno, not
 * Workers/edge.
 */

import type { Pool } from 'pg'

import { defineMiddleware, type BaseContext } from '../../core/index.js'
import type { JWTClaims } from '../../types.js'

import { type Db, type Role, getPool, authedDb, adminDb } from './db.js'

/** Per-instance configuration for `withPostgres(config, handler)`. */
export interface PostgresConfig {
  /**
   * Pool to draw connections from. When omitted, a lazily-created module-level
   * pool backed by `SUPABASE_DB_URL` is used (shared across requests).
   */
  pool?: Pool

  /**
   * Also expose an RLS-bypassing admin client at `ctx.postgres.adminDb`. Off by
   * default — opt in only for trusted server-side work that must see every row.
   * Bypassing RLS is never something a token claim can trigger; it is always an
   * explicit choice here.
   */
  admin?: boolean
}

/**
 * Shape contributed at `ctx.postgres`. `db` (RLS-scoped) is always present;
 * `adminDb` (RLS-bypassing) appears only when configured with `admin: true`, so
 * the type tracks exactly what the config enables.
 */
export type Postgres<Cfg extends PostgresConfig = PostgresConfig> = {
  /** RLS-scoped client — runs as the caller's JWT, just like PostgREST. */
  db: Db
} & (Cfg['admin'] extends true
  ? {
      /** RLS-bypassing client — sees every row. Present only with `admin: true`. */
      adminDb: Db
    }
  : Record<never, never>)

/**
 * Clamp the *connection role* to `authenticated` / `anon` — never let a token
 * claim flip the user client into an RLS-bypassing role. `service_role` belongs
 * to the admin client, which only `admin: true` exposes.
 */
function userRole(claims: JWTClaims | null): Role {
  return claims?.role === 'authenticated' ? 'authenticated' : 'anon'
}

/**
 * The underlying single-key middleware. Built once via {@link defineMiddleware}
 * for the runtime merge + defensive checks; {@link withPostgres} re-types its
 * call signature so the contribution narrows per-config.
 */
const postgresMiddleware = defineMiddleware<
  'postgres',
  PostgresConfig,
  { jwtClaims: JWTClaims | null },
  Postgres
>({
  key: 'postgres',
  run: (config) => async (_req, ctx) => {
    const pool = getPool(config.pool, ctx._runtime.getEnv('SUPABASE_DB_URL'))
    const claims = ctx.jwtClaims ?? { role: 'anon' }
    const postgres: { db: Db; adminDb?: Db } = {
      db: authedDb(pool, claims, userRole(ctx.jwtClaims)),
    }
    if (config.admin) postgres.adminDb = adminDb(pool)
    return { postgres: postgres as Postgres }
  },
})

/**
 * Postgres middleware — contributes {@link Postgres} at `ctx.postgres`.
 *
 * The generic `Cfg` carries the literal `admin` value, so the handler's
 * `ctx.postgres` type gains `adminDb` exactly when `admin: true` was passed.
 *
 * @example RLS-scoped only:
 * ```ts
 * import { withPostgres } from '@supabase/web-middleware/postgres'
 *
 * // `withAuth` is any upstream middleware that contributes `ctx.jwtClaims`.
 * withAuth({ ... },
 *   withPostgres({}, async (_req, ctx) => {
 *     // auth.uid() = ctx.jwtClaims.sub; RLS applies
 *     const mine = await ctx.postgres.db.query('select * from notes')
 *     return Response.json({ notes: mine.rows })
 *   }))
 * ```
 *
 * @example With the RLS-bypassing admin client:
 * ```ts
 * withAuth({ ... },
 *   withPostgres({ admin: true }, async (_req, ctx) => {
 *     const mine = await ctx.postgres.db.query('select * from notes')
 *     const all = await ctx.postgres.adminDb.query('select count(*) from notes')
 *     return Response.json({ mine: mine.rows, total: all.rows[0].count })
 *   }))
 * ```
 */
export function withPostgres<
  const Cfg extends PostgresConfig,
  Base extends { jwtClaims: JWTClaims | null } & BaseContext = {
    jwtClaims: JWTClaims | null
  } & BaseContext,
>(
  config: Cfg,
  handler: (
    req: Request,
    ctx: Base & { postgres: Postgres<Cfg> },
  ) => Promise<Response>,
): (req: Request, ctx: Base) => Promise<Response> {
  // `postgresMiddleware` is typed with the widened `Postgres` (no `adminDb`);
  // the public signature above narrows it per-config. Bridge the two with one
  // cast.
  const run = postgresMiddleware as unknown as (
    config: PostgresConfig,
    handler: (req: Request, ctx: unknown) => Promise<Response>,
  ) => (req: Request, baseCtx: Base) => Promise<Response>
  return run(
    config,
    handler as (req: Request, ctx: unknown) => Promise<Response>,
  )
}
