/**
 * Shared short-circuit-response convention.
 *
 * Several middleware reject a request with a configurable status + body (a
 * feature flag that's off, a signature that fails to verify). Rather than each
 * one reinventing `rejectStatus` / `rejectBody` and the `Response.json(...)`
 * plumbing, they share {@link RejectConfig} and {@link rejection} so the surface
 * and behavior stay consistent across the package and any third-party middleware.
 */

/** Mixin for a middleware config that can short-circuit with a custom response. */
export interface RejectConfig {
  /** HTTP status to use when the middleware rejects. */
  rejectStatus?: number
  /** Body to use when the middleware rejects (serialized as JSON). */
  rejectBody?: unknown
}

/**
 * Build the short-circuit `Response` for a rejecting middleware, applying the
 * caller's `rejectStatus` / `rejectBody` overrides over the middleware's
 * defaults.
 */
export function rejection(
  config: RejectConfig,
  defaults: { status: number; body: unknown },
): Response {
  return Response.json(config.rejectBody ?? defaults.body, {
    status: config.rejectStatus ?? defaults.status,
  })
}
