import type { Conflict, ConfigArgs, Entry } from './types.js'
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
    'middleware: a third fetch argument (the Workers ExecutionContext / waitUntil) was supplied but is not honored; it will be ignored. Supported entry signatures are (request) and (request, env).',
  )
}

/**
 * Defines a middleware.
 *
 * A middleware runs against an inbound `Request` and the upstream context. It
 * either short-circuits by returning a `Response`, or contributes a typed value
 * at `ctx[key]` by returning a single-key object `{ [key]: contribution }` — the
 * framework picks `result[key]`, merges it into the context, and calls the inner
 * handler. Extra keys on the returned object are ignored at runtime. Note they
 * are **not** caught at compile time: `run`'s return is contextually typed
 * against a `Response | { [key]: … }` union via a generic mapped type, a position
 * where TypeScript suppresses excess-property checks — so a stray sibling key
 * slips past the types (harmlessly). The runtime {@link contributionOf} guard is
 * the backstop, and it throws only when the key is *missing* entirely (e.g. a
 * computed/typo'd key the types couldn't see). To opt into the excess check on a
 * given middleware, annotate `run`'s inner return type explicitly.
 *
 * `run` is **request-side by default** (the common case): it runs *before* the
 * handler and never observes the handler's `Response`. Response-shaped concerns
 * (CORS, envelopes) normally belong in the handler or a `.then()` on the stack.
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
 * this via {@link isContext} and seeds a fresh context instead of merging it, so
 * platform arguments never leak into `ctx` — they are only captured as the
 * module-scoped platform env behind the importable `getEnv`.
 *
 * Typing:
 *
 * - **Prerequisite-free middleware can be the `fetch` export on their own.**
 *   Their produced handler has an optional `ctx`, so it satisfies a bare
 *   `(req) => Response` export and self-seeds a fresh context.
 * - **Middleware with `In` prerequisites require `ctx`.** They can only be nested
 *   inside a wrapper that supplies those keys — never the bare `fetch` export —
 *   which keeps the prerequisite from being a type-lie at the top level. The
 *   supplying wrapper need not be the immediately enclosing one, and no
 *   annotation is needed: an unmet prerequisite is republished by each layer that
 *   doesn't contribute it, travelling outward until one does. If none does, the
 *   stack keeps a required `ctx` and fails wherever it is checked against
 *   {@link FetchHandler} — but an untyped `export default { fetch: … }` is no
 *   such check, so annotate the outermost call to catch it at build time.
 * - **Accumulation needs no annotation.** The innermost handler sees every
 *   upstream key ambiently at any nesting depth. An unannotated outermost call
 *   has no contextual return type, so `Base` resolves to its constraint — the
 *   empty upstream, which is exactly what a `satisfies FetchHandler` would seed
 *   — and the cascade proceeds inward from there.
 * - **Collision detection does.** Composing where the upstream already has the
 *   key resolves the handler parameter to a {@link Conflict} sentinel (see
 *   {@link NoConflict}) and the stack fails to typecheck — but only under
 *   `satisfies FetchHandler` on the outermost call. The produced handler type
 *   records the upstream a stack *requires*, never the keys it *contributes*, so
 *   an unannotated enclosing call has nothing to check its own key against and a
 *   duplicate compiles silently. One annotation covers any depth.
 *   {@link pipeline} has no such gap — it validates from its entries array — so
 *   a stack that cannot carry the annotation is better written flat.
 *
 * @typeParam Key - The literal-string key contributed to ctx.
 * @typeParam Config - Configuration object the middleware accepts.
 * @typeParam In - Upstream prerequisites besides {@link BaseContext}. Defaults to none.
 * @typeParam Contribution - Shape of the value placed at `ctx[Key]`.
 *
 * @example
 * ```ts
 * import { defineMiddleware } from '@supabase/middleware'
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
    const lastArg = args[args.length - 1]

    // Config-only call — no args, or the last argument is not a function.
    // Returns an Entry whose call carries the config into the handler so it
    // can be passed to `pipeline` directly: `pipeline([withFoo(cfg)], handler)`.
    if (args.length === 0 || typeof lastArg !== 'function') {
      const config = (args.length > 0 ? args[0] : undefined) as Config
      const wrap = (
        handler: (req: Request, ctx: object) => Promise<Response>,
      ) =>
        callable(config, handler) as unknown as (
          req: Request,
          ctx: object,
        ) => Promise<Response>
      return wrap as Entry<Key, In, Contribution>
    }

    // Handler call — last arg is a function.
    // For config-less middleware `withFoo(handler)` config stays undefined.
    const config = (args.length >= 2 ? args[0] : undefined) as Config
    const handler = lastArg as (req: Request, ctx: object) => Promise<Response>
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
        upstream = seedContext(maybeCtx)
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
 * The collision check {@link Middleware} applies: resolves to `Handler` when
 * `Key` is free on `Base`, and to a {@link Conflict} sentinel when it is not.
 *
 * **Site it on the handler parameter, not the `Base` constraint.** TypeScript
 * substitutes a failed constraint silently but prints a failed parameter
 * verbatim, so on the parameter the sentinel's text reaches the reader and the
 * error is reported on the offending call rather than the one enclosing it.
 * {@link pipeline} has always taken this route (see `ValidateEntries`); the
 * {@link Middleware} overloads are the nesting equivalent.
 *
 * Reuse it in a middleware with a bespoke generic signature (e.g. one that adds
 * a `Payload` type parameter) by wrapping the handler parameter and leaving the
 * `Base` constraint to `In & BaseContext`:
 *
 * ```ts
 * <Base extends In & BaseContext>(
 *   handler: NoConflict<Key, Base, (req: Request, ctx: Base & …) => Promise<Response>>,
 * ): Produced<Base, In>
 * ```
 *
 * Every overload that can accept the handler needs the wrap. One left unguarded
 * will accept the call the guarded one rejected, resolve its own `Base` to
 * something unusable, and push the error back out to the enclosing call — which
 * is the failure mode this type exists to remove.
 *
 * @typeParam Handler - The handler type to resolve to when `Key` is free.
 */
