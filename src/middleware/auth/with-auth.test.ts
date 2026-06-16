import { describe, expect, it } from 'vitest'

import { withAuth } from './with-auth.js'

const enc = new TextEncoder()
const SECRET = 'super-secret-jwt-secret'

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlJson(value: unknown): string {
  return b64url(enc.encode(JSON.stringify(value)))
}

/** Sign an HS256 JWT (or another `alg`, for negative tests). */
async function signJwt(
  secret: string,
  claims: Record<string, unknown>,
  alg = 'HS256',
): Promise<string> {
  const header = b64urlJson({ alg, typ: 'JWT' })
  const payload = b64urlJson(claims)
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`)),
  )
  return `${header}.${payload}.${b64url(sig)}`
}

const FUTURE = 9_999_999_999
const PAST = 1_000

function bearer(token: string): Request {
  return new Request('http://localhost/', {
    headers: { authorization: `Bearer ${token}` },
  })
}

/** Read ctx.jwtClaims back out as a handler would. */
const probe = (config: Parameters<typeof withAuth>[0]) =>
  withAuth(config, async (_req, ctx) =>
    Response.json({ sub: ctx.jwtClaims?.sub ?? null, role: ctx.jwtClaims?.role ?? null }),
  )

describe('withAuth', () => {
  it('contributes the decoded claims for a valid token', async () => {
    const token = await signJwt(SECRET, {
      sub: 'user-1',
      role: 'authenticated',
      exp: FUTURE,
    })
    const res = await probe({ jwtSecret: SECRET })(bearer(token))
    expect(await res.json()).toEqual({ sub: 'user-1', role: 'authenticated' })
  })

  it('contributes null when the Authorization header is missing (anon)', async () => {
    const res = await probe({ jwtSecret: SECRET })(new Request('http://localhost/'))
    expect(await res.json()).toEqual({ sub: null, role: null })
  })

  it('contributes null for a tampered signature', async () => {
    const token = await signJwt(SECRET, { sub: 'user-1', exp: FUTURE })
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa')
    const res = await probe({ jwtSecret: SECRET })(bearer(tampered))
    expect(await res.json()).toEqual({ sub: null, role: null })
  })

  it('contributes null for a token signed with a different secret', async () => {
    const token = await signJwt('the-wrong-secret', { sub: 'user-1', exp: FUTURE })
    const res = await probe({ jwtSecret: SECRET })(bearer(token))
    expect(await res.json()).toEqual({ sub: null, role: null })
  })

  it('contributes null for an expired token', async () => {
    const token = await signJwt(SECRET, { sub: 'user-1', exp: PAST })
    const res = await probe({ jwtSecret: SECRET })(bearer(token))
    expect(await res.json()).toEqual({ sub: null, role: null })
  })

  it('rejects a non-HS256 token (alg confusion)', async () => {
    const token = await signJwt(SECRET, { sub: 'user-1', exp: FUTURE }, 'none')
    const res = await probe({ jwtSecret: SECRET })(bearer(token))
    expect(await res.json()).toEqual({ sub: null, role: null })
  })

  it('reads the secret from ctx.runtime.getEnv when jwtSecret is omitted', async () => {
    const token = await signJwt(SECRET, { sub: 'env-user', exp: FUTURE })
    // No jwtSecret in config; supply a context whose runtime resolves it.
    const handler = probe({})
    const ctx = {
      runtime: {
        name: 'node' as const,
        getEnv: (k: string) => (k === 'SUPABASE_JWT_SECRET' ? SECRET : undefined),
      },
      body: {
        arrayBuffer: async () => new ArrayBuffer(0),
        bytes: async () => new Uint8Array(),
        text: async () => '',
        json: async () => ({}) as never,
      },
    }
    const res = await handler(bearer(token), ctx)
    expect(await res.json()).toEqual({ sub: 'env-user', role: null })
  })
})
