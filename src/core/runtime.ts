/**
 * Runtime abstraction — portable environment access, detected once, up front.
 *
 * Reading configuration differs per host — `Deno.env.get` on Deno, `process.env`
 * on Node/Bun, a per-request bindings object on Cloudflare Workers.
 * {@link Runtime} normalizes that to a single `getEnv(key)`, carried on every
 * context at `ctx._runtime`. The leading underscore marks it as the framework's
 * one reserved base facet — distinct from the middleware-named keys
 * (`ctx.featureFlag`, …) that share the rest of the namespace.
 *
 * There is **no entry wrapper**. A composed stack is used directly as the
 * runtime's `fetch` handler (`export default { fetch: withFoo(config, handler) }`).
 * When the host invokes the outermost handler, {@link defineMiddleware} detects
 * that the second argument is not an upstream context (via {@link isContext})
 * and seeds a fresh `{ _runtime }` itself — so a host-supplied `env` /
 * `ServeHandlerInfo` is never merged into `ctx`. The runtime *name* is detected
 * a single time at module load; per-request bindings (Workers `env`) are
 * captured from the entry call.
 *
 * The request body is made re-readable on `req` itself (see {@link bufferRequest})
 * rather than via a `ctx` key, so the body stays a property of the request.
 *
 * @packageDocumentation
 */

/** Runtimes we recognize for environment access. */
export type RuntimeName =
  | 'deno'
  | 'cloudflare-workers'
  | 'node'
  | 'bun'
  | 'unknown'

/**
 * The portable runtime facet carried at `ctx._runtime`. `getEnv` resolves a
 * configuration value the same way regardless of host, so middleware never
 * branch on `Deno` vs `process` vs a Workers bindings object.
 */
export interface Runtime {
  /** Which host this is running on. Detected once at module load. */
  readonly name: RuntimeName
  /** Resolve an environment value (env var or Workers binding). */
  getEnv(key: string): string | undefined
}

/**
 * The lower bound of every context — the framework's single reserved facet. The
 * outermost middleware seeds it on the entry call; each middleware widens the
 * context with its own contributed key. Anchoring composition to this base is
 * what lets `Base` inference flow through nested middleware (every produced
 * handler is a single `(req, ctx)` signature).
 */
export interface BaseContext {
  /** Portable runtime facet — environment access + host name. Reserved key. */
  readonly _runtime: Runtime
}

/** A composed handler: request + an accumulated context `>= BaseContext`. */
export type Handler<Ctx extends BaseContext = BaseContext> = (
  req: Request,
  ctx: Ctx,
) => Promise<Response>

/**
 * The type of a composed stack used as a runtime `fetch` entry. Annotating the
 * outermost handler with this (`… satisfies FetchHandler`) is the optional,
 * type-only anchor that lets the innermost handler see *every* upstream key
 * ambiently. It is not needed for cross-middleware dependencies declared as `In`
 * prerequisites — those type without any annotation.
 */
export type FetchHandler = (
  req: Request,
  ctx?: BaseContext,
) => Promise<Response>

/** Best-effort host detection. Deno is checked first because it also defines `navigator`. Exported for testing. */
export function detectRuntimeName(): RuntimeName {
  const g = globalThis as Record<string, unknown>
  if (typeof g.Deno !== 'undefined') return 'deno'
  const nav = g.navigator as { userAgent?: string } | undefined
  if (nav?.userAgent === 'Cloudflare-Workers') return 'cloudflare-workers'
  const proc = g.process as { versions?: Record<string, string> } | undefined
  if (proc?.versions?.bun) return 'bun'
  if (proc?.versions?.node) return 'node'
  return 'unknown'
}

/** Detected once, up front. */
const RUNTIME_NAME: RuntimeName = detectRuntimeName()

/**
 * Build a `getEnv` for a host. On Workers the bindings live on the per-request
 * `env` object passed as the second `fetch` argument, threaded in here via
 * `platformArgs[0]`; elsewhere they come from a global. Exported (and
 * parametrized by `name`) so each runtime's branch is unit-testable, not just the
 * one that happens to match the test runner.
 */
export function makeGetEnv(
  name: RuntimeName,
  platformArgs: readonly unknown[],
): (key: string) => string | undefined {
  const g = globalThis as Record<string, unknown>
  switch (name) {
    case 'deno': {
      const deno = g.Deno as { env?: { get(k: string): string | undefined } }
      return (k) => deno?.env?.get(k)
    }
    case 'node':
    case 'bun': {
      const proc = g.process as { env?: Record<string, string | undefined> }
      return (k) => proc?.env?.[k]
    }
    case 'cloudflare-workers': {
      const env = platformArgs[0] as Record<string, unknown> | undefined
      return (k) => {
        const v = env?.[k]
        return typeof v === 'string' ? v : undefined
      }
    }
    default:
      return () => undefined
  }
}

/**
 * Seed a fresh base context for an entry call. `platformArgs` is the host's
 * second `fetch` argument (a Workers `env`, a Deno `ServeHandlerInfo`, …), used
 * only to source bindings — never merged into `ctx`. A third argument (the
 * Workers `ExecutionContext`) is rejected upstream as not implemented.
 */
export function seedContext(platformArgs: readonly unknown[]): BaseContext {
  return {
    _runtime: {
      name: RUNTIME_NAME,
      getEnv: makeGetEnv(RUNTIME_NAME, platformArgs),
    },
  }
}

/**
 * Distinguish an upstream context (passed by a parent middleware) from a
 * host-supplied platform argument (an `env` / connection-info object the runtime
 * puts in the same positional slot). The `_runtime` facet flows by reference
 * through every merge, so checking for it is reliable across the stack.
 */
export function isContext(value: unknown): value is BaseContext {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { _runtime?: { getEnv?: unknown } })._runtime?.getEnv ===
      'function'
  )
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
