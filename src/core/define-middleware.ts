import type { Conflict } from './types.js'
import type { BaseContext } from './runtime.js'
import { bufferRequest, isContext, seedContext } from './runtime.js'

/**
 * Warn (once per process) that a host passed a third `fetch` argument — the
 * Workers `ExecutionContext` (`waitUntil` / `passThroughOnException`) — which is
 * not honored. The request still proceeds; only the execution context is ignored.
 */
let warnedThirdArg = false
function warnUnhonoredThirdArg(): void {
  if (warnedThirdArg) return
  warnedThirdArg = true
  console.warn(
    'web-middleware: a third fetch argument (the Workers ExecutionContext / waitUntil) was supplied but is not honored; it will be ignored. Supported entry signatures are (request) and (request, env).',
  )
}

/**
 * Defines a middleware.
 *
 * A middleware runs against an inbound `Request` and the upstream context. It
 * either short-circuits by returning a `Response`, or contributes a typed value
 * at `ctx[key]` by returning a single-key object `{ [key]: contribution }` — the
 * framework picks `result[key]`, merges it into the context, and calls the inner
 * handler. Other keys on the returned object are ignored at runtime and flagged
 * by excess-property checks at fresh-literal returns.
 *
 * `run` is **request-side by default** (the common case): it runs *before* the
 * handler and never observes the handler's `Response`. Response-shaped concerns
 * (CORS, envelopes) normally belong in the handler or a `.then()` on the entry.
 *
 * **Response seam (escape hatch).** When a middleware genuinely needs to see the
 * way out — stamp headers, time the request, run `finally` cleanup — write `run`
 * as an `async function*` instead of `async`. `yield` is the seam: code before it
 * is the request phase; you `yield` the contribution and the `yield` expression
 * resolves to the downstream `Response` for the response phase. `yield` always
 * means "run downstream and hand me the response" — short-circuit with a plain
 * `return new Response(...)`, exactly as the request-side path does, and yield at
 * most once. This is the one place a middleware observes the handler's response,
 * and writing `function*` is the visible, opt-in signal.
 *
 * `withFoo(config, handler)` produces a single `(req, ctx) => Response` function.
 * Middleware nest directly, and the **outermost is used as the runtime's `fetch`
 * handler with no wrapper** — `export default { fetch: withFoo(config, handler) }`.
 * When the host invokes it, the second argument is a platform value (a Workers
 * `env`, a Deno `ServeHandlerInfo`), not an upstream context; the wrapper detects
 * this via {@link isContext} and seeds a fresh `{ _runtime }` instead of merging
 * it, so platform arguments never leak into `ctx`.
 *
 * Typing:
 *
 * - **Prerequisite-free middleware are entry-able.** Their produced handler has
 *   an optional `ctx`, so it satisfies a bare `(req) => Response` fetch entry and
 *   self-seeds `ctx._runtime`.
 * - **Middleware with `In` prerequisites require `ctx`.** They can only be nested
 *   inside a wrapper that supplies those keys — never a bare entry — which keeps
 *   the prerequisite from being a type-lie at the top level.
 * - **Collision detection.** Composing where the upstream already has the key
 *   resolves `Base` to a `Conflict<Key>` sentinel; the stack fails to typecheck.
 * - **Accumulation.** Cross-middleware dependencies declared via `In` type with
 *   no ceremony. For the innermost handler to *ambiently* see every upstream key,
 *   annotate the outermost with `satisfies FetchHandler` (a type-only anchor).
 *
 * @typeParam Key - The literal-string key contributed to ctx.
 * @typeParam Config - Configuration object the middleware accepts.
 * @typeParam In - Upstream prerequisites besides {@link BaseContext}. Defaults to none.
 * @typeParam Contribution - Shape of the value placed at `ctx[Key]`.
 *
 * @example
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
    ctx: In & BaseContext,
  ) =>
    | Promise<Response | { [K in Key]: Contribution }>
    | AsyncGenerator<
        Response | { [K in Key]: Contribution },
        Response | void,
        Response
      >
}): Middleware<Key, Config, In, Contribution> {
  const callable = (...args: unknown[]) => {
    // `config` is optional at the call site for config-less middleware
    // (`withFoo(handler)`); a lone argument is the handler. Two arguments are
    // always `(config, handler)` — so passing `config: undefined` explicitly
    // still works, but is never required.
    const config = (args.length >= 2 ? args[0] : undefined) as Config
    const handler = (args.length >= 2 ? args[1] : args[0]) as (
      req: Request,
      ctx: object,
    ) => Promise<Response>
    const inner = spec.run(config)
    return async (req: Request, maybeCtx?: object, ...rest: unknown[]) => {
      // A parent middleware passes a real context; the host passes a platform
      // value (env / connection info) in the same slot. At the entry (the
      // latter), seed a fresh context so platform arguments never reach `ctx`,
      // and wrap the request so its body is re-readable across the stack. Inner
      // layers receive the already-buffered request and the seeded context.
      let workingReq = req
      let upstream: BaseContext
      if (isContext(maybeCtx)) {
        upstream = maybeCtx
      } else {
        // Entry call. A third positional argument is the host's execution
        // context (the Cloudflare Workers `ExecutionContext` — `waitUntil` /
        // `passThroughOnException`). We don't honor it; warn once rather than
        // silently dropping it, and continue (the Deno target never passes one).
        if (rest.length > 0) warnUnhonoredThirdArg()
        workingReq = req.body ? bufferRequest(req) : req
        upstream = seedContext([maybeCtx])
      }

      const runInner = handler
      const callDownstream = (contribution: unknown) =>
        runInner(workingReq, { ...upstream, [spec.key]: contribution })

      const produced = inner(workingReq, upstream as In & BaseContext)

      // Plain request-side middleware (the 95% case): `run` returns a promise
      // of a short-circuit `Response` or the contribution. No response seam.
      if (!isAsyncGenerator(produced)) {
        const result = await produced
        if (result instanceof Response) return result
        return callDownstream(contributionOf(result, spec.key))
      }

      // Generator middleware (the escape hatch): `yield` is the seam between the
      // request phase (before) and the response phase (after). The middleware
      // yields a short-circuit `Response` or its contribution; we run the inner
      // stack, then resume it with the downstream `Response` so it can shape the
      // way out — the one place a middleware observes the handler's response.
      const gen = produced
      const first = await gen.next()
      if (first.value instanceof Response) {
        if (!first.done) await gen.return(undefined) // run any `finally`
        return first.value
      }
      const contribution = contributionOf(first.value, spec.key)
      // A generator that `return`ed (rather than `yield`ed) the contribution has
      // no seam — treat it like the plain path.
      if (first.done) return callDownstream(contribution)

      let response: Response
      try {
        response = await callDownstream(contribution)
      } catch (err) {
        // Let a `try/catch` around the middleware's `yield` observe the failure.
        // If it doesn't handle it, `gen.throw` rethrows and we propagate.
        const recovered = await gen.throw(err)
        if (recovered.value instanceof Response) return recovered.value
        throw err
      }
      const resumed = await gen.next(response)
      if (!resumed.done) await gen.return(undefined) // ignore extra yields, run `finally`
      return resumed.value instanceof Response ? resumed.value : response
    }
  }
  return callable as unknown as Middleware<Key, Config, In, Contribution>
}

/**
 * Narrow a `run` result to the async-generator (onion) form. A plain `async`
 * body returns a `Promise`; an `async function*` body returns an async
 * generator, which is what carries the `yield` seam. The two are disjoint, so a
 * single `Symbol.asyncIterator` probe picks the path with no author ceremony.
 */
