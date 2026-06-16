# R7 — Authoring drift / non-composing type machinery

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → R7.

## The problem

> **Note:** `auth-hook` was later removed from web-middleware (auth is owned by
> `withSupabase`). The `auth-hook`-specific detail below is historical; the durable
> outcome — **`NoConflict` / `IsAny` are exported from core** for any third-party
> middleware with a bespoke generic signature — still stands.

When a middleware needs a bespoke generic signature — e.g. `auth-hook` adds a
`Payload` type parameter on top of what `defineMiddleware` produces — the author had
to **hand-copy the core's collision machinery**: `auth-hook` reimplemented `IsAny`
and a `NoAuthHookConflict` clone of the core `NoConflict`. That copy is a maintenance
hazard: a fix to the core conflict logic would silently not reach the copy.

## How it was solved

The core now **exports** its conflict-detection types (`src/core/define-middleware.ts`,
re-exported from the package root):

```ts
export type IsAny<T> = …
export type NoConflict<Key extends string, Base> = …
```

`auth-hook` now imports `NoConflict` and uses it directly
(`src/middleware/auth-hook/with-auth-hook.ts`):

```ts
// before: a hand-copied IsAny + NoAuthHookConflict<Base>
// after:
Base extends BaseContext & NoConflict<'authHook', Base> = BaseContext
```

The hand-copied `IsAny` / `NoAuthHookConflict` are deleted. Any middleware with a
bespoke generic signature now reuses the single source of truth.

## Verification

`pnpm typecheck` ✅ · `pnpm test` (50 pass) ✅ · `pnpm lint` ✅. The auth-hook
composition tests (and the core type-guarantee tests that exercise `NoConflict`)
continue to pass against the shared helper.

## Scope / limits (the rest of R7, intentionally deferred)

R7 listed three rough edges; this commit fixes the one with a real correctness/drift
risk (the hand-copied machinery). The other two are left as-is, deliberately:

- **`Contribution` not inferred from `run`.** `defineMiddleware<Key, Config, In,
Contribution>` still takes `Contribution` explicitly. Inferring it from `run`'s
  return would remove a source of drift but is a larger core-type change with its own
  trade-offs (the explicit type also documents the contract). Deferred.
- **Four order-sensitive type params + the `postgres` `as unknown` bridge.** The
  `postgres` cast exists to narrow the contribution per-config (`admin: true` adds
  `adminDb`); it's isolated and covered by tests. Not worth a speculative redesign.

These are ⚪ author-DX papercuts, not defects — tracked, not blocking.
