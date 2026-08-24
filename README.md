# `@supabase/middleware`

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Package](https://img.shields.io/npm/v/@supabase/middleware)](https://www.npmjs.com/package/@supabase/middleware)
[![pkg.pr.new](https://pkg.pr.new/badge/supabase/middleware)](https://pkg.pr.new/~/supabase/middleware)
[![Docs](https://img.shields.io/badge/docs-supabase.github.io-3ECF8E?logo=readthedocs&logoColor=white)](https://supabase.github.io/middleware/)

Composable, type-safe middleware for Web Fetch handlers.

> **Status: public alpha.** The core engine and API are still settling — expect breaking changes before a stable 1.0. The badge above tracks the current release; follow [releases](https://github.com/supabase/middleware/releases) for changes.

A **middleware** is a `withFoo` function. Call it with just the config — `withFoo(config)` — to get an **`Entry`**: a typed placeholder that carries the middleware's key, prerequisites, and contribution as phantom types. Pass a flat array of entries to `pipeline` with a final handler; `pipeline` folds the array into nested calls at runtime and every entry's contribution lands on `ctx` in order. No registry, no `app.use()`, no nesting.

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
    async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
  ),
}
```

`pipeline` returns the outermost `(req, ctx) => Response` — **that is the `fetch` handler directly**, no wrapper. When the runtime invokes it, the framework detects a platform argument (Deno's connection info, a Workers `env`) and seeds a fresh context itself, so platform values never leak into `ctx` — the Workers env is captured behind the importable `getEnv` instead. Because everything is plain Web Fetch, the same stack runs unchanged across Deno, Cloudflare Workers, Bun, and Node.

## Install

```sh
# npm
npm install @supabase/middleware

# pnpm
pnpm add @supabase/middleware

# Deno / Supabase Edge Functions (no install — import directly)
import { pipeline } from "npm:@supabase/middleware"
```

Also published on [JSR](https://jsr.io/@supabase/middleware):

```sh
deno add jsr:@supabase/middleware
```

### Requirements

- **TypeScript 5.4 or newer.** The published types use [`NoInfer`](https://www.typescriptlang.org/docs/handbook/utility-types.html#noinfertype), a 5.4 intrinsic, to keep the accumulated `ctx` flowing inward through nested middleware. This floor applies to typechecking against the shipped `.d.ts` only — the runtime is plain JavaScript with no TypeScript dependency.
- **Node 22 or newer** on Node (per `engines`). Deno, Bun, and Cloudflare Workers add no floor of their own.

## What's in the box

| Import                              | What it does                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@supabase/middleware`              | `pipeline`, `defineMiddleware`, `getEnv`, `runtimeName`, `seedContext`, `isContext`, and the core types: `Entry`, `FetchHandler`, `Middleware`, `BaseContext`. |
| `@supabase/middleware/feature-flag` | Provider-agnostic feature flag — admit or short-circuit per request.                                                                                           |
| `@supabase/middleware/cors`         | CORS — answers preflight and stamps response headers (the worked example of the response seam).                                                                |

## How it composes

Each middleware contributes one typed key to `ctx`. Pass entries as a flat array to `pipeline` — first in the array runs first on the request. The handler sees **every** upstream key ambiently, typed from the entries array (the `satisfies FetchHandler` below just asserts the result is usable as the `fetch` export):

```ts
import { pipeline, defineMiddleware } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

// A middleware is just a `defineMiddleware` call — bundled or your own.
const withRequestId = defineMiddleware<
  'requestId',
  void,
  Record<never, never>,
  string
>({
  key: 'requestId',
  run: () => async (req) => ({
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
  }),
})

export default {
  fetch: pipeline(
    [
      withRequestId(), // no config — still returns an Entry
      withFeatureFlag({
        name: 'beta',
        evaluate: (req) => req.headers.has('x-beta'),
      }),
    ],
    async (_req, ctx) => {
      ctx.requestId //  from withRequestId
      ctx.featureFlag //  from withFeatureFlag — ctx holds middleware contributions, nothing else
      return new Response(null, { status: 200 })
    },
  ) satisfies FetchHandler,
}
```

Two type-level guarantees, with no runtime cost:

- **Collision detection.** Two middleware contributing the same key fail to compile, with an error naming the key on the offending call. `pipeline` checks this from the entries array. Nested handlers need `satisfies FetchHandler` on the outermost call — one annotation covers any depth — and without it the duplicate compiles silently and the inner contribution wins at runtime.
- **Prerequisite enforcement.** A middleware can declare upstream keys it needs (e.g. a database middleware that needs `jwtClaims` from an upstream auth middleware). Any layer further out can supply them, at any distance and with no annotation, and the contribution's type has to match — not just the key name. If **nothing** supplies it, the stack keeps a _required_ `ctx`, which fails only where it is checked against `FetchHandler`. A bare `export default { fetch: app }` is no such check, so it compiles and throws `TypeError` on the first request — annotate the outermost call with `satisfies FetchHandler` (or put the stack in any `FetchHandler`-typed position) to catch it at build time.

### Composing by nesting

`pipeline` is optional. Every middleware also takes the next handler directly, as `withFoo(config, handler)`. Nesting those calls builds the same handler, with the same accumulation and the same prerequisite enforcement, at any depth.

```ts
import type { FetchHandler } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: withCors(
    {},
    withFeatureFlag(
      { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
      async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
    ),
  ) satisfies FetchHandler,
}
```

Nesting asks one thing of you: keep `satisfies FetchHandler` on the outermost call. That anchor turns on collision detection and the build-time prerequisite check, as the bullets above describe. `ctx` accumulation needs no annotation at any depth.

`FetchHandler` is a type, so importing it adds no runtime code. The [authoring guide](./docs/authoring-guide.md) tells middleware authors to re-export it from their own package. Compose only middleware from packages that do, and your handler file imports nothing from `@supabase/middleware`. Your `package.json` never lists it either. Composition comes free with the middleware themselves.

Past two or three entries, the flat array is easier to read than the nesting it folds into. That is what `pipeline` is for, and why these docs lead with it. Both forms produce the same stack, so pick whichever fits the file.

### Runtime & environment

Environment access is a plain import — middleware never reach for `Deno.env` / `process.env` / a Workers bindings object directly, and `ctx` carries no reserved framework key:

```ts
import { getEnv, runtimeName } from '@supabase/middleware'

getEnv('SUPABASE_DB_URL') // string | undefined, resolved per host
runtimeName // 'node' | 'deno' | 'bun' | 'workerd' | … ('' when unknown) — via std-env
```

Host detection is delegated to [`std-env`](https://github.com/unjs/std-env) (which tracks the WinterCG Runtime Keys proposal), once at module load. On Cloudflare Workers, env bindings are not ambient — they arrive per request as the second `fetch` argument — so the entry call captures them module-scoped and `getEnv` reads them first, falling back to the host's global env (`process.env`, `Deno.env`). One consequence: on Workers, `getEnv` returns `undefined` at module top level, before the first request.

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

Normally the `Response` is shaped by whoever returns it — the handler, as above, or a middleware short-circuiting with one of its own. The response seam below is for the other case: a middleware that has to still be running after the downstream stack finishes — to read or replace the `Response` it returned, to catch what it threw, or just to run cleanup.

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

- [Authoring guide](./docs/authoring-guide.md) — **build your own middleware**: `defineMiddleware`, tests, publishing, and composing it in the same `pipeline` array as the built-in entries.
- [Composition primitives](./src/core/README.md) — `ctx` shape, conflict & prerequisite enforcement, composition rules, the response seam.
- Per-middleware: [feature-flag](./src/middleware/feature-flag/README.md) — the request-side worked example · [cors](./src/middleware/cors/README.md) — the response-seam worked example.

Full generated API reference: [supabase.github.io/middleware](https://supabase.github.io/middleware/).

## License

MIT
