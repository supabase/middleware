import { describe, expect, it, vi } from 'vitest'

import { withCors } from '../middleware/cors/with-cors.js'
import { withFeatureFlag } from '../middleware/feature-flag/with-feature-flag.js'
import { defineMiddleware } from './define-middleware.js'
import type { NoConflict } from './define-middleware.js'
import { pipeline } from './pipeline.js'
import type { BaseContext, FetchHandler } from './runtime.js'
import { getEnv, seedContext } from './runtime.js'
import type { Conflict, SingleKeyEntry } from './types.js'

const innerOk = async () => Response.json({ ok: true })

/** Marked base context for tests that supply a context directly. */
const base: BaseContext = seedContext()

const passing = <Key extends string, C extends object>(
  key: Key,
  contribution: C,
) =>
  defineMiddleware<Key, void, Record<never, never>, C>({
    key,
    run: () => async () => ({ [key]: contribution }) as { [K in Key]: C },
  })

const rejecting = <Key extends string>(key: Key, status = 401) =>
  defineMiddleware<Key, void, Record<never, never>, Record<never, never>>({
    key,
    run: () => async () => new Response(`rejected by ${key}`, { status }),
  })

describe('defineMiddleware', () => {
  it('runs the middleware, contributes its key, and self-seeds its context', async () => {
    const withGreeting = defineMiddleware<
      'greeting',
      { who: string },
      Record<never, never>,
      { hello: string }
    >({
      key: 'greeting',
      run: (config) => async () => ({ greeting: { hello: config.who } }),
    })

    const fetchHandler = withGreeting({ who: 'world' }, async (_req, ctx) =>
      Response.json({ msg: ctx.greeting.hello }),
    )

    // Invoked as a bare fetch entry — ctx is seeded internally.
    const res = await fetchHandler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ msg: 'world' })
  })

  const withGreeting = defineMiddleware<
    'greeting',
    void,
    Record<never, never>,
    { hello: string }
  >({
    key: 'greeting',
    run: () => async () => ({ greeting: { hello: 'hi' } }),
  })

  it('does not let a host-supplied env (arg 2) leak into ctx', async () => {
    const fetchHandler = withGreeting(async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx) }),
    )

    // Simulate a runtime calling fetch(req, env) with an enumerable env object.
    const res = await (
      fetchHandler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { SECRET: 's' })
    expect(await res.json()).toEqual({ keys: ['greeting'] })
  })

  it('captures a host-supplied env (arg 2) behind the importable getEnv', async () => {
    const fetchHandler = withGreeting(async () =>
      Response.json({ fromEnv: getEnv('__WM_BINDING__') ?? null }),
    )

    const res = await (
      fetchHandler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { __WM_BINDING__: 'bound' })
    expect(await res.json()).toEqual({ fromEnv: 'bound' })
    seedContext({}) // clear the stash so other tests see a clean slate
  })

  it('warns (does not throw) and ignores a third fetch argument (exec context)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchHandler = withGreeting(async (_req, ctx) =>
        Response.json({ keys: Object.keys(ctx) }),
      )

      // Simulate Cloudflare Workers calling fetch(req, env, executionContext).
      const res = await (
        fetchHandler as (req: Request, ...a: unknown[]) => Promise<Response>
      )(new Request('http://localhost/'), { SECRET: 's' }, { waitUntil() {} })

      // Proceeds normally; the env (arg 2) still does not leak into ctx, and the
      // execution context (arg 3) is ignored rather than throwing.
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ keys: ['greeting'] })
    } finally {
      warn.mockRestore()
    }
  })

  it('req body is readable from multiple layers (buffered request)', async () => {
    // A body-reading middleware (e.g. a signature check) followed by a handler
    // that also reads the body — both read `req`, no "Body already consumed".
    const withReader = defineMiddleware<
      'reader',
      void,
      Record<never, never>,
      { len: number }
    >({
      key: 'reader',
      run: () => async (req) => ({
        reader: { len: (await req.text()).length },
      }),
    })

    const fetchHandler = withReader(async (req, ctx) => {
      const parsed = (await req.json()) as { hello: string }
      // ctx.reader.len is the length the middleware read; hello comes from the
      // handler's own (second) read of the same body.
      return Response.json({ len: ctx.reader.len, hello: parsed.hello })
    })

    const res = await fetchHandler(
      new Request('http://localhost/', {
        method: 'POST',
        body: JSON.stringify({ hello: 'world' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ len: 17, hello: 'world' })
  })

  it('buffered req: formData() works after a middleware reads the body', async () => {
    const withReader = defineMiddleware<
      'reader',
      void,
      Record<never, never>,
      { len: number }
    >({
      key: 'reader',
      run: () => async (req) => ({
        reader: { len: (await req.text()).length },
      }),
    })

    const fetchHandler = withReader(async (req) => {
      const form = await req.formData()
      return Response.json({ a: form.get('a'), b: form.get('b') })
    })

    const res = await fetchHandler(
      new Request('http://localhost/', {
        method: 'POST',
        body: new URLSearchParams({ a: '1', b: '2' }),
      }),
    )
    expect(await res.json()).toEqual({ a: '1', b: '2' })
  })

  it('buffered req: clone() shares the cached body', async () => {
    const passthrough = defineMiddleware<
      'p',
      void,
      Record<never, never>,
      { ok: true }
    >({ key: 'p', run: () => async () => ({ p: { ok: true } }) })

    const fetchHandler = passthrough(async (req) => {
      const original = await req.json()
      const cloned = await req.clone().json() // clone reads the same cached body
      return Response.json({
        original,
        cloned,
        sameUrl: req.clone().url === req.url,
      })
    })

    const res = await fetchHandler(
      new Request('http://localhost/', {
        method: 'POST',
        body: JSON.stringify({ n: 1 }),
      }),
    )
    expect(await res.json()).toEqual({
      original: { n: 1 },
      cloned: { n: 1 },
      sameUrl: true,
    })
  })

  it('short-circuits on reject without calling the inner handler', async () => {
    const inner = vi.fn(innerOk)
    const fetchHandler = rejecting('blocker', 402)(inner)

    const res = await fetchHandler(new Request('http://localhost/'))
    expect(res.status).toBe(402)
    expect(await res.text()).toBe('rejected by blocker')
    expect(inner).not.toHaveBeenCalled()
  })

  it('enforces prerequisites: middleware with `In` keys require the upstream to provide them', async () => {
    interface Upstream {
      db: { from: (t: string) => { ok: boolean } }
      jwtClaims: { sub: string }
    }

    const withReportAccess = defineMiddleware<
      'reportAccess',
      { reportId: string },
      Upstream,
      { allowed: boolean }
    >({
      key: 'reportAccess',
      run: (config) => async (_req, ctx) => {
        const probe = ctx.db.from(`reports:${config.reportId}`)
        return {
          reportAccess: { allowed: probe.ok && ctx.jwtClaims.sub !== '' },
        }
      },
    })

    const fakeUpstream: Upstream & BaseContext = {
      db: { from: () => ({ ok: true }) },
      jwtClaims: { sub: 'u1' },
      ...base,
    }

    const fetchHandler = withReportAccess(
      { reportId: 'r1' },
      async (_req, ctx) =>
        Response.json({
          allowed: ctx.reportAccess.allowed,
          user: ctx.jwtClaims.sub,
        }),
    )

    // ctx is REQUIRED for middleware with prereqs — verifies the type.
    const res = await fetchHandler(
      new Request('http://localhost/'),
      fakeUpstream,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: true, user: 'u1' })
  })

  it('reject with prereqs short-circuits before contributing', async () => {
    interface Upstream {
      tenantId: string
    }

    const withTenantOnly = defineMiddleware<
      'tenant',
      { allowed: string[] },
      Upstream,
      { tenantId: string }
    >({
      key: 'tenant',
      run: (config) => async (_req, ctx) => {
        if (!config.allowed.includes(ctx.tenantId)) {
          return Response.json({ error: 'tenant_forbidden' }, { status: 403 })
        }
        return { tenant: { tenantId: ctx.tenantId } }
      },
    })

    const inner = vi.fn(innerOk)
    const fetchHandler = withTenantOnly({ allowed: ['acme'] }, inner)

    const blocked = await fetchHandler(new Request('http://localhost/'), {
      tenantId: 'evil-corp',
      ...base,
    })
    expect(blocked.status).toBe(403)
    expect(inner).not.toHaveBeenCalled()

    const ok = await fetchHandler(new Request('http://localhost/'), {
      tenantId: 'acme',
      ...base,
    })
    expect(ok.status).toBe(200)
    expect(inner).toHaveBeenCalledOnce()
  })

  it('throws if run() returns an object missing the key', async () => {
    const broken = defineMiddleware<
      'broken',
      void,
      Record<never, never>,
      { v: number }
    >({
      key: 'broken',
      run: () => async () => ({ wrongKey: { v: 1 } }) as never,
    })

    const fetchHandler = broken(innerOk)

    await expect(
      fetchHandler(new Request('http://localhost/')),
    ).rejects.toThrow(/'broken'/)
  })
})

