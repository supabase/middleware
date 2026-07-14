# Writing a middleware

This directory holds the **middleware** that ship with `@supabase/middleware`. A middleware is a `(config, handler)` fetch-handler wrapper that runs against the inbound `Request`, contributes a typed key to `ctx`, and either short-circuits with a `Response` or falls through to the inner handler. Anyone can publish one as a standalone npm package; the built-ins use the same `defineMiddleware` primitive third-party authors do.

This README is for **authors**. If you just want to _use_ a middleware, see [`src/core/README.md`](../core/README.md).

## The worked example

[`feature-flag/`](./feature-flag/) is the canonical reference. It is short, well-commented, and exercises every piece of the pattern — config, contribution, prerequisites, short-circuit vs fall-through. Read it alongside this guide.

```
src/middleware/feature-flag/
├── README.md                       ← consumer-facing docs
├── index.ts                        ← public exports
├── with-feature-flag.ts            ← implementation
└── with-feature-flag.test.ts       ← behavioural tests
```

## Anatomy of a middleware

`defineMiddleware` takes four type parameters and one spec object:

```ts
defineMiddleware<Key, Config, In, Contribution>({ key, run })
```

| Parameter      | What it is                                                    | Example                       |
| -------------- | ------------------------------------------------------------- | ----------------------------- |
| `Key`          | The literal-string slot the middleware contributes to `ctx`.  | `'featureFlag'`               |
| `Config`       | The object the consumer passes to `withFoo(config, handler)`. | `WithFeatureFlagConfig`       |
| `In`           | Upstream prerequisites — what must already be on `ctx`.       | `Record<never, never>` (none) |
| `Contribution` | The shape that lands at `ctx[Key]` after a successful run.    | `FeatureFlagContribution`     |

Pass the four type parameters directly. The exported middleware's type is inferred as `Middleware<Key, Config, In, Contribution>` — no separate `: Middleware<…>` annotation needed.

## `run` has two stages

```ts
run: (config: Config) => (req: Request, ctx: In) =>
  Promise<Response | { [K in Key]: Contribution }>
```

- **Outer `(config) =>`** runs **once** when the consumer constructs the middleware. Initialize per-instance state here: clients, computed config, memoized fetches.
- **Inner `(req, ctx) =>`** runs **per request**. It receives the request and the upstream-supplied `ctx` typed as `In`.

The inner stage returns one of two shapes:

| Return                    | Effect                                                  |
| ------------------------- | ------------------------------------------------------- |
| `Response`                | **Short-circuit.** The inner handler is never invoked.  |
| `{ [Key]: Contribution }` | **Fall through.** The contribution lands at `ctx[Key]`. |

The runtime picks `result[key]` off the contribution object and ignores any other fields, so a single `return { featureFlag: { ... } }` is all the author writes.

### The response seam (`async function*`)

The plain inner stage is request-side: it can't see the handler's `Response`. When a middleware genuinely needs the way out — stamp headers, time the request, run `finally` cleanup — write the inner stage as an **`async function*`** instead of `async`, and use `yield` as the seam:

```ts
run: (config) =>
  async function* (req, ctx) {
    // request phase (before yield)
    const response = yield { myKey: contribution } // suspend; inner stack runs
    // response phase (after yield) — `response` is the downstream Response
    return shape(response)
  }
```

Rules: **`yield` the contribution at most once** — `yield` means "run downstream and hand me the response," and its expression resolves to the downstream `Response` (typed, no annotation). To short-circuit, `return new Response(...)` (same as the request-side path); `try/finally` around the `yield` gives request-spanning cleanup. Both forms share the one `run` signature — the runtime picks the path by what the body returns, so the 95% plain-`async` case is untouched. [`cors/`](./cors/) is the worked example: `return` answers preflight, `yield` stamps headers on the way out.

## Authoring rules

1. **One key per middleware.** A middleware that wants multiple slots is doing too much — split it.
2. **Default to request-side.** A plain `async` middleware doesn't observe the inner handler's response, which keeps each surface small and the response shape under one owner. Reach for the response seam (`async function*`, above) only when a concern is genuinely two-sided — CORS, timing, request-spanning cleanup. If you're only producing a response, do it in the handler.
3. **Declare prerequisites in `In`.** If your middleware needs an upstream key — say `ctx.jwtClaims` from an auth middleware — set `In = { jwtClaims: { sub: string } | null }`. Standalone use then fails to compile — a real error, not a runtime surprise.
4. **Pick a unique key.** If two middleware contribute the same key, composition fails to typecheck (the inner `ctx` resolves to the `Conflict<Key>` sentinel) under the `satisfies FetchHandler` anchor. If your middleware is one a consumer might legitimately apply more than once (two feature flags, two rate-limit buckets), give it a distinct `Key` per instance — typically by exposing a key override in its own config.

## Directory layout

Mirror `feature-flag/`:

```
src/middleware/<name>/
├── README.md                       ← consumer-facing: what it does, config, examples
├── index.ts                        ← export the middleware + its public types
├── with-<name>.ts                  ← the middleware itself
└── with-<name>.test.ts             ← vitest, exercises the run stages
```

Conventions:

- Directory name is **kebab-case** (`feature-flag`, `rate-limit`).
- Function is **`withCamelCase`** (`withFeatureFlag`, `withRateLimit`).
- The key on `ctx` is **camelCase** matching the function name minus the `with` prefix (`ctx.featureFlag`, `ctx.rateLimit`).
- Export the config / contribution interfaces alongside the middleware so consumers can type their own wrappers.

## Wiring up a new built-in

To add a middleware to this package, three files change in addition to the new directory:

1. **[`package.json`](../../package.json)** — add an entry to `exports`:
   ```json
   "./<name>": {
     "types": "./dist/middleware/<name>/index.d.mts",
     "import": "./dist/middleware/<name>/index.mjs",
     "require": "./dist/middleware/<name>/index.cjs"
   }
   ```
2. **[`tsdown.config.ts`](../../tsdown.config.ts)** — add `'src/middleware/<name>/index.ts'` to `entry`.
3. **[`jsr.json`](../../jsr.json)** — add `"./<name>": "./src/middleware/<name>/index.ts"`.

A third-party middleware published as its own npm package skips all three — it just exports the result of `defineMiddleware` and depends on `@supabase/middleware` for the primitive.

## Testing the run stages

The worked example in [`feature-flag/with-feature-flag.test.ts`](./feature-flag/with-feature-flag.test.ts) shows the cases worth covering:

- Admits and contributes the expected `ctx[Key]` shape.
- Short-circuits with the configured status / body on reject.
- Honors override config (custom status, custom body).
- Passes the `Request` through, so author-supplied evaluators see header / IP / method.
- Supports async work inside `run`.

Use `vi.fn` for the inner handler when you need to assert it was (or wasn't) called.

## See also

- [`src/core/README.md`](../core/README.md) — composition rules, `ctx` shape, conflict and prerequisite enforcement.
- [`feature-flag/`](./feature-flag/) — the worked example referenced throughout this guide.
- [`cors/`](./cors/) — the worked example of the response seam (`async function*`).
