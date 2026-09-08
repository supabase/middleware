// Runs the built dist on Deno: `Deno.serve` hands the stack a `ServeHandlerInfo`
// as the second argument, which must be treated as a platform value, not a ctx.
// Runtime behavior only: the built types are checked by `typecheck:consumer`.
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

function assertJsonEqual(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`)
}

Deno.test('the built engine serves a pipeline on Deno', async () => {
  Deno.env.set('WM_RUNTIME_TEST', 'from-deno-env')
  const server = Deno.serve({ port: 0, onListen() {} }, app)
  try {
    const res = await fetch(`http://localhost:${server.addr.port}/`)
    assertJsonEqual(await res.json(), {
      runtime: 'deno',
      env: 'from-deno-env',
      upstreamKeys: [],
      handlerKeys: ['probe'],
      isCtx: true,
    })
  } finally {
    await server.shutdown()
  }
})
