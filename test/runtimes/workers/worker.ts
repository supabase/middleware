// Runs the built dist inside workerd. Bindings arrive per request as the second
// `fetch` argument; there is no ambient `process.env` without `nodejs_compat`.
import {
  defineMiddleware,
  getEnv,
  isContext,
  pipeline,
  runtimeName,
} from '@supabase/middleware'

// On Workers, `getEnv` has nothing to read before the first request.
const atModuleLoad = getEnv('WM_RUNTIME_TEST') ?? null

const probe = defineMiddleware<
  'probe',
  void,
  Record<never, never>,
  { upstreamKeys: string[]; isCtx: boolean }
>({
  key: 'probe',
  run: () => async (_req, ctx) => ({
    probe: { upstreamKeys: Object.keys(ctx), isCtx: isContext(ctx) },
  }),
})

export default {
  fetch: pipeline([probe()], async (_req, ctx) =>
    Response.json({
      runtime: runtimeName,
      atModuleLoad,
      env: getEnv('WM_RUNTIME_TEST') ?? null,
      upstreamKeys: ctx.probe.upstreamKeys,
      handlerKeys: Object.keys(ctx),
      isCtx: ctx.probe.isCtx,
    }),
  ),
}
