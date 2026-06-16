/**
 * Middleware composition primitives.
 *
 * - {@link defineMiddleware} — author-facing helper for declaring a middleware.
 *
 * Middleware compose by direct nesting: each `withFoo(config, handler)` produces
 * a single `(req, ctx) => Response` function. The outermost is used directly as
 * the runtime's `fetch` handler — there is no entry wrapper. It detects a
 * host-supplied platform argument vs. an upstream context and seeds `ctx.runtime`
 * itself. Optionally annotate the outermost with `satisfies FetchHandler` to make
 * the innermost handler see every upstream key ambiently.
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './define-middleware.js'
export type { Middleware } from './define-middleware.js'
export { withCatch } from './with-catch.js'
export type {
  BaseContext,
  BufferedBody,
  FetchHandler,
  Handler,
  Runtime,
  RuntimeName,
} from './runtime.js'
export type { Conflict } from './types.js'
