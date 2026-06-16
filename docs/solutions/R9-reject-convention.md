# R9 — Reject convention + `ctx` naming

> **⚠️ Superseded (reject helper part).** The shared `RejectConfig` + `rejection()`
> helper described below was **removed**. Its premise was that _multiple_ middleware
> reinvented `rejectStatus` / `rejectBody`; once `auth-hook` was dropped (auth →
> `withSupabase`), `feature-flag` was the only short-circuiting middleware left, so a
> shared helper is unjustified indirection. Middleware short-circuit by **returning a
> `Response`**, so `feature-flag` now just returns `Response.json(...)` inline. The
> `ctx`-naming decision below still stands.

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → R9.

R9 had two parts: a small consistency risk (`rejectStatus` / `rejectBody` reinvented
per middleware) and a naming opinion (`ctx`). The first is moot (single consumer); the
second is a documented decision.

## Reject convention — fixed

`feature-flag` and `auth-hook` each declared their own `rejectStatus` / `rejectBody`
fields (both `rejectBody?: unknown`) and hand-rolled the same
`Response.json(body ?? default, { status: status ?? default })`. As more middleware
short-circuit, that drifts.

Now there's a shared convention in core (`src/core/reject.ts`, exported from the
package root):

```ts
export interface RejectConfig {
  rejectStatus?: number
  rejectBody?: unknown
}
export function rejection(
  config: RejectConfig,
  defaults: { status: number; body: unknown },
): Response
```

- `WithFeatureFlagConfig` and `WithAuthHookConfig` now `extends RejectConfig` — one
  definition of the fields and their docs.
- Both middleware build their short-circuit response with `rejection(config, {
status, body })` instead of bespoke `Response.json` calls.
- Third-party middleware get the same shape for free.

Behavior is unchanged (feature-flag still defaults to 404, auth-hook to 401), so the
existing custom-`rejectStatus`/`rejectBody` tests cover it.

## `ctx` naming — kept, by design

`ctx` overloads Cloudflare's `ExecutionContext` and Hono's `Context`. We considered
renaming to `state` / `data` / `scope`, but **kept `ctx`**:

- It's the most widely-understood name for accumulated middleware state, and the
  package never exposes a competing `ctx` (the runtime's `ExecutionContext` is
  absorbed at the entry, never surfaced — see R1).
- Renaming is a breaking change to every handler signature for a purely cosmetic gain.

The reserved `ctx._runtime` / `ctx.body` facets are documented; that's the disambiguation.

## Verification

`pnpm typecheck` ✅ · `pnpm test` (50 pass) ✅ · `pnpm lint` ✅. Feature-flag and
auth-hook reject tests (default + custom status/body) pass against the shared helper.
