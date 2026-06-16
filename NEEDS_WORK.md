# NEEDS_WORK

Open concerns about `@supabase/web-middleware` — in concept and implementation —
beyond the resolved R1–R9 audit (see [`API_RISK_PROFILE.md`](./API_RISK_PROFILE.md)).

**Context.** [`supabase/server`](https://github.com/supabase/server) implements
`withSupabase` and may migrate onto web-middleware, contributing a single
`ctx.supabase` (its current bag of utils). That sharpens the layering: web-middleware
is the **substrate**; `withSupabase` is a **consumer** middleware. Several concerns
below are therefore `withSupabase`'s to own, not core's.

Status key: 🟥 needs work · 🟩 resolved · 🟦 by design · 🟪 owned by `withSupabase`.

---

## 1 & 3. Response-shaping (CORS, headers) and error containment — 🟩 resolved (out of scope)

Was: request-side-only meant CORS / response headers / envelopes / error boundaries
couldn't be expressed _as middleware_. We briefly shipped `withResponse` and
`withCatch` wrappers — then **removed both**.

**Disposition: not the substrate's job.** Those wrappers were near-empty
`Promise<Response>` decorators (`.then` / `.catch`) with no composition machinery — if
you write a complete middleware/handler, it owns its own errors and response shape, so
the wrappers are extraneous. The substrate stays focused on request-side composition:

- **Errors** → `try/catch` in the handler, or `stack(req).catch(onError)` at the entry.
- **Response headers / envelopes (CORS, …)** → return the shaped `Response`, or
  `stack(req).then(transform)`; CORS preflight is a request-side `OPTIONS` short-circuit.

Documented in the README's "Request-side only" section. (A richer `finalize(res, ctx)`
channel that exposes a middleware's `ctx` on the way out remains conceivable, but it
edges toward the onion model the design excludes — not built.)

## 6. `bufferRequest` proxy sharp edges — 🟩 resolved (one documented limit)

Was: only `arrayBuffer` / `bytes` / `blob` / `text` / `json` were cached, so
`req.formData()` and `req.clone()` after an upstream read threw `Body already
consumed`.

**Disposition (done): we don't want sharp edges that might hurt consumers.**
Implemented (`runtime.ts`):

- **`formData()`** now reads from the cached bytes
  (`new Response(await arrayBuffer(), { headers: req.headers }).formData()`), so a
  form-encoded POST survives an upstream read.
- **`clone()`** returns another handle over the same cache — reading either yields
  the same body; `headers`/`url`/`method`/… forward to the real request.
- Tests: form POST read by a middleware then `req.formData()` in the handler; clone
  reads the same cached body.

**One deliberate, documented limit:** reading the raw `req.body` _stream_ (e.g.
passing the request to `fetch()` to forward it) bypasses the cache — this is a
buffering model, not streaming. To forward the body, reconstruct it from
`await req.arrayBuffer()`. Documented in the `bufferRequest` JSDoc.

## Minor — 🟥 needs work

- **`src/env.d.ts` scope.** Core runtime code reads globals via `globalThis` casts,
  so the ambient `Deno` / `process` declarations are unused by `src` — but the
  **tests** still rely on them (`process.env` in the postgres + runtime tests). So
  it's not dead; it could be replaced by `@types/node` + Deno's lib in a test
  tsconfig if we want `src` and tests to stop sharing an ambient global. Low priority.
- **Public-API surface test** — 🟩 done (`src/exports.test.ts` asserts the value
  exports of every entry point).
- **`isContext` runtime trap (JS-land only).** Invoking a handler directly with a
  partial `ctx` lacking `_runtime` is re-seeded as if it were a platform arg, silently
  dropping the supplied keys. Type-caught in TS (`Base extends BaseContext`). **No
  clean runtime fix** — a host `env` is also a plain object without `_runtime`, so a
  guard can't distinguish "user passed a partial ctx" from "host passed env" without
  false-positives. Left as a documented TS-caught caveat.
- **Body-size limit on `bufferRequest`** — _not a distinct risk._ The body is only
  buffered when a layer reads it, and reading a body buffers it natively anyway; the
  cache just holds the bytes slightly longer. No guard needed beyond the streaming
  note already documented.

---

## 5. Third `fetch` argument (Workers `ExecutionContext`) — 🟩 resolved

Was: tension between supporting Workers `env` (arg 2) and throwing on arg 3 (which
Workers always passes), making the Cloudflare `getEnv` path unreachable.

**Disposition (done): note that the 3rd arg won't be honored via `console.warn`
instead of throwing.** Implemented — the entry now warns once and proceeds, ignoring
the execution context. Workers requests serve again (so the arg-2 `env` path is
reachable), and `waitUntil` is simply not honored. (`define-middleware.ts`.)

## 7. "Runs unchanged across every runtime" was overstated — 🟩 resolved (via #5)

With #5 (warn instead of throw), Workers is no longer blocked, so the cross-runtime
claim holds. With the `postgres` middleware also extracted (below), the core package
ships only Fetch-standard code with no `pg` — it is now **fully edge-portable**, no
per-subpath runtime caveats.

---

## 2. Prerequisite trust model is implicit — 🟦 by design (moved with postgres)

A `jwtClaims`-consuming middleware trusts any upstream that structurally provides the
key; there's no guarantee the claims came from real verification. **Disposition
(accepted): all middleware being trusted is reasonable.** This now applies to
`@supabase/server/postgres` (where `withPostgres` moved) and any third-party
`In: { jwtClaims }` middleware — a one-line security note in that package, no core
change.

---

## 3 & 4. Auth / JWT verification — 🟩 resolved (dropped from core)

The bundled `/auth` (`withAuth`, HS256-only) and `/auth-hook` middleware have been
**removed from web-middleware**. Auth/JWT verification — algorithm support (HS256 vs
asymmetric/JWKS), key fetching, anon-vs-error semantics, and Supabase Auth Hooks — is
Supabase-specific and is owned by `withSupabase` (the `supabase/server` migration,
which already does this with `jose`). web-middleware stays the auth-agnostic substrate:
a downstream DB middleware (now `@supabase/server/postgres` — see below) declares
`In: { jwtClaims }`, and the consumer's auth middleware (e.g. `withSupabase`)
contributes it.

## 8. `postgres` middleware extracted — 🟩 resolved (moved out)

`withPostgres` (raw `pg`, RLS-scoped) was Supabase-specific and Node/Deno-only — the
last non-generic thing in the substrate. It has been **removed from web-middleware and
moved to `@supabase/server/postgres`** (built on web-middleware's `defineMiddleware`,
isolated subpath with `pg` as an optional peer). web-middleware now ships only the
generic substrate: `defineMiddleware`, the `Runtime` facet (`ctx._runtime`), the
buffered request, and `feature-flag` (the worked example).
