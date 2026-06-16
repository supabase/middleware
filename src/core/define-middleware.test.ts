import { describe, expect, it, vi } from 'vitest'

import { withFeatureFlag } from '../middleware/feature-flag/with-feature-flag.js'
import { defineMiddleware } from './define-middleware.js'

const innerOk = async () => Response.json({ ok: true })

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
  it('runs the middleware, contributes its key to ctx, and calls the inner handler', async () => {
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

    const res = await fetchHandler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ msg: 'world' })
  })

  it('short-circuits on reject without calling the inner handler', async () => {
    const inner = vi.fn(innerOk)
    const fetchHandler = rejecting('blocker', 402)(undefined, inner)

    const res = await fetchHandler(new Request('http://localhost/'))
    expect(res.status).toBe(402)
    expect(await res.text()).toBe('rejected by blocker')
    expect(inner).not.toHaveBeenCalled()
  })

  it('nests middleware: outer contributes, inner sees the merged ctx', async () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const fetchHandler = withA(
      undefined,
      withB<{ alpha: { v: number } }>(undefined, async (_req, ctx) =>
        Response.json({ a: ctx.alpha.v, b: ctx.beta.v }),
      ),
    )

    const res = await fetchHandler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ a: 1, b: 2 })
  })

  it('refuses to compose where it would shadow an upstream key', () => {
    const withFoo = passing('foo', { v: 1 })

    // When the upstream Base already has the key, the `Base` type parameter
    // fails its `NoConflict<Key, Base>` constraint and TypeScript reports the
    // conflict at the offending call site, citing the literal conflict message.
    const conflicted =
      withFoo<// @ts-expect-error — would shadow upstream key 'foo'
      { foo: { v: number } }>(undefined, async () =>
        Response.json({ ok: true }),
      )
    void conflicted
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
        // ctx is typed as Upstream — `from` is callable here
        const probe = ctx.db.from(`reports:${config.reportId}`)
        return {
          reportAccess: { allowed: probe.ok && ctx.jwtClaims.sub !== '' },
        }
      },
    })

    const fakeUpstream: Upstream = {
      db: { from: () => ({ ok: true }) },
      jwtClaims: { sub: 'u1' },
    }

    const fetchHandler = withReportAccess(
      { reportId: 'r1' },
      async (_req, ctx) =>
        Response.json({
          allowed: ctx.reportAccess.allowed,
          user: ctx.jwtClaims.sub,
        }),
    )

    // baseCtx is REQUIRED for middleware with prereqs — verifies the type.
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
    })
    expect(blocked.status).toBe(403)
    expect(inner).not.toHaveBeenCalled()

    const ok = await fetchHandler(new Request('http://localhost/'), {
      tenantId: 'acme',
    })
    expect(ok.status).toBe(200)
    expect(inner).toHaveBeenCalledOnce()
  })

  it('threads upstream keys through to the inner handler unchanged', async () => {
    const withStamp = passing('stamp', { at: 42 })

    const fetchHandler = withStamp<{ tenantId: string }>(
      undefined,
      async (_req, ctx) =>
        Response.json({ tenant: ctx.tenantId, stamp: ctx.stamp.at }),
    )

    const res = await fetchHandler(new Request('http://localhost/'), {
      tenantId: 'acme',
    })
    expect(await res.json()).toEqual({ tenant: 'acme', stamp: 42 })
  })

  // Unit-level regression test for the load-bearing inference mechanic in
  // `Wrapped<Base, In>`. If someone simplifies that type to a single-arity
  // `(req, baseCtx?: Base) => ...` form, `ctx.external` / `ctx.alpha` on the
  // inner handler fail to typecheck — this catches the regression without
  // depending on a real upstream stack.
  it('infers Base through nested middleware when an outer wrapper provides it', async () => {
    interface Upstream {
      external: string
    }

    // Minimal stand-in for a Base-providing outer wrapper (think: an auth
    // middleware). Its handler position is what gives TS the contextual type
    // that propagates Base into the nested stack.
    const withUpstream =
      (
        handler: (req: Request, ctx: Upstream) => Promise<Response>,
      ): ((req: Request) => Promise<Response>) =>
      async (req) =>
        handler(req, { external: 'x1' })

    const withAlpha = passing('alpha', { v: 1 })
    const withBeta = passing('beta', { v: 2 })

    const fetchHandler = withUpstream(
      withAlpha(
        undefined,
        withBeta(undefined, async (_req, ctx) =>
          Response.json({
            ext: ctx.external,
            a: ctx.alpha.v,
            b: ctx.beta.v,
          }),
        ),
      ),
    )

    const res = await fetchHandler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ ext: 'x1', a: 1, b: 2 })
  })

  it('throws if run() returns an object missing the key', async () => {
    const broken = defineMiddleware<
      'broken',
      undefined,
      Record<never, never>,
      { v: number }
    >({
      key: 'broken',
      // Cast around the type system so we can exercise the runtime invariant —
      // it catches authoring bugs that slip past excess-property checks via a
      // wider-typed return.
      run: () => async () => ({ wrongKey: { v: 1 } }) as never,
    })

    const fetchHandler = broken(undefined, innerOk)

    await expect(
      fetchHandler(new Request('http://localhost/')),
    ).rejects.toThrow(/'broken'/)
  })

  it('infers upstream context through a nested stack without annotations', () => {
    interface Upstream {
      jwtClaims: { sub: string } | null
    }

    // Stand-in outer wrapper that provides `jwtClaims` (think: an auth
    // middleware). Exercises a 3-deep stack: upstream → withFeatureFlag →
    // inline middleware → handler.
    const withAuth =
      (
        handler: (req: Request, ctx: Upstream) => Promise<Response>,
      ): ((req: Request) => Promise<Response>) =>
      async (req) =>
        handler(req, { jwtClaims: { sub: 'u1' } })

    const withStamp = defineMiddleware<
      'stamp',
      undefined,
      Record<never, never>,
      { at: number }
    >({
      key: 'stamp',
      run: () => async () => ({ stamp: { at: 1 } }),
    })

    const fetchHandler = withAuth(
      withFeatureFlag(
        { name: 'beta-feedback', evaluate: () => true },
        withStamp(undefined, async (_req, ctx) => {
          const userId: string | undefined = ctx.jwtClaims?.sub
          const flagName: string = ctx.featureFlag.name
          const stampedAt: number = ctx.stamp.at

          void userId
          void flagName
          void stampedAt

          return Response.json({ ok: true })
        }),
      ),
    )

    void fetchHandler
  })
})
