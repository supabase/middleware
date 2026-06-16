/**
 * Type primitives for the middleware composition system.
 *
 * @packageDocumentation
 */

/**
 * Sentinel type used in a middleware's wrapper signature to surface a key
 * collision with the upstream context as a TypeScript error at the call site.
 *
 * The literal string is part of the type so it appears in the error message
 * (TypeScript prints "Type '…' is not assignable to type 'middleware-conflict: …'").
 */
export type Conflict<Key extends string> =
  `middleware-conflict: key '${Key}' is already present on the upstream context`
