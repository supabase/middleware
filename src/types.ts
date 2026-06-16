/**
 * Shared types used across the built-in middleware.
 *
 * @packageDocumentation
 */

/**
 * The decoded claims of a Supabase JWT — the subset middleware read from the
 * authenticated request. An upstream auth middleware is expected to contribute
 * these at `ctx.jwtClaims`; middleware that need an identity (e.g. the postgres
 * middleware) declare `{ jwtClaims: JWTClaims | null }` as their `In` prerequisite.
 */
export interface JWTClaims {
  /** Subject — the user's unique ID. */
  sub: string

  /** Issuer — typically your Supabase project URL. */
  iss?: string

  /** Audience — who the token is intended for. */
  aud?: string | string[]

  /** Expiration time (seconds since epoch). */
  exp?: number

  /** Issued at (seconds since epoch). */
  iat?: number

  /** Supabase role (e.g. `"authenticated"`, `"anon"`). */
  role?: string

  /** User's email address from Supabase Auth. */
  email?: string

  /** Application-level metadata set via Supabase Auth admin APIs. */
  app_metadata?: Record<string, unknown>

  /** User-editable metadata set via Supabase Auth. */
  user_metadata?: Record<string, unknown>

  /** Additional custom claims. */
  [key: string]: unknown
}
