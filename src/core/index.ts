/**
 * Middleware composition primitives.
 *
 * - {@link defineMiddleware} — author-facing helper for declaring a middleware.
 *
 * Middleware compose by direct nesting: each `withFoo(config, handler)` produces
 * a single `(req, ctx) => Response` function. The outermost is used directly as
 * the runtime's `fetch` handler — there is no wrapper step. It detects a
 * host-supplied platform argument vs. an upstream context and seeds a fresh
 * context itself, capturing the platform env behind the importable
 * {@link getEnv}. The innermost handler sees every upstream key ambiently with
 * no annotation; annotate the outermost with `satisfies FetchHandler` to assert
 * the stack can be the `fetch` export and to turn on collision detection.
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './define-middleware.js'
export type {
  IsAny,
  Middleware,
  NoConflict,
} from './define-middleware.js'
export { pipeline } from './pipeline.js'
export { getEnv, runtimeName, seedContext } from './runtime.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  RuntimeName,
} from './runtime.js'
export type { Conflict, Entry } from './types.js'
