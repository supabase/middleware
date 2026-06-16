import type { Conflict } from './types.js'

/**
 * Defines a middleware.
 *
 * A middleware is a small unit that runs against an inbound `Request` and the
 * upstream context. It either short-circuits by returning a `Response`, or
 * contributes a typed value at `ctx[key]` by returning a single-key object
 * `{ [key]: contribution }` — the framework picks `result[key]`, merges it
 * into the context, and calls the inner handler. Any other keys on the
 * returned object are ignored at runtime, and TypeScript flags them at
 * fresh-literal returns via excess-property checks.
 *
 * Unlike the onion-model middleware of Express/Koa, this is **request-side
 * only**: it runs *before* the handler and never observes or wraps the
 * handler's `Response`. Anything response-shaped — CORS headers, response
 * envelopes — belongs in an outer wrapper, not here. The payoff is that each
 * middleware is a plain `(req, ctx) => Response` fetch-handler wrapper that
 * composes by direct nesting and runs unchanged across every runtime.
 *
 * The returned middleware has the shape `withFoo(config, handler) →
 * fetchHandler`, so they nest the same way any fetch-handler wrapper does — no
 * separate composer.
 *
 * Two type-level guarantees fall out of plain TS constraints:
 *
 * - **Collision detection.** If the upstream context already has a key
 *   matching this middleware's `key`, the handler position resolves to a
 *   `Conflict<…>` sentinel string and any function value fails to assign.
 *   The error surfaces at the offending call site.
 * - **Prerequisite enforcement.** The `In` type parameter declares what
 *   shape the middleware requires from upstream. The wrapper constrains
 *   `Base extends In`, so nesting it where the upstream doesn't provide those
 *   keys is a type error at the call site. Middleware with `In` keys also
 *   require the caller to supply `baseCtx` — they can't be the outermost
 *   handler unless wrapped.
 *
 * @typeParam Key - The literal-string key the middleware contributes to ctx.
 * Cannot collide with any key already on the upstream context.
 * @typeParam Config - Configuration object the middleware accepts.
 * @typeParam In - Structural shape the middleware requires from upstream.
 * Defaults to `{}` (no prerequisites). Use this to declare cross-middleware
 * dependencies, e.g. `In = { jwtClaims: JWTClaims | null }`.
 * @typeParam Contribution - Shape of the value placed at `ctx[Key]`. The
 * `run` return type wraps this as `{ [Key]: Contribution }`, so the author
 * types the slot key directly in the return position.
 *
 * @example No prerequisites:
 * ```ts
 * import { defineMiddleware } from '@supabase/web-middleware'
 *
 * export const withFeatureFlag = defineMiddleware<
 *   'featureFlag',
 *   { name: string; evaluate: (req: Request) => boolean },
 *   {},
 *   { name: string; enabled: true }
 * >({
 *   key: 'featureFlag',
 *   run: (config) => async (req) => {
 *     if (!config.evaluate(req)) {
 *       return Response.json({ error: 'feature_disabled' }, { status: 404 })
 *     }
 *     return { featureFlag: { name: config.name, enabled: true } }
 *   },
 * })
 *
 * // Standalone:
 * withFeatureFlag({ name: 'beta', evaluate: ... }, async (req, ctx) => {
 *   return Response.json({ flag: ctx.featureFlag.name })
 * })
 * ```
 *
 * @example Depending on an upstream middleware that provides `jwtClaims`:
 * ```ts
 * export const withReportAccess = defineMiddleware<
 *   'reportAccess',
 *   { reportId: string },
 *   { jwtClaims: JWTClaims | null },
 *   { allowed: boolean }
 * >({
 *   key: 'reportAccess',
 *   run: (config) => async (_req, ctx) => {
 *     // ctx is typed as `{ jwtClaims }` — the In shape.
 *     const allowed = await canRead(ctx.jwtClaims, config.reportId)
 *     if (!allowed) {
 *       return Response.json({ error: 'forbidden' }, { status: 403 })
 *     }
 *     return { reportAccess: { allowed } }
 *   },
 * })
 *
 * // Composes only inside a wrapper that provides those keys:
 * withAuth({ ... },
 *   withReportAccess({ reportId: 'r1' }, async (req, ctx) => {
 *     ctx.jwtClaims    // from the upstream middleware
 *     ctx.reportAccess // from withReportAccess
 *   })
 * )
 * ```
 */
