import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/middleware/feature-flag/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
})
