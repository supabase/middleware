/**
 * The build-time half of `before`. A produced handler carries the `before`
 * rules of every middleware inside it, as a map from the key that must not be
 * on `ctx` yet to the middleware that declared it. Each layer reads the rules
 * off the handler it wraps and passes them outward, so the layer that
 * contributes one of those keys finds it at any distance and throws while the
 * stack is being built.
 *
 * @packageDocumentation
 */

// `Symbol.for`, so the rules cross module instances (the CJS and ESM builds,
// or two installed copies of this package) like the context marker does.
const RULES = Symbol.for('@supabase/middleware:before')

type Rules = ReadonlyMap<string, string>

const NONE: Rules = new Map()

function rulesOf(handler: unknown): Rules {
  if (typeof handler !== 'function') return NONE
  const rules = (handler as unknown as Record<symbol, unknown>)[RULES]
  return rules instanceof Map ? rules : NONE
}

/**
 * Throws when a middleware inside `handler` must run before anything that
 * contributes `key`, the key the layer wrapping `handler` contributes.
 */
export function assertInOrder(key: string, handler: unknown): void {
  const owner = rulesOf(handler).get(key)
  if (owner === undefined) return
  throw new Error(
    `middleware-order: '${owner}' must run before anything that contributes '${key}'. Place it outside the middleware that contributes '${key}': earlier in a pipeline, or further out when nesting.`,
  )
}

/**
 * Marks `produced` with the rules `handler` carries, plus the keys in `before`
 * declared by the middleware `owner`, and returns it.
 */
export function carryRules<F extends object>(
  produced: F,
  handler: unknown,
  before: readonly string[] = [],
  owner = '',
): F {
  const inner = rulesOf(handler)
  if (inner.size === 0 && before.length === 0) return produced
  const rules = new Map(inner)
  for (const key of before) if (!rules.has(key)) rules.set(key, owner)
  Object.defineProperty(produced, RULES, { value: rules })
  return produced
}
