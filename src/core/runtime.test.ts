import { describe, expect, it } from 'vitest'

import { detectRuntimeName, makeGetEnv } from './runtime.js'

describe('runtime detection + getEnv (arg 2 handling)', () => {
  it('detects the test runner as node', () => {
    expect(detectRuntimeName()).toBe('node')
  })

  it('cloudflare getEnv reads bindings from the per-request env (arg 2)', () => {
    const getEnv = makeGetEnv('cloudflare-workers', [{ API_KEY: 'abc', NUM: 1 }])
    expect(getEnv('API_KEY')).toBe('abc')
    expect(getEnv('NUM')).toBeUndefined() // non-string binding
    expect(getEnv('MISSING')).toBeUndefined()
  })

  it('cloudflare getEnv is undefined-safe when no env was passed', () => {
    expect(makeGetEnv('cloudflare-workers', [])('ANYTHING')).toBeUndefined()
  })

  it('node / bun getEnv reads process.env (ignores platform args)', () => {
    process!.env.__WM_TEST__ = 'present'
    try {
      expect(makeGetEnv('node', [])('__WM_TEST__')).toBe('present')
      expect(makeGetEnv('bun', [{ __WM_TEST__: 'shadow' }])('__WM_TEST__')).toBe(
        'present',
      )
    } finally {
      delete process!.env.__WM_TEST__
    }
  })

  it('unknown runtime resolves no env', () => {
    expect(makeGetEnv('unknown', [{ X: 'y' }])('X')).toBeUndefined()
  })
})
