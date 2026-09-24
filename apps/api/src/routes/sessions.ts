// /api/sessions (T05): CRUD de leitura/criação e controle de sessões.
// A API conversa com o SessionManager do worker por `deps.sessions` (interface abaixo); sem ele,
// só criação/leitura funcionam (direto no banco) e as ações de conexão respondem 500.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { E164_REGEX } from '@wsm/db'
import { InvalidTransitionError, ProxyError, SessionError, SessionStore, toSessionView, type CreateSessionInput, type SessionView } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

/** Contrato que o SessionManager (apps/worker) implementa. */
export interface SessionsControl {
  create(input: CreateSessionInput): Promise<SessionView>
  list(): Promise<SessionView[]>
  get(id: string): Promise<SessionView>
  startQr(id: string): Promise<SessionView>
  getQr(id: string): Promise<{ qr: string | null; generatedAt: string | null }>
  requestPairingCode(id: string, phone?: string): Promise<{ code: string }>
  pause(id: string): Promise<SessionView>
  resume(id: string): Promise<SessionView>
  restart(id: string): Promise<SessionView>
  logout(id: string): Promise<SessionView>
}

declare module '../types' {
  interface AppDeps {
    /** SessionManager do worker (T05). Opcional: sem ele, ações de conexão ficam indisponíveis. */
    sessions?: SessionsControl
  }
}

const phone = z.string().trim().regex(E164_REGEX, 'phone must be E.164 (e.g. +5511999999999)')
const optionalText = z.string().trim().max(2000).nullable().optional()

export const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone,
  proxyId: z.uuid().nullable().optional(),
  note: optionalText,
})
export const pairingCodeSchema = z.object({ phone: phone.optional() })

const uuid = z.uuid()

function sessionId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', `session ${id} not found`)
  return id
}

export function toApiError(err: unknown): unknown {
  if (err instanceof InvalidTransitionError) return new ApiError('INVALID_TRANSITION', err.message, { from: err.from, to: err.to })
  if (err instanceof SessionError || err instanceof ProxyError) {
    switch (err.code) {
      case 'SESSION_NOT_FOUND':
        return new ApiError('SESSION_NOT_FOUND', err.message)
      case 'PROXY_IN_USE':
        return new ApiError('PROXY_IN_USE', err.message)
      case 'PROXY_NOT_FOUND':
        return new ApiError('VALIDATION_ERROR', err.message, { issues: [{ path: 'proxyId', message: err.message, code: 'custom' }] })
      case 'VALIDATION_ERROR':
        return new ApiError('VALIDATION_ERROR', err.message, { issues: [{ path: 'phone', message: err.message, code: 'custom' }] })
    }
  }
  return err
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** Implementação sem worker: leitura/criação no banco; ações de conexão indisponíveis. */
export function dbOnlySessions(store: SessionStore): SessionsControl {
  const unavailable = async (): Promise<never> => {
    throw new ApiError('INTERNAL_ERROR', 'session manager not available')
  }
  return {
    create: async (input) => toSessionView(await store.create(input)),
    list: async () => (await store.list()).map(toSessionView),
    get: async (id) => toSessionView(await store.get(id)),
    startQr: unavailable,
    getQr: unavailable,
    requestPairingCode: unavailable,
    pause: unavailable,
    resume: unavailable,
    restart: unavailable,
    logout: unavailable,
  }
}

type Action = 'pause' | 'resume' | 'restart' | 'logout'
const ACTIONS: Action[] = ['pause', 'resume', 'restart', 'logout']

export function sessionsRoutes(deps: Pick<AppDeps, 'db' | 'sessions'>) {
  const sessions = deps.sessions ?? dbOnlySessions(new SessionStore(deps.db))

  const app = new Hono<AppEnv>()
    .get('/api/sessions', async (c) => c.json({ items: await run(() => sessions.list()) }))
    .post('/api/sessions', validate('json', createSessionSchema), async (c) => {
      const session = await run(() => sessions.create(c.req.valid('json')))
      setAudit(c, { action: 'session.create', targetType: 'session', targetId: session.id, detail: { proxyId: session.proxyId } })
      return c.json(session, 201)
    })
    .get('/api/sessions/:id', async (c) => c.json(await run(() => sessions.get(sessionId(c)))))
    .post('/api/sessions/:id/qr', async (c) => {
      const id = sessionId(c)
      const session = await run(() => sessions.startQr(id))
      setAudit(c, { action: 'session.connect', targetType: 'session', targetId: id, detail: { method: 'qr' } })
      return c.json(session, 202)
    })
    .get('/api/sessions/:id/qr', async (c) => c.json(await run(() => sessions.getQr(sessionId(c)))))
    .post('/api/sessions/:id/pairing-code', async (c) => {
      const id = sessionId(c)
      const raw = await c.req.text()
      const body = pairingCodeSchema.parse(raw.trim() ? JSON.parse(raw) : {})
      const result = await run(() => sessions.requestPairingCode(id, body.phone))
      setAudit(c, { action: 'session.connect', targetType: 'session', targetId: id, detail: { method: 'pairing_code' } })
      return c.json(result)
    })

  for (const action of ACTIONS) {
    app.post(`/api/sessions/:id/${action}`, async (c) => {
      const id = sessionId(c)
      const session = await run(() => sessions[action](id))
      setAudit(c, { action: `session.${action}`, targetType: 'session', targetId: id, detail: { state: session.status } })
      return c.json(session)
    })
  }
  return app
}
