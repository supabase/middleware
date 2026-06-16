import { describe, expect, it, vi } from 'vitest'

import { defineMiddleware } from './define-middleware.js'
import { withCatch } from './with-catch.js'
import { withResponse } from './with-response.js'

const withFlag = defineMiddleware<
  'flag',
  undefined,
  Record<never, never>,
  { on: true }
>({ key: 'flag', run: () => async () => ({ flag: { on: true } }) })

describe('withResponse', () => {
  it('transforms the final response', async () => {
    const handler = withResponse(
      (res, req) => {
        const headers = new Headers(res.headers)
        headers.set('x-origin', req.headers.get('origin') ?? 'none')
        return new Response(res.body, { status: res.status, headers })
      },
      withFlag(undefined, async () => Response.json({ ok: true })),
    )

    const res = await handler(
      new Request('http://localhost/', { headers: { origin: 'https://app' } }),
    )
    expect(res.headers.get('x-origin')).toBe('https://app')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('supports an async transform', async () => {
    const handler = withResponse(
      async (res) => new Response(res.body, { status: 201 }),
      withFlag(undefined, async () => Response.json({ ok: true })),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(201)
  })

  it('composes with withCatch and stays a bare fetch entry', async () => {
    const handler = withCatch(
      () => new Response('caught', { status: 500 }),
      withResponse(
        (res) => {
          const headers = new Headers(res.headers)
          headers.set('x-wrapped', '1')
          return new Response(res.body, { status: res.status, headers })
        },
        withFlag(undefined, async (_req, ctx) =>
          Response.json({ host: ctx._runtime.name }),
        ),
      ),
    )

    // Called the way a runtime invokes `export default { fetch }`.
    const res = await (
      handler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { SECRET: 's' })
    expect(res.headers.get('x-wrapped')).toBe('1')
    expect(await res.json()).toEqual({ host: 'node' })
  })

  it('lets a request-side OPTIONS short-circuit cover preflight (CORS end to end)', async () => {
    // Preflight: a request-side middleware short-circuits on OPTIONS.
    const withPreflight = defineMiddleware<
      'preflight',
      undefined,
      Record<never, never>,
      { handled: false }
    >({
      key: 'preflight',
      run: () => async (req) =>
        req.method === 'OPTIONS'
          ? new Response(null, { status: 204 })
          : { preflight: { handled: false } },
    })

    const addCors = (res: Response) => {
      const headers = new Headers(res.headers)
      headers.set('access-control-allow-origin', '*')
      return new Response(res.body, { status: res.status, headers })
    }

    const handler = withResponse(
      addCors,
      withPreflight(undefined, async () => Response.json({ ok: true })),
    )

    const preflight = await handler(
      new Request('http://localhost/', { method: 'OPTIONS' }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

    const real = await handler(new Request('http://localhost/'))
    expect(real.status).toBe(200)
    expect(real.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('only maps the final response — does not give middleware response access', () => {
    // Type/shape note: withResponse receives (Response, Request); it cannot
    // observe or mutate per-middleware state, by design (no onion model).
    const noop = vi.fn((res: Response) => res)
    void withResponse(
      noop,
      withFlag(undefined, async () => new Response(null)),
    )
    expect(noop).not.toHaveBeenCalled() // not invoked until a request flows
  })
})
