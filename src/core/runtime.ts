/**
 * Runtime abstraction — portable environment access with no context facet.
 *
 * Reading configuration differs per host — `Deno.env.get` on Deno, `process.env`
 * on Node/Bun, a per-request bindings object on Cloudflare Workers.
 * {@link getEnv} normalizes that to a single importable function:
 *
 * ```ts
 * import { getEnv } from '@supabase/middleware'
 *
 * getEnv('SUPABASE_DB_URL') // string | undefined, resolved per host
 * ```
 *
 * Host detection is delegated to [`std-env`](https://github.com/unjs/std-env)
 * (which tracks the WinterCG Runtime Keys proposal) — {@link runtimeName}
 * re-exports its detected name. On Workers, env bindings are not ambient: they
 * arrive per request as the second `fetch` argument. The entry call captures
 * that object module-scoped (see {@link seedContext}), and {@link getEnv} reads
 * it first before falling back to the host's global env. The one consequence:
 * on Workers, `getEnv` returns `undefined` at module top level, before the
 * first request has been seen.
 *
 * There is **no wrapper step**. A composed stack is used directly as the
 * runtime's `fetch` handler (`export default { fetch: withFoo(config, handler) }`).
 * When the host invokes the outermost handler, {@link defineMiddleware} detects
 * that the second argument is not an upstream context (via {@link isContext})
 * and seeds a fresh context itself — so a host-supplied `env` /
 * `ServeHandlerInfo` is never merged into `ctx`. The seeded context is empty
 * except for a non-enumerable-to-`Object.keys` symbol marker: `ctx` carries
 * middleware contributions and nothing else.
 *
 * The request body is made re-readable on `req` itself (see {@link bufferRequest})
 * rather than via a `ctx` key, so the body stays a property of the request.
 *
 * @packageDocumentation
 */

import { env as stdEnv, isDeno, runtime } from 'std-env'
import type { RuntimeName } from 'std-env'

export type { RuntimeName } from 'std-env'

/**
 * The host's detected runtime name, re-exported from `std-env` (WinterCG
 * Runtime Keys: `'node' | 'deno' | 'bun' | 'workerd' | 'edge-light' | …`, or
 * `''` when unknown). Detected once at module load.
 */
export const runtimeName: RuntimeName = runtime

/**
 * Platform-provided bindings, captured module-scoped from the entry call. On
 * Cloudflare Workers this is the per-request `env` object (same object for
 * every request in an isolate); on Deno it is the `ServeHandlerInfo` (whose
 * keys never look like env vars, so lookups simply fall through).
 */
let platformEnv: Record<string, unknown> | undefined

/**
 * Resolve an environment value the same way regardless of host, so middleware
 * never branch on `Deno` vs `process` vs a Workers bindings object.
 *
 * Resolution order:
 * 1. the platform object captured at the entry call (Workers bindings),
 * 2. `process.env` where a `process` global exists (Node, Bun, Deno 2,
 *    Workers with `nodejs_compat`), via `std-env`,
 * 3. `Deno.env.get` on Deno hosts without a populated `process.env`.
 *
 * On Workers, bindings are per-request, so this returns `undefined` at module
 * top level until the first request has been handled.
 */
export function getEnv(key: string): string | undefined {
  if (platformEnv) {
    const bound = platformEnv[key]
    if (typeof bound === 'string') return bound
  }
  const fromStd = stdEnv[key]
  if (fromStd !== undefined) return fromStd
  if (isDeno) {
    const deno = (
      globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }
    ).Deno
    return deno?.env?.get(key)
  }
  return undefined
}

/**
 * Marks a context object seeded by this framework, so an entry call can tell an
 * upstream context apart from a host-supplied platform argument (a Workers
 * `env`, a Deno `ServeHandlerInfo`) occupying the same positional slot.
 * `Symbol.for` (the global registry) so contexts cross module instances — e.g.
 * the CJS and ESM builds loaded side by side — and still recognize each other.
 */
const CONTEXT_MARK = Symbol.for('@supabase/middleware:context')

/**
 * The lower bound of every context. Structurally empty — the framework reserves
 * no keys; every property on `ctx` is a middleware contribution. (At runtime a
 * seeded context carries a symbol marker so the entry call can distinguish it
 * from a platform argument; the marker is invisible to `Object.keys` iteration
 * of string keys and to the type.)
 */
export type BaseContext = object

/** A composed handler: request + an accumulated context `>= BaseContext`. */
export type Handler<Ctx extends BaseContext = BaseContext> = (
  req: Request,
  ctx: Ctx,
) => Promise<Response>

