import { describe, expect, it } from 'vitest'

import {
  bufferRequest,
  getEnv,
  isContext,
  runtimeName,
  seedContext,
} from './runtime.js'
import { defineMiddleware } from './define-middleware.js'
import { pipeline } from './pipeline.js'

describe('importable env access (getEnv)', () => {
  it('detects the test runner as node (std-env)', () => {
    expect(runtimeName).toBe('node')
  })

  it('reads string bindings from the captured platform env first (Workers arg 2)', () => {
    seedContext({ API_KEY: 'abc', NUM: 1 })
    expect(getEnv('API_KEY')).toBe('abc')
    expect(getEnv('NUM')).toBeUndefined() // non-string binding is never coerced
    expect(getEnv('MISSING')).toBeUndefined()
  })

  it('falls back to the host env for keys not in the platform env', () => {
    const { env } = (
      globalThis as unknown as {
        process: { env: Record<string, string | undefined> }
      }
    ).process
    env.__WM_TEST__ = 'present'
    try {
      seedContext({ OTHER: 'x' })
      expect(getEnv('__WM_TEST__')).toBe('present')
      // A platform binding with the same key shadows the host env.
      seedContext({ __WM_TEST__: 'shadow' })
      expect(getEnv('__WM_TEST__')).toBe('shadow')
    } finally {
      delete env.__WM_TEST__
      seedContext({}) // clear the stash so other tests see a clean slate
    }
  })

  it('is undefined-safe with no platform env and no matching host var', () => {
    seedContext({})
    expect(getEnv('__WM_MISSING__')).toBeUndefined()
  })
})

describe('context marker (entry detection)', () => {
  it('recognizes seeded contexts; platform objects and non-objects are not contexts', () => {
    expect(isContext(seedContext())).toBe(true)
    expect(isContext({ SECRET: 's' })).toBe(false)
    expect(isContext(undefined)).toBe(false)
    expect(isContext(null)).toBe(false)
  })

  it('the marker survives object spread, so it flows through every ctx merge', () => {
    const ctx = seedContext()
    expect(isContext({ ...ctx, contributed: 1 })).toBe(true)
  })

  it('does not surface in Object.keys — ctx holds only middleware contributions', () => {
    expect(Object.keys(seedContext())).toEqual([])
  })
})

describe('bufferRequest (host entry points)', () => {
  const post = () =>
    new Request('http://localhost/', { method: 'POST', body: '{"a":1}' })

  const peek = defineMiddleware<'peek', void, Record<never, never>, string>({
    key: 'peek',
    run: () => async (req) => ({ peek: await req.text() }),
  })

  // `ctx: object` because a bare hand-rolled entry is a widened entry: it folds
  // an index signature onto the accumulated context (see `Widened`).
  const readTwice = async (req: Request, ctx: object) =>
    Response.json({
      peek: (ctx as { peek: string }).peek,
      handler: await req.text(),
    })

  it('lets a middleware and the handler each read the body', async () => {
    const app = pipeline([peek()], readTwice)
    const res = await app(post())
    expect(await res.json()).toEqual({ peek: '{"a":1}', handler: '{"a":1}' })
  })

  it('a host entry that seeds without buffering hands down a single-use body', async () => {
    // The failure this export exists to prevent. A hand-rolled entry that calls
    // `seedContext` but not `bufferRequest` is a valid upstream for every layer
    // below it, and every one of them shares one single-use stream.
    const unbuffered =
      (handler: (req: Request, ctx: object) => Promise<Response>) =>
      (req: Request, arg?: unknown) =>
        handler(req, isContext(arg) ? arg : seedContext(arg))

    const app = pipeline([unbuffered, peek()], readTwice)
    await expect(app(post())).rejects.toThrow(/already been read/)
  })

  it('buffering alongside seeding fixes it', async () => {
    const buffered =
      (handler: (req: Request, ctx: object) => Promise<Response>) =>
      (req: Request, arg?: unknown) =>
        handler(
          isContext(arg) || !req.body ? req : bufferRequest(req),
          isContext(arg) ? arg : seedContext(arg),
        )

    const app = pipeline([buffered, peek()], readTwice)
    const res = await app(post())
    expect(await res.json()).toEqual({ peek: '{"a":1}', handler: '{"a":1}' })
  })
})
