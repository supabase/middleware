// Runs the built dist on Bun: `Bun.serve` hands the stack its `Server` object as
// the second argument, which must be treated as a platform value, not a ctx.
import { expect, test } from 'bun:test'

import {
  defineMiddleware,
  getEnv,
  isContext,
  pipeline,
  runtimeName,
} from '../../../dist/index.mjs'

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

const app = pipeline([probe()], async (_req, ctx) =>
  Response.json({
    runtime: runtimeName,
    env: getEnv('WM_RUNTIME_TEST') ?? null,
    upstreamKeys: ctx.probe.upstreamKeys,
    handlerKeys: Object.keys(ctx),
    isCtx: ctx.probe.isCtx,
  }),
)

test('the built engine serves a pipeline on Bun', async () => {
  process.env.WM_RUNTIME_TEST = 'from-process-env'
  const server = Bun.serve({ port: 0, fetch: app })
  try {
    const res = await fetch(`http://localhost:${server.port}/`)
    expect(await res.json()).toEqual({
      runtime: 'bun',
      env: 'from-process-env',
      upstreamKeys: [],
      handlerKeys: ['probe'],
      isCtx: true,
    })
  } finally {
    server.stop(true)
  }
})
