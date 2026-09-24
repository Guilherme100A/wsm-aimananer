// /api/sessions/:id/groups (T14): leitura dos grupos via transport.fetchGroups() e releitura manual auditada.
// Não há rota de entrada em grupos: o sistema nunca entra em grupos sozinho (SPEC 1.4 #5).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { listSessionGroups, SessionError, SessionNotConnectedError, SessionStore, type WaTransport } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'

declare module './sessions' {
  interface SessionsControl {
    /** Transporte vivo da sessão (SessionManager.getTransport). */
    getTransport?(sessionId: string): WaTransport | undefined
  }
}

const uuid = z.uuid()

function sessionId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', `session ${id} not found`)
  return id
}

function toApiError(err: unknown): unknown {
  if (err instanceof SessionNotConnectedError) return new ApiError('SESSION_NOT_CONNECTED', err.message)
  if (err instanceof SessionError && err.code === 'SESSION_NOT_FOUND') return new ApiError('SESSION_NOT_FOUND', err.message)
  return err
}

export function groupsRoutes(deps: Pick<AppDeps, 'db' | 'sessions'>) {
  const store = new SessionStore(deps.db)
  const getTransport = (id: string) => deps.sessions?.getTransport?.(id)

  const list = async (id: string) => {
    try {
      return await listSessionGroups({ store, sessionId: id, getTransport })
    } catch (err) {
      throw toApiError(err)
    }
  }

  return new Hono<AppEnv>()
    .get('/api/sessions/:id/groups', async (c) => c.json({ items: await list(sessionId(c)) }))
    .post('/api/sessions/:id/groups/refresh', async (c) => {
      const id = sessionId(c)
      const items = await list(id)
      setAudit(c, { action: 'group.refresh', targetType: 'session', targetId: id, detail: { count: items.length } })
      return c.json({ items })
    })
}
