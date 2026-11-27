import { describe, expect, it, vi } from 'vitest'

import { defineMiddleware } from './define-middleware.js'
import type { BaseContext, FetchHandler } from './runtime.js'
import { pipeline } from './pipeline.js'
import type { Entry, SingleKeyEntry, ValidateEntries } from '../index.js'

const innerOk = async () => Response.json({ ok: true })

/** Exact type equality, not mutual assignability: `true` only for one type. */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false
/** `exact<Expected>()(value, true)` compiles only when `value` is exactly `Expected`. */
const exact =
  <Expected>() =>
  <Actual>(value: Actual, equal: Equal<Actual, Expected>) => [value, equal]

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

describe('pipeline', () => {
  it('composes entries in order, contributes keys, self-seeds its context', async () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const handler = pipeline([withA(), withB()], async (_req, ctx) =>
      Response.json({ alpha: ctx.alpha.v, beta: ctx.beta.v }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ alpha: 1, beta: 2 })
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

  it('is equivalent to nested handlers (same response)', async () => {
    const withA = passing('alpha', { v: 1 })
    const withB = passing('beta', { v: 2 })

    const nestedHandler = withA(
      withB(async (_req, ctx) =>
        Response.json({ alpha: ctx.alpha.v, beta: ctx.beta.v }),
      ),
    ) satisfies FetchHandler

    const flatHandler = pipeline([withA(), withB()], async (_req, ctx) =>
      Response.json({ alpha: ctx.alpha.v, beta: ctx.beta.v }),
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

    const handler = pipeline([withAuth(), withProfile()], async (_req, ctx) =>
      Response.json({ name: ctx.profile.displayName }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ name: 'user:u1' })
  })

  it('still drives a generator entry through the response seam', async () => {
    // A regression guard for the flat syntax: an `async function*` middleware
    // placed in a pipeline array must still observe and shape the downstream
    // Response, exactly as it would with nested handlers.
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

    const _app = pipeline([withA(), withB()], async (_req, ctx) => {
      const a: number = ctx.alpha.v
      const b: number = ctx.beta.v
      void a
      void b
      return Response.json({ ok: true })
    }) satisfies FetchHandler
    void _app
  })

  it('collision: duplicate key in pipeline fails to compile', () => {
    const withFoo = passing('foo', { v: 1 })

    const _bad = pipeline(
      [withFoo(), withFoo()],
      // @ts-expect-error — duplicate key 'foo': ValidateEntries fires Conflict<'foo'>
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

  it('prerequisite: an earlier entry with the key at the wrong type fails to compile', () => {
    const withNeedsAuth = defineMiddleware<
      'profile',
      void,
      { auth: { userId: string } },
      { displayName: string }
    >({
      key: 'profile',
      run: () => async () => ({ profile: { displayName: 'x' } }),
    })
    const withNumericAuth = passing('auth', { userId: 1 })

    const _bad = pipeline(
      [withNumericAuth(), withNeedsAuth()],
      // @ts-expect-error — middleware-prereq: key 'auth' is on the upstream context with an incompatible type
      async () => Response.json({ ok: true }),
    )
    void _bad
  })

  it('prerequisite: an optional key is never unmet, but its type is still checked', () => {
    const withMaybeAuth = defineMiddleware<
      'profile',
      void,
      { auth?: { userId: string } },
      { displayName: string }
    >({
      key: 'profile',
      run: () => async () => ({ profile: { displayName: 'x' } }),
    })

    const _ok = pipeline([withMaybeAuth()], async (_req, ctx) =>
      Response.json({ name: ctx.profile.displayName }),
    ) satisfies FetchHandler
    void _ok

    const _bad = pipeline(
      [passing('auth', { userId: 1 })(), withMaybeAuth()],
      // @ts-expect-error — middleware-prereq: key 'auth' is on the upstream context with an incompatible type
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
    expect(await res.json()).toEqual({ keys: ['a'] })
  })
})

// ---------------------------------------------------------------------------
// A `pipeline` written where a handler is expected: a middleware's handler
// argument, another `pipeline`'s, or a position typed as a handler whose `ctx`
// carries upstream keys. Its handler must see the same `ctx` the nested form
// sees there, and its entries are checked against that context, not against an
// empty one. Verified by `tsc --noEmit`, except the runtime case.
// ---------------------------------------------------------------------------
describe('pipeline in a handler position', () => {
  const withA = defineMiddleware<'a', undefined, Record<never, never>, string>({
    key: 'a',
    run: () => async () => ({ a: 'a' }),
  })
  const withB = defineMiddleware<'b', undefined, Record<never, never>, number>({
    key: 'b',
    run: () => async () => ({ b: 1 }),
  })
  const withC = defineMiddleware<'c', undefined, Record<never, never>, boolean>(
    { key: 'c', run: () => async () => ({ c: true }) },
  )
  const withNeedsA = defineMiddleware<'n', undefined, { a: string }, boolean>({
    key: 'n',
    run: () => async (_req, ctx) => ({ n: ctx.a === 'a' }),
  })

  it('a middleware handler argument: sees the enclosing key at runtime', async () => {
    const app = withA(
      pipeline([withB()], async (_req, ctx) =>
        Response.json({ a: ctx.a, b: ctx.b }),
      ),
    ) satisfies FetchHandler
    const res = await app(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ a: 'a', b: 1 })
  })

  it('a middleware handler argument: ctx is the enclosing context plus the entries, exactly', () => {
    const _app = withA(
      pipeline([withB()], async (_req, ctx) => {
        exact<BaseContext & { a: string } & { b: number }>()(ctx, true)
        return Response.json({ ok: true })
      }),
    ) satisfies FetchHandler
    void _app
  })

  it('a middleware handler argument: the enclosing layer meets an entry prerequisite', () => {
    const _app = withA(
      pipeline([withNeedsA()], async (_req, ctx) => {
        exact<BaseContext & { a: string } & { n: boolean }>()(ctx, true)
        return Response.json({ ok: true })
      }),
    ) satisfies FetchHandler
    void _app
  })

  it('a middleware handler argument, typed by a declaration instead of satisfies', () => {
    const _app: FetchHandler = withA(
      pipeline([withB()], async (_req, ctx) => {
        exact<BaseContext & { a: string } & { b: number }>()(ctx, true)
        return Response.json({ ok: true })
      }),
    )
    void _app
  })

  it('a middleware handler argument, unanchored: the pipeline starts from the empty upstream', () => {
    // With nothing checking the outermost call, `withA`'s upstream is not
    // inferred yet when the pipeline is typed, so its key is not visible here.
    const _app = withA(
      pipeline([withB()], async (_req, ctx) => {
        exact<BaseContext & { b: number }>()(ctx, true)
        return Response.json({ ok: true })
      }),
    )
    void _app
  })

  it('a position typed as a handler with upstream keys', () => {
    const _typed: (
      req: Request,
      ctx: BaseContext & { a: string },
    ) => Promise<Response> = pipeline([withB()], async (_req, ctx) => {
      exact<BaseContext & { a: string } & { b: number }>()(ctx, true)
      return Response.json({ ok: true })
    })
    void _typed
  })

  it('depth 3: a pipeline in a pipeline in a middleware', () => {
    const _app = withA(
      pipeline(
        [withB()],
        pipeline([withC()], async (_req, ctx) => {
          exact<BaseContext & { a: string } & { b: number } & { c: boolean }>()(
            ctx,
            true,
          )
          return Response.json({ ok: true })
        }),
      ),
    ) satisfies FetchHandler
    void _app
  })

  it('depth 4: middleware, pipeline, middleware, pipeline', () => {
    const _app = withA(
      pipeline(
        [withB()],
        withC(
          pipeline([withNeedsA()], async (_req, ctx) => {
            const all: [string, number, boolean, boolean] = [
              ctx.a,
              ctx.b,
              ctx.c,
              ctx.n,
            ]
            return Response.json(all)
          }),
        ),
      ),
    ) satisfies FetchHandler
    void _app
  })

  it('a top-level pipeline is still a FetchHandler, explicit type arguments included', () => {
    const _app: FetchHandler = pipeline([withA(), withB()], innerOk)
    const _explicit = pipeline<[Entry<{ a: string }>]>(
      [withA()],
      async (_req, ctx) => Response.json({ a: ctx.a }),
    ) satisfies FetchHandler
    void _app
    void _explicit
  })

  it('a host-typed export is not a handler position: ctx stays exact, env keys never collide', () => {
    // The shape of a Workers `ExportedHandler<Env>`: the second parameter is
    // the platform's env, and the return admits a bare `Response`.
    type Host<Env> = {
      fetch: (
        req: Request,
        env: Env,
        ctx: unknown,
      ) => Response | Promise<Response>
    }
    const withDB = defineMiddleware<'DB', undefined, Record<never, never>, 1>({
      key: 'DB',
      run: () => async () => ({ DB: 1 }),
    })
    const _app = {
      fetch: pipeline([withA(), withDB()], async (_req, ctx) => {
        exact<BaseContext & { a: string } & { DB: 1 }>()(ctx, true)
        return Response.json({ ok: true })
      }),
    } satisfies Host<{ DB: string; SECRET: string }>
    void _app
  })

  it('collision: an entry key the enclosing layer already contributes fails', () => {
    const _bad = withA(
      pipeline(
        [withA()],
        // @ts-expect-error — middleware-conflict: key 'a' is already present on the upstream context
        innerOk,
      ),
    ) satisfies FetchHandler
    void _bad
  })

  it('collision: an entry key an enclosing pipeline already contributes fails', () => {
    const _bad = pipeline(
      [withA()],
      pipeline(
        [withB(), withA()],
        // @ts-expect-error — middleware-conflict: key 'a' is already present on the upstream context
        innerOk,
      ),
    )
    void _bad
  })

  it('prerequisite: unmet at the top level, with nothing enclosing to meet it', () => {
    const _bad = pipeline(
      [withNeedsA()],
      // @ts-expect-error — middleware-prereq: key 'a' is not yet on the context (check ordering)
      innerOk,
    )
    void _bad
  })

  it('prerequisite: an enclosing layer that contributes something else does not meet it', () => {
    const _bad = withB(
      pipeline(
        [withNeedsA()],
        // @ts-expect-error — middleware-prereq: key 'a' is not yet on the context (check ordering)
        innerOk,
      ),
    )
    void _bad
  })

  it('prerequisite: an enclosing provider of the wrong type does not meet it', () => {
    const withANumber = defineMiddleware<
      'a',
      undefined,
      Record<never, never>,
      number
    >({ key: 'a', run: () => async () => ({ a: 1 }) })

    const _bad = withANumber(
      pipeline(
        [withNeedsA()],
        // @ts-expect-error — middleware-prereq: key 'a' is on the upstream context with an incompatible type
        innerOk,
      ),
    )
    void _bad
  })
})

describe('ValidateEntries (exported, tsc-verified)', () => {
  type NeedsAuthEntry = SingleKeyEntry<
    'profile',
    { auth: { userId: string } },
    { displayName: string }
  >

  it('resolves to true when the seed satisfies the prerequisite', () => {
    const _ok: ValidateEntries<[NeedsAuthEntry], { auth: { userId: string } }> =
      true
    void _ok
  })

  it('reports a missing prerequisite against the default seed', () => {
    // @ts-expect-error — prereq 'auth' is not on the default BaseContext seed
    const _bad: ValidateEntries<[NeedsAuthEntry]> = true
    void _bad
  })

  it('reports a mismatch when the seed carries the prerequisite at another type', () => {
    const _msg: ValidateEntries<
      [NeedsAuthEntry],
      { auth: { userId: number } }
    > =
      "middleware-prereq: key 'auth' is on the upstream context with an incompatible type"
    void _msg
  })

  it('reports a conflict when the seed already carries the entry key', () => {
    // @ts-expect-error — Conflict<'profile'>: key already on the seed
    const _bad: ValidateEntries<
      [NeedsAuthEntry],
      { auth: { userId: string }; profile: { displayName: string } }
    > = true
    void _bad
  })
})
