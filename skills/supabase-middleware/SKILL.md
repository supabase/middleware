---
name: supabase-middleware
description: Use when writing or modifying a Web Fetch handler that composes cross-cutting concerns with `@supabase/middleware` — CORS, feature flags, auth, rate limiting, logging — on Deno, Supabase Edge Functions, Cloudflare Workers, Bun, or Node. Trigger **before** writing or editing any file that imports from `@supabase/middleware` or a subpath (`/cors`, `/feature-flag`); calls `pipeline`, `defineMiddleware`, `getEnv`, `runtimeName`, or `seedContext`; or annotates a handler with `satisfies FetchHandler`. Also trigger during planning — if a plan mentions any of the above, load this skill before drafting code. Also trigger when porting middleware idioms that do not apply here: `app.use()` registries, `next()` chains, Express/Koa/Hono middleware being translated, or hand-rolled `(req) => wrapper(wrapper(handler))` nesting.
---

# @supabase/middleware

Composable, type-safe middleware for Web Fetch handlers. The same stack runs unchanged on Deno, Supabase Edge Functions, Cloudflare Workers, Bun, and Node.

> **This package is new.** There are no blog posts, Stack Overflow answers, or tutorials about it. Do not search the web for usage examples — read the docs routed below and the source.

## Not to be confused with

| Package                | Use it for                                                           |
| ---------------------- | -------------------------------------------------------------------- |
| `@supabase/middleware` | Composing per-request concerns around a Web Fetch handler.           |
| `@supabase/server`     | Supabase auth and client creation on the server. Embeds this engine. |
| `@supabase/ssr`        | Cookie-based session handling in SSR frameworks.                     |

Reaching for `@supabase/ssr` or `@supabase/server` when the task is composition — or for this package when the task is Supabase auth — is the most common mistake. They are complementary, not alternatives.

## The model, in one example

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

`withFoo(config)` returns an **`Entry`**. `pipeline` folds a flat array of entries around a handler and returns the `fetch` handler itself — first in the array runs first on the request. Each entry contributes one typed key to `ctx`, and the handler sees every upstream key, typed.

`withFoo(config, handler)` skips `pipeline`: middleware nest directly and produce the same stack. Anchor the outermost call with `satisfies FetchHandler`. The anchor turns on collision detection and the build-time prerequisite check. A file that composes only middleware from other packages needs no import from `@supabase/middleware`, because those packages re-export the type. Both forms are correct. Do not rewrite one into the other unasked.

**No registry, no `app.use()`, no `next()`.** If you are writing any of those, you are using the wrong model — read `src/core/README.md` before continuing.

## Read before writing code

Paths are repo-relative. When `@supabase/middleware` is installed as a dependency, prefix them with `node_modules/@supabase/middleware/` — the same files ship in the package.

| Question                                                               | Doc                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| How do I compose a stack? What is on `ctx`?                            | `src/core/README.md`                                                     |
| When is `satisfies FetchHandler` required, and what breaks without it? | `src/core/README.md`                                                     |
| A middleware needs to see the response too                             | `src/core/README.md` (response seam), `src/middleware/cors/README.md`    |
| How do I write and publish my own middleware?                          | `docs/authoring-guide.md`, and the `create-supabase-middleware` skill    |
| How do I add a built-in to this repo?                                  | `src/middleware/README.md`                                               |
| Environment access, runtime differences, Workers `env`                 | `README.md`                                                              |
| Config for the bundled middleware                                      | `src/middleware/feature-flag/README.md`, `src/middleware/cors/README.md` |
| Full API reference                                                     | <https://supabase.github.io/middleware/>                                 |

Release history and current status: <https://github.com/supabase/middleware/releases>.
