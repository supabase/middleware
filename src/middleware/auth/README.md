# `@supabase/web-middleware/auth`

Verifies the caller's Supabase JWT and contributes the decoded claims at
`ctx.jwtClaims`. This is the upstream that [`withPostgres`](../postgres/README.md)
(and any RLS-scoped middleware) needs — it's what makes `auth.uid()` and your RLS
policies see the authenticated user.

```ts
import { withAuth } from '@supabase/web-middleware/auth'
import { withPostgres } from '@supabase/web-middleware/postgres'

export default {
  fetch: withAuth(
    {}, // jwtSecret read from SUPABASE_JWT_SECRET via ctx._runtime.getEnv
    withPostgres({}, async (_req, ctx) => {
      // RLS runs as ctx.jwtClaims.sub — or anon when the token is absent/invalid
      const mine = await ctx.postgres.db.query('select * from notes')
      return Response.json({ notes: mine.rows })
    }),
  ),
}
```

## What it does

1. Reads the bearer token from `Authorization: Bearer <token>`.
2. Verifies the **HS256** signature against your Supabase JWT secret (Web Crypto,
   constant-time comparison), and checks `exp` / `nbf`.
3. Contributes `ctx.jwtClaims: JWTClaims | null`.

A missing, malformed, wrong-algorithm, badly-signed, or expired token contributes
**`null`** (the request runs as **anon**) rather than short-circuiting — so a
downstream middleware or handler decides whether unauthenticated access is allowed.
For `withPostgres`, RLS already enforces it: `null` claims run as the `anon` role.

## Config

| Field                | Type      | Description                                                                                    |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `jwtSecret`          | `string?` | The Supabase JWT secret (HS256). Omit to read `SUPABASE_JWT_SECRET` via `ctx._runtime.getEnv`. |
| `toleranceInSeconds` | `number?` | Clock-skew tolerance applied to `exp` / `nbf`. Default `0`.                                    |

## Scope / limits

- **HS256 only.** This verifies the legacy Supabase JWT secret (symmetric HS256).
  Projects using asymmetric signing keys (RS256/ES256 via JWKS) are not yet
  supported — that needs key fetching/caching and is a planned follow-up. The raw
  verifier is exported as `verifySupabaseJwt(token, secret, options)` if you want to
  build on it.
- **Anon-by-default.** Invalid tokens become `null`, not `401`. If a route must
  reject unauthenticated callers, check `ctx.jwtClaims` in the handler (or wrap with
  a small gate middleware).
