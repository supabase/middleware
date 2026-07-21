import { describe, expect, it } from 'vitest'

import { getEnv, isContext, runtimeName, seedContext } from './runtime.js'

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
