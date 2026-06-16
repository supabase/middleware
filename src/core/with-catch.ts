/**
 * `withCatch` — an opt-in error boundary for a composed handler stack.
 *
 * Middleware here are request-side only and cannot observe the inner handler's
 * outcome, so a throw from any layer (a handler bug, or a `JSON.parse` on a
 * malformed body) otherwise propagates to the host, which returns its default
 * `500`. `withCatch` wraps the stack so those throws become a `Response` you define.
 *
 * It is **not** a mandatory entry wrapper — it's a transparent pass-through you
 * add only where you want error containment. It preserves the wrapped handler's
 * call signature, so the result is still usable directly as a `fetch` entry:
 *
 * ```ts
 * import { withCatch, type FetchHandler } from '@supabase/web-middleware'
 *
 * export default {
 *   fetch: withCatch(
 *     (error) => {
 *       console.error(error)
 *       return Response.json({ error: 'internal' }, { status: 500 })
 *     },
 *     withFeatureFlag({ name: 'beta', evaluate }, handler) satisfies FetchHandler,
 *   ),
 * }
 * ```
 *
 * Put any `satisfies FetchHandler` anchor on the *inner* stack (as above), not on
 * the `withCatch` result, so `Base` inference is anchored before wrapping.
 */
export function withCatch<Args extends [Request, ...unknown[]]>(
  onError: (error: unknown, req: Request) => Response | Promise<Response>,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args)
    } catch (error) {
      return onError(error, args[0])
    }
  }
}
