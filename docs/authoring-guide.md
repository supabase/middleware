---
title: Build your own middleware
---

# Build your own middleware

This guide walks the full path: from `defineMiddleware` to publishing your own
package, to composing it alongside the built-in entries. Every code block
**labeled with a path** is a complete file — write it to that path and it
compiles. Unlabeled blocks are fragments, and elide with `{ ... }`.

The example is `withValidatedBody`, a middleware that validates a JSON request
body and short-circuits with `400` when it fails. It is deliberately shaped like
the built-in [`withFeatureFlag`](../src/middleware/feature-flag/with-feature-flag.ts),
so anything you read here transfers to the shipped source and back.

## 0. The destination

This is where you end up — your middleware sitting alongside the built-in ones
in a single flat array, every contribution typed on `ctx`, wired straight into
the runtime's `fetch`:

```ts
export default {
  fetch: pipeline(
    [withCors({}), withFeatureFlag({ ... }), withValidatedBody({ ... })],
    async (_req, ctx) => Response.json({ data: ctx.validatedBody.data }),
  ),
}
```

There is no registry to join and no plugin interface to implement. A middleware
is a function produced by `defineMiddleware`; the ones this package ships and
the ones you publish are the same kind of thing, built with the same primitive.

### `pipeline`, or nesting

`pipeline` is a convenience, not a requirement. Entries nest directly, and the
result is the same handler:

```ts
export default {
  fetch: withCors({}, withFeatureFlag({ ... }, withValidatedBody({ ... },
    async (_req, ctx) => Response.json({ data: ctx.validatedBody.data }),
  ))) satisfies FetchHandler,
}
```

Nesting costs you the flat reading order past two or three entries, and it
wants the `satisfies FetchHandler` anchor on the outermost call: `ctx`
accumulates without it, but a duplicate key compiles silently and a
prerequisite nothing supplies isn't caught until the first request. What it
buys you is that `FetchHandler` is a _type_, so a consumer composing only
third-party middleware needs no runtime import from `@supabase/middleware` at
all — which is exactly why §2 re-exports the type from your own package.

The rest of this guide uses `pipeline`.

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
instead — that is what the built-in middleware do, and it is what makes
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

// Re-exported so a consumer who hand-nests instead of using `pipeline` can
// write `satisfies FetchHandler` without importing @supabase/middleware.
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
the `Response`. That holds for as long as the middleware ignores upstream
context. If yours reads a key someone else contributes, read on.

### Testing against an upstream context

A middleware that declares `In` — or whose config takes a callback reading
upstream keys — needs a context to run against. The obvious approach, passing
one as the second argument, is what the published signature invites and it
**silently does not work**:

```ts
// Wrong. The middleware sees an empty context.
await handler(req, { validatedBody: { valid: true, data: { name: 'ada' } } })
```

That positional slot is overloaded. `isContext` looks for a symbol marker only
`seedContext` sets, so an unmarked object there is read as the **host platform
argument** — a Workers `env`, a Deno `ServeHandlerInfo`. It is not merely
ignored: it is stored as the module-scoped platform env that `getEnv` reads, and
a fresh empty context is seeded for the stack instead. Nothing throws and
nothing warns. Your assertion fails somewhere unrelated, and every later test in
the same process now sees your fixture through `getEnv`.

Two forms work. Prefer the first — it is the production path:

```ts
// Compose under the middleware that actually contributes the key.
const handler = withValidatedBody(
  { validate: () => true },
  withAuditLog({ record }, async (_req, ctx) =>
    Response.json({ recorded: ctx.auditLog.recorded }),
  ),
)
await handler(post({ name: 'ada' }))

// Or mint a real context and spread your keys onto it. `seedContext` is
// exported for exactly this — a host embedding the engine uses the same path.
const audit = withAuditLog({ record }, async (_req, ctx) =>
  Response.json({ recorded: ctx.auditLog.recorded }),
)
await audit(post({ name: 'ada' }), {
  ...seedContext(),
  validatedBody: { valid: true, data: { name: 'ada' } },
})
```

