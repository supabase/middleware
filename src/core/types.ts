/**
 * Type primitives for the middleware composition system.
 *
 * @packageDocumentation
 */

/**
 * Sentinel type used in a middleware's wrapper signature to surface a key
 * collision with the upstream context as a TypeScript error at the call site.
 *
 * The literal string is part of the type so it appears in the error message
 * (TypeScript prints "Type '…' is not assignable to type 'middleware-conflict: …'").
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
