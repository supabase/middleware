/**
 * Auth middleware — verifies the caller's Supabase JWT and contributes the
 * decoded claims at `ctx.jwtClaims`.
 *
 * This is the upstream that {@link withPostgres} (and any RLS-scoped middleware)
 * needs: it reads the `Authorization: Bearer <token>` header, verifies the HS256
 * signature against your Supabase JWT secret, and contributes
 * `ctx.jwtClaims: JWTClaims | null`. A missing, malformed, badly-signed, or
 * expired token contributes `null` — i.e. the request runs as **anon** — rather
 * than short-circuiting, so a downstream middleware/handler decides whether
 * unauthenticated access is allowed (RLS already enforces it for `withPostgres`).
 *
 * @packageDocumentation
 */

import { defineMiddleware } from '../../core/index.js'
import type { JWTClaims } from '../../types.js'

import { verifySupabaseJwt } from './verify-jwt.js'

/** Per-instance configuration passed to `withAuth(config, handler)`. */
export interface WithAuthConfig {
  /**
   * The Supabase JWT secret (HS256). When omitted, it is read from
   * `ctx.runtime.getEnv('SUPABASE_JWT_SECRET')` at request time.
   */
  jwtSecret?: string

  /**
   * Clock-skew tolerance in seconds applied to the token's `exp` / `nbf`.
   *
   * @defaultValue `0`
   */
  toleranceInSeconds?: number
}

const BEARER = /^Bearer\s+(.+)$/i

/**
 * Auth middleware — contributes `ctx.jwtClaims` (`JWTClaims | null`).
 *
 * @example Gate Postgres behind the caller's identity
 * ```ts
 * import { withAuth } from '@supabase/web-middleware/auth'
 * import { withPostgres } from '@supabase/web-middleware/postgres'
 *
 * export default {
 *   fetch: withAuth(
 *     {}, // jwtSecret read from SUPABASE_JWT_SECRET
 *     withPostgres({}, async (_req, ctx) => {
 *       // RLS runs as ctx.jwtClaims.sub (or anon when null)
 *       const mine = await ctx.postgres.db.query('select * from notes')
 *       return Response.json({ notes: mine.rows })
 *     }),
 *   ),
 * }
 * ```
 */
export const withAuth = defineMiddleware<
  'jwtClaims',
  WithAuthConfig,
  Record<never, never>,
  JWTClaims | null
>({
  key: 'jwtClaims',
  run: (config) => async (req, ctx) => {
    const secret = config.jwtSecret ?? ctx.runtime.getEnv('SUPABASE_JWT_SECRET')
    const token = req.headers.get('authorization')?.match(BEARER)?.[1]
    if (!secret || !token) return { jwtClaims: null }
    return {
      jwtClaims: await verifySupabaseJwt(token, secret, {
        toleranceInSeconds: config.toleranceInSeconds,
      }),
    }
  },
})
