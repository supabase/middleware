/**
 * Optional, machine-readable middleware metadata — the ecosystem/interop layer.
 *
 * web-middleware's core is deliberately metadata-free: a middleware is a
 * closure, and its key/prerequisites/contribution live entirely in the *type*
 * (`Middleware<Key, Config, In, Contribution>`), erased at runtime. That is
 * ideal for a single application that composes middleware with the compiler
 * watching. It gives tooling, registries, and other-language/plain-JS consumers
 * nothing to read.
 *
 * This module adds an **additive, opt-in** descriptor — the same shape the
 * `@web-middleware/core` reference implementation stamps — attached to a
 * middleware under the structural key `~middleware`. It never changes how
 * middleware execute or type-check; it only makes the erased facts (identity,
 * prerequisites, contributions) legible at runtime, so:
 *
 * - `pipeline` can enforce ordering/collision rules for dynamically- or
 *   JS-assembled stacks (the compile-time `Validate` is the backstop for TS);
 * - registries and doc/LLM tooling can introspect a stack without executing it
 *   (paired with the static `middleware.manifest.json`);
 * - descriptors survive two installed versions of these types in one tree — the
 *   key is a plain string and the type transport is structural, so nothing
 *   depends on shared symbol identity.
 *
 * The descriptor is versioned. A reader MUST ignore a descriptor whose
 * `version` it does not understand rather than fail — see {@link getDescriptor}.
 *
 * @packageDocumentation
 */

import { MiddlewareError, MiddlewareErrorCode } from './errors.js'

/** Descriptor schema version understood by this implementation. */
export const DESCRIPTOR_VERSION = 1 as const

/**
 * The string keys of `T`, or `string` when `T` carries none (an untyped
 * middleware). Lets `requires`/`provides` be bound to a middleware's declared
 * `In`/contribution keys when known — a stale key is then a compile error —
 * while still permitting hand-annotation of functions with no known shape.
 */
export type ContextKeys<T extends object> =
  Extract<keyof T, string> extends never ? string : Extract<keyof T, string>

/**
 * Runtime descriptor attached at `~middleware`. Structurally identical to the
 * reference implementation's, so a middleware from either package is legible to
 * the same tooling.
 */
export interface MiddlewareDescriptor<
  In extends object = object,
  Adds extends object = object,
> {
  /** Schema version. Readers MUST check this before interpreting other fields. */
  readonly version: typeof DESCRIPTOR_VERSION
  /** Stable identity for this middleware kind; prefixes composition diagnostics. */
  readonly id?: string
  /** Context keys this middleware needs upstream; enforced at compose time. */
  readonly requires?: readonly string[]
  /** Context keys this middleware contributes; for enforcement and tooling. */
  readonly provides?: readonly string[]
  /**
   * Phantom type transport — declaration-only, MUST be absent at runtime. Lets
   * independently-installed versions exchange types without shared symbols.
   */
  readonly types?: {
    readonly need: In
    readonly add: Adds
  }
}

/**
 * Author-facing descriptor input for {@link annotate} and `defineMiddleware`.
 * `version` and the phantom `types` are supplied by the builder, not the author.
 */
export interface DescriptorInput<
  In extends object = object,
  Adds extends object = object,
> {
  readonly id?: string
  readonly requires?: readonly ContextKeys<In>[]
  readonly provides?: readonly ContextKeys<Adds>[]
}

/** Structural shape of a value that may carry a descriptor. */
export interface WithMiddleware {
  readonly '~middleware'?: MiddlewareDescriptor
}

/** Recursively freeze a descriptor so a shared instance can't be mutated. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Build a frozen, JSON-safe descriptor from author input. Omits empty arrays so
 * the serialized shape stays minimal. Throws {@link MiddlewareError} for a
 * structurally invalid input rather than stamping something tooling can't trust.
 */
export function buildDescriptor(input: DescriptorInput): MiddlewareDescriptor {
  if (input.id !== undefined && typeof input.id !== 'string') {
    throw new MiddlewareError(
      MiddlewareErrorCode.invalidDescriptor,
      'descriptor id must be a string',
    )
  }
  const descriptor: {
    version: typeof DESCRIPTOR_VERSION
    id?: string
    requires?: readonly string[]
    provides?: readonly string[]
  } = { version: DESCRIPTOR_VERSION }
  if (input.id !== undefined) descriptor.id = input.id
  if (input.requires && input.requires.length > 0) {
    descriptor.requires = [...input.requires]
  }
  if (input.provides && input.provides.length > 0) {
    descriptor.provides = [...input.provides]
  }
  return deepFreeze(descriptor)
}

