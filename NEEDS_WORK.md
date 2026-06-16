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

## 1. Universal response-shaping (CORS, headers, timing) — 🟥 needs work

Request-side-only means the most common edge-function need — **CORS** (preflight +
`Access-Control-*` on the response), plus response headers, response logging-with-
timing, caching — can't be expressed as a middleware. `withCatch` only covers errors.
Today the answer is "hand-roll an outer wrapper" with no `ctx`/typing.

**Disposition (decided): find a solution that applies _universally_, not a
Supabase-specific CORS wrapper.** Open design question:

- A response-side combinator that still composes with the stack and sees `ctx` — e.g.
  an opt-in `finalize(res, ctx)` channel, or a `withResponse(transform, handler)`
  outer wrapper that is transparent to the call signature (like `withCatch`).
- Must stay generic (CORS is just one instance of "transform the response"); avoid
  baking Supabase/CORS specifics into core.
- Tension to respect: this is the deliberate request-side-only scope (R3). The bar is
  a _minimal, universal_ response seam, not the Express/Koa onion model.

## 6. `bufferRequest` proxy sharp edges — 🟥 needs work

`bufferRequest` only caches `arrayBuffer` / `bytes` / `blob` / `text` / `json`. Sharp
edges that can hurt consumers:

- **`req.formData()`** after a body-reading middleware (e.g. a form-encoded POST
  behind `auth-hook`) throws `Body already consumed` — not cached.
- **`req.clone()`** after a cached read throws (the underlying body is consumed).
- Passing the **proxied `req`** to `fetch()` / `new Request(req)` may behave oddly
  (the proxy forwards the raw `req.body` stream).

**Disposition (decided): we don't want sharp edges that might hurt consumers.** Make
the buffered request faithful:

- Add `formData()` to the cache, derivable from cached bytes:
  `new Response(await arrayBuffer(), { headers: req.headers }).formData()`.
- Decide `clone()` semantics (return a fresh re-readable wrapper over the cached
  bytes) or document it as unsupported and guard it.
- Audit `req.body` / fetch-passthrough; document precisely what is and isn't faithful.

## Minor — 🟥 needs work

- **`src/env.d.ts` is dead.** Runtime reads globals via `globalThis` casts now; the
  ambient `Deno` / `process` declarations are unused (and not published). Delete it.
- **No public-API surface test.** A refactor could silently drop a root/subpath
  export. Add a small "these exports exist" test.
- **`isContext` runtime trap (JS-land only).** Invoking a handler directly with a
  partial `ctx` lacking `_runtime` is re-seeded as if it were a platform arg, silently
  dropping the supplied keys. Type-caught in TS (`Base extends BaseContext`), but a
  trap in plain JS / hand-rolled tests. Consider a dev-time guard.

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
claim holds again. Remaining caveat is honest and already documented: the `postgres`
subpath is Node/Deno-only (`pg`), which is a per-subpath note, not a core limitation.

---

## 2. Prerequisite trust model is implicit — 🟦 by design

`withPostgres` trusts any upstream that structurally provides `jwtClaims`; there's no
guarantee they came from real verification. **Disposition (accepted): all middleware
being trusted is reasonable.** Worth one line in the security docs ("RLS scoping
trusts the `jwtClaims` provider"), but no code change.

---

## 3. JWT algorithm support (HS256 vs asymmetric / JWKS) — 🟪 `withSupabase`

`withAuth` (HS256-only) silently returns `null` (→ anon) for a valid asymmetric token,
which is the default for new Supabase projects. **Disposition: this is a `withSupabase`
implementation detail.** Auth/JWT verification — algorithm support, key fetching —
belongs to the `withSupabase` layer (the `supabase/server` migration), not core.

> Implication to revisit: the bundled `/auth` subpath (`withAuth`, shipped for R8) is
> really a `withSupabase` concern. Decide whether core keeps a minimal auth middleware
> or defers entirely to `withSupabase` once it lands on web-middleware.

## 4. `withAuth` can't distinguish "no token" from "bad token" — 🟪 `withSupabase`

Both → `null`/anon, so a misconfig (wrong secret, asymmetric token, clock skew)
silently yields empty results. **Disposition: also a `withSupabase` implementation
detail** — the anon-vs-error semantics (and any `console.warn`/strict mode for
"present but unverifiable") live in that layer.
