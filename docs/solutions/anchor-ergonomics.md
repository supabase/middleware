# Anchor ergonomics — decision record

See [`API_RISK_PROFILE.md`](../../API_RISK_PROFILE.md) → "Remaining → Anchor
ergonomics".

## The constraint (not a bug — a proven TypeScript limit)

Two of the type-level guarantees — the innermost handler seeing **every** upstream
key ambiently, and **collision detection** — require a concrete anchor on the
outermost handler. Without an anchor, `Base` is inferred bottom-up and collapses, so
those two features silently don't engage. (Cross-middleware dependencies declared via
`In` prerequisites do **not** need the anchor — they type with zero ceremony.)

This was established with five `tsc` experiments during the design:

1. Nested no-prereq middleware, no anchor → outer key does not flow.
2. A `Base` default does not substitute for the anchor.
3. A trailing finalize call/method can't anchor (TS resolves the callee bottom-up).
4. With an anchor, plain / overload / method shapes all flow — so the intersection
   wasn't the problem; the missing anchor was.
5. `satisfies FetchHandler` **does** anchor, and makes collision fire.

Because the design has **no entry wrapper** (per the "no `toFetch`" decision), the
anchor must be a type-only annotation the consumer writes once.

## The decision

Keep the **`satisfies FetchHandler`** annotation as the anchor, and make it as
low-friction as possible rather than reintroducing a wrapper:

- `FetchHandler` is re-exported from **every middleware subpath**
  (`feature-flag`, `auth`, `auth-hook`, `postgres`), so the anchor is a single import
  line alongside the middleware you're already importing:

  ```ts
  import {
    withFeatureFlag,
    type FetchHandler,
  } from '@supabase/web-middleware/feature-flag'

  export default {
    fetch: withFeatureFlag({ name, evaluate }, handler) satisfies FetchHandler,
  }
  ```

- The cost of omitting it is bounded and **non-breaking at runtime**: prerequisite
  typing and the runtime behavior are unaffected; only ambient accumulation +
  collision detection go quiet.

## Why not "fix" it further

- A mandatory wrapper (the old `toFetch`) would anchor automatically — explicitly
  rejected by the design ("no `toFetch`, keep nesting").
- A curried `chain()` combinator could control accumulation without contextual
  inference, but it abandons the lexical-nesting shape the design requires.
- A `Base` default / self-anchoring callable was proven not to work (experiments
  1–3).

So `satisfies FetchHandler` is the minimal, honest anchor. This doc is the record
that it's a deliberate trade-off, not an oversight.

## Verification

`src/middleware/feature-flag/with-feature-flag.test.ts` includes a tsc-verified
`satisfies FetchHandler` via the subpath re-export (single import line).
`pnpm typecheck` ✅ · `pnpm test` ✅.
