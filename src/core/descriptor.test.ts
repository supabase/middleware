import { describe, expect, it } from 'vitest'

import {
  annotate,
  assertComposable,
  buildDescriptor,
  getDescriptor,
  stampDescriptor,
} from './descriptor.js'
import { MiddlewareError, MiddlewareErrorCode } from './errors.js'
import { defineMiddleware } from './define-middleware.js'
import { pipeline } from './pipeline.js'
import { withCors } from '../middleware/cors/with-cors.js'
import { withFeatureFlag } from '../middleware/feature-flag/with-feature-flag.js'

const noop = async () => Response.json({ ok: true })

describe('buildDescriptor', () => {
  it('fills the version and keeps only non-empty fields', () => {
    expect(buildDescriptor({ id: 'x', provides: ['a'] })).toEqual({
      version: 1,
      id: 'x',
      provides: ['a'],
    })
    // Empty arrays are dropped so the serialized shape stays minimal.
    expect(buildDescriptor({ id: 'x', requires: [], provides: ['a'] })).toEqual(
      { version: 1, id: 'x', provides: ['a'] },
    )
  })

  it('deep-freezes the result', () => {
    const d = buildDescriptor({ id: 'x', provides: ['a'] })
    expect(Object.isFrozen(d)).toBe(true)
    expect(Object.isFrozen(d.provides)).toBe(true)
  })

  it('rejects a non-string id with a coded error', () => {
    expect(() =>
      buildDescriptor({ id: 123 as unknown as string }),
    ).toThrowError(MiddlewareError)
    try {
      buildDescriptor({ id: 123 as unknown as string })
    } catch (err) {
      expect((err as MiddlewareError).code).toBe(
        MiddlewareErrorCode.invalidDescriptor,
      )
    }
  })
})

describe('annotate / getDescriptor', () => {
  it('stamps a non-enumerable ~middleware property', () => {
    const fn = annotate(async () => noop(), { id: 'x', provides: ['a'] })
    expect(getDescriptor(fn)).toEqual({ version: 1, id: 'x', provides: ['a'] })
    // Non-enumerable: never leaks into spreads or key enumeration.
    expect(Object.keys(fn)).not.toContain('~middleware')
    expect(Object.prototype.propertyIsEnumerable.call(fn, '~middleware')).toBe(
      false,
    )
  })

  it('cannot be clobbered by assignment (non-writable)', () => {
    const fn = annotate(() => noop(), { id: 'x' })
    expect(() => {
      ;(fn as unknown as Record<string, unknown>)['~middleware'] = {
        version: 1,
      }
    }).toThrowError() // strict-mode assignment to a non-writable property
  })

  it('applies version negotiation: unknown versions read as absent', () => {
    const future = stampDescriptor(() => noop(), {
      version: 2,
    } as unknown as ReturnType<typeof buildDescriptor>)
    expect(getDescriptor(future)).toBeUndefined()
  })

  it('returns undefined for non-annotated / non-object values', () => {
    expect(getDescriptor(() => noop())).toBeUndefined()
    expect(getDescriptor(42)).toBeUndefined()
    expect(getDescriptor(null)).toBeUndefined()
  })
})

describe('defineMiddleware descriptor stamping', () => {
  const withClaims = defineMiddleware<
    'jwtClaims',
    void,
    Record<never, never>,
    { sub: string }
  >({
    key: 'jwtClaims',
    id: 'claims',
    run: () => async () => ({ jwtClaims: { sub: 'u1' } }),
  })

  it('stamps the factory, the entry, and the produced handler alike', () => {
    const expected = { version: 1, id: 'claims', provides: ['jwtClaims'] }
    expect(getDescriptor(withClaims)).toEqual(expected) // factory
    expect(getDescriptor(withClaims())).toEqual(expected) // entry
    expect(getDescriptor(withClaims(noop))).toEqual(expected) // handler
  })

  it('attaches nothing when no id is declared (opt-in)', () => {
    const anon = defineMiddleware<'x', void, Record<never, never>, number>({
      key: 'x',
      run: () => async () => ({ x: 1 }),
    })
    expect(getDescriptor(anon)).toBeUndefined()
    expect(getDescriptor(anon())).toBeUndefined()
  })
})

