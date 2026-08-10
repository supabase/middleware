/**
 * Feature-flag middleware — the canonical example of a `defineMiddleware`
 * implementation.
 *
 * Provider-agnostic: pass any `evaluate` function (PostHog, LaunchDarkly,
 * Statsig, a header check, a database lookup). It runs per request and either
 * admits with the verdict at `ctx.featureFlag` or short-circuits with a
 * configurable response.
 *
 * Read alongside `docs/authoring-guide.md` and `src/core/README.md` — this
 * file is referenced from both as the worked example of the pattern.
 */

import { defineMiddleware } from '../../core/index.js'
import type { Middleware } from '../../core/index.js'

/**
 * Per-instance configuration the consumer passes to `withFeatureFlag(config, handler)`.
 *
 * Keep this surface small — every field becomes part of the public API.
 */
export interface WithFeatureFlagConfig {
  /** Human-readable name for the flag. Echoed back on `ctx.featureFlag.name` and the default rejection body. */
  name: string

  /**
   * Decide whether the flag is enabled for this request.
   *
   * Return `true`/`false` for a simple on-off check, or a {@link FeatureFlagVerdict}
   * to also record a variant or provider payload. Async is fine.
   */
  evaluate: (
    req: Request,
  ) => Promise<boolean | FeatureFlagVerdict> | boolean | FeatureFlagVerdict

  /**
   * HTTP status when the flag rejects. Default is 404 — "this feature doesn't
   * exist for you yet" — a softer reveal than 403 that avoids tipping off
   * attackers about the existence of gated functionality.
   *
   * @defaultValue `404`
   */
  rejectStatus?: number

  /** Body when the flag rejects. @defaultValue `{ error: 'feature_disabled', flag: <name> }` */
  rejectBody?: unknown
}

/**
 * Richer return shape `evaluate` may produce, in place of a plain boolean,
 * when an A/B variant or provider payload is worth carrying through to the
 * handler.
 */
export interface FeatureFlagVerdict {
  /** Whether the flag is enabled for this request. */
  enabled: boolean
  /** A/B test variant if applicable. */
  variant?: string | null
  /** Provider-specific payload (rollout %, targeting rules, etc.). */
  payload?: unknown
}

/**
 * Shape contributed at `ctx.featureFlag` after a successful evaluation.
 *
 * `enabled: true` is encoded in the type — the handler only ever sees this
 * shape when the flag admitted, so `if (!ctx.featureFlag.enabled)` is a dead
 * branch by construction. The contribution shape is the contract this
 * middleware offers downstream handlers.
 */
export interface FeatureFlagContribution {
  /** The flag's name, as passed to `withFeatureFlag`. */
  name: string
  /** Always `true` — this shape is only produced on admission. */
  enabled: true
  /** A/B test variant, if the verdict provided one. */
  variant: string | null
  /** Provider-specific payload, if the verdict provided one. */
  payload: unknown
}

/**
 * Feature-flag middleware.
 *
 * @example
 * ```ts
 * import { withFeatureFlag } from '@supabase/middleware/feature-flag'
 *
 * export default {
 *   fetch: withFeatureFlag(
 *     {
 *       name: 'beta-checkout',
 *       evaluate: (req) => req.headers.get('x-beta') === '1',
 *     },
 *     async (_req, ctx) => Response.json({ feature: ctx.featureFlag.name }),
 *   ),
 * }
 * ```
 *
 * Pluggable providers — use whatever you like in `evaluate`:
 *
 * ```ts
 * withFeatureFlag({
 *   name: 'beta-checkout',
 *   evaluate: async (req) => {
 *     const userId = req.headers.get('x-user-id') ?? 'anon'
 *     return await posthog.isFeatureEnabled('beta-checkout', userId)
 *   },
 * })
 * ```
 */
export const withFeatureFlag: Middleware<
  'featureFlag',
  WithFeatureFlagConfig,
  Record<never, never>,
  FeatureFlagContribution
> = defineMiddleware<
  // 1. Key — the slot this contributes to `ctx`. Must be unique in a stack.
  'featureFlag',
  // 2. Config — what the consumer passes to `withFeatureFlag(config, handler)`.
  WithFeatureFlagConfig,
  // 3. In — upstream prerequisites. `Record<never, never>` = no prerequisites,
  //    so this can be used standalone or anywhere in a stack.
  Record<never, never>,
  // 4. Contribution — the shape that lands at `ctx.featureFlag`.
  FeatureFlagContribution
>({
  key: 'featureFlag',
  /**
   * Two-stage function. The outer `(config) =>` runs once when the consumer
   * constructs the middleware — derive computed config here. The inner
   * `(req, _ctx) =>` runs per request. Anything built from an environment value
   * belongs in the inner stage, constructed lazily on first request: `getEnv`
   * returns `undefined` at construction time on Cloudflare Workers, where
   * bindings arrive per request (see `docs/authoring-guide.md`).
   *
   * Return a `Response` to short-circuit (the inner handler never runs), or a
   * single-key object `{ [key]: contribution }` to fall through. The runtime
   * picks `result[key]` off the contribution and ignores any other fields.
   */
  run: (config) => async (req) => {
    const result = await config.evaluate(req)
    const verdict: FeatureFlagVerdict =
      typeof result === 'boolean' ? { enabled: result } : result

    if (!verdict.enabled) {
      // Short-circuit: return a Response, the inner handler is never invoked.
      return Response.json(
        config.rejectBody ?? { error: 'feature_disabled', flag: config.name },
        { status: config.rejectStatus ?? 404 },
      )
    }

    // Contribute: fall through to the inner handler with this shape on ctx.
    return {
      featureFlag: {
        name: config.name,
        enabled: true,
        variant: verdict.variant ?? null,
        payload: verdict.payload ?? null,
      },
    }
  },
})
