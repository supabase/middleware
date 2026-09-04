import { describe, expect, it } from 'vitest'

import { defineComposite } from './define-composite.js'
import { defineMiddleware } from './define-middleware.js'
import { pipeline } from './pipeline.js'
import type {
  Conflict,
  Contributions,
  FetchHandler,
  NoConflict,
  SingleKeyEntry,
} from '../index.js'

const innerOk = async () => Response.json({ ok: true })

const passing = <Key extends string, C>(key: Key, contribution: C) =>
  defineMiddleware<Key, void, Record<never, never>, C>({
    key,
    run: () => async () => ({ [key]: contribution }) as { [K in Key]: C },
  })

/** A gate contributing the whole auth result, plus projections off it. */
const withGate = defineMiddleware<
  'auth',
  { mode: 'user' | 'none' },
  Record<never, never>,
  { mode: string; sub: string }
>({
  key: 'auth',
  run: (config) => async (req) => {
    if (config.mode === 'user' && !req.headers.get('authorization')) {
      return new Response('unauthorized', { status: 401 })
    }
    return { auth: { mode: config.mode, sub: 'user-1' } }
  },
})
const withMode = defineMiddleware<
  'authMode',
  void,
  { auth: { mode: string; sub: string } },
  string
>({
  key: 'authMode',
  run: () => async (_req, ctx) => ({ authMode: ctx.auth.mode }),
})
const withClaims = defineMiddleware<
  'claims',
  void,
  { auth: { mode: string; sub: string } },
  { sub: string }
>({
  key: 'claims',
  run: () => async (_req, ctx) => ({ claims: { sub: ctx.auth.sub } }),
})

const withAuth = defineComposite({
  build: (config: { mode: 'user' | 'none' }) =>
    [withGate(config), withMode(), withClaims()] as const,
  internal: ['auth'],
})

const authed = () =>
  new Request('http://localhost/', { headers: { authorization: 'Bearer t' } })

describe('defineComposite', () => {
  it('contributes every part’s key to the handler ctx', async () => {
    const handler = withAuth({ mode: 'none' }, async (_req, ctx) =>
      Response.json({ mode: ctx.authMode, sub: ctx.claims.sub }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ mode: 'none', sub: 'user-1' })
  })

  it('drops into a pipeline array like any other middleware', async () => {
    const handler = pipeline([withAuth({ mode: 'none' })], async (_req, ctx) =>
      Response.json({ mode: ctx.authMode, sub: ctx.claims.sub }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ mode: 'none', sub: 'user-1' })
  })

  it('is equivalent nested and flat (same response)', async () => {
    const inner = async () => Response.json({ ok: true })
    const nested = await withAuth(
      { mode: 'none' },
      inner,
    )(new Request('http://localhost/'))
    const flat = await pipeline(
      [withAuth({ mode: 'none' })],
      inner,
    )(new Request('http://localhost/'))
    expect(await flat.json()).toEqual(await nested.json())
  })

  it('discharges a part’s prerequisite from an earlier part internally', () => {
    // withMode / withClaims declare In: { auth }, supplied by withGate inside
    // the composite. Nothing outstanding, so ctx is optional and the composite
    // can be the fetch export on its own.
    const handler = withAuth({ mode: 'none' }, async () =>
      Response.json({ ok: true }),
    ) satisfies FetchHandler
    void handler
  })

  it('short-circuits from inside the fold, so an outer seam observes it', async () => {
    const seen: number[] = []
    const withSeam = defineMiddleware<'seam', void, Record<never, never>, true>(
      {
        key: 'seam',
        run: () =>
          async function* () {
            const response: Response = yield { seam: true }
            seen.push(response.status)
            return response
          },
      },
    )

    const handler = pipeline(
      [withSeam(), withAuth({ mode: 'user' })],
      async () => Response.json({ ok: true }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(401)
    // The composite's gate rejected, and the enclosing seam still saw it.
    expect(seen).toEqual([401])
  })

  it('runs parts outermost-first', async () => {
    const order: string[] = []
    const trace = (name: string) =>
      defineMiddleware<string, void, Record<never, never>, true>({
        key: name,
        run: () => async () => {
          order.push(name)
          return { [name]: true }
        },
      })
    const composite = defineComposite({
      build: () => [trace('first')(), trace('second')()] as const,
    })

    await composite(async () => Response.json({ ok: true }))(
      new Request('http://localhost/'),
    )
    expect(order).toEqual(['first', 'second'])
  })

  it('preserves an upstream context when nested', async () => {
    const withUp = passing('up', 1)
    const handler = withUp(
      withAuth({ mode: 'none' }, async (_req, ctx) =>
        Response.json({ keys: Object.keys(ctx).sort() }),
      ),
    ) satisfies FetchHandler

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({
      keys: ['authMode', 'claims', 'up'],
    })
  })
})

describe('defineComposite — internal keys', () => {
  it('strips an internal key from ctx at the boundary', async () => {
    const handler = withAuth({ mode: 'none' }, async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx).sort() }),
    )

    const res = await handler(new Request('http://localhost/'))
    // `auth` is the gate's contribution — internal plumbing, gone by the boundary.
    expect(await res.json()).toEqual({ keys: ['authMode', 'claims'] })
  })

  it('hides it from a downstream middleware too, not just the handler', async () => {
    const spy = defineMiddleware<'spy', void, Record<never, never>, string[]>({
      key: 'spy',
      run: () => async (_req, ctx) => ({ spy: Object.keys(ctx).sort() }),
    })

    const handler = pipeline(
      [withAuth({ mode: 'none' }), spy()],
      async (_req, ctx) => Response.json({ seen: ctx.spy }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ seen: ['authMode', 'claims'] })
  })

  it('keeps the stripped context usable as an upstream context', async () => {
    // The strip is a spread, which carries the context marker, so a downstream
    // middleware still recognizes it rather than reseeding.
    const handler = pipeline(
      [withAuth({ mode: 'none' }), passing('after', 2)()],
      async (_req, ctx) =>
        Response.json({ after: ctx.after, mode: ctx.authMode }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ after: 2, mode: 'none' })
  })

  it('leaves ctx untouched when nothing is marked internal', async () => {
    const composite = defineComposite({
      build: () => [passing('a', 1)(), passing('b', 2)()] as const,
    })
    const handler = composite(async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx).sort() }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ keys: ['a', 'b'] })
  })
})

