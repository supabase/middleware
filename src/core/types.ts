/**
 * Type primitives for the middleware composition system.
 *
 * @packageDocumentation
 */

/**
 * Sentinel type used to surface a key collision with the upstream context as a
 * TypeScript error at the call site. Both composition paths put it in the
 * *handler parameter* position — `pipeline` via `ValidateEntries`, nesting via
 * `NoConflict` — because that is the position TypeScript prints:
 *
 * ```
 * Argument of type '(req, ctx) => …' is not assignable to parameter of type
 * "middleware-conflict: key 'alpha' is already present on the upstream context"
 * ```
 *
 * The alternative siting — the sentinel in a failed `Base` constraint — is
 * substituted silently. The stack still fails to compile either way, but on that
 * path the reported error is an overload mismatch on the *enclosing* call, in
 * which the inner handler's `ctx` has collapsed to `never` (printed as
 * `ctx?: undefined`); the collision is never named, and the colliding key may
 * not appear at all. Keep the sentinel on a parameter.
 *
 * The two paths differ only in how much surrounds the message: `pipeline` is a
 * single signature and reports a one-line TS2345, while `Middleware` is an
 * overload set and reports TS2769 with the sentinel on the first line of the
 * per-overload breakdown.
 *
 * @category Types
 */
export type Conflict<Key extends string> =
  `middleware-conflict: key '${Key}' is already present on the upstream context`

/**
 * Config arg is optional exactly when the middleware's Config admits `undefined`.
 * Used by both `defineMiddleware` (to type the config-only overload) and
 * `pipeline` (internally).
 */
export type ConfigArgs<Config> = undefined extends Config
  ? [config?: Config]
  : [config: Config]

type AnyFetchHandler = (req: Request, ctx: object) => Promise<Response>

/**
 * A middleware with its config pre-applied, ready to be passed to {@link pipeline}.
 *
 * Carries its contributions as a **record** phantom — key-to-type for every key
 * it puts on `ctx` — so `pipeline` can accumulate them onto the handler's `ctx`
 * with no manual annotation. A middleware authored with {@link defineMiddleware}
 * contributes a single key and so has a single-entry record; a composite built
 * with {@link defineComposite} carries one entry per part.
 *
 * {@link SingleKeyEntry} spells the one-key case without the braces.
 *
 * @remarks
 * `__contributes` is an optional phantom — it never exists as a value, so it
 * cannot be required — which means **any** `(handler) => handler` structurally
 * satisfies any `Entry`. Annotate a function with a record it does not produce
 * and it compiles, with the keys typed as present and `undefined` at runtime.
 *
 * So the no-over-declaring guarantee belongs to {@link defineComposite}, which
 * derives contributions from its parts, not to this type. Build multi-key
 * contributions with that; reach for a bare `Entry` annotation only to describe
 * a function you did not write, and treat it as an assertion you own.
 *
 * @category Types
 */
export interface Entry<
  Contributes extends object,
  In extends object = Record<never, never>,
> {
  (handler: AnyFetchHandler): AnyFetchHandler
  readonly __contributes?: Contributes
  readonly __in?: In
}

/**
 * An {@link Entry} contributing exactly one key — what {@link defineMiddleware}
 * produces.
 *
 * `SingleKeyEntry<'supabase', {}, SupabaseClient>` is the one-key record
 * `Entry<{ supabase: SupabaseClient }>`, spelled without the braces.
 *
 * Use it wherever you name an entry type — most often a wrapper's return type,
 * threading a generic through a middleware, which is the usual reason to write
 * the type out at all:
 *
 * ```ts
 * function withThing<Database = unknown>(
 *   config?: WithThingConfig,
 * ): SingleKeyEntry<'thing', Record<never, never>, Client<Database>>
 * ```
 *
 * An entry declared this way composes normally, {@link defineComposite}
 * included: the mapped type resolves as soon as `Key` is a literal, which it is
 * at every call site.
 *
 * @category Types
 */
export type SingleKeyEntry<
  Key extends string,
  In extends object = Record<never, never>,
  Contribution = unknown,
> = Entry<{ [K in Key]: Contribution }, In>

/**
 * The keys a contributions record puts on `ctx`, or the key itself when a
 * single literal key is given.
 */
export type ContributedKeys<KeyOrContributes> = KeyOrContributes extends string
  ? KeyOrContributes
  : Extract<keyof KeyOrContributes, string>

/** Any entry, for use as a constraint. */
export type AnyEntry = Entry<object, object>

/**
 * True when a contributions record has a string index signature rather than
 * literal keys — a *widened* entry, typically one hand-wrapped as
 * `Entry<Record<string, unknown>>` instead of produced by `defineMiddleware`.
 *
 * Its key set is unknown, so a collision check against it cannot be meaningful:
 * every key would appear to be both contributed and in conflict. Conflict
 * detection skips widened entries for the same reason it skips an `any` context.
 *
 * Note this does not make a widened entry harmless. It still folds an index
 * signature onto the accumulated context, so entries placed *after* it see
 * every literal key as already present. Fixing that means not widening the
 * entry in the first place.
 */
export type Widened<Contributes> = string extends keyof Contributes
  ? true
  : false
