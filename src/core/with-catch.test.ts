import { describe, expect, it, vi } from 'vitest'

import { defineMiddleware } from './define-middleware.js'
import { withCatch } from './with-catch.js'

const withFlag = defineMiddleware<
  'flag',
  { explode: boolean },
  Record<never, never>,
  { on: true }
>({
  key: 'flag',
  run: (config) => async () => {
    if (config.explode) throw new Error('boom')
    return { flag: { on: true } }
  },
})

describe('withCatch', () => {
  it('contains a downstream throw and returns the onError response', async () => {
    const onError = vi.fn((error: unknown) =>
      Response.json({ error: String(error) }, { status: 500 }),
    )
    const handler = withCatch(
      onError,
      withFlag({ explode: false }, async () => {
        throw new Error('handler blew up')
      }),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Error: handler blew up' })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('contains a throw from within a middleware run()', async () => {
    const handler = withCatch(
      () => new Response('caught', { status: 503 }),
      withFlag({ explode: true }, async () => Response.json({ ok: true })),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('caught')
  })

  it('passes a successful response through untouched', async () => {
    const onError = vi.fn(() => new Response(null, { status: 500 }))
    const handler = withCatch(
      onError,
      withFlag({ explode: false }, async (_req, ctx) =>
        Response.json({ on: ctx.flag.on }),
      ),
    )

    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ on: true })
    expect(onError).not.toHaveBeenCalled()
  })

  it('stays usable as a bare fetch entry (extra platform args pass through)', async () => {
    const handler = withCatch(
      () => new Response(null, { status: 500 }),
      withFlag({ explode: false }, async (_req, ctx) =>
        Response.json({ host: ctx.runtime.name }),
      ),
    )

    // Called the way a runtime invokes `export default { fetch }`.
    const res = await (
      handler as (req: Request, ...a: unknown[]) => Promise<Response>
    )(new Request('http://localhost/'), { SECRET: 's' })
    expect(await res.json()).toEqual({ host: 'node' })
  })
})
