/**
 * Auth middleware — verify a Supabase JWT and contribute `ctx.jwtClaims`.
 *
 * @packageDocumentation
 */

export { withAuth } from './with-auth.js'
export type { WithAuthConfig } from './with-auth.js'
export { verifySupabaseJwt } from './verify-jwt.js'
export type { VerifyJwtOptions } from './verify-jwt.js'
