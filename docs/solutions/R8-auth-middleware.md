# R8 — Postgres unusable out of the box (no `jwtClaims` producer)

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → R8.

## The problem

`withPostgres` declares `In = { jwtClaims: JWTClaims | null }` and (correctly) can't
be a bare entry — it must be nested under something that contributes `ctx.jwtClaims`.
But the package shipped no such middleware: `feature-flag`, `auth-hook`, and
`postgres` were the only three, and `auth-hook` emits `authHook`, not claims. So the
flagship RLS feature couldn't be used without the consumer hand-writing a
JWT-verifying middleware, and the READMEs referenced a `withAuth` that didn't exist.

(The lesser half of R8 — the implicit `SUPABASE_DB_URL` module pool — was already
addressed when `withPostgres` switched to `ctx._runtime.getEnv`; see the prior
refactor.)

## How it was solved

A new subpath **`@supabase/web-middleware/auth`** ships `withAuth`, which contributes
`ctx.jwtClaims` — exactly the prerequisite `withPostgres` needs:

- `src/middleware/auth/verify-jwt.ts` — `verifySupabaseJwt(token, secret, options)`:
  portable **HS256** verification via Web Crypto (constant-time `crypto.subtle.verify`),
  base64url decode, `exp` / `nbf` checks. Returns `JWTClaims` or `null`.
- `src/middleware/auth/with-auth.ts` — `withAuth({ jwtSecret?, toleranceInSeconds? })`:
  reads `Authorization: Bearer <token>`, verifies it, contributes
  `ctx.jwtClaims: JWTClaims | null`. `jwtSecret` defaults to
  `ctx._runtime.getEnv('SUPABASE_JWT_SECRET')`.

Composes directly:

```ts
withAuth(
  {},
  withPostgres({}, async (_req, ctx) => {
    /* auth.uid() === ctx.jwtClaims?.sub, or anon when null */
  }),
)
```

A missing/invalid/expired token contributes `null` (runs as **anon**) rather than
short-circuiting, matching the RLS model — `withPostgres` already maps `null` claims
to the `anon` role.

Wired into `package.json` exports, `tsdown.config.ts`, and `jsr.json`.

## Verification

`src/middleware/auth/with-auth.test.ts`: valid token → claims; missing header,
tampered signature, wrong secret, expired, and non-HS256 (`alg` confusion) all →
`null`; secret resolved from `ctx._runtime.getEnv`. `pnpm test` ✅ · `pnpm typecheck`
✅ · `pnpm build` emits `dist/middleware/auth`.

## Scope / limits

- **HS256 (legacy JWT secret) only.** Asymmetric keys / JWKS (RS256/ES256) are a
  follow-up — they need key fetching + caching. `verifySupabaseJwt` is exported to
  build on.
- **Anon-by-default**, not `401`. Routes that must reject unauthenticated callers
  check `ctx.jwtClaims` themselves.
- The implicit module-global pool in `withPostgres` still exists (now fed a
  `ctx._runtime.getEnv`-resolved connection string) — acceptable, documented.
