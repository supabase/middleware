# API Risk Profile — `@supabase/web-middleware`

A risk-ranked audit of the **user-facing API surface** (both the _consumer_ surface
— `withFoo(config, handler)`, composition, `ctx` — and the _author_ surface —
`defineMiddleware`). Each entry is investigated against the actual code and, where
possible, a runnable experiment, not just reasoning.

> Status legend: 🔴 confirmed, behaves as described · 🟡 latent / conditional ·
> ⚪ design opinion (no defect, but a surface I'd contest).

**Risk = severity (how bad when it bites) × likelihood (how often a real user hits
it) × irreversibility (this is a published API; changing it later breaks callers).**
The third factor is why ergonomic/shape concerns rank near correctness ones — they
are the hardest to walk back once `0.1` ships.

Target runtime context: this is meant to run on **Deno**, inside a Supabase
`edge-functions-ingress` user worker, entered via `export default { fetch }`. There
is **no `env` positional argument** in that world (Deno uses `Deno.env.get()`), so
Cloudflare-style `(request, env, ctx)` framing does not apply as-is.

> **Update (resolved):** A `defineMiddleware` rebuild + a `Runtime` abstraction
> addresses the riskiest items (R5, R4, R1, and part of R8) with **no entry
> wrapper** — the outermost middleware is the `fetch` handler directly, runtime is
> detected at module load, and an optional `satisfies FetchHandler` anchor turns on
> ambient accumulation + collision detection. See
> [**Solutions implemented**](#solutions-implemented) for the per-risk mapping, what
> was verified, and what remains. The findings below are the pre-change record.

## Ranked summary

| #   | Concern                                                                         | Class                        | Status | Headline                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------- | ---------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Arg-2 slot is overloaded: composition `baseCtx` vs. runtime-supplied second arg | correctness / security       | 🟡     | Safe on `Deno.serve` _by accident_ (non-enumerable info); pollutes on any runtime whose 2nd arg is a plain object (e.g. Workers `env`).                                                              |
| R2  | One-shot `Request` body — first reader wins, no re-read convention              | correctness (Fetch-specific) | 🔴     | First middleware to read the body locks out every later layer; no buffering/clone convention.                                                                                                        |
| R3  | No error boundary; request-side-only excludes the most common middleware        | robustness / scope           | 🔴     | Any throw in `run`/handler escapes the whole chain uncaught; logging/CORS/error-boundary/caching can't be expressed as middleware.                                                                   |
| R4  | Fixed single-instance keys — can't apply the same middleware twice              | capability gap               | 🔴     | Same key reused → inner silently shadows outer on `ctx`; no built-in offers a key override.                                                                                                          |
| R5  | **Type-safety guarantees collapse for the common (no-prereq) nesting case**     | trust in core claim          | 🔴     | **The README's own compose example doesn't typecheck. Accumulated `ctx` doesn't flow and collision detection never fires when the inner middleware has no prerequisites. Highest-severity finding.** |
| R6  | Nesting-only + two-arg shape: no reusable configured middleware, churny diffs   | ergonomics / adoption        | ⚪     | Defensible, but it's the _cause_ of R5: the two-arg/dual-sig shape is what breaks inference.                                                                                                         |
| R7  | Authoring drift: `Contribution` not inferred; conflict machinery hand-copied    | author DX → runtime bugs     | ⚪🟡   | Two of three built-ins cast around the primitive (auth-hook re-copies `NoConflict`; postgres bridges with `as unknown`).                                                                             |
| R8  | Postgres implicit global pool + no shipped middleware satisfies `jwtClaims`     | operational footgun          | 🟡     | Flagship RLS middleware is unusable out of the box (nothing produces `jwtClaims`); pool is hidden global env state. SQL role/claims injection is _safe_.                                             |
| R9  | `ctx` name collides with platform / Hono conventions                            | clarity                      | ⚪     | Overloads `ExecutionContext` / Hono `Context`; minor.                                                                                                                                                |

---

## Findings (in rank order)

### R1 — The arg-2 slot is overloaded: composition `baseCtx` vs. runtime-supplied second argument 🟡

**The surface.** A wrapped handler has the type (`define-middleware.ts:175`):

```ts
type Wrapped<Base, In> = keyof In extends never
  ? ((req: Request, baseCtx: Base) => Promise<Response>) &
      ((req: Request) => Promise<Response>)
  : (req: Request, baseCtx: Base) => Promise<Response>
```

The second positional parameter, `baseCtx`, is how an **outer** middleware threads
accumulated context into an **inner** one during composition. But at the top level —
where the handler is `export default { fetch }` or `Deno.serve(handler)` — that same
positional slot is owned by the **runtime**, which decides what to put there. The
runtime merge consumes it unconditionally (`define-middleware.ts:117-118`):

```ts
return async (req: Request, baseCtx?: object) => {
  const upstream = baseCtx ?? ({} as object)
  ...
  const ctx = { ...upstream, [spec.key]: contribution }
```

So whatever the runtime passes as arg 2 is spread into `ctx`.

**What the experiments show.**

- _Exp A_ — pass a plain object as arg 2 (this is the Cloudflare Workers `env`
  shape, and the package's own docs claim Workers support): `ctx` is polluted with
  every enumerable property of that object, while the handler's `ctx` type still
  claims to be just `{ tag }`.

  ```
  called as (req)       -> {"tag":{"v":"hello"}}
  called as (req, info) -> {"remoteAddr":{...},"completed":"<Promise>","tag":{"v":"hello"}}
  ```

- _Exp B_ — `Deno.serve` (the realistic local entry) **does** pass a second arg:
  `args.length = 2`, arg 2 is a `ServeHandlerInfo` exposing `remoteAddr`.

- _Exp C_ — but `Deno.serve(withTag({...}, handler))` does **not** pollute `ctx`:

  ```
  ctx seen by handler  = {"tag":{"v":"hi"}}
  ctx own keys         = [ "tag" ]
  ```

  The reason is subtle and load-bearing: `ServeHandlerInfo`'s properties are
  **non-enumerable getters**, and object spread copies only enumerable own
  properties. So the pollution is suppressed _by accident_, not by design.

**The actual risk.** Correctness here depends on an invisible property of an object
the library never sees: the enumerability of the runtime's second argument.

- Deno `Deno.serve` → safe today (non-enumerable).
- Cloudflare Workers `export default { fetch }` → `env` is a plain object with
  enumerable bindings → **pollutes** (`ctx` silently gains every binding; the
  `ExecutionContext`/`waitUntil` in arg 3 is dropped entirely). The package claims
  Workers support in `index.ts` and `core/README.md`, so this is a real contradiction.
- Supabase edge-runtime `export default { fetch }` → **unverified.** This is the one
  fact that decides whether R1 is latent or live on the actual target. It is not in
  the `edge-functions-ingress` repo (the ingress calls `worker.fetch(userReq)` with a
  single `Request` at `src/main/index.ts:740`; the isolate-side dispatch that calls
  the user's `fetch` lives in the edge-runtime itself).

**Why it's a design smell regardless of the verdict.** One positional slot means two
different things depending on who calls it, and the safe cases are safe only because
of property-descriptor trivia. A handler advertised as portable across runtimes
should not have a parameter whose meaning flips based on the caller.

**Options.**

1. Top-level entry is strictly `(req) => Promise<Response>`; thread composition
   context through a channel a runtime cannot accidentally fill — a closure (curried
   `withFoo(config)(handler)` + an explicit `chain`/`compose`) or a private
   symbol-keyed argument. This removes the overload entirely.
2. Keep arg 2 but **guard** it: only treat arg 2 as upstream context when it carries
   an internal brand (e.g. a non-enumerable symbol the framework stamps), otherwise
   ignore it. Cheap, backwards-compatible, kills the enumerability dependency.
3. Minimum: document that the entry point must be the `(req)` form and never
   `Deno.serve(handler)` / a runtime that passes an enumerable arg 2 — and confirm
   the edge-runtime's dispatch arity before shipping.

**Verdict:** 🟡 latent. Not currently broken on `Deno.serve`, but safe only by
coincidence; broken on at least one runtime the docs claim to support. The fix is
cheap (option 2) and worth doing before `0.1`.

---

### R2 — One-shot `Request` body: first reader wins, no re-read convention 🔴

**The surface.** The runtime passes the _original_ `req` straight through to the
inner handler (`define-middleware.ts:139`: `handler(req, ctx)`). A Fetch `Request`
body is a single-use stream — once any layer calls `.text()` / `.json()` /
`.arrayBuffer()`, `req.bodyUsed` flips to `true` and every later read throws.

**What the experiment shows.** A body-reading middleware (modelling `auth-hook`,
which does `await req.text()` at `with-auth-hook.ts:80`) followed by a handler that
reads the body:

```
status: 500
{"ok":false,"error":"TypeError: Body already consumed","bodyUsed":true}
```

**Why this matters for _this_ library specifically.** The headline pitch is
"designed around the Fetch API," and the single-consumption stream is the #1 Fetch
gotcha — yet the API is silent on it:

- `auth-hook` consumes the body and exposes only the _parsed_ payload at
  `ctx.authHook.payload`. The common case (handler wants the parsed hook body) is
  covered, but the **raw** body is gone forever — a handler that needs to forward
  the original bytes, verify a second signature, or re-parse can't.
- **Two body-reading middleware cannot be composed at all.** Stack any second
  body-consumer under `auth-hook` and it throws at runtime, with nothing at the type
  level to warn you. This is exactly the kind of failure the "type-safe" framing
  leads users not to expect.
- There is no `ctx.body` / buffered-body convention, and no documented "clone the
  request first" guidance.

**Options.**

1. Offer an opt-in buffered body on `ctx` (read once, expose `ctx.rawBody` /
   `ctx.body` as a re-readable value). Makes body-reading middleware composable.
2. Establish a convention: body-reading middleware must `req.clone()` before reading,
   and document it as an authoring rule. Cheaper, but `clone()` has its own memory
   cost and is easy to forget — a runtime footgun by omission.
3. At minimum, document the constraint loudly and have `auth-hook` surface the raw
   body it already read (`ctx.authHook.rawBody`) so nothing downstream needs a second
   read.

**Verdict:** 🔴 confirmed. Real, silent, type-invisible, and squarely in the
library's stated domain. Higher priority than R1 for the target runtime, because it
bites regardless of platform.

---

### R3 — No error boundary; request-side-only excludes the most common middleware 🔴

**The surface.** The wrapper is request-side only by design (documented in
`README.md` "Request-side only — by design" and `define-middleware.ts:15-19`): `run`
executes _before_ the handler, returns either a `Response` or a contribution, and
the wrapper then does `return handler(req, ctx)` (`:137`) with **no `try/catch` and
no inspection of the result.**

**Consequence 1 — errors escape uncaught (robustness).** Because nothing wraps the
handler call, a throw anywhere downstream propagates out of the entire chain:

```
THROW ESCAPED the middleware chain: Error: handler blew up
```

There is no library-level standard error response — the platform's default
(Deno/edge-runtime → a bare 500) is what the client sees. This isn't only the
handler's problem: `auth-hook` itself does `JSON.parse(body)` at
`with-auth-hook.ts:100` _after_ signature verification. A request with a valid HMAC
over a non-JSON body (the signer controls the bytes) throws there and escapes the
same way — no `rejectStatus`/`rejectBody` applies, because those only cover the
verification-failed path.

**Consequence 2 — a whole category of middleware can't exist here (scope).** Observe
that none of these can be written as a middleware in this model, because each needs
to see or wrap the _response_:

- request logging / timing (needs handler duration + status)
- error boundary (needs to catch downstream throws)
- CORS / security headers (needs to add headers to the response)
- response envelopes, compression, `ETag`/caching, rate-limit headers

The docs push these to "an outer wrapper or the handler," but an outer wrapper
**cannot be one of these middleware** — it gets none of the `ctx` typing, conflict
detection, or prerequisite machinery. So the type infrastructure exists for the
request half and the response half is left to hand-rolled wrappers.

**The tension.** Request-side-only is a legitimate, defensible scoping choice (it
keeps each middleware's surface small and the response under one owner). But it has a
naming cost: calling this "middleware" invokes the onion model (`next()`,
response-on-the-way-out) that the design then denies, and it has a correctness cost:
no error containment at all.

**Options.**

1. Keep request-side-only but add a minimal, separate **error-boundary primitive**
   (e.g. `withCatch(onError, handler)`) so throws have a defined response. Doesn't
   reintroduce the onion model; just contains failures.
2. Add an opt-in response hook for the subset that needs it (a second return channel
   or a `finalize(res, ctx)` step), accepting the larger surface.
3. Keep the scope, but rename/reposition so users don't expect onion behavior, and
   document the "errors escape to the platform" contract explicitly.

**Verdict:** 🔴 confirmed. The scope decision is defensible; the _silent error
escape_ (including from `auth-hook`'s own `JSON.parse`) is the part I'd treat as a
real gap, not a preference.

---

### R4 — Fixed single-instance keys: same middleware can't be applied twice 🔴

**The surface.** Each middleware hard-codes one `key` (`'featureFlag'`,
`'authHook'`, `'postgres'`). The authoring guide (rule 4, `middleware/README.md`)
says repeatable middleware should "accept a `key` override in config" — but **none
of the three built-ins do.**

**Why it bites.** Gating on two feature flags is routine. Nesting
`withFeatureFlag` twice should either compose (two slots) or be rejected. Instead,
because collision detection doesn't fire here (see R5), it silently compiles and at
runtime the inner contribution **shadows** the outer:

```
handler sees featureFlag = {"name":"beta","enabled":true,...}   // 'alpha' is gone
```

Both gates still execute (an `alpha` rejection still short-circuits), but only the
innermost middleware's value survives on `ctx` — the merge at
`define-middleware.ts:133` does `{ ...upstream, [key]: value }`, last-write-wins.
The user gets no signal that the first flag's verdict was dropped.

**Why it's a design-level gap, not just a missing feature.** The contribution model
is "one fixed key per middleware," which is fundamentally singular. Anything a user
legitimately wants more than once — feature flags, rate-limit buckets, per-scope
authz checks — has no first-class representation. The `ctx.featureFlag` slot is
singular by construction.

**Options.**

1. Built-ins take an optional `key` (or `as`) in config, defaulting to the canonical
   name; `ctx[customKey]` then carries each instance. (Implements the guide's own rule.)
2. Collection-shaped contribution: `ctx.featureFlags[name]` rather than a single slot.
3. At minimum, once R5 is fixed so collisions are detected, a second same-key apply
   becomes a _compile_ error instead of silent shadowing — strictly better than today.

**Verdict:** 🔴 confirmed. The silent-shadow runtime behavior is the dangerous part;
it's downstream of R5.

---

### R5 — Type-safety guarantees collapse for the common (no-prereq) nesting case 🔴 (highest severity)

This is the most important finding in this document. The package's headline is
"composable, **type-safe** middleware," resting on two promises (`core/README.md`):
accumulated-`ctx` typing and collision detection. Both fail for the most natural and
most-documented usage.

**Finding 1 — the README's own example does not compile.** The exact "How it
composes" snippet (`README.md:43-50`):

```
src/__probe__/readme_compose.ts(7,9): error TS2339:
  Property 'featureFlag' does not exist on type
  'Record<never, never> & { authHook: AuthHookContribution<AuthHookPayload> }'.
```

The inner handler's `ctx` contains only the inner middleware's key. The outer
`featureFlag` never reaches it.

**Finding 2 — accumulated `ctx` doesn't flow when the inner middleware has no
prerequisites.** Two `defineMiddleware` middleware nested, inner handler reading the
outer key:

```
src/__probe__/accum2.ts(6,21): error TS2339:
  Property 'a' does not exist on type 'Record<never, never> & object & { b: {...} }'.
```

**Root cause (isolated by experiment).** The `Wrapped` type gives prereq-free
middleware a _dual_ signature for standalone ergonomics
(`define-middleware.ts:175-178`):

```ts
keyof In extends never
  ? ((req, baseCtx: Base) => Promise<Response>) & ((req) => Promise<Response>)
  : (req, baseCtx: Base) => Promise<Response>
```

When such a value is passed as an outer middleware's handler, TypeScript unifies it
against the simpler `(req) => Promise<Response>` arm (a 1-param function is assignable
to a 2-param expected type), so **`Base` is never inferred from the outer context** —
it stays at its `Record<never, never>` default. The clincher: giving the _inner_
middleware a prerequisite forces the single-signature form, and the outer key
immediately flows (`tsc exit 0`). So the very dual-signature added for standalone
ergonomics is what defeats contextual inference through nesting.

**Finding 3 — collision detection never fires in natural code.** Because `Base`
doesn't accumulate, there is no upstream key for `NoConflict<Key, Base>` to catch.
The author's passing conflict test (`define-middleware.test.ts:68-80`) only works
because it supplies the upstream type _by hand_:
`withFoo<{ foo: { v: number } }>(...)` — an explicit type argument that real nested
usage never writes.

**Finding 4 — the existing "type" tests don't guard any of this.** The
inference/conflict tests (`define-middleware.test.ts:183, 239`) run under **vitest**,
which executes JS and ignores type errors — a broken type there wouldn't fail the
suite. The only gate is `tsc` over `src`, and the committed tests pass it solely
because they use _bespoke single-signature_ outer wrappers (`withUpstream`,
`withAuth`), not the library's own dual-signature middleware. So the test suite gives
false confidence: the guarantees "pass" for shapes no real consumer writes, and fail
for the shape the README ships.

**Why this is #1.** The library's entire differentiation is type safety. As it
stands: the documented example is a type error, `ctx` accumulation silently doesn't
work for prereq-free middleware (the common case — `featureFlag`, `authHook` both
qualify), and the collision guarantee is effectively inert. Everything else in this
document is secondary to this.

**Options.**

1. Drop the dual signature; make the wrapped handler uniformly `(req, baseCtx) =>`
   and provide a separate, explicit `serve(handler)` / `toFetch(handler)` adapter for
   the standalone top-level case. Single signatures preserve inference (proven by the
   prereq clincher).
2. Replace nesting-as-composition with an explicit combinator (`chain(...)` /
   `pipe(...)`) whose variadic tuple types accumulate `ctx` deterministically — more
   type machinery, but inference is under the library's control instead of relying on
   contextual unification through nested calls.
3. Whichever path: add **type-level tests** (e.g. `tsc`-asserted `@ts-expect-error` /
   `expectTypeError` fixtures, or `expect-type`/`tsd`) so accumulation and collision
   are verified at compile time, not by a vitest run that can't see types.

**Verdict:** 🔴 confirmed, critical. Reproduced from the README verbatim. The ranking
in the summary table should be read with R5 at the top.

---

### R6 — Nesting-only + two-arg shape: no reusable configured middleware ⚪

**The surface.** `withFoo(config, handler)` takes the handler as positional arg 2, and
the only composition is direct nesting. Two consequences:

- **A configured middleware is never a value.** You cannot write
  `const betaOnly = withFeatureFlag({ name, evaluate })` and apply it to several
  handlers/routes — `handler` is required at the same call. The internal `run` is
  _already_ curried (`(config) => (req, ctx) => …`), but the public surface collapses
  that curry, so every route re-specifies config inline.
- **Pyramid + churny diffs.** `withA(ca, withB(cb, withC(cc, h)))` reads inside-out,
  and inserting a middleware mid-stack re-indents everything below it.

**The deeper point — this shape _causes_ R5.** To keep `withFoo(config, handler)`
usable both standalone and nested, the library gave prereq-free middleware the dual
`(req, baseCtx) & (req)` signature. That dual signature is exactly what defeats
contextual `Base` inference (R5). So the ergonomic shape and the type failure are the
same decision viewed twice: the two-arg/standalone-friendly form is bought at the
cost of the type guarantee.

**The alternative to weigh.** `withFoo(config)` returns a unary `(handler) => handler`
(a reusable value), composed by an explicit `chain(mw1, mw2, …)` / `pipe`. This is
the ubiquitous middleware shape, makes configured middleware reusable, removes the
pyramid, and — critically — lets the library _control_ `ctx` accumulation via
variadic tuple types instead of leaning on fragile contextual unification. The cost
is real (variadic accumulation types are hard to write and to keep readable), which
is likely why nesting was chosen. But given R5, "no separate composer" is no longer a
free virtue — it's load-bearing on a guarantee that currently doesn't hold.

**Verdict:** ⚪ design opinion on its own, but it's the lever for R5. Resolve them
together.

---

### R7 — Authoring surface: drift and non-composing type machinery ⚪🟡

The _author_ surface (`defineMiddleware`) has three rough edges, all visible in the
shipped middleware:

1. **The key is written twice** — once as the `Key` type parameter, once as the `key`
   value (`defineMiddleware<'featureFlag', …>({ key: 'featureFlag', … })`). They can
   drift; nothing ties the literal to the value beyond convention.
2. **The conflict machinery doesn't survive a generic.** `auth-hook` needs one extra
   type parameter (`Payload`), and to get it the author had to **re-implement the
   core's type-level guts by hand** — `IsAny` and `NoConflict` are copied into
   `with-auth-hook.ts:108-143` as `NoAuthHookConflict`, plus a
   `as unknown as WithAuthHook` cast (`:164`). `postgres` similarly needs a
   `as unknown as (…)` bridge cast (`with-postgres.ts:133-140`) to re-type its
   per-config contribution. When two of three built-ins must cast around the
   primitive to express ordinary needs (a generic payload, a config-dependent
   contribution), the primitive isn't covering its own use cases.
3. **Four order-sensitive positional type params.** `defineMiddleware<Key, Config, In,
Contribution>` — swap `In` and `Contribution` and you get a baffling error far from
   the cause. A single options-object of types, or inferring `Contribution` from
   `run`'s return, would remove the footgun.

Note these are partly _downstream of R5_: the casts exist because the generic
`Middleware` type doesn't compose, so authors escape it. Fixing R5's inference model
may dissolve some of this.

**Verdict:** ⚪/🟡 — author-DX, but the hand-copied conflict machinery is a maintenance
hazard (the copy in `auth-hook` won't track fixes to the core `NoConflict`).

---

### R8 — Postgres: unusable out of the box + hidden global pool 🟡

**Finding 1 — nothing in the package satisfies the `jwtClaims` prerequisite.**
`withPostgres` declares `In = { jwtClaims: JWTClaims | null }` and (correctly) won't
compose standalone. But the package ships exactly three middleware — `feature-flag`,
`auth-hook`, `postgres` — and **none contributes `jwtClaims`** (`auth-hook` emits
`authHook`, not claims). So the flagship security feature — RLS-scoped Postgres —
cannot be used without the consumer first writing their own JWT-verifying auth
middleware. The README's examples lean on a `withAuth({ ... })` that does not exist in
the package. For a Supabase-branded library, "verify the Supabase JWT → `ctx.jwtClaims`"
is the one middleware users will assume is included.

**Finding 2 — implicit module-global pool from an env var.** With no `pool` in config,
`getPool()` lazily news up a module-level `Pool` from `SUPABASE_DB_URL`
(`db.ts:43-65`). That's hidden global state keyed on an env var: invisible in the call
site, shared across requests, and surprising in tests (a missing var fails at first
query, not at construction). Defensible for ergonomics, but it should be an explicit,
documented opt-in rather than the default.

**What is _not_ a problem (checked).** The RLS scoping itself looks sound: `role` is
interpolated into `set local role ${role}` but comes from a closed enum
(`'authenticated' | 'anon'`, clamped in `userRole`, `with-postgres.ts:64-66`), so no
injection; claims are applied via a parameterized `set_config(..., $1, true)`
(`db.ts:84`); each op runs in its own transaction and releases the connection before
the promise settles (no cross-request leakage). `service_role` is reachable only via
the explicit `admin: true` opt-in, never via a token claim. This part is well
constructed.

**Verdict:** 🟡 — the missing auth middleware makes the headline use case
non-functional as shipped; the implicit pool is a lesser footgun.

---

### R9 — `ctx` naming collides with platform / framework conventions ⚪

`ctx` is already a loaded name in this domain: it's Cloudflare's `ExecutionContext`
(arg 3 of a Workers `fetch`) and Hono's request/response `Context`. Using it for the
accumulated middleware _state_ invites confusion, especially given R1 (where a
platform object can end up merged into this very `ctx`). A less overloaded name —
`state`, `data`, `scope` — would read unambiguously. Minor, but cheap to get right
before the API is public.

Also minor and adjacent: `rejectStatus` / `rejectBody` are reinvented independently in
`feature-flag` and `auth-hook` (both `rejectBody?: unknown`), with no shared
short-circuit-response convention — a small consistency risk as the ecosystem grows.

**Verdict:** ⚪ clarity/consistency, no defect.

---

## Revised ranking (post-investigation)

Investigation changed the order. By **severity to the core value proposition**:

1. **R5** — type guarantees collapse for prereq-free nesting; the README example
   doesn't compile. _This is the headline risk._
2. **R2** — one-shot body consumption; silent, type-invisible, in-domain.
3. **R3** — errors escape the chain uncaught (incl. `auth-hook`'s own `JSON.parse`).
4. **R4** — same-key reuse silently shadows on `ctx` (downstream of R5).
5. **R8** — flagship RLS middleware unusable out of the box (no `jwtClaims` producer).
6. **R1** — arg-2 overload; safe on `Deno.serve` by accident, latent elsewhere.
7. **R6 / R7** — composition shape & authoring drift; the _cause_ of R5, resolve together.
8. **R9** — naming/consistency polish.

**The through-line:** R5, R6, and R7 are one decision seen three times — the
`withFoo(config, handler)` + nesting + dual-signature shape. It buys standalone
ergonomics and "no composer," and pays for it with the type guarantee that is the
library's entire reason to exist. That trade is the single most important thing to
revisit.

**Method note:** findings R1–R5 and the R4 runtime behavior were reproduced with
runnable experiments (Deno 2.1 / Node 24) against the actual `src`, not inferred. The
one unverified fact is what the Supabase edge-runtime passes as the 2nd arg to a user
worker's `fetch` (R1) — it determines whether R1 is latent or live on the target.

---

## Solutions implemented

R5, R4, R1, and R6 were facets of one decision — the `withFoo(config, handler)` +
nesting + **dual `(req) & (req, ctx)` signature** shape. The rebuild keeps direct
nesting and adds **no entry wrapper** (no `toFetch`): the outermost middleware is the
runtime's `fetch` handler directly.

**The change, in three parts:**

1. **Single-signature handlers with a conditional `ctx`** (`define-middleware.ts`).
   Each `withFoo(config, handler)` produces one function. Prerequisite-free middleware
   get an **optional** `ctx` (so they're directly usable as a `fetch` entry);
   middleware with `In` prerequisites keep a **required** `ctx` (so they must be
   nested — preventing a prerequisite from becoming a type-lie at the top level).
   Removing the old dual _intersection_ signature is what restores `Base` inference.
2. **Early detection + auto-seed, no wrapper** (`core/runtime.ts`). The runtime
   _name_ is detected once at module load. On the entry call the wrapper sees the
   host's second argument is not an upstream context (via `isContext`) and seeds a
   fresh `{ runtime }` itself — so a host `env` / `ServeHandlerInfo` is never merged
   into `ctx`. On Workers, per-request bindings are captured from that entry call.
3. **A `Runtime` abstraction at `ctx.runtime`** — `{ name: RuntimeName; getEnv(key) }`
   — so middleware read configuration portably instead of reaching for `Deno.env` /
   `process.env` / a Workers bindings object.

**The anchor law (proven by 5 experiments).** Typed _ambient_ accumulation through
lexical nesting requires a concrete anchor on the outermost handler — no implicit
default substitutes. Since there's no wrapper, the anchor is a **type-only**
`satisfies FetchHandler` the consumer writes once. It is **not** needed for
cross-middleware dependencies declared as `In` prerequisites (those type with zero
ceremony); it turns on (a) the innermost handler seeing _every_ upstream key, and
(b) collision detection.

### Per-risk mapping

| #      | Status after change         | What was done                                                                                                                                                                                                                                                                                                                                                                     | Verified by                                                                                                                                           |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R2** | ✅ **resolved**             | Added a read-once-cache `ctx.body` (`BufferedBody`) to the base context; `auth-hook` reads through it, so a downstream handler can re-read the body and two body-reading middleware compose. See [docs/solutions/R2-buffered-body.md](docs/solutions/R2-buffered-body.md).                                                                                                        | `define-middleware.test.ts` "ctx.body is readable from multiple layers"; `pnpm test` ✅.                                                              |
| **R5** | ✅ **resolved**             | Single-signature handlers; cross-middleware `In` deps type with no ceremony, and `satisfies FetchHandler` gives full ambient accumulation. Added **tsc-verified** type-guarantee tests (`define-middleware.test.ts` → "type guarantees") so a regression fails `typecheck`, not just a vitest run that can't see types.                                                           | `tsc` probes: prereq-based access compiles zero-anchor; README-shape ambient access compiles under `satisfies`; `pnpm typecheck` + `pnpm test` green. |
| **R4** | ✅ **resolved** (detection) | Applying the same middleware twice is a **compile error** (`middleware-conflict: key 'featureFlag' …`) under the `satisfies FetchHandler` anchor, instead of silent runtime shadowing. _Intentional_ multi-instance (a key override in config) is a separate follow-up.                                                                                                           | `tsc` probe: double `withFeatureFlag` + `satisfies` → `TS2345` citing the conflict sentinel.                                                          |
| **R1** | ✅ **resolved**             | The wrapper distinguishes an upstream context from a host platform arg (`isContext`) and seeds `{ runtime }` rather than merging the arg — so no runtime-supplied 2nd arg can reach `ctx`, regardless of enumerability. Portable env via `ctx.runtime.getEnv`; `RuntimeName` covers `'deno' \| 'cloudflare-workers' \| 'node' \| 'bun'`. Edge-runtime arg-2 question is **moot**. | Runtime test (`define-middleware.test.ts`): calling as `(req, {SECRET:'s'}, execCtx)` yields `ctx` keys `['runtime', …]` only.                        |
| **R3** | ✅ **resolved**             | Added an opt-in `withCatch(onError, handler)` boundary (package root) that contains downstream throws — including `auth-hook`'s post-verification `JSON.parse` — behind a `Response` you define. Transparent to the call signature, so the result is still a `fetch` entry. See [docs/solutions/R3-error-boundary.md](docs/solutions/R3-error-boundary.md).                       | `with-catch.test.ts`: catches handler + `run()` throws, passes success through, stays entry-able.                                                     |
| **R8** | 🟡 **partly resolved**      | `withPostgres` resolves `SUPABASE_DB_URL` via `ctx.runtime.getEnv` (portable + testable) rather than a global lookup in `db.ts`. Implicit module pool remains (now fed a resolved connection string). **Still missing:** a shipped middleware contributing `jwtClaims`.                                                                                                           | `pnpm build`/`typecheck` green; postgres test injects a stub `runtime`.                                                                               |
| **R6** | 🟡 **root cause removed**   | The dual _intersection_ signature that caused R5 is gone, and nesting is preserved with **no wrapper**. A reusable curried form (`withFoo(config) => (handler)`) + `chain()` was not adopted.                                                                                                                                                                                     | n/a (design)                                                                                                                                          |

### Remaining (not addressed by this change)

- **R4 multi-instance (intentional).** Detection is fixed; deliberately running the
  same middleware twice still needs a `key`/`as` override in config.
- **Anchor ergonomics.** Ambient accumulation + collision detection require a
  `satisfies FetchHandler` annotation; omitting it silently degrades _types_ (runtime
  stays correct). Prerequisite-based typing needs no annotation.
- **R7 — authoring drift.** `auth-hook` still hand-copies the `NoConflict` machinery
  and `postgres` still bridges with `as unknown`. Not addressed.
- **R9 — `ctx` naming.** Kept `ctx`; added the reserved `ctx.runtime`. Not renamed.

### Verification summary

`pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm build` ✅ · `pnpm test` ✅ (36 pass, 8
postgres integration skipped without `SUPABASE_DB_URL`). All design claims —
no-wrapper entry, no `ctx` pollution from platform args, prereq typing zero-anchor,
ambient accumulation + collision under `satisfies`, prereq-middleware-can't-be-entry —
were reproduced with runnable `tsc`/runtime experiments against the actual `src`.
