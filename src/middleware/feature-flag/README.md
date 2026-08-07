# `@supabase/middleware/feature-flag`

Provider-agnostic feature-flag middleware. Pass any `evaluate` function — it's called per request, admits when the flag is on, rejects otherwise. Use it with PostHog, LaunchDarkly, Statsig, an env-var, a header, a database row — anything that can answer "is this flag enabled for this request?".

> This is the worked example for authors. The implementation is short and well-commented — read [`with-feature-flag.ts`](./with-feature-flag.ts) alongside the [authoring guide](../../../docs/authoring-guide.md) to see how each piece of `defineMiddleware` lands in practice.

```ts
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: withFeatureFlag(
    {
      name: 'beta-checkout',
      evaluate: (req) => req.headers.get('x-beta') === '1',
    },
    async (_req, ctx) => Response.json({ feature: ctx.featureFlag.name }),
  ),
}
```

## Config

| Field          | Type                                                                               | Description                                                                        |
| -------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `name`         | `string`                                                                           | Recorded in `ctx.featureFlag.name` and the default rejection body.                 |
| `evaluate`     | `(req) => boolean \| FeatureFlagVerdict \| Promise<boolean \| FeatureFlagVerdict>` | Decide whether the flag is enabled for this request.                               |
| `rejectStatus` | `number?`                                                                          | Status when the flag rejects. Default `404` (soft reveal).                         |
| `rejectBody`   | `unknown?`                                                                         | Body when the flag rejects. Default `{ error: 'feature_disabled', flag: <name> }`. |

## Returning richer verdicts

`evaluate` can return a verdict object to capture variant or payload:

```ts
withFeatureFlag({
  name: 'pricing-experiment',
  evaluate: async (req) => {
    const variant = await ld.variation('pricing-experiment', userKey, 'control')
    return { enabled: variant !== 'off', variant, payload: { rollout: 0.5 } }
  },
})
```

Then the handler reads:

```ts
ctx.featureFlag.variant // 'a' | 'b' | 'control' | null
ctx.featureFlag.payload // anything you returned
```

## Why 404 by default

Soft reveal. A `403 Forbidden` tells the caller "this exists, but you can't see it" — useful intel for an attacker probing for unreleased endpoints. `404 Not Found` says "there's nothing here." Override via `rejectStatus` if you need stricter or different semantics.

## Single namespace caveat

The middleware occupies `ctx.featureFlag` — only one `withFeatureFlag` can compose into a stack at a time. For multiple flags on the same route, write a single composite evaluator that returns a richer verdict, or run separate routes per flag.

## See also

- [Authoring guide](../../../docs/authoring-guide.md)
- [Composition primitives](../../core/README.md)
