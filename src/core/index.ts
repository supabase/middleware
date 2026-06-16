/**
 * Middleware composition primitives.
 *
 * - {@link defineMiddleware} — author-facing helper for declaring a middleware.
 *
 * Middleware compose by direct nesting: each `withFoo(config, handler)` is a
 * fetch-handler wrapper that runs its check, contributes a flat key to the
 * context, and either short-circuits or invokes the inner handler.
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './define-middleware.js'
export type { Middleware } from './define-middleware.js'
export type { Conflict } from './types.js'
