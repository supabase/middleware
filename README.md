# `@supabase/middleware`

Composable, type-safe middleware for Web Fetch handlers.

A **middleware** is a `withFoo` function. Call it with just the config — `withFoo(config)` — to get an **`Entry`**: a typed placeholder that carries the middleware's key, prerequisites, and contribution as phantom types. Pass a flat array of entries to `pipeline` with a final handler; `pipeline` folds the array into nested calls at runtime and every entry's contribution lands on `ctx` in order. No registry, no `app.use()`, no nesting.

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
    async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
  ),
}
```

`pipeline` returns the outermost `(req, ctx) => Response` — **that is the `fetch` handler directly**, no wrapper. When the runtime invokes it, the framework detects a platform argument (Deno's connection info, a Workers `env`) and seeds `ctx._runtime` itself, so platform values never leak into `ctx`. The runtime is detected once at module load. Because everything is plain Web Fetch, the same stack runs unchanged across Deno, Cloudflare Workers, Bun, and Node.

## Install

Not yet published to npm/JSR — install from git. The package builds itself on install via a `prepare` script:

```sh
pnpm add github:supabase/middleware
```

With pnpm, allow the install build in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@supabase/middleware': true
```

## What's in the box

| Import                                  | What it does                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@supabase/middleware`              | `pipeline`, `defineMiddleware`, and the core types: `Entry`, `FetchHandler`, `Middleware`, `Conflict`, `Runtime`, `BaseContext`. |
| `@supabase/middleware/feature-flag` | Provider-agnostic feature flag — admit or short-circuit per request.                                                             |
| `@supabase/middleware/cors`         | CORS — answers preflight and stamps response headers (the worked example of the response seam).                                  |

## How it composes

Each middleware contributes one typed key to `ctx`. Pass entries as a flat array to `pipeline` — first in the array runs first on the request. Add `satisfies FetchHandler` on the `pipeline` call to anchor the types so the handler sees **every** upstream key ambiently:

```ts
import { pipeline, defineMiddleware } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

// A middleware is just a `defineMiddleware` call — bundled or your own.
const withRequestId = defineMiddleware<'requestId', void, Record<never, never>, string>({
  key: 'requestId',
  run: () => async (req) => ({
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
  }),
})

export default {
  fetch: pipeline(
    [
      withRequestId(),    // no config — still returns an Entry
      withFeatureFlag({ name: 'beta', evaluate: (req) => req.headers.has('x-beta') }),
    ],
    async (_req, ctx) => {
      ctx.requestId   //  from withRequestId
      ctx.featureFlag //  from withFeatureFlag
      ctx._runtime    //  seeded automatically — ctx._runtime.getEnv('…'), ctx._runtime.name
      return new Response(null, { status: 200 })
    },
  ) satisfies FetchHandler,
}
```

Two type-level guarantees, with no runtime cost:

- **Collision detection.** Two middleware contributing the same key fail to compile (under the `satisfies FetchHandler` anchor).
- **Prerequisite enforcement.** A middleware can declare upstream keys it needs (e.g. a database middleware that needs `jwtClaims` from an upstream auth middleware). Composing it without that upstream is a type error — it can't be a bare entry. Prerequisite-declared keys type with no anchor required.

### Runtime & environment

The framework seeds `ctx._runtime`, a portable facet middleware use instead of reaching for `Deno.env` / `process.env` / a Workers bindings object directly:

```ts
ctx._runtime.name // 'deno' | 'cloudflare-workers' | 'node' | 'bun' | 'unknown'
ctx._runtime.getEnv('SUPABASE_DB_URL') // string | undefined, resolved per host
```

The host is detected once at module load. On Cloudflare Workers, `getEnv` reads the per-request bindings the runtime passes to `fetch`; elsewhere it reads the host's global (`Deno.env`, `process.env`).

Supported entry signatures are **`(request)`** and **`(request, env)`**. A third `fetch` argument — the Workers `ExecutionContext` (`waitUntil` / `passThroughOnException`) — is **not honored**: it's ignored with a one-time `console.warn`. The Deno target never passes one.

## Request-side by default

A middleware runs **before** the handler. In the common case it never observes the handler's `Response` — no `next()`, no on-the-way-out mutation — so response shape stays under one owner: the handler. Response-side concerns are then plain `Response` work, right where they belong:

- **Errors** — `try/catch` inside the handler.
- **Response headers / envelopes** — shape the `Response` the handler returns.

```ts
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: withFeatureFlag(
    { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
    async (req, ctx) => {
      try {
        const body = await req.json()
        // response headers / envelope — shaped here, by the response's owner
        return Response.json(
          { flag: ctx.featureFlag.name, body },
          { headers: { 'x-powered-by': 'middleware' } },
        )
      } catch {
        return Response.json({ error: 'bad request' }, { status: 400 })
      }
    },
  ),
}
```

When a concern is genuinely two-sided and belongs _inside_ a middleware rather than on the entry, reach for the response seam below.

### The response seam (when a middleware really needs the way out)

Some concerns are irreducibly two-sided — timing, request-spanning cleanup, CORS (preflight in, headers out). For those, write `run` as an **`async function*`** instead of `async`. `yield` is the seam:

```ts
run: (config) =>
  async function* (req, ctx) {
    const start = performance.now() // request phase (before)
    const response = yield { timing: { route: req.url } } // ← contribute, then suspend
    response.headers.set('x-time', `${performance.now() - start}`) // response phase (after)
    return response
  }
```

The `yield` expression resolves to the downstream `Response` (typed as `Response`, inferred — no annotation). `yield` the contribution at most once — `yield` means "run downstream and hand me the response." To short-circuit (handler never runs), `return new Response(...)`, exactly as a plain request-side middleware does. `try/finally` around the `yield` gives request-spanning cleanup; `try/catch` can turn a downstream throw into a `Response`.

This is the **one** place the "request-side" guarantee is relaxed, and writing `function*` is the visible, opt-in signal — the 95% plain-`async` path is unchanged. [`/cors`](./src/middleware/cors/) is the worked example.

## Docs

- [Composition primitives](./src/core/README.md) — `ctx` shape, conflict & prerequisite enforcement, composition rules, the response seam.
- [Authoring guide](./src/middleware/README.md) — write your own middleware with `defineMiddleware` (request-side and generator forms).
- Per-middleware: [feature-flag](./src/middleware/feature-flag/README.md) — the request-side worked example · [cors](./src/middleware/cors/README.md) — the response-seam worked example.

## License

MIT