describe('defineComposite — types (tsc-verified)', () => {
  it('derives contributions as the union of its parts', () => {
    type C = Contributions<
      readonly [
        SingleKeyEntry<'a', Record<never, never>, 1>,
        SingleKeyEntry<'b', Record<never, never>, 2>,
      ]
    >
    const _ok: C = { a: 1, b: 2 }
    void _ok
  })

  it('cannot declare a key no part contributes', () => {
    defineComposite({
      build: () => [passing('a', 1)()] as const,
      // @ts-expect-error — 'nope' is contributed by no part
      internal: ['nope'],
    })
  })

  it('omits internal keys from the declared contributions', () => {
    const composite = defineComposite({
      build: () => [passing('a', 1)(), passing('b', 2)()] as const,
      internal: ['a'],
    })
    composite(async (_req, ctx) => {
      const b: number = ctx.b
      // @ts-expect-error — 'a' is internal
      void ctx.a
      return Response.json({ b })
    })
  })

  it('resolves NoConflict to a Conflict sentinel naming the offending key', () => {
    // The mechanism, asserted directly. Through the overload set the same
    // collision surfaces as a TS2769 whose text depends on which overload
    // absorbs the fall-through, so pin the sentinel here instead.
    type Guarded = NoConflict<{ a: 1; b: 2 }, { b: 2 }, 'handler-ok'>
    const _named: Guarded =
      "middleware-conflict: key 'b' is already present on the upstream context"
    void _named
    const _isConflict: Conflict<'b'> = _named
    void _isConflict
  })

  it('resolves NoConflict to the handler when every key is free', () => {
    type Free = NoConflict<{ a: 1; b: 2 }, { c: 3 }, 'handler-ok'>
    const _ok: Free = 'handler-ok'
    void _ok
  })

  it('rejects a part whose key collides with the upstream context', () => {
    const withA = passing('a', 1)
    const composite = defineComposite({
      build: () => [passing('a', 9)()] as const,
    })
    // Must stay syntactically nested: `Base` flows in from the enclosing
    // call's contextual type, so hoisting the inner call out of the argument
    // position is what turns the check off (see `NoConflict`).
    // @ts-expect-error — Conflict<'a'>: the upstream already carries 'a'
    const bad = withA(composite(innerOk)) satisfies FetchHandler
    void bad
  })

  it('republishes a prerequisite no part supplies, failing FetchHandler', () => {
    const needsX = defineMiddleware<'y', void, { x: number }, true>({
      key: 'y',
      run: () => async () => ({ y: true }),
    })
    const composite = defineComposite({
      build: () => [needsX()] as const,
    })
    const produced = composite(innerOk)
    // @ts-expect-error — 'x' is outstanding, so ctx is required
    const bad = produced satisfies FetchHandler
    void bad
  })

  it('accepts a composite whose outstanding prerequisite an outer layer supplies', async () => {
    const needsX = defineMiddleware<'y', void, { x: number }, true>({
      key: 'y',
      run: () => async () => ({ y: true }),
    })
    const composite = defineComposite({ build: () => [needsX()] as const })
    const handler = pipeline(
      [passing('x', 1)(), composite()],
      async (_req, ctx) => Response.json({ y: ctx.y, x: ctx.x }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ y: true, x: 1 })
  })
})

