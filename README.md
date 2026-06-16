# `@supabase/web-middleware`

Composable, type-safe middleware for Web Fetch handlers.

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request`, contributes a typed key to `ctx`, and either short-circuits with a `Response` or falls through to the inner handler. Stack them by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. No registry, no `app.use()`, no separate composer.

Each `withFoo(config, handler)` produces a single `(req, ctx) => Response` function, and **the outermost one is the `fetch` handler directly** — no wrapper. When the runtime invokes it, the middleware detects that the host's second argument is a platform value (Deno's connection info, a Workers `env`) rather than an upstream context and seeds `ctx.runtime` itself, so platform arguments never leak into `ctx`. The runtime is detected once, at module load. Because everything is plain Web Fetch, the same stack runs unchanged across Deno, Cloudflare Workers, Bun, and Node.

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

| Import                                  | What it does                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@supabase/web-middleware`              | The `defineMiddleware` primitive, `withCatch` + `Runtime` / `FetchHandler` / `Middleware` / `Conflict` types. |
| `@supabase/web-middleware/auth`         | Verify a Supabase JWT (HS256) → `ctx.jwtClaims`. The upstream `withPostgres` needs.                           |
| `@supabase/web-middleware/feature-flag` | Provider-agnostic feature flag — admit or short-circuit per request.                                          |
| `@supabase/web-middleware/auth-hook`    | Verify a Supabase Auth Hook's Standard Webhooks signature.                                                    |
| `@supabase/web-middleware/postgres`     | RLS-scoped (and optional RLS-bypassing) Postgres client. Node/Deno.                                           |

## How it composes

Each middleware contributes one typed key to `ctx`. Nest them; the inner handler sees the union. Add `satisfies FetchHandler` on the outermost handler to anchor the types so the innermost handler sees **every** upstream key ambiently:

```ts
import type { FetchHandler } from '@supabase/web-middleware'
import { withAuthHook } from '@supabase/web-middleware/auth-hook'
import { withFeatureFlag } from '@supabase/web-middleware/feature-flag'

export default {
  fetch: withFeatureFlag(
    { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
    withAuthHook({ secret: 'whsec_…' }, async (_req, ctx) => {
      ctx.featureFlag // from withFeatureFlag
      ctx.authHook //   from withAuthHook
      ctx.runtime //    seeded automatically — ctx.runtime.getEnv('…'), ctx.runtime.name
      return new Response(null, { status: 200 })
    }),
  ) satisfies FetchHandler,
}
```

Two type-level guarantees, with no runtime cost:

- **Collision detection.** Two middleware contributing the same key fail to compile (under the `satisfies FetchHandler` anchor).
- **Prerequisite enforcement.** A middleware can declare upstream keys it needs (e.g. `withPostgres` needs `jwtClaims`). Composing it without that upstream is a type error — it can't be a bare entry. Prerequisite-declared keys type with no anchor required.

### Runtime & environment

The framework seeds `ctx.runtime`, a portable facet middleware use instead of reaching for `Deno.env` / `process.env` / a Workers bindings object directly:

```ts
ctx.runtime.name // 'deno' | 'cloudflare-workers' | 'node' | 'bun' | 'unknown'
ctx.runtime.getEnv('SUPABASE_DB_URL') // string | undefined, resolved per host
```

The host is detected once at module load. On Cloudflare Workers, `getEnv` reads the per-request bindings the runtime passes to `fetch`; elsewhere it reads the host's global (`Deno.env`, `process.env`).

## Request-side only — by design

A middleware here runs **before** the handler and never observes or wraps the handler's `Response`. This is the deliberate difference from Express/Koa's onion model: there's no `next()`, no on-the-way-out response mutation. Anything response-shaped — CORS headers, response envelopes, rate-limit headers — belongs in an outer wrapper or the handler itself, so the response shape stays under one owner and each middleware's surface stays small.

## Docs

- [Composition primitives](./src/core/README.md) — `ctx` shape, conflict & prerequisite enforcement, composition rules.
- [Authoring guide](./src/middleware/README.md) — write your own middleware with `defineMiddleware`.
- Per-middleware: [feature-flag](./src/middleware/feature-flag/README.md) · [auth-hook](./src/middleware/auth-hook/README.md) · [postgres](./src/middleware/postgres/README.md)

## License

MIT