/**
 * The type of a composed stack handed to the host — the `fetch` export,
 * `Deno.serve(app)`, and so on.
 *
 * Annotating the outermost handler with this (`… satisfies FetchHandler`) is
 * optional and adds no runtime code. It does two things:
 *
 * - **Asserts the stack can be the `fetch` export.** Prerequisites are enforced
 *   between layers with no annotation. What is left over is the case where *no*
 *   layer supplies a declared `In` key: the requirement is republished all the
 *   way out, so the stack has a **required** `ctx`. That alone is not an error —
 *   a required `ctx` is only wrong where the stack is handed to the host, and
 *   this type is what makes that position explicit (its `ctx` is optional, and a
 *   required one is not assignable to it). An untyped
 *   `export default { fetch: app }` checks nothing, so without the annotation
 *   the stack compiles, ships, and reads `undefined` off `ctx` on the first
 *   request. Any `FetchHandler`-typed position does the same job.
 * - **Turns on collision detection.** Two middleware contributing the same key
 *   are only caught under this annotation; see the `Middleware` overload set.
 *   One annotation on the outermost call covers any nesting depth.
 *
 * It is **not** needed for accumulation: an unannotated outermost call resolves
 * `Base` to its constraint — the empty upstream, the same context an annotation
 * would seed — so the cascade reaches the innermost handler at any depth either
 * way. Nor for `In` prerequisites (those travel outward), nor for
 * {@link pipeline} (which accumulates and validates from its entries array).
 */
export type FetchHandler = (
  req: Request,
  ctx?: BaseContext,
) => Promise<Response>

/**
 * Seed a fresh base context for an entry call, capturing the host's second
 * `fetch` argument (a Workers `env`, a Deno `ServeHandlerInfo`, …) as the
 * module-scoped platform env for {@link getEnv}. The platform value itself is
 * never merged into `ctx`.
 *
 * Public so a host embedding the engine (e.g. `@supabase/server`) can mint a
 * valid upstream context and spread its own keys onto it.
 */
export function seedContext(platformArg?: unknown): BaseContext {
  if (platformArg && typeof platformArg === 'object') {
    platformEnv = platformArg as Record<string, unknown>
  }
  return { [CONTEXT_MARK]: true }
}

/**
 * Distinguish an upstream context (passed by a parent middleware) from a
 * host-supplied platform argument (an `env` / connection-info object the runtime
 * puts in the same positional slot). The symbol marker set by {@link seedContext}
 * flows by reference through every `{ ...upstream }` merge (spread copies
 * enumerable own symbols), so checking for it is reliable across the stack.
 *
 * Public so a host embedding the engine (e.g. `@supabase/server`) can make the
 * same distinction before calling {@link seedContext}: reseeding with an
 * upstream context would stash it as the platform env, clobbering the real
 * bindings captured earlier.
 */
export function isContext(value: unknown): value is BaseContext {
  return !!value && typeof value === 'object' && CONTEXT_MARK in value
}

/** Body-reading `Request` methods the buffered proxy re-implements from a single cached read. */
const BUFFERED_METHODS = new Set([
  'arrayBuffer',
  'bytes',
  'blob',
  'text',
  'json',
  'formData',
])

/**
 * Wrap a `Request` so its body can be read more than once.
 *
 * A Fetch `Request` body is a single-use stream — the first reader of
 * `req.text()` / `req.json()` / … locks out every later one. This returns a
 * proxy that reads the underlying body **at most once** and caches the bytes, so
 * a body-verifying middleware (e.g. a webhook signature check) and the handler can each read it, in
 * any form:
 *
 * - `arrayBuffer` / `bytes` / `blob` / `text` / `json` / **`formData`** all read
 *   from the one cached read (`formData` is parsed from the cached bytes using
 *   the request's `content-type`).
 * - **`clone()`** returns another handle over the same cache — reading either
 *   yields the same body; `headers` / `url` / `method` / `signal` / … forward to
 *   the real request, and `proxy instanceof Request` stays true.
 *
 * The proxy is created once at the entry call and flows down the stack, so the
 * cache is shared across every layer.
 *
 * **One deliberate limit:** reading the raw `req.body` *stream* (e.g. handing the
 * request to `fetch()` to forward it) bypasses the cache. By design this is a
 * *buffering* model, not a streaming one — to forward the body, reconstruct it,
 * e.g. `new Request(req.url, { method: req.method, headers: req.headers, body:
 * await req.arrayBuffer() })`.
 */
export function bufferRequest(req: Request): Request {
  let buffer: Promise<ArrayBuffer> | undefined
  const arrayBuffer = (): Promise<ArrayBuffer> => (buffer ??= req.arrayBuffer())
  const text = async (): Promise<string> =>
    new TextDecoder().decode(await arrayBuffer())
  const cached: Record<string, () => Promise<unknown>> = {
    arrayBuffer,
    text,
    json: async () => JSON.parse(await text()) as unknown,
    bytes: async () => new Uint8Array(await arrayBuffer()),
    blob: async () => new Blob([await arrayBuffer()]),
    // Parse the cached bytes with the request's content-type (multipart /
    // urlencoded), so a form body survives an upstream read.
    formData: async () =>
      new Response(await arrayBuffer(), { headers: req.headers }).formData(),
  }
  const handler: ProxyHandler<Request> = {
    get(target, prop) {
      if (typeof prop === 'string' && BUFFERED_METHODS.has(prop)) {
        return cached[prop]
      }
      // A clone is another handle over the same cached body (sharing `handler`,
      // hence the same `buffer`); other members forward to the real request.
      if (prop === 'clone') return () => new Proxy(target, handler)
      // Read with receiver = target so native accessors (headers, url, …) run
      // against the real request's internal slots, and bind methods to it.
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }
  return new Proxy(req, handler)
}
