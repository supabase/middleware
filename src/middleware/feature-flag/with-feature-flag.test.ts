import { describe, expect, it, vi } from 'vitest'

// The subpath re-exports `FetchHandler`, so the `satisfies` anchor is a single
// import line. This assignment is tsc-verified (the `typecheck` script).
import { withFeatureFlag, type FetchHandler } from './index.js'
import { defineMiddleware, pipeline } from '../../core/index.js'

const _anchored = withFeatureFlag(
  { name: 'beta', evaluate: () => true },
  async (_req, ctx) => Response.json({ name: ctx.featureFlag.name }),
) satisfies FetchHandler
void _anchored

const innerOk = async () => Response.json({ ok: true })

describe('withFeatureFlag', () => {
  it('admits when evaluate returns true and contributes the flag state', async () => {
    const inner = vi.fn(async (_req: Request, ctx) => {
      expect(ctx.featureFlag).toEqual({
        name: 'beta',
        enabled: true,
        variant: null,
        payload: null,
      })
      return Response.json({ ok: true })
    })

    const handler = withFeatureFlag(
      { name: 'beta', evaluate: () => true },
      inner,
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(inner).toHaveBeenCalledOnce()
  })

  it('rejects with 404 by default when evaluate returns false', async () => {
    const handler = withFeatureFlag(
      { name: 'beta', evaluate: () => false },
      innerOk,
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'feature_disabled',
      flag: 'beta',
    })
  })

  it('honors a custom rejectStatus and rejectBody', async () => {
    const handler = withFeatureFlag(
      {
        name: 'beta',
        evaluate: () => false,
        rejectStatus: 403,
        rejectBody: { code: 'NOT_ROLLED_OUT' },
      },
      innerOk,
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: 'NOT_ROLLED_OUT' })
  })

  it('captures variant + payload when evaluate returns a verdict object', async () => {
    const inner = vi.fn(async (_req: Request, ctx) => {
      expect(ctx.featureFlag.variant).toBe('green')
      expect(ctx.featureFlag.payload).toEqual({ rollout: 0.25 })
      return Response.json({ ok: true })
    })

    const handler = withFeatureFlag(
      {
        name: 'beta',
        evaluate: () => ({
          enabled: true,
          variant: 'green',
          payload: { rollout: 0.25 },
        }),
      },
      inner,
    )

    await handler(new Request('http://localhost/'))
    expect(inner).toHaveBeenCalledOnce()
  })

  it('passes the request to evaluate so flags can target by header / IP / user', async () => {
    const evaluate = vi.fn((req: Request) => req.headers.get('x-beta') === '1')

    const handler = withFeatureFlag({ name: 'beta', evaluate }, innerOk)

    const off = await handler(new Request('http://localhost/'))
    expect(off.status).toBe(404)

    const on = await handler(
      new Request('http://localhost/', { headers: { 'x-beta': '1' } }),
    )
    expect(on.status).toBe(200)

    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it('passes the upstream context to evaluate so flags can target the verified caller', async () => {
    const withUser = defineMiddleware<
      'user',
      void,
      Record<never, never>,
      { id: string }
    >({
      key: 'user',
      run: () => async (req) => ({
        user: { id: req.headers.get('x-user') ?? 'anon' },
      }),
    })

    const evaluate = vi.fn(
      (_req: Request, ctx: { user: { id: string } }) =>
        ctx.user.id === 'tester',
    )

    const app = pipeline(
      [withUser(), withFeatureFlag({ name: 'beta', evaluate })],
      innerOk,
    )

    const off = await app(
      new Request('http://localhost/', { headers: { 'x-user': 'someone' } }),
    )
    expect(off.status).toBe(404)

    const on = await app(
      new Request('http://localhost/', { headers: { 'x-user': 'tester' } }),
    )
    expect(on.status).toBe(200)

    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      user: { id: 'someone' },
    })
  })

  it('supports async evaluators', async () => {
    const handler = withFeatureFlag(
      {
        name: 'beta',
        evaluate: async () => {
          await new Promise((r) => setTimeout(r, 1))
          return { enabled: true, variant: 'a' }
        },
      },
      async (_req, ctx) => Response.json({ variant: ctx.featureFlag.variant }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ variant: 'a' })
  })

  it('self-seeds its context when invoked as a bare fetch entry', async () => {
    const handler = withFeatureFlag(
      { name: 'beta', evaluate: () => true },
      async (_req, ctx) => Response.json({ keys: Object.keys(ctx) }),
    )

    // Called directly, the way a runtime invokes `export default { fetch }`.
    const res = await handler(new Request('http://localhost/'))
    // ctx holds only middleware contributions — no reserved framework key.
    expect(await res.json()).toEqual({ keys: ['featureFlag'] })
  })
})

// What `evaluate` declares about `ctx` is a prerequisite of that call, so a
// stack with nothing to supply it fails to compile in either form.
describe('withFeatureFlag — evaluate reads the upstream (tsc-verified)', () => {
  type User = { id: string }
  const testers = new Set(['tester'])
  const withUser = defineMiddleware<'user', void, Record<never, never>, User>({
    key: 'user',
    run: () => async () => ({ user: { id: 'tester' } }),
  })
  const withRegion = defineMiddleware<
    'region',
    void,
    Record<never, never>,
    string
  >({
    key: 'region',
    run: () => async () => ({ region: 'eu' }),
  })

  it('pipeline: an annotated evaluate reads an earlier entry', () => {
    const _app = pipeline(
      [
        withUser(),
        withFeatureFlag({
          name: 'beta',
          evaluate: (_req, ctx: { user: User }) => testers.has(ctx.user.id),
        }),
      ],
      async (_req, ctx) =>
        Response.json({ flag: ctx.featureFlag.name, user: ctx.user.id }),
    ) satisfies FetchHandler
    void _app
  })

  it('pipeline: an annotated evaluate with no provider fails to compile', () => {
    const _app = pipeline(
      [
        withRegion(),
        withFeatureFlag({
          name: 'beta',
          evaluate: (_req, ctx: { user: User }) => testers.has(ctx.user.id),
        }),
      ],
      // @ts-expect-error — middleware-prereq: key 'user' is not yet on the context
      async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
    )
    void _app
  })

  it('pipeline: an optional key compiles with or without a provider', () => {
    const evaluate = (_req: Request, ctx: { user?: User }) =>
      ctx.user !== undefined && testers.has(ctx.user.id)
    const _with = pipeline(
      [withUser(), withFeatureFlag({ name: 'beta', evaluate })],
      async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
    ) satisfies FetchHandler
    const _without = pipeline(
      [withRegion(), withFeatureFlag({ name: 'beta', evaluate })],
      async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
    ) satisfies FetchHandler
    void [_with, _without]
  })

  it('nested: an annotated evaluate reads an enclosing layer', () => {
    const _app = withUser(
      withFeatureFlag(
        {
          name: 'beta',
          evaluate: (_req, ctx: { user: User }) => testers.has(ctx.user.id),
        },
        async (_req, ctx) =>
          Response.json({ flag: ctx.featureFlag.name, user: ctx.user.id }),
      ),
    ) satisfies FetchHandler
    void _app
  })

  it('nested: an annotated evaluate with no provider fails to compile', () => {
    const stack = withRegion(
      withFeatureFlag(
        {
          name: 'beta',
          evaluate: (_req, ctx: { user: User }) => testers.has(ctx.user.id),
        },
        async (_req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
      ),
    )
    // @ts-expect-error — nothing in the stack contributes `user`
    const _entry: FetchHandler = stack
    void _entry
  })
})
