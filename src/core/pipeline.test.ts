import { describe, expect, it, vi } from 'vitest'

import { defineMiddleware } from './define-middleware.js'
import type { BaseContext, FetchHandler } from './runtime.js'
import { pipeline } from './pipeline.js'

const innerOk = async () => Response.json({ ok: true })

const runtime: BaseContext['_runtime'] = { name: 'node', getEnv: () => undefined }
void runtime

const passing = <Key extends string, C extends object>(key: Key, contribution: C) =>
  defineMiddleware<Key, void, Record<never, never>, C>({
    key,
    run: () => async () => ({ [key]: contribution }) as { [K in Key]: C },
  })

const rejecting = <Key extends string>(key: Key, status = 401) =>
  defineMiddleware<Key, void, Record<never, never>, Record<never, never>>({
    key,
    run: () => async () => new Response(`rejected by ${key}`, { status }),
  })

describe('pipeline', () => {
  it('composes entries in order, contributes keys, self-seeds ctx._runtime', async () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const handler = pipeline(
      [withA(), withB()],
      async (_req, ctx) =>
        Response.json({ alpha: ctx.alpha.v, beta: ctx.beta.v, host: ctx._runtime.name }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ alpha: 1, beta: 2, host: 'node' })
  })

  it('pre-applies required config', async () => {
    const withGreeting = defineMiddleware<
      'greeting',
      { who: string },
      Record<never, never>,
      string
    >({
      key: 'greeting',
      run: (config) => async () => ({ greeting: config.who }),
    })

    const handler = pipeline(
      [withGreeting({ who: 'world' })],
      async (_req, ctx) => Response.json({ msg: ctx.greeting }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ msg: 'world' })
  })

  it('is equivalent to hand-nesting (same response)', async () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const nestedHandler = withA(
      withB(async (_req, ctx) =>
        Response.json({ alpha: ctx.alpha.v, beta: ctx.beta.v }),
      ),
    ) satisfies FetchHandler

    const flatHandler = pipeline(
      [withA(), withB()],
      async (_req, ctx) => Response.json({ alpha: ctx.alpha.v, beta: ctx.beta.v }),
    )

    const [nestedRes, flatRes] = await Promise.all([
      nestedHandler(new Request('http://localhost/')),
      flatHandler(new Request('http://localhost/')),
    ])
    expect(await nestedRes.json()).toEqual(await flatRes.json())
  })

  it('short-circuits on reject without calling the inner handler', async () => {
    const inner = vi.fn(innerOk)
    const handler = pipeline([rejecting('blocker', 402)()], inner)

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(402)
    expect(await res.text()).toBe('rejected by blocker')
    expect(inner).not.toHaveBeenCalled()
  })

  it('uses middleware whose prerequisites are provided by an earlier entry', async () => {
    const withAuth = passing('auth', { userId: 'u1' })
    const withProfile = defineMiddleware<
      'profile',
      void,
      { auth: { userId: string } },
      { displayName: string }
    >({
      key: 'profile',
      run: () => async (_req, ctx) => ({
        profile: { displayName: `user:${ctx.auth.userId}` },
      }),
    })

    const handler = pipeline(
      [withAuth(), withProfile()],
      async (_req, ctx) => Response.json({ name: ctx.profile.displayName }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ name: 'user:u1' })
  })

  it('still drives a generator entry through the response seam', async () => {
    // A regression guard for the flat syntax: an `async function*` middleware
    // placed in a pipeline array must still observe and shape the downstream
    // Response, exactly as it would hand-nested.
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

    const handler = pipeline(
      [withStamp({ header: 'x-stamp' })],
      async (_req, ctx) => Response.json({ at: ctx.stamp.at }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.headers.get('x-stamp')).toBe('seen')
    expect(await res.json()).toEqual({ at: 'before' })
  })
})

// ---------------------------------------------------------------------------
// Compile-time guarantees — verified by `tsc --noEmit`. A regression is a
// type error or an unused-directive error. A plain vitest run cannot see these.
// ---------------------------------------------------------------------------
describe('type guarantees (tsc-verified)', () => {
  it('ctx accumulation: all contributed keys are typed in the handler', () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const _app = pipeline(
      [withA(), withB()],
      async (_req, ctx) => {
        const a: number = ctx.alpha.v
        const b: number = ctx.beta.v
        const host: string = ctx._runtime.name
        void a
        void b
        void host
        return Response.json({ ok: true })
      },
    ) satisfies FetchHandler
    void _app
  })

  it('collision: duplicate key in pipeline fails to compile', () => {
    const withFoo = passing('foo', { v: 1 })

    const _bad = pipeline(
      [withFoo(), withFoo()],
      // @ts-expect-error — duplicate key 'foo': Validate fires Conflict<'foo'>
      async () => Response.json({ ok: true }),
    )
    void _bad
  })

  it('prerequisite: wrong ordering (prereq not yet provided) fails to compile', () => {
    const withNeedsAuth = defineMiddleware<
      'profile',
      void,
      { auth: { userId: string } },
      { displayName: string }
    >({
      key: 'profile',
      run: () => async () => ({ profile: { displayName: 'x' } }),
    })
    const withAuth = passing('auth', { userId: 'u1' })

    const _bad = pipeline(
      [withNeedsAuth(), withAuth()], // profile before auth — wrong order
      // @ts-expect-error — prereq 'auth' is not yet on the context
      async () => Response.json({ ok: true }),
    )
    void _bad
  })

  it('does not let a host-supplied env (arg 2) leak into ctx', async () => {
    const withA = passing('a', { v: 1 })
    const handler = pipeline([withA()], async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx) }),
    )

    const res = await (
      handler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { SECRET: 's' })
    expect(await res.json()).toEqual({ keys: ['_runtime', 'a'] })
  })
})
