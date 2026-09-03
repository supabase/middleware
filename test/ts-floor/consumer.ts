/**
 * Consumer-seat typecheck against the **published** types, at the minimum
 * TypeScript version the README claims support for.
 *
 * `@supabase/middleware` is linked, not imported by relative path, so this
 * resolves through the real `exports` map and checks `dist/*.d.ts` — the
 * artifact npm consumers actually typecheck against. Run it after `pnpm build`;
 * without a `dist` there is nothing to check.
 *
 * **The negatives are the point.** Below the floor the failure mode is not that
 * a check errors differently — it is that a check *stops erroring*. At TS 5.3
 * `NoInfer` does not exist, collision detection silently goes quiet, and a
 * duplicate key compiles. Only `@ts-expect-error` catches that direction: the
 * directive goes unused and tsc fails with TS2578. Positives alone would still
 * compile at 5.3 and prove nothing.
 *
 * `skipLibCheck` stays `true` in the tsconfig. With it off, `std-env`'s own
 * declarations raise a pre-existing TS7017 that has nothing to do with this
 * package and turns the fixture red at every version. Errors that matter here
 * are reported in *this* file, which `skipLibCheck` does not suppress.
 *
 * Raising the floor is a deliberate act: bump `typescript` in this fixture's
 * package.json and the Requirements section of the root README together.
 */
import {
  defineComposite,
  defineMiddleware,
  pipeline,
} from '@supabase/middleware'
import type { FetchHandler } from '@supabase/middleware'
import { withCors } from '@supabase/middleware/cors'
import { withFeatureFlag } from '@supabase/middleware/feature-flag'

const innerOk = async () => Response.json({ ok: true })

const passing = <Key extends string, C extends object>(
  key: Key,
  contribution: C,
) =>
  defineMiddleware<Key, void, Record<never, never>, C>({
    key,
    run: () => async () => ({ [key]: contribution }) as { [K in Key]: C },
  })

const withA = passing('alpha', { v: 1 })
const withB = passing('beta', { v: 2 })
const withC = passing('gamma', { v: 3 })
const withD = passing('delta', { v: 4 })

// Accumulation four layers deep under a single anchor — the regression that
// motivated the floor. Every upstream key must be visible on the innermost
// `ctx`; before `NoInfer` the cascade stopped at depth 2.
const _deep = withA(
  withB(
    withC(
      withD(async (_req, ctx) => {
        const a: number = ctx.alpha.v
        const b: number = ctx.beta.v
        const c: number = ctx.gamma.v
        const d: number = ctx.delta.v
        void a
        void b
        void c
        void d
        return Response.json({ ok: true })
      }),
    ),
  ),
) satisfies FetchHandler
void _deep

// The flat path, using the shipped middleware the way a consumer imports them.
const _flat = pipeline(
  [
    withCors({}),
    withFeatureFlag({
      name: 'beta',
      evaluate: (req) => req.headers.has('x-beta'),
    }),
  ],
  async (_req, ctx) => {
    const name: string = ctx.featureFlag.name
    void name
    return Response.json({ ok: true })
  },
)
void _flat

// A key contributed two layers up must still be caught. This is the check that
// goes quiet below the floor.
const withFoo = passing('foo', { v: 1 })
const withBar = passing('bar', { v: 2 })

const _collision =
  // @ts-expect-error — innermost `withFoo` shadows 'foo' from two layers up
  withFoo(withBar(withFoo(innerOk))) satisfies FetchHandler
void _collision

// An `In` prerequisite no layer contributes leaves `ctx` required, so the stack
// cannot be the `fetch` export. With a provider above it, the same stack is fine.
const withNeedsAlpha = defineMiddleware<
  'needsAlpha',
  void,
  { alpha: { v: number } },
  { ok: true }
>({
  key: 'needsAlpha',
  run: () => async () => ({ needsAlpha: { ok: true } as const }),
})

const _unmet =
  // @ts-expect-error — nothing contributes 'alpha', so `ctx` stays required
  withNeedsAlpha(innerOk) satisfies FetchHandler
void _unmet

const _met = withA(withNeedsAlpha(innerOk)) satisfies FetchHandler
void _met

// --- Composites -------------------------------------------------------------
// A composite declares a *record* of contributions derived from its parts, so
// the same checks that guard a single-key middleware have to hold across a set.

const withGate = defineMiddleware<
  'auth',
  { mode: string },
  Record<never, never>,
  { mode: string }
>({
  key: 'auth',
  run: (config) => async () => ({ auth: { mode: config.mode } }),
})
const withMode = defineMiddleware<
  'authMode',
  void,
  { auth: { mode: string } },
  string
>({
  key: 'authMode',
  run: () => async (_req, ctx) => ({ authMode: ctx.auth.mode }),
})

const withAuth = defineComposite({
  build: (config: { mode: string }) => [withGate(config), withMode()] as const,
  hide: ['auth'],
})

// Nested: the composite's public key reaches the handler, and an upstream key
// still cascades in beside it.
const _compNested = withA(
  withAuth({ mode: 'user' }, async (_req, ctx) => {
    const mode: string = ctx.authMode
    const a: number = ctx.alpha.v
    void mode
    void a
    return Response.json({ ok: true })
  }),
) satisfies FetchHandler
void _compNested

// Flat: the same declaration drops into a pipeline array.
const _compFlat = pipeline([withAuth({ mode: 'user' })], async (_req, ctx) => {
  const mode: string = ctx.authMode
  void mode
  return Response.json({ ok: true })
})
void _compFlat

// A hidden key is absent from the declared contributions.
const _compHidden = withAuth({ mode: 'user' }, async (_req, ctx) => {
  // @ts-expect-error — 'auth' is internal plumbing, hidden at the boundary
  void ctx.auth
  return Response.json({ ok: true })
})
void _compHidden

// `hide` can only name a key some part actually contributes.
defineComposite({
  build: () => [withA()] as const,
  // @ts-expect-error — 'nope' is contributed by no part
  hide: ['nope'],
})

// A composite's key collides with the upstream context just as a single key does.
const _compDup = defineComposite({ build: () => [withA()] as const })
const _compCollision =
  // @ts-expect-error — Conflict<'alpha'>: the upstream already carries 'alpha'
  withA(_compDup(innerOk)) satisfies FetchHandler
void _compCollision

// A prerequisite no part supplies is republished as the composite's own, so the
// stack keeps a required `ctx` and cannot be the `fetch` export.
const _compNeeds = defineComposite({ build: () => [withNeedsAlpha()] as const })
const _compUnmet =
  // @ts-expect-error — nothing contributes 'alpha', so `ctx` stays required
  _compNeeds(innerOk) satisfies FetchHandler
void _compUnmet
