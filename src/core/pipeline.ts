/**
 * Flat-array composition — the recommended consumer API for stacking middleware.
 *
 * Instead of nesting (`withA(config, withB(config, withC(handler)))`), write:
 *
 * ```ts
 * pipeline(
 *   [withA(config), withB(config), withC()],
 *   async (req, ctx) => { … }, // ctx.a, ctx.b, ctx.c all inferred
 * )
 * ```
 *
 * At runtime `pipeline` folds the array back into the same nested calls, so
 * behavior is identical to nested handlers. The type-level benefits over nesting:
 * `ctx` is accumulated across the array (no manual annotation), and duplicate
 * keys / out-of-order prerequisites fail to compile with a descriptive message.
 *
 * @packageDocumentation
 */

import type { IsAny } from './define-middleware.js'
import type { BaseContext, FetchHandler } from './runtime.js'
import type { AnyEntry, Conflict, EntryOf, Widened } from './types.js'

type AnyHandler = (req: Request, ctx: object) => Promise<Response>

/**
 * Fold a tuple of entries onto `Ctx`, accumulating each entry's contributions
 * record in order. An entry contributing one key adds one key; a composite adds
 * one per part.
 */
type Accumulate<
  Entries extends readonly AnyEntry[],
  Ctx,
> = Entries extends readonly [EntryOf<infer C, object>, ...infer Rest]
  ? Rest extends readonly AnyEntry[]
    ? Accumulate<Rest, Ctx & C>
    : Ctx
  : Ctx

/**
 * Keys an entry contributes that are already on the context, or `never` for a
 * widened entry whose key set is unknown (see {@link Widened}).
 */
type Duplicated<Contributes, Ctx> =
  Widened<Contributes> extends true
    ? never
    : Extract<keyof Contributes & keyof Ctx, string>

/** Prerequisites an entry declares that are not yet on the context. */
type Unmet<In, Ctx> = Extract<Exclude<keyof In, keyof Ctx>, string>

/**
 * Validate a tuple of entries in order against a seed context. Each entry's
 * prerequisites (`In`) must be present on the context accumulated so far, and
 * its key must not already be there. Resolves to `true` when the whole chain
 * is valid, or to a descriptive error-string type naming the offending key.
 *
 * {@link pipeline} applies it seeded with {@link BaseContext}. A composing
 * wrapper that puts its own keys on the context before the entries run should
 * seed it with that context instead. Entries can then declare prerequisites on
 * the wrapper's keys, and a collision with one of them fails to compile.
 *
 * Site it on the **handler** parameter, never on the entries tuple, so it does
 * not disrupt `const Entries` tuple inference. {@link Conflict} documents why
 * the parameter position is the one TypeScript prints:
 *
 * ```ts
 * handler: [ValidateEntries<Entries, Seed>] extends [true]
 *   ? (req: Request, ctx: Accumulated) => Promise<Response>
 *   : ValidateEntries<Entries, Seed>
 * ```
 *
 * @category Types
 */
export type ValidateEntries<
  Entries extends readonly unknown[],
  Ctx = BaseContext,
> = Entries extends readonly [EntryOf<infer C, infer In>, ...infer Rest]
  ? IsAny<Ctx> extends true
    ? ValidateEntries<Rest, Ctx & C>
    : [Duplicated<C, Ctx>] extends [never]
      ? [Unmet<In, Ctx>] extends [never]
        ? ValidateEntries<Rest, Ctx & C>
        : `middleware-prereq: key '${Unmet<In, Ctx>}' is not yet on the context (check ordering)`
      : Conflict<Duplicated<C, Ctx>>
  : true

/**
 * Compose a flat list of middleware entries around a handler (first = outermost,
 * runs first on the request). Returns a {@link FetchHandler} ready for
 * `export default { fetch: … }`.
 *
 * The handler's `ctx` is inferred as {@link BaseContext} plus every entry's
 * contribution — no manual annotation. Ordering and collision errors surface on
 * the **handler** argument so they don't break tuple inference on `entries`.
 *
 * Under the hood, `pipeline` folds the array into the same nested calls as
 * nested handlers — there is no new runtime behavior.
 *
 * @example
 * ```ts
 * import { pipeline } from '@supabase/middleware'
 * import { withCors } from '@supabase/middleware/cors'
 * import { withFeatureFlag } from '@supabase/middleware/feature-flag'
 *
 * export default {
 *   fetch: pipeline(
 *     [
 *       withCors({}),
 *       withFeatureFlag({ name: 'beta', evaluate: (req) => req.headers.has('x-beta') }),
 *     ],
 *     async (req, ctx) => Response.json({ flag: ctx.featureFlag.name }),
 *   ),
 * }
 * ```
 *
 * @category Composition
 */
export function pipeline<const Entries extends readonly AnyEntry[]>(
  entries: Entries,
  handler: [ValidateEntries<Entries>] extends [true]
    ? (req: Request, ctx: Accumulate<Entries, BaseContext>) => Promise<Response>
    : ValidateEntries<Entries>,
): FetchHandler {
  return (entries as readonly AnyEntry[]).reduceRight<AnyHandler>(
    (h, entry) => entry(h),
    handler as AnyHandler,
  ) as unknown as FetchHandler
}