describe('defineComposite — gate behavior', () => {
  it('rejects when the gate rejects', async () => {
    const handler = pipeline([withAuth({ mode: 'user' })], async () =>
      Response.json({ ok: true }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(401)
  })

  it('passes through when the gate is satisfied', async () => {
    const handler = pipeline([withAuth({ mode: 'user' })], async (_req, ctx) =>
      Response.json({ sub: ctx.claims.sub }),
    )
    const res = await handler(authed())
    expect(await res.json()).toEqual({ sub: 'user-1' })
  })
})

describe('defineComposite — nested composites', () => {
  it('accepts a composite as a part, deriving through both levels', async () => {
    const inner = defineComposite({
      build: () => [passing('a', 1)(), passing('b', 2)()] as const,
    })
    const outer = defineComposite({
      build: () => [inner(), passing('c', 3)()] as const,
    })

    const handler = outer(async (_req, ctx) =>
      Response.json({ a: ctx.a, b: ctx.b, c: ctx.c }),
    ) satisfies FetchHandler
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('keeps a key the inner composite marks internal hidden through the outer', async () => {
    const inner = defineComposite({
      build: () => [passing('secret', 1)(), passing('shown', 2)()] as const,
      internal: ['secret'],
    })
    const outer = defineComposite({ build: () => [inner()] as const })

    const handler = outer(async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx).sort() }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ keys: ['shown'] })
  })

  it('propagates an inner composite’s outstanding prerequisite outward', async () => {
    const needsX = defineMiddleware<'y', void, { x: number }, true>({
      key: 'y',
      run: () => async () => ({ y: true }),
    })
    const inner = defineComposite({ build: () => [needsX()] as const })
    const outer = defineComposite({ build: () => [inner()] as const })

    const handler = pipeline([passing('x', 1)(), outer()], async (_req, ctx) =>
      Response.json({ y: ctx.y, x: ctx.x }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ y: true, x: 1 })
  })

  it('detects a collision between an inner composite key and a sibling', () => {
    const inner = defineComposite({
      build: () => [passing('dup', 1)()] as const,
    })
    const handler = pipeline(
      [inner(), passing('dup', 2)()],
      // @ts-expect-error — Conflict<'dup'>: the composite already contributes it
      innerOk,
    )
    void handler
  })
})

describe('defineComposite — internal keys are scoped, not deleted', () => {
  const upstreamAuth = passing('auth', 'from-upstream' as const)

  it('restores an upstream key of the same name, flat', async () => {
    const app = pipeline(
      [upstreamAuth(), withAuth({ mode: 'none' })],
      async (_req, ctx) => {
        // The type says the upstream value survives; so must the runtime.
        const still: 'from-upstream' = ctx.auth
        return Response.json({ still, keys: Object.keys(ctx).sort() })
      },
    )

    const res = await app(new Request('http://localhost/'))
    expect(await res.json()).toEqual({
      still: 'from-upstream',
      keys: ['auth', 'authMode', 'claims'],
    })
  })

  it('restores an upstream key of the same name, nested', async () => {
    // `satisfies FetchHandler` anchors the outermost call, which is what the
    // docs ask for and what keeps the cascade overload (rather than
    // propagation) selected at the TypeScript floor.
    const app = upstreamAuth(
      withAuth({ mode: 'none' }, async (_req, ctx) =>
        Response.json({ auth: ctx.auth, keys: Object.keys(ctx).sort() }),
      ),
    ) satisfies FetchHandler

    const res = await app(new Request('http://localhost/'))
    expect(await res.json()).toEqual({
      auth: 'from-upstream',
      keys: ['auth', 'authMode', 'claims'],
    })
  })

  it('still strips an internal key with no upstream counterpart', async () => {
    const app = pipeline([withAuth({ mode: 'none' })], async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx).sort() }),
    )

    const res = await app(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ keys: ['authMode', 'claims'] })
  })

  it('scopes the composite’s own value while its parts run', async () => {
    // Inside the composite the parts must see the gate's `auth`, not the
    // upstream's — that is what the projections read.
    const app = pipeline(
      [upstreamAuth(), withAuth({ mode: 'none' })],
      async (_req, ctx) =>
        Response.json({ mode: ctx.authMode, auth: ctx.auth }),
    )

    const res = await app(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ mode: 'none', auth: 'from-upstream' })
  })

  it('keeps each level’s snapshot separate when composites nest and both mark internals', async () => {
    const inner = defineComposite({
      build: () =>
        [passing('shared', 'inner' as const)(), passing('a', 1)()] as const,
      internal: ['shared'],
    })
    const outer = defineComposite({
      build: () =>
        [
          inner(),
          passing('shared', 'outer' as const)(),
          passing('b', 2)(),
        ] as const,
      internal: ['shared'],
    })

    const app = pipeline(
      [passing('shared', 'upstream' as const)(), outer()],
      async (_req, ctx) =>
        Response.json({ shared: ctx.shared, keys: Object.keys(ctx).sort() }),
    )

    const res = await app(new Request('http://localhost/'))
    // Both levels restore, so the upstream value reaches the handler intact.
    expect(await res.json()).toEqual({
      shared: 'upstream',
      keys: ['a', 'b', 'shared'],
    })
  })

  it('leaves no snapshot marker on the context', async () => {
    const app = pipeline(
      [upstreamAuth(), withAuth({ mode: 'none' })],
      async (_req, ctx) =>
        Response.json({ symbols: Object.getOwnPropertySymbols(ctx).length }),
    )

    const res = await app(new Request('http://localhost/'))
    // Only the engine's own context marker remains.
    expect(await res.json()).toEqual({ symbols: 1 })
  })
})

