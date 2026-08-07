# Built-in middleware

This directory holds the middleware that ship with `@supabase/middleware`.

| Directory                          | Key               | What it does                                                        |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------- |
| [`feature-flag/`](./feature-flag/) | `ctx.featureFlag` | Provider-agnostic feature flag. The request-side worked example.    |
| [`cors/`](./cors/)                 | `ctx.cors`        | CORS — preflight in, headers out. The response-seam worked example. |

> **Writing your own middleware?** See the [authoring guide](../../docs/authoring-guide.md).
> It covers the full path — `defineMiddleware`, tests, publishing, and composing
> your middleware in the same `pipeline` array as these built-ins. Nothing in
> this directory uses a private API; the built-ins are built with the same
> `defineMiddleware` primitive third-party authors use.

This README covers only what is different about adding a middleware **to this
repository**.

## Adding a built-in

Mirror [`feature-flag/`](./feature-flag/):

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
- The key on `ctx` is the function name minus the `with` prefix, camelCased
  (`ctx.featureFlag`, `ctx.rateLimit`).
- Export the config and contribution interfaces alongside the middleware.
- Annotate the export with `Middleware<…>` explicitly — JSR rejects inferred
  public types.

Then wire up the new subpath in three places:

1. **[`package.json`](../../package.json)** — add an entry to `exports`:

   ```json
   "./<name>": {
     "import": {
       "types": "./dist/middleware/<name>/index.d.mts",
       "default": "./dist/middleware/<name>/index.mjs"
     },
     "require": {
       "types": "./dist/middleware/<name>/index.d.cts",
       "default": "./dist/middleware/<name>/index.cjs"
     }
   }
   ```

2. **[`tsdown.config.ts`](../../tsdown.config.ts)** — add
   `'src/middleware/<name>/index.ts'` to `entry`.

3. **[`jsr.json`](../../jsr.json)** — add
   `"./<name>": "./src/middleware/<name>/index.ts"` to `exports`.

Add the new entry point to [`typedoc.json`](../../typedoc.json) as well, and
list its README under `projectDocuments`, so it appears in the generated API
reference.

A third-party middleware published as its own package skips all of this — see
the [authoring guide](../../docs/authoring-guide.md).

## See also

- [Authoring guide](../../docs/authoring-guide.md) — build and publish your own middleware.
- [Composition primitives](../core/README.md) — `ctx` shape, conflict and prerequisite enforcement, the response seam.
