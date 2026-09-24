// Config compartilhada da suíte de aceitação (propriedade dos Testers).
// Uso (a partir da raiz): pnpm exec vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/T00
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  root: ROOT,
  resolve: {
    // A raiz não depende dos workspaces: os testes importam os pacotes pelo nome (@wsm/...)
    // e o alias aponta para o fonte de cada pacote (packages/<nome>/src/index.ts, apps/<nome>/src/index.ts).
    alias: [
      { find: /^@wsm\/(core|db)$/, replacement: `${ROOT.split('\\').join('/')}packages/$1/src/index.ts` },
      { find: /^@wsm\/(api|worker)$/, replacement: `${ROOT.split('\\').join('/')}apps/$1/src/index.ts` },
    ],
  },
  test: {
    include: ['tests/acceptance/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    pool: 'forks',
    // Testes de aceitação rodam comandos pesados (pnpm install/build, docker) e compartilham
    // infra (Postgres/Redis, portas HTTP): arquivos em série evitam interferência.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
  },
})
