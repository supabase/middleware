import { describe, expect, it, vi } from 'vitest'

import { withCors } from './with-cors.js'

const ORIGIN = 'https://app.example.com'

const preflight = (origin = ORIGIN, method = 'POST') =>
  new Request('http://localhost/', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'content-type, authorization',
    },
  })

const actual = (origin = ORIGIN) =>
  new Request('http://localhost/', { headers: { Origin: origin } })

describe('withCors', () => {
  it('answers preflight without invoking the handler', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const res = await withCors({ origin: '*' }, handler)(preflight())

    expect(res.status).toBe(204)
    expect(handler).not.toHaveBeenCalled()
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    // No explicit allowedHeaders → reflect the requested ones.
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'content-type, authorization',
    )
  })

  it('stamps CORS headers onto the actual response and runs the handler', async () => {
    const res = await withCors({ origin: '*' }, async (_req, ctx) =>
      Response.json({ allowed: ctx.cors.allowedOrigin }),
    )(actual())

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await res.json()).toEqual({ allowed: '*' })
  })

  it('reflects an allowed origin from a list and sets Vary: Origin', async () => {
    const res = await withCors({ origin: [ORIGIN] }, async () =>
      Response.json({ ok: true }),
    )(actual())

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(res.headers.get('Vary')).toContain('Origin')
  })

  it('omits CORS headers for a disallowed origin (handler still runs)', async () => {
    const res = await withCors({ origin: [ORIGIN] }, async () =>
      Response.json({ ok: true }, { status: 201 }),
    )(actual('https://evil.example.com'))

    expect(res.status).toBe(201)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(await res.json()).toEqual({ ok: true })
  })

  it('reflects the origin (never *) when credentials are enabled', async () => {
    const res = await withCors({ origin: '*', credentials: true }, async () =>
      Response.json({ ok: true }),
    )(actual())

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('honors maxAge and explicit allowedHeaders on preflight', async () => {
    const res = await withCors(
      { origin: '*', allowedHeaders: ['x-custom'], maxAge: 600 },
      async () => Response.json({ ok: true }),
    )(preflight())

    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('x-custom')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600')
  })

  it('passes Response.error() through untouched (status 0 cannot be reconstructed)', async () => {
    const res = await withCors({ origin: '*' }, async () => Response.error())(
      actual(),
    )

    // `new Response(body, { status: 0 })` would throw — the error response must
    // pass through as-is, without CORS headers.
    expect(res.status).toBe(0)
    expect(res.type).toBe('error')
  })

  it('passes a non-reconstructable status through untouched (e.g. a 101 upgrade)', async () => {
    // The Response constructor rejects statuses outside 200–599, so build the
    // downstream response via the same escape hatch a host would use.
    const upgrade = Response.error()
    Object.defineProperty(upgrade, 'status', { value: 101 })
    const res = await withCors({ origin: '*' }, async () => upgrade)(actual())

    expect(res).toBe(upgrade)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('preserves a streamed/immutable response body when stamping headers', async () => {
    const body = JSON.stringify({ streamed: true })
    const res = await withCors({ origin: '*' }, async () => {
      // A Response whose headers are immutable (as from `fetch`) — stamping must
      // not throw and the body must pass through.
      const r = new Response(body, {
        headers: { 'content-type': 'application/json' },
      })
      return r
    })(actual())

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ streamed: true })
  })
})