function isAsyncGenerator(
  value: unknown,
): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    value != null &&
    typeof (value as AsyncGenerator)[Symbol.asyncIterator] === 'function' &&
    typeof (value as AsyncGenerator).next === 'function'
  )
}

/**
 * Pull the contribution off a fall-through result. Defensive: catches authoring
 * bugs the type system can't, e.g. a typo in the key that slipped past
 * excess-property checks, or a generator that produced nothing.
 */
function contributionOf(result: unknown, key: string): unknown {
  if (result === null || typeof result !== 'object' || !(key in result)) {
    throw new Error(
      `defineMiddleware '${key}': run() must return or yield an object carrying the key '${key}'`,
    )
  }
  return (result as Record<string, unknown>)[key]
}

/**
 * True when `T` is exactly `any` — the conflict check is skipped for `any` Base
 * (common in tests via `vi.fn` inference), since `keyof any` would false-positive
 * every key.
 */
export type IsAny<T> = boolean extends (T extends never ? true : false)
  ? true
  : false

/**
 * Resolves to a {@link Conflict} sentinel when `Base` already carries `Key`,
 * surfacing the collision at the call site (the sentinel string is not an
 * `object`, so the constraint fails). Exported so a middleware with a bespoke
 * generic signature (e.g. one that adds a `Payload` type parameter) can reuse the
 * core's collision check instead of hand-copying it.
 */
export type NoConflict<Key extends string, Base> =
  IsAny<Base> extends true
    ? object
    : Key extends keyof Base
      ? Conflict<Key>
      : object

/**
 * The produced handler shape.
 *
 * - **No prerequisites** (`In` empty): `ctx` is optional, so the handler is
 *   directly usable as a runtime `fetch` entry and self-seeds `ctx._runtime`.
 * - **With prerequisites**: `ctx` is required, so the middleware must be nested
 *   inside a wrapper that provides those keys.
 *
 * Both arms are a *single* call signature (not an intersection), which is what
 * preserves contextual `Base` inference through nesting.
 */
type Produced<Base, In> = keyof In extends never
  ? (req: Request, ctx?: Base) => Promise<Response>
  : (req: Request, ctx: Base) => Promise<Response>

/**
 * The argument list of a produced middleware. When `Config` admits `undefined`
 * — a config-less middleware, typed `void` or `undefined` — the leading
 * `config` argument may be dropped (`withFoo(handler)`), so no `undefined`
 * placeholder is threaded through call sites. Otherwise `config` is required and
 * positional. Either way, passing `config` explicitly still typechecks.
 */
type MiddlewareArgs<Config, Handler> = undefined extends Config
  ? [handler: Handler] | [config: Config, handler: Handler]
  : [config: Config, handler: Handler]

/**
 * The shape of a middleware — a `(config, handler) => handler` callable that
 * {@link defineMiddleware} produces (config-less middleware may call it as
 * `(handler)`; see {@link MiddlewareArgs}). `Base` is constrained to
 * `In & BaseContext & NoConflict<Key, Base>` and defaults to `In & BaseContext`,
 * which self-anchors the outermost handler without an entry wrapper.
 */
export type Middleware<
  Key extends string,
  Config,
  In extends object,
  Contribution,
> = <Base extends In & BaseContext & NoConflict<Key, Base>>(
  ...args: MiddlewareArgs<
    Config,
    (
      req: Request,
      ctx: Base & { [K in Key]: Contribution },
    ) => Promise<Response>
  >
) => Produced<Base, In>
