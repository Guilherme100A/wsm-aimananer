// App Hono da API (T03). `createApp(deps)` não abre porta: teste com `app.request(...)`.
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { notFound, onError } from './errors'
import { auditMiddleware } from './middleware/audit'
import { bearerAuth } from './middleware/auth'
import { loginTokenAuth } from './middleware/auth'
import { requestLogger } from './middleware/request-log'
import { sessionLogContext, sessionRequestLogger } from './observability/session-context'
import { registerRoutes } from './routes/index'
import type { AppDeps, AppEnv } from './types'

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  // Middlewares no app raiz: valem também para rotas registradas depois de createApp.
  app.use('*', requestId({ headerName: 'x-request-id' }))
  // T15: session_id no contexto de log (antes do requestLogger, para valer também na linha 'request completed')
  app.use('*', sessionLogContext())
  app.use('*', requestLogger(deps.logger))
  app.use('*', sessionRequestLogger())
  // T17 — token de login do painel (e POST /api/auth/login público); o API_TOKEN segue valendo no bearerAuth.
  app.use('/api/*', loginTokenAuth(deps))
  app.use('/api/*', bearerAuth(deps.apiToken))
  app.use('/api/*', auditMiddleware(deps.db))

  app.onError(onError)
  app.notFound(notFound)

  registerRoutes(app, deps)
  return app
}

export type App = ReturnType<typeof createApp>
