---
title: Build your own middleware
---

# Build your own middleware

This guide walks the full path: from `defineMiddleware` to publishing your own
package, to composing it in the same `pipeline` array as the first-party
entries. Every code block below is a **complete file** with its path in the
first line — write it to that path and it compiles. Nothing is elided.

The example is `withValidatedBody`, a middleware that validates a JSON request
body and short-circuits with `400` when it fails. It is deliberately shaped like
the first-party [`withFeatureFlag`](../src/middleware/feature-flag/with-feature-flag.ts),
so anything you read here transfers to the shipped source and back.

## 0. The destination

This is where you end up — your middleware sitting alongside first-party ones in
a single flat array, every contribution typed on `ctx`:

```ts
pipeline(
  [withCors({}), withFeatureFlag({ ... }), withValidatedBody({ ... })],
  async (_req, ctx) => Response.json({ data: ctx.validatedBody.data }),
)
```

There is no registry to join and no plugin interface to implement. A middleware
is a function produced by `defineMiddleware`; first-party and third-party
middleware are the same kind of thing, built with the same primitive.

### Which form do you need?

Write a plain `async` `run`. It executes **before** the handler and never sees
the handler's `Response`, which keeps response shape under a single owner.

Reach for the generator form (`async function*`, covered at the end) only when a
concern is genuinely two-sided — stamping headers on the way out, timing,
request-spanning cleanup. If you are only _producing_ a response, do it in the
handler instead.

## 1. The middleware

`defineMiddleware` takes four type parameters and a spec of `{ key, run }`:

| Parameter      | What it is                                      | Here                        |
| -------------- | ----------------------------------------------- | --------------------------- |
| `Key`          | The literal-string slot contributed to `ctx`    | `'validatedBody'`           |
| `Config`       | What the consumer passes to `withValidatedBody` | `WithValidatedBodyConfig`   |
| `In`           | Upstream keys required before this runs         | `Record<never, never>`      |
| `Contribution` | The shape that lands at `ctx[Key]`              | `ValidatedBodyContribution` |

`run` has two stages. The outer `(config) =>` runs **once**, when the consumer
constructs the middleware — derive computed config there. The inner
`(req, ctx) =>` runs **per request**, and returns either a `Response`
(short-circuit; the handler never runs) or a single-key object
`{ [key]: contribution }` (fall through).

Anything that needs an environment value — an API client built from a secret —
does **not** belong in the outer stage. See
[client init and `getEnv` timing](#client-init-and-getenv-timing) below.

````ts
// src/with-validated-body.ts
import { defineMiddleware } from '@supabase/middleware'
import type { Middleware } from '@supabase/middleware'

/** Per-instance configuration for {@link withValidatedBody}. */
export interface WithValidatedBodyConfig {
  /**
   * Decide whether the parsed JSON body is acceptable. Return `true`/`false`
   * for a plain check, or a {@link ValidationVerdict} to also normalize the
   * data or report errors. Async is fine — use any validator you like.
   */
  validate: (
    body: unknown,
    req: Request,
  ) => Promise<boolean | ValidationVerdict> | boolean | ValidationVerdict

  /** HTTP status when validation fails. @defaultValue `400` */
  rejectStatus?: number

  /** Body when validation fails. @defaultValue `{ error: 'invalid_body', errors }` */
  rejectBody?: unknown
}

/** Richer return shape `validate` may produce in place of a plain boolean. */
export interface ValidationVerdict {
  /** Whether the body is acceptable. */
  valid: boolean
  /** Normalized data to expose downstream. Defaults to the parsed body. */
  data?: unknown
  /** Messages included in the default rejection body. */
  errors?: string[]
}

/**
 * Shape contributed at `ctx.validatedBody` after a successful validation.
 *
 * `valid: true` is encoded in the type — the handler only ever sees this shape
 * when validation passed, so `if (!ctx.validatedBody.valid)` is a dead branch
 * by construction.
 */
export interface ValidatedBodyContribution {
  /** Always `true` — this shape is only produced on success. */
  valid: true
  /** The validated body: the verdict's `data`, or the parsed body. */
  data: unknown
}

/**
 * Validate a JSON request body before the handler runs.
 *
 * @example
 * ```ts
 * withValidatedBody(
 *   { validate: (body) => typeof body === 'object' && body !== null },
 *   async (_req, ctx) => Response.json({ received: ctx.validatedBody.data }),
 * )
 * ```
 */
export const withValidatedBody: Middleware<
  'validatedBody',
  WithValidatedBodyConfig,
  Record<never, never>,
  ValidatedBodyContribution
> = defineMiddleware<
  // 1. Key — the slot this contributes to `ctx`. Must be unique in a stack.
  'validatedBody',
  // 2. Config — what the consumer passes to `withValidatedBody(config, handler)`.
  WithValidatedBodyConfig,
  // 3. In — upstream prerequisites. `Record<never, never>` = none, so this can
  //    be used standalone or anywhere in a stack.
  Record<never, never>,
  // 4. Contribution — the shape that lands at `ctx.validatedBody`.
  ValidatedBodyContribution
>({
  key: 'validatedBody',
  run: (config) => async (req) => {
    const reject = (errors: string[]) =>
      Response.json(config.rejectBody ?? { error: 'invalid_body', errors }, {
        status: config.rejectStatus ?? 400,
      })

    // Reading the body here does not consume it: the framework hands every
    // layer a buffered request, so the handler can read it again.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return reject(['body is not valid JSON'])
    }

    const result = await config.validate(body, req)
    const verdict: ValidationVerdict =
      typeof result === 'boolean' ? { valid: result } : result

    if (!verdict.valid) {
      // Short-circuit: return a Response and the handler never runs.
      return reject(verdict.errors ?? [])
    }

    // Contribute: fall through with this shape on `ctx.validatedBody`.
    return { validatedBody: { valid: true, data: verdict.data ?? body } }
  },
})
````

