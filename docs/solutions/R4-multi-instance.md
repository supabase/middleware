# R4 — Applying the same middleware twice

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → R4.

## The problem

Each middleware contributes a single fixed key (`'featureFlag'`, …). Gating on two
feature flags meant nesting `withFeatureFlag` twice — and before the type rebuild
that silently compiled and the inner instance **shadowed** the outer on `ctx`
(last-write-wins), dropping the first flag's verdict with no signal.

The type rebuild made the same-key collision a **compile error** (good — no more
silent shadowing). But that left no way to _intentionally_ run the same middleware
twice, which is a legitimate need.

## How it was solved

`defineMiddleware` now attaches an **`.as(newKey)`** method to every middleware it
produces. It returns the same middleware (same config, `run`, prerequisites) whose
contribution lands at `ctx[newKey]` instead of the original key:

```ts
withFeatureFlag(
  { name: 'alpha', evaluate }, // -> ctx.featureFlag
  withFeatureFlag.as('beta')(
    { name: 'beta', evaluate }, //  -> ctx.beta
    async (_req, ctx) =>
      Response.json({ a: ctx.featureFlag.name, b: ctx.beta.name }),
  ),
) satisfies FetchHandler
```

Implementation (`src/core/define-middleware.ts`): the wrapper now distinguishes the
key `run` contributes under (always `spec.key`) from the **target key** the value is
merged onto `ctx`. `.as(k)` rebuilds the middleware with a new target key; the type
`Middleware<Key, …>.as<NewKey>(k): Middleware<NewKey, …>` re-keys the contribution at
the type level too, so `ctx.beta` is typed and the two instances no longer collide.

This is **general** — every `defineMiddleware`-built middleware gets `.as`, so
`featureFlag` stays the simple canonical example (no `as`-in-config plumbing), and the
same mechanism covers rate-limit buckets, per-scope authz checks, etc.

## Verification

`src/core/define-middleware.test.ts`: ".as re-keys a middleware so the same one can be
applied twice" (runtime — both `ctx.featureFlag` and `ctx.beta` present) and ".as gives
two instances distinct, typed keys (no collision)" (tsc-verified under `satisfies
FetchHandler`). `pnpm test` ✅ · `pnpm typecheck` ✅.

## Scope / limits

- Bespoke-typed middleware that don't return the raw `defineMiddleware` value
  (`auth-hook`, `postgres`) don't expose `.as` today; they'd each opt in. The two
  canonical multi-instance cases (`feature-flag`, and any future repeatable
  middleware) are covered.
- `.as` re-keys; it does not let two instances _share_ a collection slot
  (`ctx.flags[name]`). That collection shape remains a separate option if wanted.