export type NoConflict<Key extends string, Base, Handler> =
  IsAny<Base> extends true
    ? Handler
    : Key extends keyof Base
      ? Conflict<Key>
      : Handler

/**
 * The produced handler shape.
 *
 * - **No prerequisites** (`In` empty): `ctx` is optional, so the handler is
 *   directly usable as the runtime's `fetch` export and self-seeds its context.
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
 * The shape of a middleware produced by {@link defineMiddleware}.
 *
 * Three call signatures:
 * - **Handler (cascade)** — `mw(config, handler)` (or `mw(handler)`) returns the
 *   produced fetch handler, with `Base` pushed *inward* from the contextual type
 *   of the call's return. `Base` is constrained to `In & BaseContext` for
 *   prerequisite enforcement, and the handler parameter is wrapped in
 *   {@link NoConflict} for collision detection — both surface at the call site.
 * - **Handler (propagation)** — the same call when the wrapped handler declares
 *   prerequisites this layer cannot meet from the inward push alone. `Ctx` is
 *   read *outward* off that handler and re-published as this layer's own
 *   requirement, minus the key it contributes.
 * - **Config-only** — `mw(config)` (or `mw()` for config-less) returns an
 *   {@link Entry} for use in a {@link pipeline} array.
 *
 * The two directions cannot share one signature: the cascade needs the handler
 * argument to be a dead inference site, and the propagation needs it to be the
 * live one. Splitting them into ordered overloads lets each keep what it needs.
 */
export interface Middleware<
  Key extends string,
  Config,
  In extends object,
  Contribution,
