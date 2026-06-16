# R2 — One-shot request body

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → R2.

## The problem

A Fetch `Request` body is a single-use stream. Whichever layer reads it first
(`req.text()` / `req.json()` / `req.arrayBuffer()`) flips `req.bodyUsed` to `true`,
and every later read throws `TypeError: Body already consumed`. Because the framework
passes the original `req` straight through, this meant:

- `auth-hook` read the body to verify the signature, so a downstream handler could
  never read it (only the parsed `ctx.authHook.payload` survived).
- Two body-reading middleware could not be composed at all — a runtime failure with
  nothing at the type level to warn you.

## How it was solved

The body is made re-readable on **`req` itself** — not via a `ctx` key. At the entry
call, `defineMiddleware` wraps the request with `bufferRequest(req)`
(`src/core/runtime.ts`): a `Proxy` whose body-consuming methods
(`arrayBuffer` / `bytes` / `blob` / `text` / `json`) read the underlying body **at
most once** and cache it; everything else (headers, url, method, signal, …) forwards
to the real request, and `proxy instanceof Request` stays true. The buffered request
is created once at the entry and flows down the stack, so the cache is shared.

So body-reading is just normal Fetch — read it off `req`:

```ts
// auth-hook
run: (config) => async (req) => {
  const body = await req.text() // buffered: a downstream handler can read it too
  // …verify signature over `body`…
}
```

The handler can then `await req.json()` (or `.text()`, …) on the same `req` and get
the cached bytes — no "Body already consumed".

### Why `req`, not `ctx.body`

The first cut put a `BufferedBody` at `ctx.body`. That introduced an asymmetry: every
other `ctx` key is named after the middleware that set it, but `body` (like
`_runtime`) was a framework-seeded top-level key. The body is a property of the
**request**, so it belongs on `req`. Moving it there keeps the reserved-facet set on
`ctx` down to just `_runtime`, and makes body-reading read like idiomatic Fetch.

## Verification

`src/core/define-middleware.test.ts` → "req body is readable from multiple layers
(buffered request)": a body-reading middleware followed by a handler that reads the
body again both succeed (previously the second read threw). The auth-hook suite still
passes reading via `req`. `pnpm test` ✅ · `pnpm typecheck` ✅.

## Scope / limits

- The cache holds the full body in memory — fine for JSON/webhook payloads, not for
  streaming large uploads. A middleware that needs the raw stream reads `req.body`
  directly (and accepts single-consumption).
- `req.formData()` and the raw `req.body` stream are **not** cached — only the four
  buffering methods above. Bodyless requests (GET/HEAD) skip the proxy entirely.
- The handler's `req` is a `Proxy` over the original, not the original instance
  (identity check / `req.clone()` after a cached read are the known edges).