describe('defineMiddleware — generator (response seam)', () => {
  // A timing middleware written as an `async function*`: stamp a header on the
  // way out. The `yield` expression resolves to the downstream Response.
  const withStamp = defineMiddleware<
    'stamp',
    { header: string },
    Record<never, never>,
    { at: string }
  >({
    key: 'stamp',
    run: (config) =>
      async function* () {
        const response = yield { stamp: { at: 'before' } }
        response.headers.set(config.header, 'seen')
        return response
      },
  })

  it('observes and shapes the downstream response on the way out', async () => {
    const handler = withStamp({ header: 'x-stamp' }, async (_req, ctx) =>
      Response.json({ at: ctx.stamp.at }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.headers.get('x-stamp')).toBe('seen')
    expect(await res.json()).toEqual({ at: 'before' }) // contribution reached the handler
  })

  it('returns the inner response when the generator falls off without returning one', async () => {
    const observe = defineMiddleware<
      'observe',
      void,
      Record<never, never>,
      { seen: true }
    >({
      key: 'observe',
      run: () =>
        async function* () {
          yield { observe: { seen: true } }
          // no `return` — the downstream response passes through unchanged
        },
    })

    const handler = observe(async () =>
      Response.json({ ok: true }, { status: 201 }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
  })

  // A generator short-circuits the same way a plain body does: by *producing* a
  // Response. `return` is idiomatic (it reads as "I'm done, no response phase");
  // the driver also accepts a yielded Response, but `yield` is meant for the seam.
  it.each(['return', 'yield'] as const)(
    'short-circuits via %s of a Response — the inner handler never runs',
    async (mode) => {
      const inner = vi.fn(innerOk)
      const gate = defineMiddleware<
        'gate',
        void,
        Record<never, never>,
        Record<never, never>
      >({
        key: 'gate',
        run: () =>
          async function* () {
            const blocked = new Response('blocked', { status: 403 })
            if (mode === 'return') return blocked
            yield blocked
          },
      })

      const res = await gate(inner)(new Request('http://localhost/'))
      expect(res.status).toBe(403)
      expect(inner).not.toHaveBeenCalled()
    },
  )

  it('runs `finally` for request-spanning cleanup, even on downstream throw', async () => {
    const order: string[] = []
    const withResource = defineMiddleware<
      'resource',
      void,
      Record<never, never>,
      { id: number }
    >({
      key: 'resource',
      run: () =>
        async function* () {
          order.push('acquire')
          try {
            const response = yield { resource: { id: 1 } }
            return response
          } finally {
            order.push('release')
          }
        },
    })

    const boom = withResource(async () => {
      order.push('handler')
      throw new Error('downstream boom')
    })

    await expect(boom(new Request('http://localhost/'))).rejects.toThrow(
      'downstream boom',
    )
    expect(order).toEqual(['acquire', 'handler', 'release'])
  })

  it('lets a try/catch around `yield` recover a downstream throw into a Response', async () => {
    const withCatch = defineMiddleware<
      'guard',
      void,
      Record<never, never>,
      { ok: true }
    >({
      key: 'guard',
      run: () =>
        async function* () {
          try {
            return yield { guard: { ok: true } }
          } catch {
            return new Response('handled', { status: 500 })
          }
        },
    })

    const handler = withCatch(async () => {
      throw new Error('kaboom')
    })
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('handled')
  })

  it('composes a generator middleware under a plain one, accumulating ctx', async () => {
    const handler = withFeatureFlag(
      { name: 'beta', evaluate: () => true },
      withStamp({ header: 'x-stamp' }, async (_req, ctx) =>
        Response.json({ flag: ctx.featureFlag.name, at: ctx.stamp.at }),
      ),
    ) satisfies FetchHandler

    const res = await handler(new Request('http://localhost/'))
    expect(res.headers.get('x-stamp')).toBe('seen')
    expect(await res.json()).toEqual({ flag: 'beta', at: 'before' })
  })

  it('two generator seams unwind as an onion: request top-down, response bottom-up', async () => {
    const order: string[] = []
    const seam = <Key extends string>(key: Key) =>
      defineMiddleware<Key, void, Record<never, never>, { tag: Key }>({
        key,
        run: () =>
          async function* () {
            order.push(`${key}:in`)
            const response = (yield { [key]: { tag: key } } as {
              [P in Key]: { tag: Key }
            }) as Response
            order.push(`${key}:out`)
            // Each layer sees the response shaped by everything inside it.
            response.headers.append('x-seen', key)
            return response
          },
      })

    const outer = seam('outer')
    const inner = seam('inner')

    const handler = outer(
      inner(async () => {
        order.push('handler')
        return Response.json({ ok: true })
      }),
    ) satisfies FetchHandler

    const res = await handler(new Request('http://localhost/'))

    // Request phase runs outer→inner→handler; response phase unwinds inner→outer.
    expect(order).toEqual([
      'outer:in',
      'inner:in',
      'handler',
      'inner:out',
      'outer:out',
    ])
    // Both seams shaped the same response, inner first then outer.
    expect(res.headers.get('x-seen')).toBe('inner, outer')
  })
})

describe('auto-curry: mw(config) returns an Entry', () => {
  it('mw(config) returns an entry that pipelines correctly', async () => {
    const withGreeting = defineMiddleware<
      'greeting',
      { who: string },
      Record<never, never>,
      { hello: string }
    >({
      key: 'greeting',
      run: (config) => async () => ({ greeting: { hello: config.who } }),
    })

    const handler = pipeline(
      [withGreeting({ who: 'world' })],
      async (_req, ctx) => Response.json({ msg: ctx.greeting.hello }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ msg: 'world' })
  })

  it('mw(config) in pipeline produces the same result as direct nesting', async () => {
    const withGreeting = defineMiddleware<
      'greeting',
      { who: string },
      Record<never, never>,
      { hello: string }
    >({
      key: 'greeting',
      run: (config) => async () => ({ greeting: { hello: config.who } }),
    })

    const nested = withGreeting({ who: 'world' }, async (_req, ctx) =>
      Response.json({ msg: ctx.greeting.hello }),
    )
    const flat = pipeline([withGreeting({ who: 'world' })], async (_req, ctx) =>
      Response.json({ msg: ctx.greeting.hello }),
    )

    const [nestedRes, flatRes] = await Promise.all([
      nested(new Request('http://localhost/')),
      flat(new Request('http://localhost/')),
    ])
    expect(await nestedRes.json()).toEqual(await flatRes.json())
  })

  it('mw() (no config) works for config-less middleware', async () => {
    const withTag = passing('tag', { v: 'ok' })
    const handler = pipeline([withTag()], async (_req, ctx) =>
      Response.json({ v: ctx.tag.v }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ v: 'ok' })
  })

  it('mw() (no config) in pipeline produces the same result as direct nesting', async () => {
    const withTag = passing('tag', { v: 'ok' })

    const nested = withTag(async (_req, ctx) => Response.json({ v: ctx.tag.v }))
    const flat = pipeline([withTag()], async (_req, ctx) =>
      Response.json({ v: ctx.tag.v }),
    )

    const [nestedRes, flatRes] = await Promise.all([
      nested(new Request('http://localhost/')),
      flat(new Request('http://localhost/')),
    ])
    expect(await nestedRes.json()).toEqual(await flatRes.json())
  })

  it('type guarantee: mw(config) satisfies Entry', () => {
    const withGreeting = defineMiddleware<
      'greeting',
      { who: string },
      Record<never, never>,
      { hello: string }
    >({
      key: 'greeting',
      run: (config) => async () => ({ greeting: { hello: config.who } }),
    })

    const _entry = withGreeting({ who: 'world' }) satisfies SingleKeyEntry<
      'greeting',
      Record<never, never>,
      { hello: string }
    >
    void _entry
  })

  it('type guarantee: mw() satisfies Entry for config-less middleware', () => {
    const withTag = passing('tag', { v: 'ok' })

    const _entry = withTag() satisfies SingleKeyEntry<
      'tag',
      Record<never, never>,
      { v: string }
    >
    void _entry
  })
})

// ---------------------------------------------------------------------------
// Four-deep nesting, end to end: real shipped middleware, an `In` prerequisite
// declared four layers down, and the stack actually invoked. The `type
// guarantees` block below proves depth-4 accumulation *compiles*; this proves
// the same stack runs and that every layer's contribution arrives at the
// innermost handler with the value it was given.
// ---------------------------------------------------------------------------
describe('four-deep nesting', () => {
  const order: string[] = []

  /** Layer 3 — config-less, contributes a plain string. */
  const withRequestId = defineMiddleware<
    'requestId',
    void,
    Record<never, never>,
    string
  >({
    key: 'requestId',
    run: () => async (req) => {
      order.push('requestId')
      return { requestId: req.headers.get('x-request-id') ?? 'generated' }
    },
  })

  /**
   * Layer 4 — declares prerequisites contributed by layers 2 and 3, so this
   * only compiles when accumulation actually reached four deep.
   */
  const withAudit = defineMiddleware<
    'audit',
    { actor: string },
    { featureFlag: { name: string }; requestId: string },
    { line: string }
  >({
    key: 'audit',
    run: (config) => async (_req, ctx) => {
      order.push('audit')
      return {
        audit: {
          line: `${config.actor}:${ctx.featureFlag.name}:${ctx.requestId}`,
        },
      }
    },
  })

  const app = withCors(
    { origin: 'https://app.example.com' },
    withFeatureFlag(
      { name: 'beta', evaluate: () => ({ enabled: true, variant: 'B' }) },
      withRequestId(
        withAudit({ actor: 'svc' }, async (_req, ctx) => {
          order.push('handler')
          // All four upstream keys, ambiently typed — no annotation here.
          const allowedOrigin: string | null = ctx.cors.allowedOrigin
          const flag: string = ctx.featureFlag.name
          const variant: string | null = ctx.featureFlag.variant
          const requestId: string = ctx.requestId
          const line: string = ctx.audit.line
          return Response.json({
            allowedOrigin,
            flag,
            variant,
            requestId,
            line,
          })
        }),
      ),
    ),
  ) satisfies FetchHandler

  it('delivers every upstream contribution to the innermost handler', async () => {
    order.length = 0
    const res = await app(
      new Request('http://localhost/', {
        headers: {
          Origin: 'https://app.example.com',
          'x-request-id': 'req-42',
        },
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      allowedOrigin: 'https://app.example.com',
      flag: 'beta',
      variant: 'B',
      requestId: 'req-42',
      line: 'svc:beta:req-42',
    })
  })

  it('runs the layers outermost-first and unwinds the response seam last', async () => {
    order.length = 0
    const res = await app(
      new Request('http://localhost/', {
        headers: { Origin: 'https://app.example.com' },
      }),
    )

    expect(order).toEqual(['requestId', 'audit', 'handler'])
    // The outermost layer (a generator) still stamped the response on the way
    // out, four layers up from the handler.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com',
    )
  })

  it('short-circuits from the outermost layer without running the inner three', async () => {
    order.length = 0
    const preflight = await app(
      new Request('http://localhost/', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      }),
    )

    expect(preflight.status).toBe(204)
    expect(order).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Compile-time guarantee tests, verified by `tsc --noEmit` (the `typecheck`
// script) — a regression is a type error or an unused-directive error. A plain
// vitest run cannot see these.
//
// The accumulation cases below carry `satisfies FetchHandler`, but ambient
// accumulation does not depend on it — an unannotated outermost call resolves
// `Base` to its constraint, the same empty upstream the annotation would seed,
// and the cascade proceeds inward from there at any depth. Collision detection
// is the guarantee that does depend on it: the produced handler type records the
// upstream a stack requires, never the keys it contributes, so unannotated there
// is nothing for an enclosing call to check its own key against. The annotation
// is therefore load-bearing in the `collision:` cases and incidental in the
// `accumulation:` ones.
// ---------------------------------------------------------------------------
describe('type guarantees (tsc-verified)', () => {
  it('accumulation: the inner handler sees every upstream key, typed', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const _app = withA(
      withB(async (_req, ctx) => {
        const a: number = ctx.alpha.v
        const b: number = ctx.beta.v
        void a
        void b
        return Response.json({ ok: true })
      }),
    ) satisfies FetchHandler
    void _app
  })

  it('accumulation: three levels deep, every upstream key still typed', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })
    const withC = passing('gamma', { v: 3 })

    const _app = withA(
      withB(
        withC(async (_req, ctx) => {
          const a: number = ctx.alpha.v
          const b: number = ctx.beta.v
          const c: number = ctx.gamma.v
          void a
          void b
          void c
          return Response.json({ ok: true })
        }),
      ),
    ) satisfies FetchHandler
    void _app
  })

  it('accumulation: four levels deep, every upstream key still typed', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })
    const withC = passing('gamma', { v: 3 })
    const withD = passing('delta', { v: 4 })

    const _app = withA(
      withB(
        withC(
          withD(async (_req, ctx) => {
            const a: number = ctx.alpha.v
            const b: number = ctx.beta.v
            const c: number = ctx.gamma.v
            const d: number = ctx.delta.v
            void a
            void b
            void c
            void d
            return Response.json({ ok: true })
          }),
        ),
      ),
    ) satisfies FetchHandler
    void _app
  })

  it('accumulation: three levels deep with real config-taking middleware', () => {
    const withStamp = defineMiddleware<
      'stamp',
      { at: string },
      Record<never, never>,
      { at: string }
    >({
      key: 'stamp',
      run: (config) => async () => ({ stamp: { at: config.at } }),
    })
    const withA = passing('alpha', { v: 1 })

    const _app = withFeatureFlag(
      { name: 'beta', evaluate: () => true },
      withStamp(
        { at: 'now' },
        withA(async (_req, ctx) => {
          const f: string = ctx.featureFlag.name
          const s: string = ctx.stamp.at
          const a: number = ctx.alpha.v
          void f
          void s
          void a
          return Response.json({ ok: true })
        }),
      ),
    ) satisfies FetchHandler
    void _app
  })

  it('collision: composing a middleware over an upstream that already has its key fails', () => {
    const withFoo = passing('foo', { v: 1 })

    const _bad =
      // @ts-expect-error — inner `withFoo` shadows upstream key 'foo'
      withFoo(withFoo(innerOk)) satisfies FetchHandler
    void _bad
  })

  // Collision detection resolves `Base` through the same inward cascade as
  // accumulation, so the adjacent-layer case above does not guard depth 3+. The
  // positive controls are the accumulation tests above: the same shapes without a
  // repeated key compile, so what these two expect is the duplicate key.
  it('collision: a key contributed two layers up is still caught', () => {
    const withFoo = passing('foo', { v: 1 })
    const withBar = passing('bar', { v: 2 })

    const _bad =
      // @ts-expect-error — innermost `withFoo` shadows 'foo' from two layers up
      withFoo(withBar(withFoo(innerOk))) satisfies FetchHandler
    void _bad
  })

  it('collision: a key contributed three layers up is still caught', () => {
    const withFoo = passing('foo', { v: 1 })
    const withBar = passing('bar', { v: 2 })
    const withBaz = passing('baz', { v: 3 })

    const _bad =
      // @ts-expect-error — innermost `withFoo` shadows 'foo' from three layers up
      withFoo(withBar(withBaz(withFoo(innerOk)))) satisfies FetchHandler
    void _bad
  })

  // `@ts-expect-error` pins that *an* error fires, not which one, and the whole
  // point of siting the sentinel on the handler parameter is the text. These pin
  // it directly: on a collision the parameter a call is checked against *is* the
  // sentinel, so what TypeScript prints is this string.
  it('collision: the guard resolves to the sentinel string, verbatim', () => {
    const _msg: NoConflict<'foo', { foo: { v: number } }, never> =
      "middleware-conflict: key 'foo' is already present on the upstream context"
    // Mutually assignable with `Conflict<'foo'>`, so the guard cannot quietly
    // widen to `string` and keep this test passing.
    const _exact: Conflict<'foo'> = _msg
    void _exact
  })

  it('collision: the guard passes the handler through when the key is free', () => {
    type H = (req: Request, ctx: BaseContext) => Promise<Response>
    const _passthrough: NoConflict<'foo', { bar: { v: number } }, H> = innerOk
    void _passthrough
  })

  it('collision: the guard is skipped for an `any` upstream', () => {
    type H = (req: Request, ctx: BaseContext) => Promise<Response>
    // `keyof any` is every key, so without the `IsAny` arm this would report a
    // collision for any key at all — `vi.fn`-inferred handlers hit this.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _anyBase: NoConflict<'foo', any, H> = innerOk
    void _anyBase
  })

  it('prerequisite: a middleware with `In` keys cannot be the bare `fetch` export', () => {
    const withNeedsAuth = defineMiddleware<
      'authz',
      void,
      { jwtClaims: { sub: string } },
      { ok: boolean }
    >({
      key: 'authz',
      run: () => async () => ({ authz: { ok: true } }),
    })

    const handler = withNeedsAuth(innerOk)
    // @ts-expect-error — requires upstream jwtClaims; cannot be the bare `fetch` export
    const _entry: FetchHandler = handler
    void _entry
  })

  it('unannotated: a nested handler reads its own contribution', () => {
    const withStamp = defineMiddleware<
      'stamp',
      void,
      Record<never, never>,
      { at: number }
    >({ key: 'stamp', run: () => async () => ({ stamp: { at: 1 } }) })

    // Neither middleware declares an `In` prerequisite — this pins only that a
    // nested handler types with no annotation. `In` behaviour is pinned by the
    // tests below.
    const _app = withFeatureFlag(
      { name: 'beta', evaluate: () => true },
      withStamp(async (_req, ctx) => {
        const at: number = ctx.stamp.at
        void at
        return Response.json({ ok: true })
      }),
    )
    void _app
  })

  // -------------------------------------------------------------------------
  // Unmet `In` prerequisites travel *outward* — the direction opposite to the
  // anchored cascade, and the one the propagation overload on `Middleware`
  // exists to serve. Unanchored there is no accumulated `Base` to push inward,
  // so each layer that does not contribute the required key republishes it as
  // its own requirement; the stack only typechecks once some layer contributes
  // it, or fails wherever the stack is checked against `FetchHandler`.
  //
  // Distance between provider and requirer is the axis these pin: the earlier
  // signature discharged a prerequisite only from the immediately enclosing
  // layer, so the two-layer case is the regression guard.
  // -------------------------------------------------------------------------
  const withNeedsAlpha = defineMiddleware<
    'needsAlpha',
    void,
    { alpha: { v: number } },
    { ok: true }
  >({
    key: 'needsAlpha',
    run: () => async () => ({ needsAlpha: { ok: true } }),
  })

  it('prerequisite: unanchored, provider immediately encloses the requirer', () => {
    const withA = passing('alpha', { v: 1 })

    const _app = withA(withNeedsAlpha(innerOk))
    void _app
  })

  it('prerequisite: unanchored, provider two layers up', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    // `withB` contributes nothing `withNeedsAlpha` asked for, so it carries the
    // outstanding `alpha` up to `withA`, which discharges it.
    const _app = withA(withB(withNeedsAlpha(innerOk)))
    void _app
  })

  it('prerequisite: unanchored, provider four layers up', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })
    const withC = passing('gamma', { v: 3 })
    const withD = passing('delta', { v: 4 })

    const _app = withA(withB(withC(withD(withNeedsAlpha(innerOk)))))
    void _app
  })

  it('prerequisite: annotated, provider two layers up', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    // Same stack as above, now also asserted usable as the `fetch` export: the inward cascade
    // carries `alpha` to the requirer, so it is discharged on the way in rather
    // than republished outward.
    const _app = withA(withB(withNeedsAlpha(innerOk))) satisfies FetchHandler
    void _app
  })

  it('prerequisite: unanchored, chained through a second requirer', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })
    const withC = passing('gamma', { v: 3 })
    const withNeedsNeedsAlpha = defineMiddleware<
      'downstream',
      void,
      { needsAlpha: { ok: true } },
      { d: number }
    >({ key: 'downstream', run: () => async () => ({ downstream: { d: 1 } }) })

    // Two prerequisites in flight at once, discharged at different depths:
    // `needsAlpha` by the layer just outside `withC`, `alpha` three layers up.
    const _app = withA(
      withB(withNeedsAlpha(withC(withNeedsNeedsAlpha(innerOk)))),
    )
    void _app
  })

  it('prerequisite: a requirement no layer contributes fails when checked as the `fetch` export', () => {
    const withB = passing('beta', { v: 2 })
    const withC = passing('gamma', { v: 3 })

    // Composes — the requirement is still travelling — but never lands, so the
    // produced stack keeps a required `ctx`. Note what pins the error: the
    // `FetchHandler` annotation below. The composition itself is fine, and an
    // untyped `export default { fetch: stack }` would compile and then read
    // `undefined` off `ctx` at runtime.
    const stack = withB(withC(withNeedsAlpha(innerOk)))
    // @ts-expect-error — nothing in the stack contributes `alpha`
    const _entry: FetchHandler = stack
    void _entry
  })

  it('prerequisite: a provider with the wrong contribution type does not discharge it', () => {
    // `alpha.v` is a string here; `withNeedsAlpha` requires a number. The layer
    // must not discharge the requirement just because the key names match.
    const withA = passing('alpha', { v: 'one' })
    const withB = passing('beta', { v: 2 })

    const _bad =
      // @ts-expect-error — alpha.v is string, but the prerequisite wants number
      withA(withB(withNeedsAlpha(innerOk)))
    void _bad
  })

  it('prerequisite: the leaf handler still sees an exact ctx inside a travelling stack', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const _app = withA(
      withB(
        withNeedsAlpha(async (_req, ctx) => {
          const ok: true = ctx.needsAlpha.ok
          void ok
          // @ts-expect-error — 'nope' was never contributed
          void ctx.nope
          return Response.json({ ok: true })
        }),
      ),
    )
    void _app
  })
})