> {
  // Handler call, cascade form — listed first so TypeScript's bidirectional
  // generic inference works correctly for nested calls (`withA(withB(handler))`),
  // and so this form, not the propagation overload below, is the one that types
  // an implicitly-typed arrow handler. Overload order is the tie-break: an arrow
  // matches both, and only this one contextually types its `ctx`.
  //
  // `NoInfer<Base>` on the handler's `ctx` is what makes accumulation survive
  // past two layers. `Base` flows *inward*, from the contextual type of this
  // call's return — a `satisfies FetchHandler` where there is one, and otherwise
  // `Base`'s own constraint, the empty upstream, which is the same starting
  // point — so each layer's `ctx` is the accumulated upstream plus its own key.
  // That fallback is why accumulation needs no annotation at any depth. Left
  // inferable, `ctx` is a second inference site — and at depth >= 2 the handler
  // argument is itself a middleware call whose type supplies a candidate there,
  // which outranks the contextual return type and collapses `Base` to its
  // constraint (the empty upstream). The cascade then stops: the innermost
  // handler sees only its own key and the stack fails to compile. Blocking
  // inference at that site leaves the return type as the single source of
  // `Base`, so the push chains through any nesting depth.
  //
  // `NoInfer` is a TypeScript 5.4 intrinsic and it is emitted into the published
  // `.d.ts`, so it sets the consumer TypeScript floor (documented under
  // Requirements in the root README). Replacing it means replacing that floor.
  <Base extends In & BaseContext>(
    ...args: MiddlewareArgs<
      Config,
      NoConflict<
        Key,
        Base,
        (
          req: Request,
          ctx: NoInfer<Base> & { [K in Key]: Contribution },
        ) => Promise<Response>
      >
    >
  ): Produced<Base, In>
  // Handler call, propagation form — reached only when the cascade overload
  // above fails, which is exactly the unanchored-prerequisite case.
  //
  // An `In` prerequisite is discharged by whichever layer contributes the key.
  // With an anchor that happens on the way in: `Base` carries the accumulated
  // upstream down to the requirer, so the cascade overload already satisfies it
  // at any depth. Unanchored there is nothing to carry — `Base` collapses to its
  // constraint, the empty upstream — so the requirement has to travel the other
  // way, *outward*, one layer at a time until some layer contributes the key.
  //
  // That outward travel is inference off the handler argument, the very site
  // `NoInfer` closes above; the two readings of that argument are mutually
  // exclusive within one signature. Hence the split. Here `Ctx` is the wrapped
  // handler's declared `ctx` — its unmet requirement — and the produced type
  // republishes `Omit<Ctx, Key>`: everything still outstanding once this layer's
  // own contribution is accounted for. `Produced`'s second argument gets it too,
  // so a stack with an outstanding requirement has a *required* `ctx` and cannot
  // pass as a bare `FetchHandler` export.
  //
  // `Ctx extends { [K in Key]?: Contribution }` is what keeps `Omit` honest.
  // Omitting by key name alone would discharge `{ alpha: { v: number } }` against
  // a layer contributing `alpha: { v: string }`. The optional-key constraint
  // makes the requirement's type checked against `Contribution` where the key is
  // present, and is vacuous where it isn't.
  <
    Base extends In & BaseContext,
    Ctx extends BaseContext & { [K in Key]?: Contribution } = BaseContext,
  >(
    ...args: MiddlewareArgs<
      Config,
      NoConflict<Key, Base, (req: Request, ctx: Ctx) => Promise<Response>>
    >
  ): Produced<Base & Omit<Ctx, Key>, In & Omit<Ctx, Key>>
  // Config-only call — `mw(config)` (or `mw()` for config-less) returns an
  // Entry for use in a `pipeline` array. Falls through from the handler overload
  // because config-only calls either have the wrong arity (required-config mw)
  // or pass a non-function (which doesn't match MiddlewareArgs' Handler slot).
  (...args: ConfigArgs<Config>): Entry<Key, In, Contribution>
}
