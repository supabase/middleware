import { describe, expect, it, vi } from 'vitest'

import { withFeatureFlag } from '../middleware/feature-flag/with-feature-flag.js'
import { defineMiddleware } from './define-middleware.js'
import type { BaseContext, FetchHandler } from './runtime.js'

const innerOk = async () => Response.json({ ok: true })

/** Stand-in base context for tests that supply a context directly. */
const runtime: BaseContext['runtime'] = {
  name: 'node',
  getEnv: () => undefined,
}
const body: BaseContext['body'] = {
  arrayBuffer: async () => new ArrayBuffer(0),
  bytes: async () => new Uint8Array(),
  text: async () => '',
  json: async () => ({}) as never,
}
const base: BaseContext = { runtime, body }

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
  it('runs the middleware, contributes its key, and self-seeds ctx.runtime', async () => {
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
      Response.json({ msg: ctx.greeting.hello, host: ctx.runtime.name }),
    )

    // Invoked as a bare fetch entry — ctx is seeded internally.
    const res = await fetchHandler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ msg: 'world', host: 'node' })
  })

  it('does not let a host-supplied platform arg leak into ctx', async () => {
    const withGreeting = defineMiddleware<
      'greeting',
      undefined,
      Record<never, never>,
      { hello: string }
    >({
      key: 'greeting',
      run: () => async () => ({ greeting: { hello: 'hi' } }),
    })

    const fetchHandler = withGreeting(undefined, async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx) }),
    )

    // Simulate a runtime calling fetch(req, env, execCtx) with an enumerable env.
    const res = await (
      fetchHandler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { SECRET: 's' }, { waitUntil() {} })
    expect(await res.json()).toEqual({ keys: ['runtime', 'body', 'greeting'] })
  })

  it('ctx.body is readable from multiple layers (read-once-cache)', async () => {
    // A body-reading middleware (models auth-hook) followed by a handler that
    // also reads the body — both succeed, no "Body already consumed".
    const withReader = defineMiddleware<
      'reader',
      undefined,
      Record<never, never>,
      { len: number }
    >({
      key: 'reader',
      run: () => async (_req, ctx) => ({
        reader: { len: (await ctx.body.text()).length },
      }),
    })

    const fetchHandler = withReader(undefined, async (_req, ctx) => {
      const parsed = await ctx.body.json<{ hello: string }>()
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
        const host: string = ctx.runtime.name
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
        const host: string = ctx.runtime.name
        void at
        void host
        return Response.json({ ok: true })
      }),
    )
    void _app
  })
})