Four things in that file are worth calling out.

**The body stays readable.** A Fetch `Request` body is normally a single-use
stream, so reading it here would lock out the handler. It does not: the
framework hands every layer a buffered request that caches the body after the
first read, so your middleware and the handler can both read it, in any form
(`text`, `json`, `arrayBuffer`, `bytes`, `blob`, `formData`). The one deliberate
limit is that reading the raw `req.body` **stream** bypasses the cache — to
forward a body onward, reconstruct it from `await req.arrayBuffer()`.

**The explicit `Middleware<…>` annotation is not optional ceremony.** It is what
lets the package publish to JSR, which rejects inferred public types.

**`data` is `unknown` on purpose,** because this example accepts any validator.
A middleware written for one domain should make its contribution concrete
instead — that is what the first-party middleware do, and it is what makes
`ctx.yourKey` genuinely useful to a handler without a cast.

**Explicit reject config beats a thrown error.** Returning a `Response` is not
an error path — it can carry any status. Errors that escape `run` propagate to
the host, so handle what you can describe.

### Client init and `getEnv` timing

Read configuration through `getEnv` (rule 2) — never `process.env`, `Deno.env`,
or a Workers bindings object. That is what keeps a middleware portable. But
`getEnv` has one timing constraint that decides _where_ you can call it.

On Cloudflare Workers, env bindings are not ambient: they arrive per request as
the second `fetch` argument, and the framework captures them when the host
invokes the outermost handler. **Until the first request lands, `getEnv` returns
`undefined` on Workers** (`src/core/runtime.ts` documents the resolution order).
The outer `(config) =>` stage runs at construction — typically at module top
level — which is before that. So this is portable everywhere except the one
runtime it most needs to be portable on:

```ts
run: (config) => {
  const client = new Client(getEnv('API_KEY')) // undefined on Workers
  return async () => ({ myKey: await client.check() })
}
```

Construct on first request instead and cache with `??=`. That runs once per
isolate, not once per request, so it costs a single nullish check thereafter:

```ts
// src/with-notifier.ts
import { defineMiddleware, getEnv } from '@supabase/middleware'
import type { Middleware } from '@supabase/middleware'

/** Per-instance configuration for {@link withNotifier}. */
export interface WithNotifierConfig {
  /** Name of the env var holding the API key. @defaultValue `'NOTIFIER_API_KEY'` */
  apiKeyEnv?: string
}

/** Shape contributed at `ctx.notifier`. */
export interface NotifierContribution {
  /** Send a notification through the provider. */
  notify: (message: string) => Promise<Response>
}

/** Stands in for whatever provider SDK you construct with a secret. */
class NotifierClient {
  constructor(private readonly apiKey: string) {}
  notify(message: string): Promise<Response> {
    return fetch('https://api.example.com/notify', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message }),
    })
  }
}

function requireEnv(name: string): string {
  const value = getEnv(name)
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** Exposes a lazily constructed notification client at `ctx.notifier`. */
export const withNotifier: Middleware<
  'notifier',
  WithNotifierConfig | undefined,
  Record<never, never>,
  NotifierContribution
> = defineMiddleware<
  'notifier',
  WithNotifierConfig | undefined,
  Record<never, never>,
  NotifierContribution
>({
  key: 'notifier',
  run: (config) => {
    // Outer stage — runs once, at construction. Plain config resolves here.
    const apiKeyEnv = config?.apiKeyEnv ?? 'NOTIFIER_API_KEY'

    // Deferred: `getEnv(apiKeyEnv)` would be `undefined` here on Workers.
    let client: NotifierClient | undefined

    return async () => {
      // First request — bindings have arrived, so `getEnv` resolves. `??=`
      // keeps this to one construction for the life of the isolate.
      const ready = (client ??= new NotifierClient(requireEnv(apiKeyEnv)))
      return { notifier: { notify: (message) => ready.notify(message) } }
    }
  },
})
```