`withAuditLog` is the example from
[requiring an upstream key](#variant-requiring-an-upstream-key).

### Type-level tests

Most of what a middleware promises is type-level: `ctx` accumulates, a duplicate
key collides, a prerequisite out of order fails. The `satisfies FetchHandler`
above covers the positive half, and cases that must compile can live beside your
source. Cases that must **fail** to compile cannot — `pnpm typecheck` would fail
on them — so they need their own project and a harness that asserts the expected
diagnostics actually appear.

Positive cases join the main `tsconfig.json`:

```ts
// type-tests/positive.ts
import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'

import { withValidatedBody } from '../src/with-validated-body.js'
import { withAuditLog } from '../src/with-audit-log.js'

// P1 — stands alone as a fetch entry.
const _p1 = withValidatedBody({ validate: () => true }, async (_req, ctx) =>
  Response.json({ data: ctx.validatedBody.data }),
) satisfies FetchHandler
void _p1

// P2 — composes, and `ctx` carries both keys.
const _p2 = pipeline(
  [
    withValidatedBody({ validate: () => true }),
    withAuditLog({ record: () => {} }),
  ],
  async (_req, ctx) =>
    Response.json({
      data: ctx.validatedBody.data,
      recorded: ctx.auditLog.recorded,
    }),
) satisfies FetchHandler
void _p2
```

Negative cases get their own project, and each one carries a marker naming the
diagnostic it expects:

```ts
// type-tests/negative.ts
// Marker format: `// @expect-error <TSCODE> <substring of the message>`
import { pipeline } from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'

import { withValidatedBody } from '../src/with-validated-body.js'
import { withAuditLog } from '../src/with-audit-log.js'

// N1 — `ctx` is genuinely typed, not silently `any`.
// @expect-error TS2339 Property 'nope' does not exist on type
withValidatedBody({ validate: () => true }, async (_req, ctx) =>
  Response.json({ data: ctx.nope }),
) satisfies FetchHandler

// N2 — prerequisite ordering is enforced.
// @expect-error TS2345 middleware-prereq
pipeline(
  [
    withAuditLog({ record: () => {} }),
    withValidatedBody({ validate: () => true }),
  ],
  async () => new Response(),
) satisfies FetchHandler

// N3 — a duplicate key collides.
// @expect-error TS2345 middleware-conflict
pipeline(
  [
    withValidatedBody({ validate: () => true }),
    withValidatedBody({ validate: () => true }),
  ],
  async () => new Response(),
) satisfies FetchHandler
```

```json
// type-tests/tsconfig.negative.json
{
  "extends": "../tsconfig.json",
  "include": ["negative.ts"]
}
```

**Check the message, not just that an error occurred.** `@ts-expect-error` would
prove only that _something_ failed. N1 exists to show `ctx` is not silently
`any`, and only the message text separates "correctly rejected" from "rejected
for an unrelated reason". The harness matches both directions — an expectation
with no diagnostic means a regression made the case compile; a diagnostic with
no expectation means the tests are failing for the wrong reason:

```js
// scripts/check-negative-types.mjs
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const FILE = 'type-tests/negative.ts'
const PROJECT = 'type-tests/tsconfig.negative.json'

const expectations = readFileSync(FILE, 'utf8')
  .split('\n')
  .flatMap((line, i) => {
    const m = /^\s*\/\/\s*@expect-error\s+(TS\d+)\s+(.+?)\s*$/.exec(line)
    return m ? [{ line: i + 1, code: m[1], message: m[2] }] : []
  })

if (expectations.length === 0) {
  console.error(
    `No @expect-error markers in ${FILE}. Refusing to pass vacuously.`,
  )
  process.exit(1)
}

const tsc = spawnSync(
  'node_modules/.bin/tsc',
  ['--noEmit', '--pretty', 'false', '-p', PROJECT],
  { encoding: 'utf8' },
)

// Fold tsc's indented continuation lines into the preceding diagnostic. Once
// two or more signatures in an overload set can take a handler, a collision is
// reported as TS2769 and the useful text — the `middleware-conflict` sentinel
// included — moves into the per-overload breakdown, where a parser that reads
// only top-level lines cannot see it.
const diagnostics = []
for (const line of `${tsc.stdout ?? ''}\n${tsc.stderr ?? ''}`.split('\n')) {
  const m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line)
  if (m) diagnostics.push({ file: m[1], line: m[2], code: m[4], message: m[5] })
  else if (diagnostics.length && /^\s+\S/.test(line))
    diagnostics[diagnostics.length - 1].message += `\n${line}`
}

