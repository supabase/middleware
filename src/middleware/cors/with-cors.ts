/**
 * CORS middleware — the worked example of the **response seam**.
 *
 * CORS is the canonical reason the seam exists: it has a request-side half (the
 * `OPTIONS` preflight, a short-circuit) and a response-side half (stamping
 * `Access-Control-*` headers onto the handler's response). A plain request-side
 * middleware can do the first but not the second. Written as an `async function*`,
 * `withCors` does both in one place — handle preflight before `yield`, stamp
 * headers after.
 *
 * It is intentionally small, not a spec-exhaustive CORS implementation. Read it
 * alongside `src/core/README.md` (the seam) and `with-cors.test.ts`.
 */

import { defineMiddleware } from '../../core/index.js'

/** Decides the `Access-Control-Allow-Origin` value for a request. */
export type CorsOrigin =
  | string
  | string[]
  | '*'
  | ((requestOrigin: string | null) => boolean)

/** Per-instance configuration for {@link withCors}. */
export interface WithCorsConfig {
  /**
   * Allowed origin(s). A literal `'*'`, an exact origin string, a list of
   * origins, or a predicate over the request's `Origin`. Defaults to `'*'`.
   *
   * `'*'` cannot be combined with `credentials: true` (the Fetch spec forbids
   * it); when both are set, the request's `Origin` is reflected instead.
   *
   * @defaultValue `'*'`
   */
  origin?: CorsOrigin

  /** Methods advertised on preflight. @defaultValue the common verbs */
  methods?: string[]

  /**
   * Headers advertised on preflight. When omitted, the request's
   * `Access-Control-Request-Headers` is reflected.
   */
  allowedHeaders?: string[]

  /** Response headers exposed to the client beyond the safelist. */
  exposedHeaders?: string[]

  /** Send `Access-Control-Allow-Credentials: true`. @defaultValue `false` */
  credentials?: boolean

  /** `Access-Control-Max-Age` (seconds) for preflight caching. */
  maxAge?: number

  /** Status for a successful preflight. @defaultValue `204` */
  optionsSuccessStatus?: number
}

/** Shape contributed at `ctx.cors`. */
export interface CorsContribution {
  /** The resolved `Access-Control-Allow-Origin`, or `null` when not allowed. */
  allowedOrigin: string | null
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']

/** Resolve the `Access-Control-Allow-Origin` value, or `null` to send none. */
function resolveAllowOrigin(
  config: WithCorsConfig,
  requestOrigin: string | null,
): string | null {
  const origin = config.origin ?? '*'

  if (origin === '*') {
    // Credentials forbid a literal `*`; reflect the caller's origin instead.
    return config.credentials ? requestOrigin : '*'
  }
  if (typeof origin === 'function') {
    return origin(requestOrigin) ? requestOrigin : null
  }
  if (Array.isArray(origin)) {
    return requestOrigin && origin.includes(requestOrigin)
      ? requestOrigin
      : null
  }
  return requestOrigin === origin ? origin : null
}

/** Stamp the response-side CORS headers onto a `Headers` instance. */
function applyResponseHeaders(
  headers: Headers,
  config: WithCorsConfig,
  allowOrigin: string,
): void {
  headers.set('Access-Control-Allow-Origin', allowOrigin)
  // A per-origin (reflected) value makes the response origin-dependent; caches
  // must vary on it. A literal `*` does not.
  if (allowOrigin !== '*') headers.append('Vary', 'Origin')
  if (config.credentials) {
    headers.set('Access-Control-Allow-Credentials', 'true')
  }
  if (config.exposedHeaders?.length) {
    headers.set(
      'Access-Control-Expose-Headers',
      config.exposedHeaders.join(', '),
    )
  }
}

/** Build the preflight (`OPTIONS`) response headers. */
function buildPreflightHeaders(
  config: WithCorsConfig,
  req: Request,
  allowOrigin: string | null,
): Headers {
  const headers = new Headers()
  if (allowOrigin !== null) applyResponseHeaders(headers, config, allowOrigin)

  headers.set(
    'Access-Control-Allow-Methods',
    (config.methods ?? DEFAULT_METHODS).join(', '),
  )

  if (config.allowedHeaders?.length) {
    headers.set(
      'Access-Control-Allow-Headers',
      config.allowedHeaders.join(', '),
    )
  } else {
    const requested = req.headers.get('Access-Control-Request-Headers')
    if (requested) headers.set('Access-Control-Allow-Headers', requested)
    headers.append('Vary', 'Access-Control-Request-Headers')
  }

  if (config.maxAge != null) {
    headers.set('Access-Control-Max-Age', String(config.maxAge))
  }
  return headers
}

/**
 * CORS middleware.
 *
 * @example
 * ```ts
 * import { withCors } from '@supabase/web-middleware/cors'
 *
 * export default {
 *   fetch: withCors(
 *     { origin: ['https://app.example.com'], credentials: true },
 *     async () => Response.json({ ok: true }),
 *   ),
 * }
 * ```
 */
export const withCors = defineMiddleware<
  'cors',
  WithCorsConfig,
  Record<never, never>,
  CorsContribution
>({
  key: 'cors',
  id: 'cors',
  // A generator so it can act on both sides of the handler: preflight before
  // `yield`, header stamping after.
  run: (config) =>
    async function* (req) {
      const requestOrigin = req.headers.get('Origin')
      const allowOrigin = resolveAllowOrigin(config, requestOrigin)

      // Request side: answer the preflight ourselves. `return` short-circuits —
      // the handler never runs, and there's no response phase to reach.
      const isPreflight =
        req.method === 'OPTIONS' &&
        req.headers.has('Access-Control-Request-Method')
      if (isPreflight) {
        return new Response(null, {
          status: config.optionsSuccessStatus ?? 204,
          headers: buildPreflightHeaders(config, req, allowOrigin),
        })
      }

      // Fall through, then shape the response on the way out.
      const response = yield { cors: { allowedOrigin: allowOrigin } }
      if (allowOrigin === null) return response

      // Copy headers so an immutable response (e.g. from `fetch`) is handled,
      // and pass the body through untouched (no buffering of streams).
      const headers = new Headers(response.headers)
      applyResponseHeaders(headers, config, allowOrigin)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
})