The rule of thumb: **the outer stage is for values you already hold; the first
request is for values the host has to give you.**

## 2. Public exports

```ts
// src/index.ts
export { withValidatedBody } from './with-validated-body.js'
export type {
  WithValidatedBodyConfig,
  ValidationVerdict,
  ValidatedBodyContribution,
} from './with-validated-body.js'

// Re-exported so consumers can write `satisfies FetchHandler` with one import.
export type { FetchHandler } from '@supabase/middleware'
```

Export the config and contribution interfaces alongside the middleware —
consumers need them to type their own wrappers.

## 3. Tests

Cover both `run` outcomes, the request passthrough, and the body-reread
guarantee. Use `vi.fn` for the inner handler when you need to assert it was, or
was not, called.

```ts
// src/with-validated-body.test.ts
import { describe, expect, it, vi } from 'vitest'

import { withValidatedBody, type FetchHandler } from './index.js'

const post = (body: unknown) =>
  new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// Type-level check, verified by `tsc`: the composed stack is a fetch entry.
const _anchored = withValidatedBody(
  { validate: () => true },
  async (_req, ctx) => Response.json({ data: ctx.validatedBody.data }),
) satisfies FetchHandler
void _anchored

describe('withValidatedBody', () => {
  it('contributes the validated body when validate passes', async () => {
    const inner = vi.fn(async (_req: Request, ctx) => {
      expect(ctx.validatedBody).toEqual({ valid: true, data: { name: 'ada' } })
      return Response.json({ ok: true })
    })

    const handler = withValidatedBody({ validate: () => true }, inner)

    const res = await handler(post({ name: 'ada' }))
    expect(res.status).toBe(200)
    expect(inner).toHaveBeenCalledOnce()
  })

  it('short-circuits with 400 without calling the handler', async () => {
    const inner = vi.fn(async () => Response.json({ ok: true }))

    const handler = withValidatedBody(
      { validate: () => ({ valid: false, errors: ['name is required'] }) },
      inner,
    )

    const res = await handler(post({}))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_body',
      errors: ['name is required'],
    })
    expect(inner).not.toHaveBeenCalled()
  })

  it('rejects a body that is not valid JSON', async () => {
    const handler = withValidatedBody({ validate: () => true }, async () =>
      Response.json({ ok: true }),
    )

    const res = await handler(
      new Request('http://localhost/', { method: 'POST', body: 'not json' }),
    )
    expect(res.status).toBe(400)
  })

  it('exposes normalized data from a verdict', async () => {
    const handler = withValidatedBody(
      { validate: () => ({ valid: true, data: { name: 'ADA' } }) },
      async (_req, ctx) => Response.json(ctx.validatedBody.data),
    )

    const res = await handler(post({ name: 'ada' }))
    expect(await res.json()).toEqual({ name: 'ADA' })
  })

  it('leaves the body readable by the handler', async () => {
    const handler = withValidatedBody({ validate: () => true }, async (req) => {
      // The middleware already read the body; this read still works.
      const again = await req.json()
      return Response.json({ again })
    })

    const res = await handler(post({ name: 'ada' }))
    expect(await res.json()).toEqual({ again: { name: 'ada' } })
  })

  it('honors a custom rejectStatus and rejectBody', async () => {
    const handler = withValidatedBody(
      {
        validate: () => false,
        rejectStatus: 422,
        rejectBody: { code: 'UNPROCESSABLE' },
      },
      async () => Response.json({ ok: true }),
    )

    const res = await handler(post({}))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ code: 'UNPROCESSABLE' })
  })

  it('supports async validators', async () => {
    const handler = withValidatedBody(
      {
        validate: async () => {
          await new Promise((r) => setTimeout(r, 1))
          return true
        },
      },
      async (_req, ctx) => Response.json(ctx.validatedBody.data),
    )

    const res = await handler(post({ name: 'ada' }))
    expect(res.status).toBe(200)
  })
})
```

