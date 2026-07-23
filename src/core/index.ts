/**
 * Middleware composition primitives.
 *
 * - {@link defineMiddleware} — author-facing helper for declaring a middleware.
 *
 * Middleware compose by direct nesting: each `withFoo(config, handler)` produces
 * a single `(req, ctx) => Response` function. The outermost is used directly as
 * the runtime's `fetch` handler — there is no entry wrapper. It detects a
 * host-supplied platform argument vs. an upstream context and seeds `ctx._runtime`
 * itself. Optionally annotate the outermost with `satisfies FetchHandler` to make
 * the innermost handler see every upstream key ambiently.
 *
 * @packageDocumentation
 */

export { defineMiddleware } from './define-middleware.js'
export type { IsAny, Middleware, NoConflict } from './define-middleware.js'
export { pipeline } from './pipeline.js'
export type {
  BaseContext,
  FetchHandler,
  Handler,
  Runtime,
  RuntimeName,
} from './runtime.js'
export type { Conflict, Entry } from './types.js'

// Optional descriptor / interop layer (see ./descriptor.ts). Additive: a
// middleware without an `id` carries none of this, and consumers that don't
// care never import it.
export {
  annotate,
  assertComposable,
  getDescriptor,
  DESCRIPTOR_VERSION,
} from './descriptor.js'
export type {
  ContextKeys,
  DescriptorInput,
  MiddlewareDescriptor,
  WithMiddleware,
} from './descriptor.js'
export { MiddlewareError, MiddlewareErrorCode } from './errors.js'
export type { MiddlewareErrorDetails } from './errors.js'
