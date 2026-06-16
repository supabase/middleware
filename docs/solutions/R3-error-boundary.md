# R3 — Error containment

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → R3.

## The problem

Middleware here are request-side only: the framework calls `handler(req, ctx)` with
no `try/catch`, and no middleware can wrap the inner handler's execution. So a throw
anywhere downstream — a handler bug, or `auth-hook`'s post-verification
`JSON.parse(body)` on a malformed-but-signed payload — propagated out of the whole
chain to the host, which returns a bare `500`. There was no way to define a failure
response, and (because middleware can't see the response) an error boundary could not
be written as a normal middleware.

## How it was solved

A small, **opt-in** wrapper — `withCatch(onError, handler)` (`src/core/with-catch.ts`,
exported from the package root) — wraps a composed stack in `try/catch` and turns a
throw into a `Response` you define:

```ts
import { withCatch, type FetchHandler } from '@supabase/web-middleware'

export default {
  fetch: withCatch(
    (error) => {
      console.error(error)
      return Response.json({ error: 'internal' }, { status: 500 })
    },
    withFeatureFlag({ name: 'beta', evaluate }, handler) satisfies FetchHandler,
  ),
}
```

Key properties:

- **Not a mandatory entry wrapper.** Unlike the earlier `toFetch`, you add it only
  where you want error containment. Stacks without it behave exactly as before
  (errors propagate to the host).
- **Transparent to the call signature.** It's generic over the wrapped handler's
  argument tuple, so the result keeps the same signature — still directly usable as a
  `fetch` entry, and extra platform args pass straight through to the stack (which
  seeds `ctx` as usual).
- **Anchor placement.** Put any `satisfies FetchHandler` on the _inner_ stack (as
  above), so `Base` is anchored before `withCatch` wraps it.

## Verification

`src/core/with-catch.test.ts`: contains a throw from the handler, contains a throw
from a middleware `run()`, passes successful responses through untouched, and stays
usable as a bare entry with extra platform args. `pnpm test` ✅ · `pnpm typecheck` ✅.

## Scope / limits

- `onError` receives `(error, req)` only — not `ctx`. The runtime/body facets aren't
  threaded into the error path; if you need them, capture them in the handler.
- This contains errors; it does not add response _shaping_ (CORS, envelopes). That
  remains the handler's or an outer wrapper's job, by design.
