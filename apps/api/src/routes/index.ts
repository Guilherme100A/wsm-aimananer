// Ponto de registro das rotas (arquivo compartilhado: alterações somente aditivas, SPEC 2.4).
// Rotas de domínio montam sob `/api/*` (auth + auditoria já aplicados em app.ts).
import type { Hono } from 'hono'
import type { AppDeps, AppEnv } from '../types'
import { healthRoutes } from './health'
import { contactsRoutes } from './contacts'
import { proxiesRoutes } from './proxies'
import { sessionsRoutes } from './sessions'

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.route('/', healthRoutes(deps))
  app.route('/', contactsRoutes(deps))
  app.route('/', proxiesRoutes(deps))
  app.route('/', sessionsRoutes(deps))
}
