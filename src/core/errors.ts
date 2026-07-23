/**
 * Stable, machine-readable composition diagnostics.
 *
 * web-middleware's ordering and collision guarantees are enforced by the type
 * system (see `pipeline`'s `Validate`/`Accumulate`), and for TypeScript
 * consumers that is the whole story. These codes are the **runtime backstop**:
 * they fire when a stack is assembled dynamically or from plain JavaScript,
 * where the compile-time checks were never run. The human message may evolve;
 * the `code` is the stable contract tooling should switch on.
 *
 * @packageDocumentation
 */

/** Stable diagnostic codes. The string values are the contract, not the keys. */
export const MiddlewareErrorCode = {
  /** A middleware declared a prerequisite context key that nothing upstream provides. */
  prerequisiteMissing: 'WM_PREREQUISITE_MISSING',
  /** Two middleware in one pipeline contribute the same context key. */
  duplicateProvision: 'WM_DUPLICATE_PROVISION',
  /** A middleware's `run` returned/yielded an object missing its declared key. */
  contributionMissing: 'WM_CONTRIBUTION_MISSING',
  /** A descriptor was structurally invalid (e.g. a non-string id). */
  invalidDescriptor: 'WM_INVALID_DESCRIPTOR',
} as const

export type MiddlewareErrorCode =
  (typeof MiddlewareErrorCode)[keyof typeof MiddlewareErrorCode]

export interface MiddlewareErrorDetails {
  /** The `id` of the middleware the error is attributed to, when known. */
  readonly middlewareId?: string
  /** The offending context key, when the error concerns one. */
  readonly key?: string
  /** Underlying cause, forwarded to the `Error` cause chain. */
  readonly cause?: unknown
}

/**
 * A composition failure that tooling can handle without parsing prose. The
 * `code` is stable; `message` is prefixed with it so logs stay searchable even
 * when the error is stringified.
 */
export class MiddlewareError extends Error {
  readonly code: MiddlewareErrorCode
  readonly middlewareId?: string
  readonly key?: string

  constructor(
    code: MiddlewareErrorCode,
    message: string,
    details: MiddlewareErrorDetails = {},
  ) {
    super(
      `${code}: ${message}`,
      details.cause === undefined ? undefined : { cause: details.cause },
    )
    this.name = 'MiddlewareError'
    this.code = code
    this.middlewareId = details.middlewareId
    this.key = details.key
  }
}