const unclaimed = [...diagnostics]
const unmet = []
for (const e of expectations) {
  const i = unclaimed.findIndex(
    (d) => d.code === e.code && d.message.includes(e.message),
  )
  if (i === -1) unmet.push(e)
  else unclaimed.splice(i, 1)
}

for (const e of unmet)
  console.error(
    `${FILE}:${e.line} compiled — expected ${e.code} containing: ${e.message}`,
  )
for (const d of unclaimed)
  console.error(`Unexpected ${d.code} at ${d.file}:${d.line}: ${d.message}`)

if (unmet.length || unclaimed.length) process.exit(1)
console.log(
  `Negative type tests OK — ${expectations.length} expected errors, all matched.`,
)
```

Wire it up as `"typecheck:negative": "node scripts/check-negative-types.mjs"`.

## 4. The package

Two files, and they have to agree. `package.json` advertises where the built
entrypoint lives; `tsdown.config.ts` decides where the build actually puts it.

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
    "typecheck": "tsc --noEmit",
    "typecheck:negative": "node scripts/check-negative-types.mjs",
    "typecheck:consumer": "pnpm --dir test/ts-floor install --ignore-workspace && pnpm --dir test/ts-floor exec tsc --noEmit"
  },
  "dependencies": {
    "@supabase/middleware": "^0.3.0"
  },
  "devDependencies": {
    "tsdown": "^0.20.3",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  },
  "peerDependencies": {
    "typescript": ">=5.4"
  },
  "peerDependenciesMeta": {
    "typescript": {
      "optional": true
    }
  }
}
```

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Emit `dist/index.js` and `dist/index.d.ts` rather than `.mjs` and
  // `.d.mts`. tsdown defaults `fixedExtension` to `true` on the node platform,
  // which emits the dotted-m names — and the `exports` block above names the
  // plain ones. `"type": "module"` already marks the package as ESM, so a
  // plain `.js` extension is unambiguous.
  fixedExtension: false,
})
```

**Do not skip that config.** Without it, nothing complains: the build reports
success, `pnpm test` passes because vitest resolves through source, and
`pnpm typecheck` passes too — while `exports` points at two files that were
never emitted. The package is broken only from the outside, and the first
consumer to `import` it is the one who finds out.

**Depend on `@supabase/middleware` normally — it does not need to be a peer
dependency.** Contexts are marked with a `Symbol.for` key from the global symbol
registry, so two copies of the package loaded side by side still recognize each
other's contexts. A version skew between your middleware and the consumer's is
not a correctness problem.

**TypeScript is the one peer dependency you do need.** Your own source may never
write `NoInfer`, but your published `.d.ts` refers to `Middleware<…>`, and that
type's definition uses it — a TypeScript 5.4 intrinsic. You inherit the floor
whether or not you typed the word. What a consumer below it sees depends on
their `skipLibCheck`:

| Their TypeScript | `skipLibCheck` | What happens                             |
| ---------------- | -------------- | ---------------------------------------- |
| 5.4 or newer     | either         | Correct — a bogus `ctx` key is rejected  |
| 5.3              | `false`        | `TS2304: Cannot find name 'NoInfer'`     |
| 5.3              | `true`         | **Compiles clean, and `ctx` is untyped** |

The last row is why declaring it matters. `skipLibCheck: true` is the common
setting, so the failure is not a loud error a consumer can act on — it is the
quiet loss of the typing your middleware exists to provide. Marking the peer
`optional` keeps it from being installed by consumers who only want the runtime.

**ESM-only is the recommended default.** One condition pair, as above, is enough
for every runtime this targets. The engine's own package ships dual ESM and CJS
with four condition entries per subpath; that is a compatibility choice it makes
as a widely-depended-on library, not an obligation it passes on to you.

### The rest of the files

`package.json` and `tsdown.config.ts` are the two that have to agree with each
other. The rest is ordinary scaffolding, and the compiler options below are
load-bearing for the type tests in §3:

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "type-tests/positive.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

That leaves a `.gitignore` (`node_modules`, `dist`), a formatter config, and a
licence. For anything not spelled out here, the engine's own repository is the
reference scaffold — it is public, and every file above has a counterpart in it:
[github.com/supabase/middleware](https://github.com/supabase/middleware).

### CI

Four of these five steps are the ones you would write anyway. The fifth is the
one nobody adds unaided:

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

      - name: Assert the must-NOT-compile type tests still fail
        run: pnpm typecheck:negative

      - run: pnpm test
      - run: pnpm build

      - name: Typecheck a consumer against the published types at the floor
        run: pnpm typecheck:consumer
```

