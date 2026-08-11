# `@supabase/middleware/cors`

CORS for Web Fetch handlers — answers the `OPTIONS` preflight and stamps `Access-Control-*` headers onto your handler's response.

> This is the worked example of the **response seam**. CORS is the textbook case for it: it acts on the request (preflight) _and_ the response (headers). `withCors` is written as an `async function*` so it can do both in one middleware — read [`with-cors.ts`](./with-cors.ts) alongside the [core README](../../core/README.md#response-seam-generator-middleware).

```ts
import { withCors } from '@supabase/middleware/cors'

export default {
  fetch: withCors(
    { origin: ['https://app.example.com'], credentials: true },
    async () => Response.json({ ok: true }),
  ),
}
```

## Config

| Field                  | Type                                                                 | Description                                                                              |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `origin`               | `string \| string[] \| '*' \| ((origin: string \| null) => boolean)` | Allowed origin(s). Default `'*'`. With `credentials`, the request `Origin` is reflected. |
| `methods`              | `string[]?`                                                          | Methods advertised on preflight. Default: the common verbs.                              |
| `allowedHeaders`       | `string[]?`                                                          | Headers advertised on preflight. Omit to reflect `Access-Control-Request-Headers`.       |
| `exposedHeaders`       | `string[]?`                                                          | Response headers exposed to the client beyond the safelist.                              |
| `credentials`          | `boolean?`                                                           | Send `Access-Control-Allow-Credentials: true`. Default `false`.                          |
| `maxAge`               | `number?`                                                            | `Access-Control-Max-Age` (seconds) for preflight caching.                                |
| `optionsSuccessStatus` | `number?`                                                            | Status for a successful preflight. Default `204`.                                        |

It contributes `ctx.cors.allowedOrigin` (the resolved `Access-Control-Allow-Origin`, or `null` when the origin isn't allowed) for handlers that want to branch on it.

## Behavior notes

- **Preflight** (`OPTIONS` + `Access-Control-Request-Method`) short-circuits before the handler runs and returns `204`.
- **Credentials + `'*'`** is forbidden by the Fetch spec, so when both are set the request's `Origin` is reflected instead of a literal `*`.
- **`Vary: Origin`** is set whenever the allow-origin is per-origin (anything but a literal `*`), so shared caches don't serve one origin's response to another.
- **Disallowed origins** still reach the handler — CORS is enforced by the browser, not the server; we simply omit the headers.
- The response is rebuilt with copied headers, so an immutable response (e.g. one returned from `fetch`) is handled and a streaming body passes through untouched.

This is a small, practical implementation, not a spec-exhaustive one. If you need private-network access, complex header negotiation, or per-route policies, compose your own `withCors`-shaped middleware — it's ~20 lines.

## See also

- [Core README — the response seam](../../core/README.md)
- [Authoring guide](../../../docs/authoring-guide.md)
