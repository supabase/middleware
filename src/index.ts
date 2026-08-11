/**
 * `@supabase/middleware` — composable, type-safe middleware for Web Fetch
 * handlers.
 *
 * The package root exports the {@link defineMiddleware} primitive, the
 * {@link pipeline} composer, portable environment access ({@link getEnv},
 * {@link runtimeName}) and supporting types. The built-in middleware live
 * behind subpaths:
 *
 * - `@supabase/middleware/feature-flag`
 * - `@supabase/middleware/cors`
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './core/define-middleware.js'
export type { IsAny, Middleware, NoConflict } from './core/define-middleware.js'
export { pipeline } from './core/pipeline.js'
export { getEnv, runtimeName, seedContext } from './core/runtime.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  RuntimeName,
} from './core/runtime.js'
export type { Conflict, Entry } from './core/types.js'
