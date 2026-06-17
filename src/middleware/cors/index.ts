/**
 * CORS middleware.
 *
 * @packageDocumentation
 */

export type { FetchHandler } from '../../core/index.js'
export { withCors } from './with-cors.js'
export type {
  CorsContribution,
  CorsOrigin,
  WithCorsConfig,
} from './with-cors.js'
