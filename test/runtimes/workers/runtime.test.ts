import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('the built engine serves a pipeline inside workerd', async () => {
  const res = await SELF.fetch('http://example.com/')
  expect(await res.json()).toEqual({
    runtime: 'workerd',
    atModuleLoad: null,
    env: 'from-binding',
    upstreamKeys: [],
    handlerKeys: ['probe'],
    isCtx: true,
  })
})
