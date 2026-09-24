// Testes unitários: o antiban roda em passthrough por configuração EXPLÍCITA (decisão T09; ver docs/antiban.md).
// O código de produção nunca decide o modo por NODE_ENV/VITEST; sem ANTIBAN_MODE o default é `real`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: { ANTIBAN_MODE: 'passthrough' },
  },
})
