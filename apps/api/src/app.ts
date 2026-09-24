// App Hono da API (T03). `createApp(deps)` não abre porta: teste com `app.request(...)`.
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { notFound, onError } from './errors'
import { auditMiddleware } from './middleware/audit'
import { bearerAuth } from './middleware/auth'
import { requestLogger } from './middleware/request-log'
import { registerRoutes } from './routes/index'
import type { AppDeps, AppEnv } from './types'

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  // Middlewares no app raiz: valem também para rotas registradas depois de createApp.
  app.use('*', requestId({ headerName: 'x-request-id' }))
  app.use('*', requestLogger(deps.logger))
  app.use('/api/*', bearerAuth(deps.apiToken))
  app.use('/api/*', auditMiddleware(deps.db))

  app.onError(onError)
  app.notFound(notFound)

  registerRoutes(app, deps)
  return app
}

export type App = ReturnType<typeof createApp>
