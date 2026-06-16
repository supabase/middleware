/**
 * Feature-flag middleware.
 *
 * @packageDocumentation
 */

export type { FetchHandler } from '../../core/index.js'
export { withFeatureFlag } from './with-feature-flag.js'
export type {
  FeatureFlagContribution,
  FeatureFlagVerdict,
  WithFeatureFlagConfig,
} from './with-feature-flag.js'
