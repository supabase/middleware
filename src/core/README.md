# `@supabase/middleware` (composition primitives)

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request` and contributes its own typed key to `ctx`. Each one produces a single `(req, ctx) => Response` function. Stack middleware by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. **The outermost is the runtime's `fetch` handler directly — no wrapper, no separate composer.**

Everything is plain Web Fetch, so the same stack runs unchanged across every runtime — Deno, Workers, Bun, Node — and inside any framework that can surface a `Request`. When the host invokes the outermost handler, the middleware detects a host-supplied platform argument (vs. an upstream context) and seeds `ctx._runtime` itself.

The package root exports:

- **`defineMiddleware`** — for _authors_ writing a new middleware. See the [authoring guide](../middleware/README.md).
- **`Middleware`** — the type a `defineMiddleware` call produces.
- **`Runtime` / `RuntimeName` / `BaseContext` / `Handler`** — the runtime/context types.
- **`FetchHandler`** — the type-only anchor (`… satisfies FetchHandler`) that turns on ambient accumulation + collision detection on the outermost handler.
- **`Conflict`** — the sentinel type surfaced on a key collision.

## Quick start (consumer)

Pass an array of entries to `pipeline` — first runs first on the request.
`ctx` is inferred from the array; no manual annotation is needed.

```ts
import { pipeline } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: pipeline(
    [
      withCors({}),
      withFeatureFlag({ name: 'beta', evaluate: (req) => req.headers.has('x-beta') }),
    ],
    async (req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
  ),
}
```

Under the hood, `pipeline` folds the array into the same nested calls as
hand-writing `withCors({}, withFeatureFlag({…}, handler))` — there is no new
runtime behavior, just a flat readable form.

## The `ctx` shape

Inside a wrapped handler, `ctx` is a flat intersection — the framework seeds the one reserved `_runtime` facet, and each middleware contributes a typed key:

| Key                                  | Set by                              | Mutability              |
| ------------------------------------ | ----------------------------------- | ----------------------- |
| `ctx._runtime` (`name`, `getEnv`)    | seeded at the entry call (reserved) | read-only               |
| `ctx.<key>` (e.g. `ctx.featureFlag`) | the corresponding middleware        | read-only by convention |

> **Reading the body.** Read it off **`req`** as usual — `req.text()` / `req.json()` /
> `req.arrayBuffer()` / `req.bytes()`. The framework hands every layer a buffered
> request that caches the body after the first read, so a body-verifying middleware
> (e.g. a webhook signature check) and your handler can both read it without "Body already consumed".
> (Reading the raw `req.body` stream or `req.formData()` still consumes once.)

Two type-level guarantees:

- **Collision detection.** If a middleware composes where the upstream already has its key, its `ctx` resolves to a `Conflict<Key>` sentinel string and the stack fails to typecheck. A second apply of the same middleware is a compile error, not a silent overwrite. (Surfaces under the `satisfies FetchHandler` anchor — see below.)
- **Prerequisite enforcement.** Middleware declare the upstream shape they require via `In`. The wrapper constrains `Base extends In & BaseContext`. Composing where the upstream doesn't provide those keys is a type error. A middleware that declares prerequisites can't be a bare entry — it must be nested inside a wrapper that supplies those keys. Prerequisite-declared keys type with **no** anchor required.

> **The anchor.** Cross-middleware dependencies declared via `In` type with zero ceremony. For the innermost handler to _ambiently_ see every upstream key (and for collision detection to fire), annotate the outermost handler with `satisfies FetchHandler` — a type-only anchor that resolves the accumulated `Base`. It adds no runtime code.

## Composition rules

1. **Outer runs first.** Each middleware is a fetch-handler wrapper, so the outermost sees the request first and its contribution appears on `ctx` for everything it wraps. Reverse the order and any inner middleware that declared an outer's key as a prerequisite won't compile.

2. **Either a `Response` or a contribution — not both.** `run` returns either a `Response` (handed back to the caller in place of the inner handler) or a contribution `{ [key]: … }` (fall through). A returned `Response` isn't a "rejection" or error — it can be any status (200, 302, 404, 503, …). By default a middleware doesn't observe the inner handler's response — response-shaped concerns are the handler's job, which keeps each surface small and the response shape under one owner. When a middleware genuinely needs the way out, it opts in via the response seam (below).

## Response seam (generator middleware)

The default `run` is request-side: `async (req, ctx) => Response | contribution`. When a middleware needs to act on the response too — stamp headers, time the request, run cleanup — write `run` as an **`async function*`** instead. `yield` is the seam between the request phase and the response phase:

```ts
run: (config) =>
  async function* (req, ctx) {
    // request phase (before yield)
    const response = yield { myKey: contribution } // suspend; the inner stack runs
    // response phase (after yield) — `response` is the downstream Response, typed
    response.headers.set('x-handled', '1')
    return response // optional; omit to pass the downstream response through
  }
```

- **`yield` only ever means "run downstream, hand me the response."** Yield the contribution `{ [key]: … }` once; the `yield` expression resolves to the downstream **`Response`** (inferred, no annotation). To short-circuit, `return new Response(...)` — same as the request-side path. (Yielding a `Response` also short-circuits, but `return` is the idiomatic spelling; reserve `yield` for the seam.)
- `try { … yield … } finally { … }` runs cleanup even when a downstream layer throws; `try/catch` around the `yield` can turn a downstream throw into a `Response`.
- The runtime picks the path automatically (a plain body returns a `Promise`; a generator body returns an async generator). The plain path is unchanged — there's no cost or API difference unless you write `function*`.

This is the one place the request-side default is relaxed, and `function*` is the visible signal that a middleware reaches into the response. [`cors/`](../middleware/cors/) is the worked example — preflight before the `yield`, header stamping after.

## Threading state through the stack

Each middleware's contribution lands on `ctx` for every middleware and handler
inside it. With `pipeline`, this accumulation is typed from the array — add
`satisfies FetchHandler` on the outermost call to anchor ambient accumulation
and collision detection:

```ts
import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: pipeline(
    [
      withFeatureFlag({ name: 'beta', evaluate: (req) => req.headers.has('x-beta') }),
      withMyMiddleware({ ... }),
    ],
    async (_req, ctx) => {
      ctx._runtime      // seeded at the entry call
      ctx.featureFlag  // from withFeatureFlag
      ctx.myMiddleware // from withMyMiddleware
      return Response.json({ ok: true })
    },
  ) satisfies FetchHandler,
}
```

## API

| Export                                      | Description                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pipeline(entries, handler)`                | Compose a flat array of entries around a handler. Returns a `FetchHandler`.                   |
| `Entry<Key, In, Contribution>`              | Type produced by `mw(config)`. Carries phantom types for `pipeline`'s accumulation.           |
| `defineMiddleware(spec)`                    | Author helper: declare a middleware. Returns a `(config, handler)` callable.                  |
| `FetchHandler`                              | Type-only anchor (`… satisfies FetchHandler`) for ambient accumulation + collision detection. |
| `Conflict<Key>`                             | Sentinel string a middleware's `ctx` resolves to when it would shadow an upstream key.        |
| `Middleware<Key, Config, In, Contribution>` | The shape of a middleware produced by `defineMiddleware`.                                     |
| `Runtime` / `RuntimeName` / `BaseContext`   | The runtime facet at `ctx._runtime`, host names, and the base context type.                   |

## See also

- [Authoring guide](../middleware/README.md) — write your own middleware.
- [`feature-flag/`](../middleware/feature-flag/) — the worked example (request-side).
- [`cors/`](../middleware/cors/) — the worked example of the response seam (`async function*`).