describe('defineComposite — parts declared with SingleKeyEntry', () => {
  // The shape a wrapper writes to thread a generic through a middleware. It has
  // to compose like any other part; the shorthand is only unsafe where `Key` is
  // still a deferred parameter, which is never true at a call site.
  interface FakeClient<Database> {
    db: Database
  }
  const base = defineMiddleware<
    'thing',
    void,
    Record<never, never>,
    FakeClient<unknown>
  >({ key: 'thing', run: () => async () => ({ thing: { db: null } }) })

  function withThing<Database = unknown>(): SingleKeyEntry<
    'thing',
    Record<never, never>,
    FakeClient<Database>
  > {
    return base() as unknown as SingleKeyEntry<
      'thing',
      Record<never, never>,
      FakeClient<Database>
    >
  }

  it('contributes its key, typed through the generic', async () => {
    const composite = defineComposite({
      build: () => [withThing<{ tag: 'db' }>(), passing('other', 1)()] as const,
    })

    const handler = composite(async (_req, ctx) => {
      const db: { tag: 'db' } = ctx.thing.db
      const other: number = ctx.other
      return Response.json({ db, other })
    }) satisfies FetchHandler

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ db: null, other: 1 })
  })

  it('can be marked internal, so `Contributions` resolved its key', async () => {
    const composite = defineComposite({
      build: () => [withThing(), passing('other', 1)()] as const,
      internal: ['thing'],
    })

    const handler = composite(async (_req, ctx) =>
      Response.json({ keys: Object.keys(ctx).sort() }),
    ) satisfies FetchHandler

    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ keys: ['other'] })
  })
})
