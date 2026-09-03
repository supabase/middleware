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
  it('package root', () => {
    expect(Object.keys(root).sort()).toEqual([
      'defineComposite',
      'defineMiddleware',
      'getEnv',
      'isContext',
      'pipeline',
      'runtimeName',
      'seedContext',
    ])
  })

  it('core subpath', () => {
    expect(Object.keys(core).sort()).toEqual([
      'defineComposite',
      'defineMiddleware',
      'getEnv',
      'isContext',
      'pipeline',
      'runtimeName',
      'seedContext',
    ])
  })

  it('middleware subpaths', () => {
    expect(typeof featureFlag.withFeatureFlag).toBe('function')
    expect(typeof cors.withCors).toBe('function')
  })
})