/**
 * Install a pre-built descriptor on a target function under `~middleware`. The
 * property is non-enumerable (so it never pollutes spreads or `JSON.stringify`
 * of the function's own keys) and non-writable (so it can't be clobbered by
 * assignment), but configurable so {@link annotate} is idempotent-friendly.
 */
export function stampDescriptor<T extends object>(
  target: T,
  descriptor: MiddlewareDescriptor,
): T {
  Object.defineProperty(target, '~middleware', {
    value: descriptor,
    enumerable: false,
    writable: false,
    configurable: true,
  })
  return target
}

/**
 * Attach a descriptor to a middleware/entry/handler. The single public seam for
 * stamping metadata — `defineMiddleware` uses it internally, and it is exported
 * so hand-written middleware can declare the same metadata.
 *
 * @example
 * ```ts
 * const withTenant = annotate(
 *   (req: Request, ctx: Ctx) => Response.json({ ok: true }),
 *   { id: 'tenant', provides: ['tenant'] },
 * )
 * ```
 */
export function annotate<T extends object>(
  target: T,
  input: DescriptorInput,
): T {
  return stampDescriptor(target, buildDescriptor(input))
}

/**
 * Read a middleware's descriptor, applying version negotiation: a descriptor
 * whose `version` this implementation does not understand is treated as absent
 * (returns `undefined`) rather than raising — a forward-compatible reader must
 * tolerate newer producers.
 */
export function getDescriptor(
  value: unknown,
): MiddlewareDescriptor | undefined {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return undefined
  }
  const descriptor = (value as WithMiddleware)['~middleware']
  if (!descriptor || descriptor.version !== DESCRIPTOR_VERSION) return undefined
  return descriptor
}

/**
 * Enforce composition rules across a stack using whatever descriptors are
 * present — the runtime backstop for stacks the compiler never checked (dynamic
 * or plain-JS composition). Called by {@link pipeline} at compose time so a bad
 * stack fails fast, before the first request.
 *
 * Rules, applied in array order (first entry = outermost = runs first):
 * - **prerequisites** — a declared `requires` key must be contributed by an
 *   earlier entry (or be the reserved `_runtime` base facet). Provided by a
 *   *later* entry is an ordering error; provided by *no* entry is a missing
 *   prerequisite.
 * - **write-once contributions** — two entries contributing the same key is a
 *   duplicate-provision error, mirroring the type-level collision check.
 *
 * Entries without an (understood) descriptor are opaque: they are skipped, and
 * because such an entry *might* contribute a key we can't see, a prerequisite is
 * only flagged once we know no opaque entry preceded it. Conservative by design
 * — it never rejects a stack that could be valid.
 */
export function assertComposable(entries: readonly unknown[]): void {
  const providedAnywhere = new Set<string>()
  for (const entry of entries) {
    const descriptor = getDescriptor(entry)
    for (const key of descriptor?.provides ?? []) providedAnywhere.add(key)
  }

  const seen = new Set<string>(['_runtime'])
  const providedBy = new Map<string, string>()
  let opaqueBefore = false

  for (const entry of entries) {
    const descriptor = getDescriptor(entry)
    if (!descriptor) {
      opaqueBefore = true
      continue
    }
    const id = descriptor.id ?? 'middleware'

    for (const key of descriptor.requires ?? []) {
      if (seen.has(key) || opaqueBefore) continue
      throw new MiddlewareError(
        MiddlewareErrorCode.prerequisiteMissing,
        providedAnywhere.has(key)
          ? `'${id}' requires context key '${key}', but the middleware providing it runs later — reorder so it comes first`
          : `'${id}' requires context key '${key}', but no middleware in the pipeline provides it`,
        { middlewareId: id, key },
      )
    }

    for (const key of descriptor.provides ?? []) {
      if (seen.has(key)) {
        const owner =
          providedBy.get(key) ??
          (key === '_runtime' ? 'the runtime' : 'an earlier middleware')
        throw new MiddlewareError(
          MiddlewareErrorCode.duplicateProvision,
          `'${id}' contributes context key '${key}', already provided by ${owner} — context keys are write-once`,
          { middlewareId: id, key },
        )
      }
      seen.add(key)
      providedBy.set(key, id)
    }
  }
}
