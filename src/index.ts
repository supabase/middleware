/**
 * `@supabase/web-middleware` — composable, type-safe middleware for Web Fetch
 * handlers.
 *
 * The package root exports the {@link defineMiddleware} primitive and its
 * supporting types. The built-in middleware live behind subpaths:
 *
 * - `@supabase/web-middleware/feature-flag`
 * - `@supabase/web-middleware/auth-hook`
 * - `@supabase/web-middleware/postgres`
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './core/define-middleware.js'
export type { IsAny, Middleware, NoConflict } from './core/define-middleware.js'
export { withCatch } from './core/with-catch.js'
export { withResponse } from './core/with-response.js'
export { rejection } from './core/reject.js'
export type { RejectConfig } from './core/reject.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  Runtime,
  RuntimeName,
} from './core/runtime.js'
export type { Conflict } from './core/types.js'
export type { JWTClaims } from './types.js'
