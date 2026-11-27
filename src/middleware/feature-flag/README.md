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

| Field          | Type                                                                                    | Description                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `name`         | `string`                                                                                | Recorded in `ctx.featureFlag.name` and the default rejection body.                           |
| `evaluate`     | `(req, ctx) => boolean \| FeatureFlagVerdict \| Promise<boolean \| FeatureFlagVerdict>` | Decide whether the flag is enabled for this request. `ctx` holds the upstream contributions. |
| `rejectStatus` | `number?`                                                                               | Status when the flag rejects. Default `404` (soft reveal).                                   |
| `rejectBody`   | `unknown?`                                                                              | Body when the flag rejects. Default `{ error: 'feature_disabled', flag: <name> }`.           |

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

## Targeting the verified caller

`evaluate` receives the context accumulated by the entries placed before it. A flag composed after an auth middleware can read the caller that middleware verified, with no second lookup of its own. Annotate the keys it reads:

```ts
pipeline(
  [
    withUser(),
    withFeatureFlag({
      name: 'beta-checkout',
      evaluate: (_req, ctx: { user: { id: string } }) =>
        betaTesters.has(ctx.user.id),
    }),
  ],
  handler,
)
```

The annotation is a prerequisite of that call, checked like any other. Without `withUser` before the flag, the stack fails to compile:

```
middleware-prereq: key 'user' is not yet on the context (check ordering)
```

Nesting checks it too: `withUser(withFeatureFlag(config, handler))` compiles, and the same flag with no `withUser` around it fails where the stack is checked against `FetchHandler`. When the flag also works without the key, mark it optional (`ctx: { user?: { id: string } }`) and handle its absence. Unannotated, `ctx` is `BaseContext` (`object`), or the enclosing context when the flag is nested in an anchored stack.

## Why 404 by default

Soft reveal. A `403 Forbidden` tells the caller "this exists, but you can't see it" — useful intel for an attacker probing for unreleased endpoints. `404 Not Found` says "there's nothing here." Override via `rejectStatus` if you need stricter or different semantics.

## Single namespace caveat

The middleware occupies `ctx.featureFlag` — only one `withFeatureFlag` can compose into a stack at a time. For multiple flags on the same route, write a single composite evaluator that returns a richer verdict, or run separate routes per flag.

## See also

- [Authoring guide](../../../docs/authoring-guide.md)
- [Composition primitives](../../core/README.md)