The last step is a fixture outside your workspace that pins the floor version of
`tsc` and compiles a consumer against your built `.d.ts`. It is what keeps the
`>=5.4` you declared honest: if you later reach for a newer intrinsic, this is
where you find out, rather than a consumer finding out for you.

`test/ts-floor/package.json` — unlabeled, because unlike `tsconfig.json` a
`package.json` is strict JSON and a comment makes it unparseable:

```json
{
  "name": "ts-floor-fixture",
  "private": true,
  "type": "module",
  "description": "Not part of the workspace — it pins its own tsc.",
  "dependencies": { "@acme/middleware-validated-body": "link:../.." },
  "devDependencies": { "typescript": "5.4.2" }
}
```

```ts
// test/ts-floor/consumer.ts
import { withValidatedBody } from '@acme/middleware-validated-body'

export const handler = withValidatedBody(
  { validate: () => true },
  async (_req, ctx) => Response.json({ data: ctx.validatedBody.data }),
)
```

Give it a `tsconfig.json` with the same options as the root one and
`"include": ["consumer.ts"]`.

Releases are a separate decision and this guide takes no position on it. The
engine uses release-please driven by conventional commits; its
`release-please-config.json` and `.github/workflows/release.yml` are a working
starting point if you want one.

## 5. Compose it with the built-in middleware

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
      ctx.cors // from withCors           — built-in
      ctx.featureFlag // from withFeatureFlag    — built-in
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
— composed without `pipeline`. There the anchor turns on collision detection
and asserts the stack can be the `fetch` export. Accumulation is ambient either
way. That is why §3's test uses it.

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
`satisfies FetchHandler` fails, and calling it with a request alone fails to
compile: it needs the context argument too. Anywhere the stack is checked
against `FetchHandler`, the prerequisite cannot become a lie at the top level.
An untyped `export default { fetch: … }` is no such check, which is why the
anchor matters.

## Variant: a config callback that reads upstream context

Some middleware take a **callback** in their configuration rather than only
plain values — a function called per request to derive something from the
request and the accumulated context. It is a useful shape, and it has one
wrinkle worth understanding before you publish it.

`Middleware<Key, Config, In, Contribution>` has no generic for the accumulated
upstream: `Base` appears only in the handler position. A config callback typed
through `defineMiddleware` can therefore see the keys you declared in `In`, and
nothing else. To let it see whatever the consumer composed upstream, thread a
`Base` parameter through the config type:

```ts
export interface WithRequestLogConfig<Base extends BaseContext = BaseContext> {
  log: (line: Record<string, unknown>) => void
  /** Extra fields, read off the request and the accumulated upstream context. */
  fields?: (req: Request, ctx: Base) => Record<string, unknown>
}
```

and publish a hand-written signature over the ordinary `defineMiddleware`
runtime — the pattern the
[`NoConflict` docblock](../src/core/define-middleware.ts) sanctions. Writing
that overload set correctly is its own topic; what matters here is what your
consumers then see, because the two composition forms are not equivalent.

**Nesting types it automatically.** There is nothing to annotate:

```ts
withValidatedBody(
  { validate: () => true },
  withRequestLog(
    { log, fields: (_r, ctx) => ({ body: ctx.validatedBody.data }) },
    async (_req, ctx) => Response.json({ logged: ctx.requestLog.logged }),
  ),
) satisfies FetchHandler
```

**The `pipeline` form needs one inline annotation** on the callback's `ctx`:

