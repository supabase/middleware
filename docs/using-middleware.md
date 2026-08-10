# Using middleware

> **Status: work in progress.** This page is being written alongside the
> investigation in `mattjo/fix/deep-nesting-inference`. Code blocks that have been
> checked with `tsc` against this repo carry no marker; blocks that have **not**
> been verified carry an `UNVERIFIED` comment inside the block itself. The
> "two-level ceiling" section below describes a real, currently-unfixed limitation —
> if that gets fixed, this page needs rewriting.

This is the consumer-facing guide. If you want to _write_ a middleware, see the
[authoring guide](../src/middleware/README.md).

## Who this page is for

A middleware is a `withFoo` function. There are two ways to stack them, and which one
you reach for changes what you have to install:

| You are                                     | Install `@supabase/middleware`? | Import from it?                     |
| ------------------------------------------- | ------------------------------- | ----------------------------------- |
| **Nesting** — `withFoo(config, handler)`    | no — transitive only            | never                               |
| **`pipeline`** — `pipeline([...], handler)` | yes, direct dependency          | `pipeline`, `Entry`, `FetchHandler` |
| **Authoring** — `defineMiddleware(...)`     | yes, direct dependency          | `defineMiddleware`, types           |

`cors` and `feature-flag` ship in this repo, but they are _worked examples_. Most
middleware will be their own packages built on `defineMiddleware`. So a consumer who
nests installs only the middleware they actually want:

```ts
// UNVERIFIED — illustrative third-party package; the shape is accurate, but this
// import does not resolve in this repo and has not been typechecked.
import { withRateLimit } from '@acme/with-rate-limit'

export default {
  fetch: withRateLimit({ limit: 100 }, async () => Response.json({ ok: true })),
}
```

That consumer never adds `@supabase/middleware` to their `package.json`, and never
has to learn `pipeline`, `Entry`, or `satisfies FetchHandler`. **Nesting is the
zero-dependency path.**

## Composing by nesting

The outermost runs first. Each middleware contributes one typed key to `ctx`:

```ts
import { withCors } from '@supabase/middleware/cors'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: withCors(
    {},
    withFeatureFlag(
      { name: 'beta', evaluate: (req) => req.headers.has('x-beta') },
      async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
    ),
  ),
}
```

At runtime this composes to any depth — a four-deep stack puts all four keys on `ctx`
with no ceremony. The **types** are a different story; see the ceiling below.

### The anchor

By default a nested handler sees only _its own_ middleware's key. To make the
innermost handler see **every** upstream key, and to turn on collision detection,
annotate the outermost call with `satisfies FetchHandler`:

```ts
import { defineMiddleware } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'

const withAlpha = defineMiddleware<
  'alpha',
  void,
  Record<never, never>,
  { v: number }
>({
  key: 'alpha',
  run: () => async () => ({ alpha: { v: 1 } }),
})
const withBeta = defineMiddleware<
  'beta',
  void,
  Record<never, never>,
  { v: number }
>({
  key: 'beta',
  run: () => async () => ({ beta: { v: 2 } }),
})

export default {
  fetch: withAlpha(
    withBeta(async (_req, ctx) => {
      ctx.alpha.v // visible only because of the anchor
      ctx.beta.v
      return Response.json({ ok: true })
    }),
  ) satisfies FetchHandler,
}
```

The anchor is type-only — it emits no runtime code. It exists because without a
concrete type at the outermost call, TypeScript infers the context bottom-up and it
collapses. This was established during design with five `tsc` experiments; a `Base`
default, a trailing finalize call, and alternative signature shapes were all tried and
none substitute for it. (That decision record lived at
`docs/solutions/anchor-ergonomics.md`, added in `26dacce` and deleted in `ae39f4c`.)

Omitting the anchor is safe at runtime. You lose exactly two things: ambient
accumulation and collision detection. Prerequisites declared via `In` still type with
no anchor.

### The two-level ceiling

**The anchor only cascades one level.** Nesting is typed at depth 2. At depth 3 and
beyond, the anchor does not compile at all:

```ts
// UNVERIFIED as written — but the failure IS verified: this exact shape produces
// `TS2769: No overload matches this call`, even when the handler reads nothing
// off ctx. Do not copy this block; it does not compile.
withAlpha(
  withBeta(withGamma(async () => Response.json({ ok: true }))),
) satisfies FetchHandler
```

