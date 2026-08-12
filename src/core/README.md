# `@supabase/middleware` (composition primitives)

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request` and contributes its own typed key to `ctx`. Each one produces a single `(req, ctx) => Response` function. Stack middleware by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. **The outermost is the runtime's `fetch` handler directly — no wrapper, no separate composer.**

Everything is plain Web Fetch, so the same stack runs unchanged across every runtime — Deno, Workers, Bun, Node — and inside any framework that can surface a `Request`. When the host invokes the outermost handler, the middleware detects a host-supplied platform argument (vs. an upstream context), seeds a fresh context itself, and captures the platform env behind the importable `getEnv`.

The package root exports:

- **`pipeline` / `Entry`** — flat-array composition for _consumers_: `withFoo(config)` returns an `Entry`, and `pipeline(entries, handler)` folds the array into the nested calls described above. See the quick start below.
- **`defineMiddleware`** — for _authors_ writing a new middleware. See the [authoring guide](../../docs/authoring-guide.md).
- **`Middleware`** — the type a `defineMiddleware` call produces.
- **`getEnv` / `runtimeName`** — portable environment access and the std-env-detected host name.
- **`seedContext`** — mint a marked base context (for hosts embedding the engine).
- **`RuntimeName` / `BaseContext` / `Handler`** — the runtime/context types.
- **`FetchHandler`** — the type of a stack handed to the host (the `fetch` export, `Deno.serve(app)`, …). Annotating the outermost handler with it (`… satisfies FetchHandler`) asserts the stack can be the `fetch` export, and is what turns on collision detection for nested handlers. Accumulation and `In` prerequisites need no annotation.
- **`Conflict` / `NoConflict`** — the sentinel type surfaced on a key collision, and the guard that sites it on the handler parameter.

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
      withFeatureFlag({
        name: 'beta',
        evaluate: (req) => req.headers.has('x-beta'),
      }),
    ],
    async (req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
  ),
}
```

Under the hood, `pipeline` folds the array into the same nested calls as
hand-writing `withCors({}, withFeatureFlag({…}, handler))` — there is no new
runtime behavior, just a flat readable form.

## The `ctx` shape

Inside a wrapped handler, `ctx` is a flat intersection of middleware contributions — the framework reserves no keys (environment access is the importable `getEnv`, not a context facet):

| Key                                  | Set by                       | Mutability              |
| ------------------------------------ | ---------------------------- | ----------------------- |
| `ctx.<key>` (e.g. `ctx.featureFlag`) | the corresponding middleware | read-only by convention |

> **Reading the body.** Read it off **`req`** as usual — `req.text()` / `req.json()` /
> `req.arrayBuffer()` / `req.bytes()` / `req.blob()` / `req.formData()`. The framework hands every layer a buffered
> request that caches the body after the first read, so a body-verifying middleware
> (e.g. a webhook signature check) and your handler can both read it without "Body already consumed".
> (Reading the raw `req.body` stream still consumes once: it bypasses the cache.)

Two type-level guarantees:

- **Collision detection.** If a middleware composes where the upstream already has its key, the handler parameter it is checked against resolves to a `Conflict<Key>` sentinel string and the stack fails to typecheck — the error names the key and lands on the offending call. A second apply of the same middleware is a compile error, not a silent overwrite. `pipeline` checks this from the entries array; nested handlers need `satisfies FetchHandler` on the outermost call — see below.
- **Prerequisite enforcement.** Middleware declare the upstream shape they require via `In`. The wrapper constrains `Base extends In & BaseContext`, so composing where the upstream doesn't provide those keys is a type error — and matching key names alone don't discharge it, the contribution's type has to match too. This needs **no** annotation, at any distance: with no accumulated `Base` to push inward, an unmet prerequisite travels outward instead — each layer that doesn't contribute the key republishes it as its own requirement (the propagation overload on `Middleware`), until some layer does.

  If no layer does, the requirement is still outstanding at the top and the composed stack has a **required** `ctx`. That is not an error by itself — it surfaces only where the stack is checked against `FetchHandler`, whose `ctx` is optional and to which a required one is not assignable. **An untyped `export default { fetch: app }` performs no such check**, so a stack missing its prerequisite entirely compiles clean, ships, and reads `undefined` on the first request:

  ```
  TypeError: Cannot read properties of undefined (reading 'sub')
  ```

  Annotate the outermost call with `satisfies FetchHandler`, or put the stack in any `FetchHandler`-typed position (a typed export, `Deno.serve(app)`, …), to make that a build error instead. Unlike collision detection, the annotation is not the only route here — it is just the one that works at the point of definition.

> **What `satisfies FetchHandler` is for.** Two things only: asserting the stack can be the `fetch` export (above), and **collision detection** for nested handlers. It is _not_ needed for accumulation — an unannotated outermost call resolves `Base` to its constraint, the same empty upstream the annotation would seed, so `ctx` types at any depth either way. Collision detection is the one guarantee nesting doesn't get for free: the produced handler type records the upstream a stack _requires_, never the keys it _contributes_, so an unannotated enclosing call has nothing to check its own key against and a duplicate compiles silently. One annotation on the outermost call covers any depth, and adds no runtime code. `pipeline` has no such gap — prefer it where you can.

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
inside it, typed either way — from the entries array under `pipeline`, from the
inward `Base` cascade when nesting. The `satisfies FetchHandler` below is
therefore an assertion that the stack can be the `fetch` export, not a
requirement for `ctx` to type.

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
      ctx.featureFlag  // from withFeatureFlag
      ctx.myMiddleware // from withMyMiddleware
      return Response.json({ ok: true })
    },
  ) satisfies FetchHandler,
}
```

## API

| Export                                      | Description                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline(entries, handler)`                | Compose a flat array of entries around a handler. Returns a `FetchHandler`.                                                                                                                                                                                 |
| `Entry<Key, In, Contribution>`              | Type produced by `mw(config)`. Carries phantom types for `pipeline`'s accumulation.                                                                                                                                                                         |
| `defineMiddleware(spec)`                    | Author helper: declare a middleware. Returns a `(config, handler)` callable.                                                                                                                                                                                |
| `FetchHandler`                              | The type of a stack handed to the host (the `fetch` export, `Deno.serve(app)`, …). Required for collision detection in nested handlers; also rejects a stack whose `In` prerequisite nobody supplied. Prerequisites between layers are enforced without it. |
| `Conflict<Key>`                             | Sentinel string the handler parameter resolves to when a middleware would shadow an upstream key.                                                                                                                                                           |
| `NoConflict<Key, Base, Handler>`            | The collision check `Middleware` applies — `Handler` when `Key` is free on `Base`, the sentinel when it isn't.                                                                                                                                              |
| `Middleware<Key, Config, In, Contribution>` | The shape of a middleware produced by `defineMiddleware`.                                                                                                                                                                                                   |
| `getEnv(key)` / `runtimeName`               | Portable environment access (platform env first, host env fallback) and the std-env host name.                                                                                                                                                              |
| `seedContext(platformArg?)`                 | Mint a marked base context — for hosts embedding the engine (e.g. `@supabase/server`).                                                                                                                                                                      |
| `RuntimeName` / `BaseContext`               | The std-env host-name union and the base context type.                                                                                                                                                                                                      |

## See also

- [Authoring guide](../../docs/authoring-guide.md) — write your own middleware.
- [`feature-flag/`](../middleware/feature-flag/) — the worked example (request-side).
- [`cors/`](../middleware/cors/) — the worked example of the response seam (`async function*`).