export function defineMiddleware<
  const Key extends string,
  Config,
  In extends object = Record<never, never>,
  Contribution = unknown,
>(spec: {
  key: Key
  run: (
    config: Config,
  ) => (
    req: Request,
    ctx: In,
  ) => Promise<Response | { [K in Key]: Contribution }>
}): Middleware<Key, Config, In, Contribution> {
  return ((config: Config, handler: never) => {
    const inner = spec.run(config)
    return async (req: Request, baseCtx?: object) => {
      const upstream = baseCtx ?? ({} as object)
      const result = await inner(req, upstream as In)
      if (result instanceof Response) return result
      // Defensive: catches authoring bugs the type system can't, e.g. a
      // typo in the returned key (`{ flagg: ... }` for key 'flag') that
      // slipped past excess-property checks via a wider-typed return.
      if (
        result === null ||
        typeof result !== 'object' ||
        !(spec.key in result)
      ) {
        throw new Error(
          `defineMiddleware '${spec.key}': run() returned an object missing the key '${spec.key}'`,
        )
      }
      const ctx = {
        ...upstream,
        [spec.key]: (result as Record<string, unknown>)[spec.key],
      }
      return (
        handler as unknown as (req: Request, ctx: object) => Promise<Response>
      )(req, ctx)
    }
  }) as Middleware<Key, Config, In, Contribution>
}

/**
 * The shape of a middleware — a `(config, handler) => fetchHandler` callable
 * that {@link defineMiddleware} produces. Two arms:
 *
 * - **No prerequisites** (`In` keys empty): `baseCtx` is optional, so the
 *   middleware works as a standalone outermost handler.
 * - **With prerequisites**: `baseCtx` is required, so it can only be composed
 *   where another wrapper provides the upstream keys.
 */
/**
 * True when `T` is exactly `any`. The naive `0 extends 1 & T` formulation
 * doesn't fire reliably for TypeParams in deferred-conditional positions;
 * the `boolean extends (T extends never ? true : false)` form does, because
 * `any` distributes the conditional to both branches and the result becomes
 * `boolean` (which `boolean` extends).
 */
type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false

/**
 * The shape of a wrapped fetch handler.
 *
 * Middleware without prerequisites expose both signatures:
 *
 * - `(req, baseCtx)` for composition, so TypeScript can infer `Base` from the
 *   outer wrapper's handler context through nested calls.
 * - `(req)` for standalone handlers, preserving the ergonomic top-level use.
 *
 * A single optional `baseCtx?: Base` signature looks equivalent at runtime, but
 * it prevents the outer context from flowing into nested generic calls because
 * the parameter type becomes `Base | undefined`.
 */
type Wrapped<Base, In> = keyof In extends never
  ? ((req: Request, baseCtx: Base) => Promise<Response>) &
      ((req: Request) => Promise<Response>)
  : (req: Request, baseCtx: Base) => Promise<Response>

/**
 * Constraint that surfaces a key collision as a TypeScript error at the
 * offending call site. When the upstream `Base` already has the middleware's
 * `Key`, this resolves to `Conflict<Key>` (a sentinel string), which `Base`
 * (an `object`) cannot extend — TypeScript reports the conflict citing the
 * literal conflict message.
 *
 * Critically, this constraint sits next to `Base extends In` in the type
 * parameter list, *not* in the return-type or handler-parameter position. A
 * conditional type wrapping the return or handler types would block contextual
 * inference of `Base` from the outer caller. By contrast, a constraint is
 * checked but doesn't gate inference flow: TS infers `Base` from the
 * contextual handler shape first, then validates the conflict constraint.
 *
 * This is what lets nested middleware pick up their upstream context types
 * automatically — no explicit `<Base>` annotations needed at each level.
 *
 * `any` Base (common in tests via `vi.fn` inference) skips the check because
 * `keyof any` would false-positive every key.
 */
type NoConflict<Key extends string, Base> =
  IsAny<Base> extends true
    ? object
    : Key extends keyof Base
      ? Conflict<Key>
      : object

export interface Middleware<
  Key extends string,
  Config,
  In extends object,
  Contribution,
> {
  <Base extends In & NoConflict<Key, Base>>(
    config: Config,
    handler: (
      req: Request,
      ctx: Base & { [K in Key]: Contribution },
    ) => Promise<Response>,
  ): Wrapped<Base, In>
}
