// Contexto de log por requisição (AC-T15-03): requisições de uma sessão levam `session_id` em todos os logs,
// inclusive a linha "request completed". Registrado em app.ts ANTES do requestLogger.
import type { MiddlewareHandler } from 'hono'
import { runWithLogContext } from '@wsm/core'
import type { AppEnv } from '../types'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SESSION_PATH = new RegExp(`^/api/sessions/(${UUID})(?:/|$)`, 'i')
const UUID_RE = new RegExp(`^${UUID}$`, 'i')

/** `session_id` da requisição: `/api/sessions/:id/...` ou `?sessionId=`. */
export function sessionIdFromRequest(path: string, query: (name: string) => string | undefined): string | undefined {
  const fromPath = SESSION_PATH.exec(path)?.[1]
  if (fromPath) return fromPath.toLowerCase()
  const fromQuery = query('sessionId')
  return fromQuery && UUID_RE.test(fromQuery) ? fromQuery.toLowerCase() : undefined
}

export function sessionLogContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sessionId = sessionIdFromRequest(c.req.path, (n) => c.req.query(n))
    if (!sessionId) return next()
    return runWithLogContext({ session_id: sessionId }, async () => {
      await next()
    })
  }
}

/** Depois do requestLogger: o logger da requisição (c.get('logger')) ganha `session_id` mesmo sem o mixin. */
export function sessionRequestLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sessionId = sessionIdFromRequest(c.req.path, (n) => c.req.query(n))
    const log = c.get('logger')
    if (sessionId && log && !('session_id' in log.bindings())) c.set('logger', log.child({ session_id: sessionId }))
    await next()
  }
}
