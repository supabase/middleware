/**
 * `@supabase/middleware` — composable, type-safe middleware for Web Fetch
 * handlers.
 *
 * The package root exports the {@link defineMiddleware} primitive, the
 * {@link defineComposite} bundler, the {@link pipeline} composer, portable
 * environment access ({@link getEnv}, {@link runtimeName}) and supporting
 * types. The built-in middleware live
 * behind subpaths:
 *
 * - `@supabase/middleware/feature-flag`
 * - `@supabase/middleware/cors`
 *
 * @packageDocumentation
 */

export { defineComposite } from './core/define-composite.js'
export type {
  Composite,
  Contributions,
  Prerequisites,
} from './core/define-composite.js'
export { defineMiddleware } from './core/define-middleware.js'
export type { IsAny, Middleware, NoConflict } from './core/define-middleware.js'
export { pipeline } from './core/pipeline.js'
export type { ValidateEntries } from './core/pipeline.js'
export { getEnv, isContext, runtimeName, seedContext } from './core/runtime.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  RuntimeName,
} from './core/runtime.js'
export type {
  AnyEntry,
  Conflict,
  ContributedKeys,
  Entry,
  EntryOf,
} from './core/types.js'
