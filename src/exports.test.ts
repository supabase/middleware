import { describe, expect, it } from 'vitest'

import * as root from './index.js'
import * as core from './core/index.js'
import * as cors from './middleware/cors/index.js'
import * as featureFlag from './middleware/feature-flag/index.js'

/**
 * Guards the public *value* exports of every entry point. Type-only exports are
 * erased at runtime and covered by `tsc`; this catches a value export silently
 * disappearing in a refactor.
 */
describe('public API surface', () => {
  // Value exports of the root and core surfaces are identical (root is a
  // curated re-export of core): the composition primitives plus the additive
  // descriptor/interop layer.
  const expected = [
    'DESCRIPTOR_VERSION',
    'MiddlewareError',
    'MiddlewareErrorCode',
    'annotate',
    'assertComposable',
    'defineMiddleware',
    'getDescriptor',
    'pipeline',
  ]

  it('package root', () => {
    expect(Object.keys(root).sort()).toEqual(expected)
  })

  it('core subpath', () => {
    expect(Object.keys(core).sort()).toEqual(expected)
  })

  it('middleware subpaths', () => {
    expect(typeof featureFlag.withFeatureFlag).toBe('function')
    expect(typeof cors.withCors).toBe('function')
  })
})