describe('assertComposable', () => {
  const withClaims = defineMiddleware<
    'jwtClaims',
    void,
    Record<never, never>,
    { sub: string }
  >({
    key: 'jwtClaims',
    id: 'claims',
    run: () => async () => ({ jwtClaims: { sub: 'u1' } }),
  })
  const withRole = defineMiddleware<
    'role',
    void,
    { jwtClaims: { sub: string } },
    string
  >({
    key: 'role',
    id: 'require-role',
    requires: ['jwtClaims'],
    run: () => async () => ({ role: 'admin' }),
  })

  it('accepts a correctly-ordered stack', () => {
    expect(() => assertComposable([withClaims(), withRole()])).not.toThrow()
  })

  it('flags a prerequisite provided by a later middleware (ordering)', () => {
    try {
      assertComposable([withRole(), withClaims()])
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MiddlewareError)
      expect((err as MiddlewareError).code).toBe(
        MiddlewareErrorCode.prerequisiteMissing,
      )
      expect((err as MiddlewareError).message).toContain('runs later')
      expect((err as MiddlewareError).key).toBe('jwtClaims')
    }
  })

  it('flags a prerequisite nothing provides (missing)', () => {
    try {
      assertComposable([withRole()])
      throw new Error('expected throw')
    } catch (err) {
      expect((err as MiddlewareError).code).toBe(
        MiddlewareErrorCode.prerequisiteMissing,
      )
      expect((err as MiddlewareError).message).toContain('no middleware')
    }
  })

  it('flags two middleware contributing the same key (duplicate)', () => {
    try {
      assertComposable([withClaims(), withClaims()])
      throw new Error('expected throw')
    } catch (err) {
      expect((err as MiddlewareError).code).toBe(
        MiddlewareErrorCode.duplicateProvision,
      )
      expect((err as MiddlewareError).key).toBe('jwtClaims')
    }
  })

  it('protects the reserved _runtime base key', () => {
    const bad = annotate(() => noop(), { id: 'bad', provides: ['_runtime'] })
    expect(() => assertComposable([bad])).toThrowError(MiddlewareError)
  })

  it('stays silent for entries without descriptors', () => {
    const opaque = (h: unknown) => h
    expect(() => assertComposable([opaque, opaque])).not.toThrow()
  })

  it('does not cry wolf when an opaque entry precedes a requirer', () => {
    const opaque = (h: unknown) => h
    // The opaque entry might supply jwtClaims; we cannot prove otherwise.
    expect(() => assertComposable([opaque, withRole()])).not.toThrow()
  })
})

describe('pipeline enforcement', () => {
  const withClaims = defineMiddleware<
    'jwtClaims',
    void,
    Record<never, never>,
    { sub: string }
  >({
    key: 'jwtClaims',
    id: 'claims',
    run: () => async () => ({ jwtClaims: { sub: 'u1' } }),
  })

  it('throws at compose time for a duplicate contribution', () => {
    // Cast around the compile-time collision check to exercise the runtime one
    // (the case a plain-JS or dynamically-built stack would hit).
    const entries = [withClaims(), withClaims()] as unknown as Parameters<
      typeof pipeline
    >[0]
    expect(() => pipeline(entries, noop as never)).toThrowError(MiddlewareError)
  })

  it('composes a valid descriptor-bearing stack and runs it', async () => {
    const handler = pipeline([withClaims()], async (_req, ctx) =>
      Response.json({ sub: ctx.jwtClaims.sub }),
    )
    const res = await handler(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ sub: 'u1' })
  })
})

describe('bundled middleware descriptors', () => {
  it('cors advertises its identity and contribution', () => {
    expect(getDescriptor(withCors({}))).toEqual({
      version: 1,
      id: 'cors',
      provides: ['cors'],
    })
  })

  it('feature-flag advertises its identity and contribution', () => {
    const entry = withFeatureFlag({ name: 'beta', evaluate: () => true })
    expect(getDescriptor(entry)).toEqual({
      version: 1,
      id: 'feature-flag',
      provides: ['featureFlag'],
    })
  })
})
