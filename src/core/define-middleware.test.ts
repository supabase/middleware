import { describe, expect, it, vi } from 'vitest'

import { withFeatureFlag } from '../middleware/feature-flag/with-feature-flag.js'
import { defineMiddleware } from './define-middleware.js'
import type { BaseContext, FetchHandler } from './runtime.js'

const innerOk = async () => Response.json({ ok: true })

/** Stand-in base context for tests that supply a context directly. */
const runtime: BaseContext['_runtime'] = {
  name: 'node',
  getEnv: () => undefined,
}
const base: BaseContext = { _runtime: runtime }

const passing = <Key extends string, C extends object>(
  key: Key,
  contribution: C,
) =>
  defineMiddleware<Key, undefined, Record<never, never>, C>({
    key,
    run: () => async () => ({ [key]: contribution }) as { [K in Key]: C },
  })

const rejecting = <Key extends string>(key: Key, status = 401) =>
  defineMiddleware<Key, undefined, Record<never, never>, Record<never, never>>({
    key,
    run: () => async () => new Response(`rejected by ${key}`, { status }),
  })

describe('defineMiddleware', () => {
  it('runs the middleware, contributes its key, and self-seeds ctx._runtime', async () => {
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
      Response.json({ msg: ctx.greeting.hello, host: ctx._runtime.name }),
    )

    // Invoked as a bare fetch entry — ctx is seeded internally.
    const res = await fetchHandler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ msg: 'world', host: 'node' })
  })

  const withGreeting = defineMiddleware<
    'greeting',
    undefined,
    Record<never, never>,
    { hello: string }
  >({
    key: 'greeting',
    run: () => async () => ({ greeting: { hello: 'hi' } }),
  })

  it('does not let a host-supplied env (arg 2) leak into ctx', async () => {
    const fetchHandler = withGreeting(undefined, async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx) }),
    )

    // Simulate a runtime calling fetch(req, env) with an enumerable env object.
    const res = await (
      fetchHandler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { SECRET: 's' })
    expect(await res.json()).toEqual({ keys: ['_runtime', 'greeting'] })
  })

  it('warns (does not throw) and ignores a third fetch argument (exec context)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchHandler = withGreeting(undefined, async (_req, ctx) =>
        Response.json({ keys: Object.keys(ctx) }),
      )

      // Simulate Cloudflare Workers calling fetch(req, env, executionContext).
      const res = await (
        fetchHandler as (req: Request, ...a: unknown[]) => Promise<Response>
      )(new Request('http://localhost/'), { SECRET: 's' }, { waitUntil() {} })

      // Proceeds normally; the env (arg 2) still does not leak into ctx, and the
      // execution context (arg 3) is ignored rather than throwing.
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ keys: ['_runtime', 'greeting'] })
    } finally {
      warn.mockRestore()
    }
  })

  it('req body is readable from multiple layers (buffered request)', async () => {
    // A body-reading middleware (e.g. a signature check) followed by a handler
    // that also reads the body — both read `req`, no "Body already consumed".
    const withReader = defineMiddleware<
      'reader',
      undefined,
      Record<never, never>,
      { len: number }
    >({
      key: 'reader',
      run: () => async (req) => ({
        reader: { len: (await req.text()).length },
      }),
    })

    const fetchHandler = withReader(undefined, async (req, ctx) => {
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
      undefined,
      Record<never, never>,
      { len: number }
    >({
      key: 'reader',
      run: () => async (req) => ({
        reader: { len: (await req.text()).length },
      }),
    })

    const fetchHandler = withReader(undefined, async (req) => {
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
      undefined,
      Record<never, never>,
      { ok: true }
    >({ key: 'p', run: () => async () => ({ p: { ok: true } }) })

    const fetchHandler = passthrough(undefined, async (req) => {
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
    const fetchHandler = rejecting('blocker', 402)(undefined, inner)

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
      undefined,
      Record<never, never>,
      { v: number }
    >({
      key: 'broken',
      run: () => async () => ({ wrongKey: { v: 1 } }) as never,
    })

    const fetchHandler = broken(undefined, innerOk)

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
      undefined,
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

    const handler = observe(undefined, async () =>
      Response.json({ ok: true }, { status: 201 }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('short-circuits by yielding a Response — the inner handler never runs', async () => {
    const inner = vi.fn(innerOk)
    const gate = defineMiddleware<
      'gate',
      undefined,
      Record<never, never>,
      Record<never, never>
    >({
      key: 'gate',
      run: () =>
        async function* () {
          yield new Response('blocked', { status: 403 })
        },
    })

    const res = await gate(undefined, inner)(new Request('http://localhost/'))
    expect(res.status).toBe(403)
    expect(inner).not.toHaveBeenCalled()
  })

  it('runs `finally` for request-spanning cleanup, even on downstream throw', async () => {
    const order: string[] = []
    const withResource = defineMiddleware<
      'resource',
      undefined,
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

    const boom = withResource(undefined, async () => {
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
      undefined,
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

    const handler = withCatch(undefined, async () => {
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
})

// ---------------------------------------------------------------------------
// Compile-time guarantee tests, verified by `tsc --noEmit` (the `typecheck`
// script) — a regression is a type error or an unused-directive error. A plain
// vitest run cannot see these. Ambient accumulation and collision detection both
// require the `satisfies FetchHandler` anchor on the outermost handler.
// ---------------------------------------------------------------------------
describe('type guarantees (tsc-verified)', () => {
  it('accumulation: the inner handler sees every upstream key, typed', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const _app = withA(
      undefined,
      withB(undefined, async (_req, ctx) => {
        const a: number = ctx.alpha.v
        const b: number = ctx.beta.v
        const host: string = ctx._runtime.name
        void a
        void b
        void host
        return Response.json({ ok: true })
      }),
    ) satisfies FetchHandler
    void _app
  })

  it('collision: composing a middleware over an upstream that already has its key fails', () => {
    const withFoo = passing('foo', { v: 1 })

    const _bad =
      // @ts-expect-error — inner `withFoo` shadows upstream key 'foo'
      withFoo(undefined, withFoo(undefined, innerOk)) satisfies FetchHandler
    void _bad
  })

  it('prerequisite: a middleware with `In` keys cannot be a bare fetch entry', () => {
    const withNeedsAuth = defineMiddleware<
      'authz',
      undefined,
      { jwtClaims: { sub: string } },
      { ok: boolean }
    >({
      key: 'authz',
      run: () => async () => ({ authz: { ok: true } }),
    })

    const handler = withNeedsAuth(undefined, innerOk)
    // @ts-expect-error — requires upstream jwtClaims; cannot satisfy a bare entry
    const _entry: FetchHandler = handler
    void _entry
  })

  it('cross-middleware deps via `In` type with no anchor', () => {
    const withStamp = defineMiddleware<
      'stamp',
      undefined,
      Record<never, never>,
      { at: number }
    >({ key: 'stamp', run: () => async () => ({ stamp: { at: 1 } }) })

    // withFeatureFlag (no prereq) wraps withStamp; the handler reads its own key,
    // the prerequisite-free upstream needn't be declared — runtime is always there.
    const _app = withFeatureFlag(
      { name: 'beta', evaluate: () => true },
      withStamp(undefined, async (_req, ctx) => {
        const at: number = ctx.stamp.at
        const host: string = ctx._runtime.name
        void at
        void host
        return Response.json({ ok: true })
      }),
    )
    void _app
  })
})
