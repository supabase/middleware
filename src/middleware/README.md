# Writing a middleware

This directory holds the **middleware** that ship with `@supabase/web-middleware`. A middleware is a `(config, handler)` fetch-handler wrapper that runs against the inbound `Request`, contributes a typed key to `ctx`, and either short-circuits with a `Response` or falls through to the inner handler. Anyone can publish one as a standalone npm package; the built-ins use the same `defineMiddleware` primitive third-party authors do.

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

## Authoring rules

1. **One key per middleware.** A middleware that wants multiple slots is doing too much — split it.
2. **No response shaping.** Middleware don't observe or wrap the inner handler's response. Anything response-shaped — rate-limit headers, CORS, response envelopes — is the handler's (or an outer wrapper's) job. Keeps each surface small and the response shape under one owner.
3. **Declare prerequisites in `In`.** If your middleware needs `ctx.jwtClaims`, set `In = { jwtClaims: JWTClaims | null }`. Standalone use then fails to compile — a real error, not a runtime surprise.
4. **Pick a unique key.** If two middleware contribute the same key, composition fails to typecheck (the inner `ctx` resolves to the `Conflict<Key>` sentinel) under the `satisfies FetchHandler` anchor. To apply the same middleware more than once on purpose, callers use the built-in `.as(newKey)` re-key — `withFeatureFlag.as('beta')(config, handler)` — so you don't need a key-override in config.

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

A third-party middleware published as its own npm package skips all three — it just exports the result of `defineMiddleware` and depends on `@supabase/web-middleware` for the primitive.

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
