/**
 * `withResponse` — an opt-in, universal transform for a composed stack's response.
 *
 * Middleware here are request-side only; this is the symmetric, minimal seam for
 * the response side, **without** reintroducing the onion model. It wraps a stack
 * and maps the final `Response` — add CORS / security headers, wrap an envelope,
 * rewrite a status. It does not give individual middleware access to the
 * response; it only transforms the one the handler ultimately produced.
 *
 * Transparent to the call signature (like {@link withCatch}), so the result is
 * still a `fetch` entry, and it composes:
 *
 * ```ts
 * withCatch(onError, withResponse(addCorsHeaders, withFeatureFlag(cfg, handler)))
 * ```
 *
 * @example CORS headers (generic — not Supabase-specific)
 * ```ts
 * const addCors = (res: Response, req: Request) => {
 *   const headers = new Headers(res.headers)
 *   headers.set('access-control-allow-origin', req.headers.get('origin') ?? '*')
 *   return new Response(res.body, { status: res.status, headers })
 * }
 *
 * export default { fetch: withResponse(addCors, withFeatureFlag(cfg, handler)) }
 * ```
 *
 * `withResponse` covers the *response* half of CORS (headers on the way out). The
 * *request* half — replying to an `OPTIONS` preflight — is a normal request-side
 * middleware that short-circuits with a `Response` when `req.method === 'OPTIONS'`.
 * Together the existing model now expresses CORS end to end.
 */
export function withResponse<Args extends [Request, ...unknown[]]>(
  transform: (
    response: Response,
    request: Request,
  ) => Response | Promise<Response>,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => transform(await handler(...args), args[0])
}