Your options at depth 3+:

1. **Drop the anchor.** It compiles and runs correctly — all keys are on `ctx` at
   runtime — but the handler only sees its own middleware's key, and collision
   detection goes quiet.
2. **Annotate the middle level by hand.** Verified to work, but it means writing out
   the accumulated context yourself:

   ```ts
   // UNVERIFIED as written (needs the surrounding declarations), but this technique
   // is verified: supplying Base on the MIDDLE level restores full accumulation.
   withAlpha(
     withBeta<object & { alpha: { v: number } }>(withGamma(handler)),
   ) satisfies FetchHandler
   ```

3. **Use `pipeline`,** which has no depth limit.

This is the one place the two styles genuinely differ in capability rather than
taste. Tracking: red tests are on `mattjo/fix/deep-nesting-inference`.

## Composing with `pipeline`

Call a middleware with config only — `withFoo(config)`, or `withFoo()` for a
config-less one — and you get an `Entry`. Pass a flat array plus a final handler.
First in the array runs first:

```ts
import { pipeline } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

export default {
  fetch: pipeline(
    [
      withCors({}),
      withFeatureFlag({
        name: 'beta',
        evaluate: (req) => req.headers.has('x-beta'),
      }),
    ],
    async (_req, ctx) => {
      ctx.cors.allowedOrigin
      ctx.featureFlag.name
      return Response.json({ ok: true })
    },
  ),
}
```

Note there is **no anchor**. `pipeline` accumulates `ctx` by folding the array in
type-space rather than relying on contextual inference, so it needs no annotation and
has no depth limit. This costs you a direct dependency on `@supabase/middleware`.

## They are the same stack

`pipeline` folds its array into exactly the nested calls you would write by hand
(`src/core/pipeline.ts:93-96`), and an `Entry` is literally a deferred nesting call
(`src/core/define-middleware.ts:117-133`). There is no separate runtime path. Proven
by `src/core/pipeline.test.ts:56` and `src/core/define-middleware.test.ts:522,558`.

## Which should I use?

|                                      | Nesting                            | `pipeline`            |
| ------------------------------------ | ---------------------------------- | --------------------- |
| Dependency on `@supabase/middleware` | none (transitive)                  | direct                |
| Middleware at runtime                | any number                         | any number            |
| Middleware **typed**                 | 2 (anchor ceiling)                 | any number            |
| Anchor required                      | yes, for accumulation + collisions | no                    |
| Code shape                           | nests rightward                    | flat, top-to-bottom   |
| Reordering                           | rewrite the nesting                | move a line           |
| Per-route / branching stacks         | natural — it's just a handler      | terminal handler only |

Short version: nesting if you want to depend on nothing and you're one or two
middleware deep; `pipeline` once you want typed accumulation across a longer stack.

## Type guarantees

All rows below were checked with `tsc` against this repo.

| Guarantee                  | Nesting, no anchor                         | Nesting + anchor        | `pipeline`                 |
| -------------------------- | ------------------------------------------ | ----------------------- | -------------------------- |
| Handler sees own key       | ✅                                         | ✅                      | ✅                         |
| Handler sees upstream keys | ❌                                         | ✅ at depth 2, ❌ at 3+ | ✅                         |
| Duplicate key rejected     | ❌ silent                                  | ✅                      | ✅ (no anchor needed)      |
| Prerequisite enforced      | ✅ at point of use                         | ✅                      | ✅ at the composition site |
| Wrong prerequisite order   | surfaces later, on use as a `FetchHandler` | same                    | ✅ named error message     |

`pipeline`'s ordering error names the offending key —
`middleware-prereq: key 'auth' is not yet on the context (check ordering)` —
because `Validate` walks the tuple in order (`src/core/pipeline.ts:47-56`).

## Not supported

`pipeline(...)` returns a `FetchHandler`, not an `Entry`, so a pipeline cannot be an
element of another pipeline's array. There is no exported `group()` or `compose()`
combinator — the full export list is in `src/index.ts`.

## See also

- [Composition primitives](../src/core/README.md) — `ctx` shape, the response seam.
- [Authoring guide](../src/middleware/README.md) — write your own middleware.
- [feature-flag](../src/middleware/feature-flag/README.md) · [cors](../src/middleware/cors/README.md)
