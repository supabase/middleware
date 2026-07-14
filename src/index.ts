/**
 * `@supabase/middleware` — composable, type-safe middleware for Web Fetch
 * handlers.
 *
 * The package root exports the {@link defineMiddleware} primitive and supporting
 * types. The built-in `feature-flag` middleware lives behind a subpath:
 *
 * - `@supabase/middleware/feature-flag`
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './core/define-middleware.js'
export type { IsAny, Middleware, NoConflict } from './core/define-middleware.js'
export { pipeline } from './core/pipeline.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  Runtime,
  RuntimeName,
} from './core/runtime.js'
export type { Conflict, Entry } from './core/types.js'
