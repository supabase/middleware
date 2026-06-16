# `@supabase/web-middleware` (composition primitives)

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request` and contributes its own typed key to `ctx`. Stack middleware by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. No separate composer.

Every middleware is a plain `(req, ctx) => Response` wrapper over the Web Fetch API, so the same one runs unchanged across every runtime — Workers, Deno, Bun, Node — and inside any framework that can surface a `Request`.

The package root exports:

- **`defineMiddleware`** — for _authors_ writing a new middleware. See the [authoring guide](../middleware/README.md).
- **`Middleware`** — the type a `defineMiddleware` call produces (for referring to an arbitrary middleware's type).
- **`Conflict`** — the sentinel type surfaced on a key collision.

## Quick start (consumer)

```ts
import { withFeatureFlag } from '@supabase/web-middleware/feature-flag'

export default {
  fetch: withFeatureFlag(
    { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
    async (req, ctx) => Response.json({ variant: ctx.featureFlag.variant }),
  ),
}
```

## The `ctx` shape

Inside a wrapped handler, `ctx` is a flat intersection — each middleware contributes a typed key:

| Key                                                  | Set by                       | Mutability              |
| ---------------------------------------------------- | ---------------------------- | ----------------------- |
| `ctx.<key>` (e.g. `ctx.featureFlag`, `ctx.postgres`) | the corresponding middleware | read-only by convention |

Two type-level guarantees:

- **Collision detection.** If a middleware tries to compose where the upstream already has its key, the call returns a `Conflict<Key>` sentinel string. Using the result where a fetch handler is expected fails to typecheck — the error surfaces at the offending call site.
- **Prerequisite enforcement.** Middleware declare the upstream shape they require via `In`. The wrapper constrains `Base extends In`. Composing where the upstream doesn't provide those keys is a type error. A middleware that declares prerequisites can't be the top-level handler — it must be nested inside a wrapper that supplies those keys.

## Composition rules

1. **Outer runs first.** Each middleware is a fetch-handler wrapper, so the outermost sees the request first and its contribution appears on `ctx` for everything it wraps. Reverse the order and any inner middleware that declared an outer's key as a prerequisite won't compile.

2. **Either a `Response` or a contribution — not both.** `run` returns either a `Response` (handed back to the caller in place of the inner handler) or a contribution `{ [key]: … }` (fall through). A returned `Response` isn't a "rejection" or error — it can be any status (200, 302, 404, 503, …). Middleware don't observe or wrap the inner handler's response either. Anything response-shaped — CORS, rate-limit headers, response envelopes — is the handler's (or an outer wrapper's) job. This keeps each middleware's surface small and the response shape under one owner.

## Threading state through nested middleware

When a middleware is wrapped by another, the outer's keys land on `Base` for the inner. TypeScript infers `Base` through the nested fetch-handler signatures, so the handler sees the full accumulated `ctx` without explicit annotations:

```ts
withFeatureFlag(
  { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
  withMyMiddleware({ ... }, async (_req, ctx) => {
    ctx.featureFlag  // from withFeatureFlag
    ctx.myMiddleware // from withMyMiddleware
    return Response.json({ ok: true })
  }),
)
```

## API

| Export                                      | Description                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `defineMiddleware(spec)`                    | Author helper: declare a middleware. Returns a `(config, handler)` callable. |
| `Conflict<Key>`                             | Sentinel string returned when a middleware would shadow an upstream key.     |
| `Middleware<Key, Config, In, Contribution>` | The shape of a middleware produced by `defineMiddleware`.                    |

## See also

- [Authoring guide](../middleware/README.md) — write your own middleware.
- [`feature-flag/`](../middleware/feature-flag/) — the worked example.
