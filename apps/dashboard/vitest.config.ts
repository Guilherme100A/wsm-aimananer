import { defineConfig } from 'vitest/config'

// Testes unitários da lógica do dashboard (funções puras; sem DOM).
export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.{ts,tsx}'],
    environment: 'node',
  },
})
