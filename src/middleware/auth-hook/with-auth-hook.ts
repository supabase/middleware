/**
 * Auth-hook middleware — verifies a Supabase Auth Hook's Standard Webhooks
 * signature and injects the decoded payload at `ctx.authHook`.
 *
 * Write a hook endpoint (Send Email, Send SMS, Custom Access Token, …) without
 * the security boilerplate: it strips the `v1,whsec_` secret, checks the
 * `webhook-id` / `webhook-timestamp` / `webhook-signature` headers, enforces a
 * replay window, and only then hands your handler the parsed body. An invalid
 * or missing signature short-circuits with `401`.
 *
 * @packageDocumentation
 */

import {
  defineMiddleware,
  rejection,
  type BaseContext,
  type NoConflict,
  type RejectConfig,
} from '../../core/index.js'

import type { AuthHookPayload } from './types.js'
import { verifyStandardWebhook } from './verify.js'

/**
 * Per-instance configuration passed to `withAuthHook(config, handler)`.
 */
export interface WithAuthHookConfig extends RejectConfig {
  /**
   * The hook secret from the Supabase dashboard. Accepts the stored form
   * `v1,whsec_<base64>`, the bare Standard Webhooks form `whsec_<base64>`, or
   * just the `<base64>` key — the prefixes are stripped before use.
   */
  secret: string

  /**
   * Replay-protection window in seconds. A request whose `webhook-timestamp` is
   * further than this from now is rejected.
   *
   * @defaultValue `300`
   */
  toleranceInSeconds?: number

  // `rejectStatus` / `rejectBody` come from RejectConfig. Verification failure
  // defaults to 401 with `{ error: 'invalid_signature' }`.
}

/**
 * Shape contributed at `ctx.authHook` after a verified request. `payload` is
 * the parsed hook body; `webhookId` and `timestamp` come from the verified
 * headers.
 */
export interface AuthHookContribution<Payload = AuthHookPayload> {
  payload: Payload
  webhookId: string
  timestamp: number
}

const DEFAULT_TOLERANCE_SECONDS = 300

/**
 * Runtime middleware. Contribution is fixed to {@link AuthHookContribution}
 * here; the payload-generic surface is layered on by {@link WithAuthHook} below.
 */
const authHookMiddleware = defineMiddleware<
  'authHook',
  WithAuthHookConfig,
  Record<never, never>,
  AuthHookContribution
>({
  key: 'authHook',
  run: (config) => async (req) => {
    // Standard Webhooks signs the raw body, so read text (not json) and verify
    // before parsing. `req` is the framework's buffered request (read-once-cache),
    // so reading it here still lets a downstream handler read the body too.
    const body = await req.text()
    const result = await verifyStandardWebhook(
      config.secret,
      body,
      req.headers,
      config.toleranceInSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    )

    if (!result.ok) {
      return rejection(config, {
        status: 401,
        body: { error: 'invalid_signature' },
      })
    }

    // Headers are guaranteed present once verification succeeds.
    return {
      authHook: {
        payload: JSON.parse(body) as AuthHookPayload,
        webhookId: req.headers.get('webhook-id')!,
        timestamp: Number(req.headers.get('webhook-timestamp')),
      },
    }
  },
})

/**
 * Public, payload-generic surface for {@link withAuthHook}.
 *
 * `defineMiddleware` fixes the contribution type, so the middleware is re-typed
 * here to add a leading `Payload` type parameter (default {@link AuthHookPayload}).
 * The collision check reuses the core's exported {@link NoConflict} (rather than a
 * hand-copy), so `Base` is inferred from an outer wrapper and a duplicate
 * `authHook` key is a type error.
 */
export interface WithAuthHook {
  <
    Payload = AuthHookPayload,
    Base extends BaseContext & NoConflict<'authHook', Base> = BaseContext,
  >(
    config: WithAuthHookConfig,
    handler: (
      req: Request,
      ctx: Base & { authHook: AuthHookContribution<Payload> },
    ) => Promise<Response>,
  ): (req: Request, ctx?: Base) => Promise<Response>
}

/**
 * Auth-hook middleware.
 *
 * @example Send Email Hook
 * ```ts
 * import { withAuthHook, type SendEmailHookPayload } from '@supabase/web-middleware/auth-hook'
 *
 * export default {
 *   fetch: withAuthHook<SendEmailHookPayload>(
 *     { secret: Deno.env.get('SEND_EMAIL_HOOK_SECRET')! },
 *     async (_req, ctx) => {
 *       const { user, email_data } = ctx.authHook.payload
 *       // ...send the email with your provider...
 *       return new Response(null, { status: 200 })
 *     },
 *   ),
 * }
 * ```
 */
export const withAuthHook = authHookMiddleware as unknown as WithAuthHook
