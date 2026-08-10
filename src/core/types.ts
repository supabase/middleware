/**
 * Type primitives for the middleware composition system.
 *
 * @packageDocumentation
 */

/**
 * Sentinel type used to surface a key collision with the upstream context as a
 * TypeScript error at the call site. Where the sentinel lands decides whether
 * its text ever reaches the reader:
 *
 * - **`pipeline`** puts it in the *handler parameter* position (see `Validate`),
 *   so TypeScript prints it verbatim: `Argument of type '(req, ctx) => …' is not
 *   assignable to parameter of type "middleware-conflict: key 'alpha' is already
 *   present on the upstream context"`. This is the message the sentinel is for.
 * - **Nesting** puts it in the wrapper's `Base` constraint (see `NoConflict`),
 *   and TypeScript substitutes a failed constraint silently. The stack still
 *   fails to compile — that guarantee holds at any nesting depth — but the
 *   reported error is an overload mismatch on the *enclosing* call, in which the
 *   inner handler's `ctx` has collapsed to `never` (printed as `ctx?: undefined`).
 *   Neither the key nor the collision is named there, so on this path the
 *   sentinel's text documents the intent for whoever reads the signature rather
 *   than for whoever reads the error.
 */
export type Conflict<Key extends string> =
  `middleware-conflict: key '${Key}' is already present on the upstream context`

/**
 * Config arg is optional exactly when the middleware's Config admits `undefined`.
 * Used by both `defineMiddleware` (to type the config-only overload) and
 * `pipeline` (internally).
 */
export type ConfigArgs<Config> = undefined extends Config ? [config?: Config] : [config: Config]

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
