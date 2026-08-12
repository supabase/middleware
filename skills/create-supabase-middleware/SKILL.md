---
name: create-supabase-middleware
description: Use when creating a new middleware for `@supabase/middleware` — either a built-in inside the middleware repo itself, or a standalone package that anyone can publish. Trigger when the user asks to write, scaffold, or add a middleware; describes a per-request cross-cutting concern they want to reuse ("I want to rate limit", "add request logging", "check an API key on every request"); calls `defineMiddleware`; or adds a new directory under `src/middleware/`. Also trigger when a plan proposes a new middleware, before any file is written.
---

# Creating a middleware

Before scaffolding anything, check the concern is actually middleware-shaped:

- **Response-only** — headers, envelopes, error formatting — belongs in the handler, which owns the response. Not a middleware.
- **Used once, in one handler** — inline it. A middleware earns its keep by being composed across handlers.

Then pick the target by reading the nearest `package.json`:

| `name` is              | You are writing      | Follow                                                                                |
| ---------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `@supabase/middleware` | a built-in           | `src/middleware/README.md` — layout, then the three subpath-wiring files              |
| anything else          | a standalone package | `docs/authoring-guide.md` — the full path, from `defineMiddleware` through publishing |

Both paths use the same `defineMiddleware` primitive; the difference is only whose package it lives in and whether a subpath export has to be wired up.

**Read the guide before writing code, and follow its `## Rules` section** — eight MUST/NEVER items covering one-key-per-middleware, `getEnv` over `process.env`/`Deno.env`, declaring prerequisites in `In`, `yield`ing at most once, and returning a `Response` to short-circuit rather than throwing. Its code blocks labeled with a path are complete files: write them to disk as given rather than adapting them from memory. Unlabeled blocks are fragments that elide with `{ ... }`. Never write those verbatim.

Paths are repo-relative. When `@supabase/middleware` is installed as a dependency, prefix them with `node_modules/@supabase/middleware/`.
