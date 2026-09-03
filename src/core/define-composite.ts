/**
 * Composite middleware — bundling a series of middleware into one.
 *
 * {@link defineMiddleware} builds a middleware that contributes exactly one
 * key. That rule is what keeps a stack readable and a contribution greppable,
 * and it stays. But some units of behavior genuinely own several keys —
 * `withSupabase` in `@supabase/server` establishes six — and before this
 * primitive their only options were to publish a tuple that consumers had to
 * spread, or to hand-write a multi-key function that the type layer could not
 * describe (see the `Entry` phantom: contributions used to be one `Key` plus one
 * `Contribution`).
 *
 * `defineComposite` closes that gap without weakening the one-key rule: a
 * composite is *built from* single-key middleware, and its contributions are
 * **derived** from theirs. It cannot declare a key that no part supplies, so
 * every key on a composite still traces to exactly one `defineMiddleware` call.
 *
 * @packageDocumentation
 */

import type { NoConflict } from './define-middleware.js'
import type { BaseContext } from './runtime.js'
import type { AnyEntry, ConfigArgs, EntryOf } from './types.js'

type AnyHandler = (req: Request, ctx: object) => Promise<Response>

/**
 * Fold a tuple of entries into the contributions record they collectively put
 * on `ctx`, in order.
 */
export type Contributions<
  Entries extends readonly AnyEntry[],
  Ctx = Record<never, never>,
> = Entries extends readonly [EntryOf<infer C, object>, ...infer Rest]
  ? Rest extends readonly AnyEntry[]
    ? Contributions<Rest, Ctx & C>
    : Ctx
  : Ctx

/**
 * Fold a tuple of entries into the prerequisites still outstanding once every
 * part's own contributions are accounted for — the composite's `In`.
 *
 * A part's `In` that an earlier part contributes is discharged internally and
 * never surfaces; anything left is republished as the composite's own
 * requirement, exactly as a nested stack republishes an unmet prerequisite.
 */
export type Prerequisites<
  Entries extends readonly AnyEntry[],
  Ctx = Record<never, never>,
  Need = Record<never, never>,
> = Entries extends readonly [EntryOf<infer C, infer In>, ...infer Rest]
  ? Rest extends readonly AnyEntry[]
    ? Prerequisites<Rest, Ctx & C, Need & Omit<In, keyof Ctx>>
    : Need
  : Need

/**
 * The produced handler shape, mirroring {@link defineMiddleware}'s: `ctx` is
 * optional when the composite has no outstanding prerequisites (so it can be
 * the `fetch` export and self-seed), required when it has.
 */
type Produced<Base, In> = keyof In extends never
  ? (req: Request, ctx?: Base) => Promise<Response>
  : (req: Request, ctx: Base) => Promise<Response>

type CompositeArgs<Config, Handler> = undefined extends Config
  ? [handler: Handler] | [config: Config, handler: Handler]
  : [config: Config, handler: Handler]

/**
 * The shape of a composite produced by {@link defineComposite}.
 *
 * The same three call signatures as {@link Middleware}, so a composite is
 * usable everywhere a middleware is — nested (`wsup(config, handler)`) or flat
 * (`pipeline([wsup(config)], handler)`) — from one declaration. The only
 * difference is that `Contributes` is a record rather than a single key.
 *
 * @category Types
 */
export interface Composite<
  Contributes extends object,
  Config,
  In extends object,
> {
  // Handler call, cascade form. `Base` flows inward from the contextual return
  // type; `NoInfer` keeps the handler argument a dead inference site so the
  // push chains through any nesting depth. See `Middleware` for the full
  // reasoning — this is the record-valued twin of that overload.
  <Base extends In & BaseContext>(
    ...args: CompositeArgs<
      Config,
      NoConflict<
        Contributes,
        Base,
        (req: Request, ctx: NoInfer<Base> & Contributes) => Promise<Response>
      >
    >
  ): Produced<Base, In>
  // Handler call, propagation form. `Ctx` is read outward off the wrapped
  // handler and republished minus everything this composite contributes.
  // `Partial<Contributes>` is the record analogue of the single-key
  // `{ [K in Key]?: Contribution }` constraint that keeps `Omit` honest: a
  // requirement whose type disagrees with what we contribute is not discharged.
  <
    Base extends In & BaseContext,
    Ctx extends BaseContext & Partial<Contributes> = BaseContext,
  >(
    ...args: CompositeArgs<
      Config,
      NoConflict<
        Contributes,
        Base,
        (req: Request, ctx: Ctx) => Promise<Response>
      >
    >
  ): Produced<
    Base & Omit<Ctx, keyof Contributes>,
    In & Omit<Ctx, keyof Contributes>
  >
  // Config-only call — returns the Entry for a `pipeline` array.
  (...args: ConfigArgs<Config>): EntryOf<Contributes, In>
}

