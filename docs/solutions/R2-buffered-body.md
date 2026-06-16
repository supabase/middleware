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

A **read-once-cache** body view is now part of the base context at **`ctx.body`**
(`src/core/runtime.ts`):

```ts
export interface BufferedBody {
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}
```

- It reads the underlying body **at most once** (caching the `arrayBuffer` promise)
  and derives `text` / `json` / `bytes` from that cache. Reading is lazy — a GET with
  no body never triggers a read.
- The body view is seeded once at the entry call (`seedContext(req, …)`) and flows by
  reference through every middleware merge, so the **cache is shared** across the
  whole stack. Any number of layers can read it, in any form.

`auth-hook` now reads through `ctx.body.text()` instead of `req.text()`
(`src/middleware/auth-hook/with-auth-hook.ts`), so a handler downstream of it can
still read the body.

### The convention

Body-reading middleware should read through **`ctx.body`**, never `req.text()` /
`req.json()` directly. (Reading `req` directly still works, but consumes the stream
for everyone — the same footgun as before.)

## Verification

`src/core/define-middleware.test.ts` → "ctx.body is readable from multiple layers":
a body-reading middleware followed by a handler that reads the body again both
succeed (previously the second read threw). `pnpm test` ✅ · `pnpm typecheck` ✅.

## Scope / limits

- The cache holds the full body in memory — fine for typical JSON/webhook payloads,
  not for streaming large uploads. A middleware that genuinely needs the raw stream
  can still read `req.body` directly (and accept that it consumes it).
- The convention is advisory: nothing prevents a middleware from reading `req`
  directly and consuming the stream. Enforcing that is out of scope.
