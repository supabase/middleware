/**
 * Auth-hook middleware.
 *
 * @packageDocumentation
 */

export type { FetchHandler } from '../../core/index.js'
export { withAuthHook } from './with-auth-hook.js'
export type {
  AuthHookContribution,
  WithAuthHook,
  WithAuthHookConfig,
} from './with-auth-hook.js'
export type {
  AuthHookPayload,
  AuthHookUser,
  CustomAccessTokenHookPayload,
  EmailActionType,
  EmailData,
  MFAVerificationHookPayload,
  PasswordVerificationHookPayload,
  SendEmailHookPayload,
  SendSMSHookPayload,
} from './types.js'