No test harness is needed. A composed middleware is just a
`(req, ctx?) => Promise<Response>`, so you call it with a `Request` and assert on
the `Response`.

## 4. The package

```json
{
  "name": "@acme/middleware-validated-body",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "sideEffects": false,
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/middleware": "^0.1.0"
  },
  "devDependencies": {
    "tsdown": "^0.20.3",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

**Depend on `@supabase/middleware` normally — it does not need to be a peer
dependency.** Contexts are marked with a `Symbol.for` key from the global symbol
registry, so two copies of the package loaded side by side still recognize each
other's contexts. A version skew between your middleware and the consumer's is
not a correctness problem.

## 5. Compose it with first-party middleware

```ts
// server.ts
import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'
import { withValidatedBody } from '@acme/middleware-validated-body'

export default {
  fetch: pipeline(
    [
      withCors({ origin: ['https://app.example.com'] }),
      withFeatureFlag({
        name: 'beta-api',
        evaluate: (req) => req.headers.get('x-beta') === '1',
      }),
      withValidatedBody({
        validate: (body) =>
          typeof body === 'object' && body !== null && 'name' in body,
      }),
    ],
    async (_req, ctx) => {
      ctx.cors // from withCors           — first-party
      ctx.featureFlag // from withFeatureFlag    — first-party
      ctx.validatedBody // from withValidatedBody  — yours

      return Response.json({
        flag: ctx.featureFlag.name,
        data: ctx.validatedBody.data,
      })
    },
  ) satisfies FetchHandler,
}
```

First in the array runs first on the request. `pipeline` returns the outermost
`(req, ctx) => Response` — that **is** the `fetch` handler, with no wrapper
around it.

With `pipeline`, accumulation and collision detection are **built in** — the
handler sees every upstream key on `ctx`, and duplicating a key fails to compile
with `middleware-conflict: key '…' is already present on the upstream context`,
with no anchor anywhere. `pipeline` already returns `FetchHandler`, so the
`satisfies FetchHandler` above is type-only documentation of the export shape.

Where it does carry weight is the **hand-nested** form — `withCors({}, withFeatureFlag({…}, handler))`
— composed without `pipeline`. There the anchor is what turns on ambient
accumulation and collision detection, which is why §3's test uses it.

## Variant: requiring an upstream key

Set `In` when your middleware needs a key another middleware contributes. This
is a compile-time contract, not a runtime check.

```ts
// src/with-audit-log.ts
import { defineMiddleware } from '@supabase/middleware'
import type { Middleware } from '@supabase/middleware'

import type { ValidatedBodyContribution } from './with-validated-body.js'

/** Upstream keys this middleware requires. */
export interface WithAuditLogIn {
  validatedBody: ValidatedBodyContribution
}

/** Per-instance configuration for {@link withAuditLog}. */
export interface WithAuditLogConfig {
  /** Called once per request with the already-validated body. */
  record: (entry: { url: string; data: unknown }) => Promise<void> | void
}

/** Shape contributed at `ctx.auditLog`. */
export interface AuditLogContribution {
  /** Whether the entry was recorded. */
  recorded: boolean
}

/**
 * Records an audit entry from the validated body.
 *
 * Declares `validatedBody` as a prerequisite, so it can only compose after a
 * middleware that provides it. Placing it earlier fails to compile.
 */
export const withAuditLog: Middleware<
  'auditLog',
  WithAuditLogConfig,
  WithAuditLogIn,
  AuditLogContribution
> = defineMiddleware<
  'auditLog',
  WithAuditLogConfig,
  // In — the upstream shape this middleware requires. Not a runtime check:
  // composing without `validatedBody` is a type error at the call site.
  WithAuditLogIn,
  AuditLogContribution
>({
  key: 'auditLog',
  run: (config) => async (req, ctx) => {
    // `ctx.validatedBody` is typed here because it is declared in `In`.
    await config.record({ url: req.url, data: ctx.validatedBody.data })
    return { auditLog: { recorded: true } }
  },
})
```

Composed in the right order it just works, and needs no anchor —
prerequisite-declared keys type on their own:

```ts
pipeline(
  [
    withValidatedBody({ validate: () => true }),
    withAuditLog({ record: (entry) => console.log(entry) }),
  ],
  async (_req, ctx) => Response.json({ recorded: ctx.auditLog.recorded }),
)
```

Reverse those two entries and compilation fails with
`middleware-prereq: key 'validatedBody' is not yet on the context (check ordering)`.

A middleware with prerequisites also cannot stand alone as a `fetch` entry. You
can still construct it, but its `ctx` is required rather than optional, so
`satisfies FetchHandler` fails and calling it with a request alone is an
arity error. The prerequisite can never become a lie at the top level.

## Variant: the response seam

When a concern is genuinely two-sided, write `run` as an `async function*`.
`yield` is the seam: code before it is the request phase, the `yield` expression
resolves to the downstream `Response`, and code after it is the response phase.

```ts
// src/with-timing.ts
import { defineMiddleware } from '@supabase/middleware'
import type { Middleware } from '@supabase/middleware'

