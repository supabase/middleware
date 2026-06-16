# `@supabase/web-middleware`

Composable, type-safe middleware for Web Fetch handlers.

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request`, contributes a typed key to `ctx`, and either short-circuits with a `Response` or falls through to the inner handler. Stack them by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. No registry, no `app.use()`, no separate composer.

Each `withFoo(config, handler)` produces a single `(req, ctx) => Response` function, and **the outermost one is the `fetch` handler directly** — no wrapper. When the runtime invokes it, the middleware detects that the host's second argument is a platform value (Deno's connection info, a Workers `env`) rather than an upstream context and seeds `ctx._runtime` itself, so platform arguments never leak into `ctx`. The runtime is detected once, at module load. Because everything is plain Web Fetch, the same stack runs unchanged across Deno, Cloudflare Workers, Bun, and Node.

```ts
import { withFeatureFlag } from '@supabase/web-middleware/feature-flag'

export default {
  fetch: withFeatureFlag(
    { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
    async (_req, ctx) => Response.json({ variant: ctx.featureFlag.variant }),
  ),
}
```

## Install

```sh
pnpm add @supabase/web-middleware
```

## What's in the box

| Import                                  | What it does                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@supabase/web-middleware`              | The `defineMiddleware` primitive + `Runtime` / `FetchHandler` / `Middleware` / `Conflict` types. |
| `@supabase/web-middleware/feature-flag` | Provider-agnostic feature flag — admit or short-circuit per request.                             |

## How it composes

Each middleware contributes one typed key to `ctx`. Nest them; the inner handler sees the union. Add `satisfies FetchHandler` on the outermost handler to anchor the types so the innermost handler sees **every** upstream key ambiently:

```ts
import { defineMiddleware } from '@supabase/web-middleware'
import type { FetchHandler } from '@supabase/web-middleware'
import { withFeatureFlag } from '@supabase/web-middleware/feature-flag'

// A middleware is just a `defineMiddleware` call — bundled or your own.
const withRequestId = defineMiddleware<
  'requestId',
  undefined,
  Record<never, never>,
  string
>({
  key: 'requestId',
  run: () => async (req) => ({
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
  }),
})

export default {
  fetch: withRequestId(
    undefined,
    withFeatureFlag(
      { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
      async (_req, ctx) => {
        ctx.requestId //  from withRequestId
        ctx.featureFlag // from withFeatureFlag
        ctx._runtime //   seeded automatically — ctx._runtime.getEnv('…'), ctx._runtime.name
        return new Response(null, { status: 200 })
      },
    ),
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

## Request-side only — by design

A middleware here runs **before** the handler and never observes or wraps the handler's `Response`. This is the deliberate difference from Express/Koa's onion model: there's no `next()`, no on-the-way-out response mutation.

So **response-side concerns live in the handler (or a complete middleware), not in framework wrappers.** Each is a plain `Response` operation you already know:

- **Errors** — `try/catch` in your handler, or `.catch()` on the entry: `export default { fetch: (req) => stack(req).catch(onError) }`.
- **Response headers / envelopes (CORS, security headers)** — return the shaped `Response` from your handler, or map it: `(req) => stack(req).then(addHeaders)`. CORS preflight is a request-side `OPTIONS` short-circuit (a normal middleware).

These are one-liners over a `Promise<Response>`; the substrate stays focused on request-side composition rather than shipping wrappers for them.

## Docs

- [Composition primitives](./src/core/README.md) — `ctx` shape, conflict & prerequisite enforcement, composition rules.
- [Authoring guide](./src/middleware/README.md) — write your own middleware with `defineMiddleware`.
- Per-middleware: [feature-flag](./src/middleware/feature-flag/README.md) — the worked example.

## License

MIT
