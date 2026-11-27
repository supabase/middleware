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
 * behavior is identical to nested handlers, and so are the types: `ctx` is
 * accumulated across the array with no annotation, duplicate keys and unmet
 * prerequisites fail to compile with a descriptive message, and a `pipeline`
 * written where a handler is expected sees the context it is placed in (see
 * {@link pipeline} for when an enclosing middleware's keys are known).
 *
 * @packageDocumentation
 */

import type { IsAny } from './define-middleware.js'
import type { BaseContext } from './runtime.js'
import type {
  AnyEntry,
  Conflict,
  Entry,
  Mismatch,
  Mistyped,
  RequiredKeys,
  Widened,
} from './types.js'

type AnyHandler = (req: Request, ctx: object) => Promise<Response>

/**
 * Fold a tuple of entries onto `Ctx`, accumulating each entry's contributions
 * record in order. An entry contributing one key adds one key; a composite adds
 * one per part.
 */
type Accumulate<
  Entries extends readonly AnyEntry[],
  Ctx,
> = Entries extends readonly [Entry<infer C, object>, ...infer Rest]
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

/**
 * Prerequisites an entry declares that are not yet on the context. An optional
 * key is never unmet; `Mistyped` still checks its type where it is present.
 */
type Unmet<In, Ctx> = Extract<Exclude<RequiredKeys<In>, keyof Ctx>, string>

/**
 * Validate a tuple of entries in order against a seed context. Each entry's
 * prerequisites (`In`) must be present on the context accumulated so far, with
 * types they accept, and its key must not already be there. Resolves to `true`
 * when the whole chain is valid, or to a descriptive error-string type naming
 * the offending key.
 *
 * {@link pipeline} applies it seeded with the context it is placed in, which is
 * {@link BaseContext} at the top level. A composing wrapper that puts its own
 * keys on the context before the entries run should seed it with that context
 * instead. Entries can then declare prerequisites on the wrapper's keys, and a
 * collision with one of them fails to compile.
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
> = Entries extends readonly [Entry<infer C, infer In>, ...infer Rest]
  ? IsAny<Ctx> extends true
    ? ValidateEntries<Rest, Ctx & C>
    : [Duplicated<C, Ctx>] extends [never]
      ? [Unmet<In, Ctx>] extends [never]
        ? [Mistyped<In, Ctx>] extends [never]
          ? ValidateEntries<Rest, Ctx & C>
          : Mismatch<Mistyped<In, Ctx>>
        : `middleware-prereq: key '${Unmet<In, Ctx>}' is not yet on the context (check ordering)`
      : Conflict<Duplicated<C, Ctx>>
  : true

/**
 * `Base`, or the empty upstream ({@link BaseContext}) when `Base` is `never`:
 * what an enclosing middleware's `Base` reads as while it is not yet inferred,
 * in a stack with no anchor.
 */
type Upstream<Base> = [Base] extends [never] ? BaseContext : Base

/**
 * The upstream a `pipeline` validates and accumulates from: `Base`, unless the
 * position's return type admits more than `Promise<Response>`. A host's `fetch`
 * signature (`Deno.serve`, a Workers `ExportedHandler`) also admits a bare
 * `Response`, and its second parameter is a platform value, not an upstream
 * context, so there `Base` is ignored. The test is containment, not `never`:
 * in a handler position TypeScript still infers `Out` as `Promise<Response>`.
 */
type Seed<Base, Out> = [Out] extends [Promise<Response>]
  ? Upstream<Base>
  : BaseContext

/**
 * Compose a flat list of middleware entries around a handler (first = outermost,
 * runs first on the request). Returns the outermost handler: at the top level a
 * {@link FetchHandler}, ready for `export default { fetch: … }`.
 *
 * The handler's `ctx` is inferred as the upstream plus every entry's
 * contribution — no manual annotation. The upstream is the context the call is
 * placed in: {@link BaseContext} at the top level, and everything that
 * position's `ctx` carries inside another `pipeline`'s handler argument or any
 * position typed as a handler (`(req, ctx: …) => Promise<Response>`).
 *
 * Inside the handler argument of a middleware built with {@link defineMiddleware}
 * or {@link defineComposite}, the enclosing keys are known once the stack is
 * anchored: its outermost call is checked against a handler type, by
 * `satisfies FetchHandler`, a typed declaration, or a host signature such as
 * `Deno.serve`. Unanchored, the upstream there is {@link BaseContext}. A
 * middleware whose type signature is written by hand doesn't pass its keys this
 * way; list it in the entries instead.
 *
 * Entries are checked against the upstream, so a key it already has is a
 * collision and a key it supplies meets a prerequisite. A host-typed position
 * (a Workers `ExportedHandler`, `Deno.serve`) is not a handler position: its
 * second parameter is a platform value, so there the upstream stays
 * {@link BaseContext}. Ordering and collision errors surface on the **handler**
 * argument so they don't break tuple inference on `entries`.
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
export function pipeline<
  const Entries extends readonly AnyEntry[],
  // `Base` and `Out` are read off the contextual type of the call's return, the
  // way a middleware's cascade reads `Base`: its `ctx` gives `Base`, and its
  // return type gives `Out`. `NoInfer` on the handler's `ctx` keeps the
  // contextual type the only source of `Base`.
  //
  // A middleware's handler is contextually typed by a separate pass over the
  // return type alone, which TypeScript uses only while no type parameter has
  // an inference. Here `Entries` has one from the first argument, so the handler
  // is typed from the ordinary inferences instead, where an enclosing
  // middleware's `Base` reads as `never` until an anchor has supplied it.
  // `Seed` reads that as the empty upstream.
  Base extends BaseContext = BaseContext,
  Out = never,
>(
  entries: Entries,
  handler: [ValidateEntries<Entries, Seed<Base, Out>>] extends [true]
    ? (
        req: Request,
        ctx: NoInfer<Accumulate<Entries, Seed<Base, Out>>>,
      ) => Promise<Response>
    : ValidateEntries<Entries, Seed<Base, Out>>,
): (req: Request, ctx?: Base) => Promise<Response> | Out {
  return (entries as readonly AnyEntry[]).reduceRight<AnyHandler>(
    (h, entry) => entry(h),
    handler as AnyHandler,
  ) as unknown as (req: Request, ctx?: Base) => Promise<Response> | Out
}