/** Per-instance configuration for {@link withTiming}. */
export interface WithTimingConfig {
  /** Metric name used in the `Server-Timing` header. @defaultValue `'total'` */
  metric?: string
}

/** Shape contributed at `ctx.timing`. */
export interface TimingContribution {
  /** When the request entered this middleware, from `performance.now()`. */
  startedAt: number
}

/**
 * Times the request and stamps a `Server-Timing` header on the way out.
 *
 * Genuinely two-sided, so `run` is an `async function*`: code before the
 * `yield` is the request phase, the `yield` expression resolves to the
 * downstream `Response`, and code after it is the response phase.
 */
export const withTiming: Middleware<
  'timing',
  WithTimingConfig | undefined,
  Record<never, never>,
  TimingContribution
> = defineMiddleware<
  'timing',
  WithTimingConfig | undefined,
  Record<never, never>,
  TimingContribution
>({
  key: 'timing',
  run: (config) =>
    async function* () {
      const metric = config?.metric ?? 'total'
      const startedAt = performance.now() // request phase

      // Contribute, then suspend. The rest of the stack runs.
      const response = yield { timing: { startedAt } }

      // Response phase. Copy the headers so an immutable response is handled.
      const headers = new Headers(response.headers)
      headers.append(
        'Server-Timing',
        `${metric};dur=${(performance.now() - startedAt).toFixed(1)}`,
      )
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
})
```

Typing `Config` as `WithTimingConfig | undefined` is what makes the config
argument optional, so consumers can write `withTiming()` as well as
`withTiming({ metric: 'api' })`.

Rules for the seam:

- `yield` the contribution **at most once**. `yield` always means "run
  downstream and hand me the response."
- To short-circuit, `return new Response(...)` — the same as the request-side
  path. There is then no response phase to reach.
- `try { … yield … } finally { … }` runs cleanup even when something downstream
  throws. A `try`/`catch` around the `yield` can turn a downstream throw into a
  `Response`.
- Returning nothing passes the downstream response through untouched.

The runtime picks the path from what the body returns, so the plain `async` case
is unaffected. [`withCors`](../src/middleware/cors/with-cors.ts) is the
first-party worked example: it answers preflight with a `return` before the
`yield`, and stamps headers after.

## Rules

1. **MUST** contribute exactly one key. A middleware that wants two slots is
   doing too much — split it.
2. **MUST** read configuration through `getEnv` from `@supabase/middleware`.
   **NEVER** touch `process.env`, `Deno.env`, or a Workers bindings object
   directly — that is what makes the middleware portable across hosts.
   **NEVER** call `getEnv` in the outer `(config) =>` stage: on Workers it
   returns `undefined` before the first request. Construct env-dependent clients
   lazily on first request — see
   [client init and `getEnv` timing](#client-init-and-getenv-timing).
3. **MUST** declare upstream requirements in `In`. **NEVER** check for them at
   runtime.
4. **NEVER** `yield` more than once in a generator `run`.
5. **NEVER** use the response seam to produce a response the handler could
   produce itself. Default to a plain `async` `run`.
6. **MUST** pick a key that is unique in a stack. If a consumer might reasonably
   apply your middleware twice, expose a key override in its config.
7. **NEVER** import from `node:*`. Web Fetch APIs only, so the middleware runs
   on Deno, Cloudflare Workers, Bun, and Node alike.
8. **MUST** return a `Response` to short-circuit, rather than throwing. A
   `Response` is not an error — it can carry any status.

## See also

- [Composition primitives](../src/core/README.md) — `ctx` shape, conflict and
  prerequisite enforcement, the response seam.
- [`feature-flag`](../src/middleware/feature-flag/README.md) — the first-party
  request-side worked example.
- [`cors`](../src/middleware/cors/README.md) — the first-party response-seam
  worked example.
- [Adding a middleware to this repository](../src/middleware/README.md) — for
  built-ins rather than standalone packages.
