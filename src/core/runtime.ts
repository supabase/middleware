/**
 * Runtime abstraction — portable environment access, detected once, up front.
 *
 * Reading configuration differs per host — `Deno.env.get` on Deno, `process.env`
 * on Node/Bun, a per-request bindings object on Cloudflare Workers.
 * {@link Runtime} normalizes that to a single `getEnv(key)`, carried on every
 * context at `ctx.runtime`.
 *
 * There is **no entry wrapper**. A composed stack is used directly as the
 * runtime's `fetch` handler (`export default { fetch: withFoo(config, handler) }`).
 * When the host invokes the outermost handler, {@link defineMiddleware} detects
 * that the second argument is not an upstream context (via {@link isContext})
 * and seeds a fresh `{ runtime }` itself — so a host-supplied `env` /
 * `ServeHandlerInfo` is never merged into `ctx`. The runtime *name* is detected
 * a single time at module load; per-request bindings (Workers `env`) are
 * captured from the entry call.
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
 * The portable runtime facet carried at `ctx.runtime`. `getEnv` resolves a
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
 * The lower bound of every context. The outermost middleware seeds it on the
 * entry call; each middleware widens it with its contributed key. Anchoring
 * composition to this base is what lets `Base` inference flow through nested
 * middleware — every produced handler is a single `(req, ctx)` signature.
 */
export interface BaseContext {
  /** Portable runtime facet — environment access + host name. */
  readonly runtime: Runtime
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

/** Best-effort host detection. Deno is checked first because it also defines `navigator`. */
function detectRuntimeName(): RuntimeName {
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
 * Build a `getEnv` for the detected host. On Workers the bindings live on the
 * per-request `env` object passed as the second `fetch` argument, threaded in
 * here via `platformArgs`; elsewhere they come from a global.
 */
function makeGetEnv(
  platformArgs: readonly unknown[],
): (key: string) => string | undefined {
  const g = globalThis as Record<string, unknown>
  switch (RUNTIME_NAME) {
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
 * Seed a fresh base context for an entry call. `platformArgs` are the positional
 * arguments the host passed after `req` (a Workers `env`, a Deno
 * `ServeHandlerInfo`, …) — used only to source bindings, never merged into `ctx`.
 */
export function seedContext(platformArgs: readonly unknown[]): BaseContext {
  return { runtime: { name: RUNTIME_NAME, getEnv: makeGetEnv(platformArgs) } }
}

/**
 * Distinguish an upstream context (passed by a parent middleware) from a
 * host-supplied platform argument (an `env` / connection-info object the runtime
 * puts in the same positional slot). The `runtime` facet flows by reference
 * through every merge, so checking for it is reliable across the stack.
 */
export function isContext(value: unknown): value is BaseContext {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { runtime?: { getEnv?: unknown } }).runtime?.getEnv ===
      'function'
  )
}
