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
 * Carries phantom type parameters so `pipeline` can accumulate each entry's
 * contribution onto the handler's `ctx` without requiring a manual annotation.
 *
 * Produced by calling a middleware with config only — `withFoo(config)` — or
 * with no args for config-less middleware — `withFoo()`.
 */
export interface Entry<Key extends string, In extends object, Contribution> {
  (handler: AnyFetchHandler): AnyFetchHandler
  readonly __key?: Key
  readonly __in?: In
  readonly __contribution?: Contribution
}
