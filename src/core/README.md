# `@supabase/web-middleware` (composition primitives)

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request` and contributes its own typed key to `ctx`. Each one produces a single `(req, ctx) => Response` function. Stack middleware by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. **The outermost is the runtime's `fetch` handler directly — no wrapper, no separate composer.**

Everything is plain Web Fetch, so the same stack runs unchanged across every runtime — Deno, Workers, Bun, Node — and inside any framework that can surface a `Request`. When the host invokes the outermost handler, the middleware detects a host-supplied platform argument (vs. an upstream context) and seeds `ctx._runtime` itself.

The package root exports:

- **`defineMiddleware`** — for _authors_ writing a new middleware. See the [authoring guide](../middleware/README.md).
- **`Middleware`** — the type a `defineMiddleware` call produces.
- **`Runtime` / `RuntimeName` / `BaseContext` / `Handler`** — the runtime/context types.
- **`FetchHandler`** — the type-only anchor (`… satisfies FetchHandler`) that turns on ambient accumulation + collision detection on the outermost handler.
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

Inside a wrapped handler, `ctx` is a flat intersection — the framework seeds the one reserved `_runtime` facet, and each middleware contributes a typed key:

| Key                                                  | Set by                              | Mutability              |
| ---------------------------------------------------- | ----------------------------------- | ----------------------- |
| `ctx._runtime` (`name`, `getEnv`)                    | seeded at the entry call (reserved) | read-only               |
| `ctx.<key>` (e.g. `ctx.featureFlag`, `ctx.postgres`) | the corresponding middleware        | read-only by convention |

> **Reading the body.** Read it off **`req`** as usual — `req.text()` / `req.json()` /
> `req.arrayBuffer()` / `req.bytes()`. The framework hands every layer a buffered
> request that caches the body after the first read, so a body-verifying middleware
> (`auth-hook`) and your handler can both read it without "Body already consumed".
> (Reading the raw `req.body` stream or `req.formData()` still consumes once.)

Two type-level guarantees:

- **Collision detection.** If a middleware composes where the upstream already has its key, its `ctx` resolves to a `Conflict<Key>` sentinel string and the stack fails to typecheck. A second apply of the same middleware is a compile error, not a silent overwrite. (Surfaces under the `satisfies FetchHandler` anchor — see below.)
- **Prerequisite enforcement.** Middleware declare the upstream shape they require via `In`. The wrapper constrains `Base extends In & BaseContext`. Composing where the upstream doesn't provide those keys is a type error. A middleware that declares prerequisites can't be a bare entry — it must be nested inside a wrapper that supplies those keys. Prerequisite-declared keys type with **no** anchor required.

> **The anchor.** Cross-middleware dependencies declared via `In` type with zero ceremony. For the innermost handler to _ambiently_ see every upstream key (and for collision detection to fire), annotate the outermost handler with `satisfies FetchHandler` — a type-only anchor that resolves the accumulated `Base`. It adds no runtime code.

## Composition rules

1. **Outer runs first.** Each middleware is a fetch-handler wrapper, so the outermost sees the request first and its contribution appears on `ctx` for everything it wraps. Reverse the order and any inner middleware that declared an outer's key as a prerequisite won't compile.

2. **Either a `Response` or a contribution — not both.** `run` returns either a `Response` (handed back to the caller in place of the inner handler) or a contribution `{ [key]: … }` (fall through). A returned `Response` isn't a "rejection" or error — it can be any status (200, 302, 404, 503, …). Middleware don't observe or wrap the inner handler's response either. Anything response-shaped — CORS, rate-limit headers, response envelopes — is the handler's (or an outer wrapper's) job. This keeps each middleware's surface small and the response shape under one owner.

## Threading state through nested middleware

When a middleware is wrapped by another, the outer's keys land on `Base` for the inner. TypeScript infers `Base` through the nested single-signature handlers — anchored at the top by `satisfies FetchHandler` — so the handler sees the full accumulated `ctx`:

```ts
import type { FetchHandler } from '@supabase/web-middleware'

export default {
  fetch: withFeatureFlag(
    { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
    withMyMiddleware({ ... }, async (_req, ctx) => {
      ctx._runtime      // seeded at the entry call
      ctx.featureFlag  // from withFeatureFlag
      ctx.myMiddleware // from withMyMiddleware
      return Response.json({ ok: true })
    }),
  ) satisfies FetchHandler,
}
```

## API

| Export                                      | Description                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `defineMiddleware(spec)`                    | Author helper: declare a middleware. Returns a `(config, handler)` callable.                  |
| `withCatch(onError, handler)`               | Opt-in error boundary: contains downstream throws behind a `Response` you define.             |
| `FetchHandler`                              | Type-only anchor (`… satisfies FetchHandler`) for ambient accumulation + collision detection. |
| `Conflict<Key>`                             | Sentinel string a middleware's `ctx` resolves to when it would shadow an upstream key.        |
| `Middleware<Key, Config, In, Contribution>` | The shape of a middleware produced by `defineMiddleware`.                                     |
| `Runtime` / `RuntimeName` / `BaseContext`   | The runtime facet at `ctx._runtime`, host names, and the base context type.                   |

## See also

- [Authoring guide](../middleware/README.md) — write your own middleware.
- [`feature-flag/`](../middleware/feature-flag/) — the worked example.
