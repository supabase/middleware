/**
 * Minimal, portable verification of a Supabase JWT (HS256).
 *
 * Supabase's legacy JWT secret signs access tokens with `HS256`. This verifies
 * the signature with Web Crypto (works on Deno / Workers / Node / Bun), checks
 * `exp` / `nbf`, and returns the decoded {@link JWTClaims} — or `null` for any
 * token that is missing, malformed, wrong-algorithm, badly-signed, or expired.
 *
 * Asymmetric (RS256/ES256 / JWKS) projects are out of scope here — see the
 * middleware README.
 */

import type { JWTClaims } from '../../types.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Decode a base64url segment to bytes. Returns `null` on malformed input. */
function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> | null {
  try {
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** Parse a base64url JSON segment. Returns `null` on malformed input. */
function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment)
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes))
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Options for {@link verifySupabaseJwt}. */
export interface VerifyJwtOptions {
  /** Clock-skew tolerance in seconds applied to `exp` / `nbf`. @defaultValue `0` */
  toleranceInSeconds?: number
  /**
   * Current time in seconds since epoch — injectable for tests. Defaults to the
   * real clock.
   */
  now?: number
}

/**
 * Verify an HS256 Supabase JWT against `secret`. Resolves to the decoded claims,
 * or `null` if the token is absent/malformed/wrong-alg/badly-signed/expired.
 */
export async function verifySupabaseJwt(
  token: string,
  secret: string,
  options: VerifyJwtOptions = {},
): Promise<JWTClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ]

  const header = decodeJson(headerB64)
  if (!header || header.alg !== 'HS256') return null

  const signature = base64UrlToBytes(signatureB64)
  if (!signature) return null

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  // `crypto.subtle.verify` compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(`${headerB64}.${payloadB64}`),
  )
  if (!valid) return null

  const claims = decodeJson(payloadB64)
  if (!claims || typeof claims.sub !== 'string') return null

  const now = options.now ?? Math.floor(Date.now() / 1000)
  const tolerance = options.toleranceInSeconds ?? 0
  if (typeof claims.exp === 'number' && now > claims.exp + tolerance) return null
  if (typeof claims.nbf === 'number' && now + tolerance < claims.nbf) return null

  return claims as JWTClaims
}
