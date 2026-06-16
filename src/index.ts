/**
 * `@supabase/web-middleware` — composable, type-safe middleware for Web Fetch
 * handlers.
 *
 * The package root exports the {@link defineMiddleware} primitive, the
 * `withCatch` / `withResponse` wrappers, and supporting types. The built-in
 * `feature-flag` middleware lives behind a subpath:
 *
 * - `@supabase/web-middleware/feature-flag`
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './core/define-middleware.js'
export type { IsAny, Middleware, NoConflict } from './core/define-middleware.js'
export { withCatch } from './core/with-catch.js'
export { withResponse } from './core/with-response.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  Runtime,
  RuntimeName,
} from './core/runtime.js'
export type { Conflict } from './core/types.js'