/**
 * Bundles a series of middleware into a single middleware.
 *
 * `build` receives the composite's config and returns the parts, outermost
 * first — the same order `pipeline` takes. The composite's contributions are
 * derived from the parts', so it publishes exactly the union of what they
 * contribute and **cannot over-declare**: naming a key no part supplies is a
 * compile error. Prerequisites are derived the same way — a part's `In` that an
 * earlier part contributes is discharged internally, and anything outstanding
 * becomes the composite's own `In`.
 *
 * At runtime the parts fold exactly as `pipeline` folds them, so there is no new
 * execution behavior and no change to `defineMiddleware`: each part still merges
 * its own single key. In particular a part that short-circuits does so from
 * *inside* the fold, so an enclosing middleware's response seam observes it.
 *
 * @param spec.build - `(config) => readonly [...parts]`, outermost first. Return
 * the tuple `as const` so its length and order are visible to the types.
 * @param spec.hide - Keys that are internal plumbing rather than public API.
 * They are stripped from `ctx` at the composite's boundary and absent from its
 * declared contributions, so a downstream layer sees neither the type nor the
 * value. Each must be a key some part actually contributes.
 *
 * @example A composite with private plumbing
 * ```ts
 * import { defineComposite } from '@supabase/middleware'
 *
 * // `withGate` contributes the whole auth result at `ctx.auth`; the projections
 * // republish the individual keys the public contract promises. `auth` itself is
 * // an implementation detail, so it is hidden.
 * export const withAuth = defineComposite({
 *   build: (config: { mode: 'user' | 'none' }) =>
 *     [withGate(config), withMode(), withClaims()] as const,
 *   hide: ['auth'],
 * })
 *
 * // Nested, or flat — one declaration serves both.
 * export default {
 *   fetch: pipeline([withAuth({ mode: 'user' }), withPostgres()], async (req, ctx) => {
 *     ctx.authMode   // from withMode
 *     ctx.jwtClaims  // from withClaims
 *     ctx.postgres   // reads ctx.jwtClaims as its own `In`
 *     return Response.json({ ok: true })
 *   }),
 * }
 * ```
 *
 * @category Composition
 */
export function defineComposite<
  Config,
  const Entries extends readonly AnyEntry[],
  const Hidden extends readonly (keyof Contributions<Entries> & string)[] = [],
>(spec: {
  build: (config: Config) => Entries
  hide?: Hidden
}): Composite<
  Omit<Contributions<Entries>, Hidden[number]>,
  Config,
  Prerequisites<Entries>
> {
  const callable = (...args: unknown[]) => {
    const lastArg = args[args.length - 1]

    // Config-only call — return an Entry that carries the config, so the
    // composite drops into a `pipeline` array like any other middleware.
    if (args.length === 0 || typeof lastArg !== 'function') {
      const config = (args.length > 0 ? args[0] : undefined) as Config
      const wrap = (handler: AnyHandler) =>
        callable(config, handler) as unknown as AnyHandler
      return wrap
    }

    const config = (args.length >= 2 ? args[0] : undefined) as Config
    const handler = lastArg as AnyHandler
    const hidden = spec.hide ?? []

    // Hidden keys are stripped at the boundary, not merely omitted from the
    // type. Leaving the value on `ctx` would make the declaration a lie and let
    // internal plumbing shadow a same-named key belonging to a downstream layer.
    // The spread carries the context marker symbol, so the result is still a
    // valid upstream context.
    const boundary: AnyHandler =
      hidden.length === 0
        ? handler
        : (req, ctx) => {
            const visible = { ...ctx } as Record<string, unknown>
            for (const key of hidden) delete visible[key]
            return handler(req, visible)
          }

    // The same fold `pipeline` performs. Parts each merge their own key, so a
    // composite needs no multi-key merge of its own.
    return spec
      .build(config)
      .reduceRight<AnyHandler>((h, entry) => entry(h), boundary)
  }
  return callable as unknown as Composite<
    Omit<Contributions<Entries>, Hidden[number]>,
    Config,
    Prerequisites<Entries>
  >
}
