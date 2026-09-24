// Ponto de registro das rotas (arquivo compartilhado: alterações somente aditivas, SPEC 2.4).
// Rotas de domínio montam sob `/api/*` (auth + auditoria já aplicados em app.ts).
import type { Hono } from 'hono'
import type { AppDeps, AppEnv } from '../types'
import { healthRoutes } from './health'

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.route('/', healthRoutes(deps))
}
