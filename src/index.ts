/**
 * `@supabase/web-middleware` — composable, type-safe middleware for Web Fetch
 * handlers.
 *
 * The package root exports the {@link defineMiddleware} primitive and supporting
 * types. The built-in `feature-flag` middleware lives behind a subpath:
 *
 * - `@supabase/web-middleware/feature-flag`
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

// Optional descriptor / interop layer — additive and opt-in (see
// ./core/descriptor.ts). A middleware without an `id` carries none of it.
export {
  annotate,
  assertComposable,
  getDescriptor,
  DESCRIPTOR_VERSION,
} from './core/descriptor.js'
export type {
  ContextKeys,
  DescriptorInput,
  MiddlewareDescriptor,
  WithMiddleware,
} from './core/descriptor.js'
export { MiddlewareError, MiddlewareErrorCode } from './core/errors.js'
export type { MiddlewareErrorDetails } from './core/errors.js'