```ts
pipeline(
  [
    withValidatedBody({ validate: () => true }),
    withRequestLog({
      log,
      fields: (_r, ctx: { validatedBody: ValidatedBodyContribution }) => ({
        body: ctx.validatedBody.data,
      }),
    }),
  ],
  async (_req, ctx) => Response.json({ logged: ctx.requestLog.logged }),
)
```

Without it, `ctx` is the empty upstream:

```
Property 'validatedBody' does not exist on type 'object'
```

**That is evaluation order, not a defect.** `withRequestLog(config)` is a
complete expression, checked before `pipeline` ever sees the array, so position
cannot flow backwards into an argument already checked. `Entry` carries no
accumulated-context parameter, and adding one would not help — the config object
was checked at the inner call site. The only shape that would fix it is
`pipeline` taking unapplied pairs, `[withRequestLog, config]`, which is a large
API change for a small gain. Document the annotation; do not redesign around it.

### The annotation is an assertion, not a contract

This is the part to be careful about, and the reason the annotation deserves
more than a footnote. **Nothing checks it.** Compose the same entry with no
contributor for the key it names and it still compiles:

```ts
pipeline(
  [
    // withValidatedBody omitted — nothing supplies `validatedBody`
    withRequestLog({
      log,
      fields: (_r, ctx: { validatedBody: ValidatedBodyContribution }) => ({
        body: ctx.validatedBody.data,
      }),
    }),
  ],
  handler,
) satisfies FetchHandler // tsc exits 0
```

At runtime that throws `TypeError: Cannot read properties of undefined`. Written
with optional chaining instead it does something worse — it silently produces a
fallback value for every request and looks like working code.

`pipeline` is not the weak link here. It enforces declared prerequisites and
detects key collisions. The gap is that a config-callback annotation is a
_different_ channel, and only one of the two is checked:

| Channel                            | Enforced by `pipeline`?                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `In` (a declared prerequisite)     | **Yes** — `middleware-prereq: key 'validatedBody' is not yet on the context` |
| A config-callback param annotation | **No** — it asserts a shape; nothing verifies anyone supplies it             |

So the two composition forms differ in safety, not only in ergonomics. Nesting
catches a missing upstream precisely _because_ you write no annotation there —
the same code without a contributor above it fails with
`Property 'validatedBody' does not exist on type 'object'`.

Two rules follow:

1. **If your middleware requires the key, declare it in `In`.** Then the engine
   enforces it in both forms and names the missing key. Reach for a
   config-callback annotation only for context your middleware genuinely works
   without.
2. **If it optionally reads upstream context, annotate the key as optional** and
   handle its absence. That is the honest assertion, and it puts the compiler
   back in the loop — it will not let the callback assume a key nothing
   supplies:

```ts
const fields = (
  _r: Request,
  ctx: { validatedBody?: ValidatedBodyContribution },
) => ({ body: ctx.validatedBody?.data ?? null })
```

Both pipelines then compile, and neither can crash — with the contributor
present the field is populated, without it the fallback is deliberate rather
than accidental. Put the annotated form in your middleware's own `@example`
TSDoc, so the shape consumers copy is the safe one.

Nothing else about the `pipeline` form is affected. Composition, ordering,
prerequisites and handler typing all work at full fidelity with nothing
annotated — the handler's `ctx` above sees both keys either way — and a config
callback that does not read upstream context needs no annotation in either form.

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
built-in worked example: it answers preflight with a `return` before the
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
   `Response` is not an error — it can carry any status. This is about rejecting
   **requests**. Surfacing **misconfiguration** — a missing API key, an
   unparseable option — by throwing is fine and often right: there is no request
   to blame, and errors that escape `run` propagate to the host.

## See also

- [Composition primitives](../src/core/README.md) — `ctx` shape, conflict and
  prerequisite enforcement, the response seam.
- [`feature-flag`](../src/middleware/feature-flag/README.md) — the built-in
  request-side worked example.
- [`cors`](../src/middleware/cors/README.md) — the built-in response-seam
  worked example.
- [Adding a middleware to this repository](../src/middleware/README.md) — for
  built-ins rather than standalone packages.
