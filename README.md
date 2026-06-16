# `@supabase/web-middleware`

Composable, type-safe middleware for Web Fetch handlers.

A **middleware** is a `(config, handler)` wrapper — `withFoo(config, handler)` — that runs against the inbound `Request`, contributes a typed key to `ctx`, and either short-circuits with a `Response` or falls through to the inner handler. Stack them by direct nesting; the innermost handler sees a flat `ctx` aggregated from every wrapper around it. No registry, no `app.use()`, no separate composer.

Because every middleware is a plain `(req, ctx) => Response` wrapper over the Web Fetch API, the same middleware runs unchanged across every runtime — Cloudflare Workers, Deno, Bun, Node — and inside any framework that can hand you a `Request`.

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

| Import                                  | What it does                                                         |
| --------------------------------------- | -------------------------------------------------------------------- |
| `@supabase/web-middleware`              | The `defineMiddleware` primitive + `Middleware` / `Conflict` types.  |
| `@supabase/web-middleware/feature-flag` | Provider-agnostic feature flag — admit or short-circuit per request. |
| `@supabase/web-middleware/auth-hook`    | Verify a Supabase Auth Hook's Standard Webhooks signature.           |
| `@supabase/web-middleware/postgres`     | RLS-scoped (and optional RLS-bypassing) Postgres client. Node/Deno.  |

## How it composes

Each middleware contributes one typed key to `ctx`. Nest them; the inner handler sees the union:

```ts
import { withAuthHook } from '@supabase/web-middleware/auth-hook'
import { withFeatureFlag } from '@supabase/web-middleware/feature-flag'

withFeatureFlag(
  { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
  withAuthHook({ secret: process.env.HOOK_SECRET! }, async (_req, ctx) => {
    ctx.featureFlag // from withFeatureFlag
    ctx.authHook //   from withAuthHook
    return new Response(null, { status: 200 })
  }),
)
```

Two type-level guarantees fall out of the design, with no runtime cost:

- **Collision detection.** Two middleware contributing the same key fail to compile, at the offending call site.
- **Prerequisite enforcement.** A middleware can declare upstream keys it needs (e.g. `withPostgres` needs `jwtClaims`). Composing it without that upstream is a type error — it can't be the outermost handler.

## Request-side only — by design

A middleware here runs **before** the handler and never observes or wraps the handler's `Response`. This is the deliberate difference from Express/Koa's onion model: there's no `next()`, no on-the-way-out response mutation. Anything response-shaped — CORS headers, response envelopes, rate-limit headers — belongs in an outer wrapper or the handler itself, so the response shape stays under one owner and each middleware's surface stays small.

## Docs

- [Composition primitives](./src/core/README.md) — `ctx` shape, conflict & prerequisite enforcement, composition rules.
- [Authoring guide](./src/middleware/README.md) — write your own middleware with `defineMiddleware`.
- Per-middleware: [feature-flag](./src/middleware/feature-flag/README.md) · [auth-hook](./src/middleware/auth-hook/README.md) · [postgres](./src/middleware/postgres/README.md)

## License

MIT
