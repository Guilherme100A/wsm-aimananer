// Persistência das sessões (tabela sessions + health_events). Nunca expõe credenciais (AC-T05-07).
import { and, desc, eq, sql } from 'drizzle-orm'
import { E164_REGEX, healthEvents, proxies, sessionCredentials, sessions, type Database } from '@wsm/db'
import { isUniqueViolation } from '../proxy/errors'
import { assertTransition, InvalidTransitionError, type SessionState } from './states'

export type SessionRow = typeof sessions.$inferSelect

export type SessionErrorCode = 'SESSION_NOT_FOUND' | 'PROXY_IN_USE' | 'PROXY_NOT_FOUND' | 'VALIDATION_ERROR'

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

/** Visão pública da sessão: somente colunas de `sessions` (nenhum material de credencial). */
export interface SessionView {
  id: string
  name: string
  phone: string
  status: SessionState
  /** Alias de `status`. */
  state: SessionState
  proxyId: string | null
  note: string | null
  requiresRestart: boolean
  warmupStartedAt: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSessionInput {
  name: string
  phone: string
  proxyId?: string | null
  note?: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    state: row.status,
    proxyId: row.proxyId,
    note: row.note,
    requiresRestart: row.requiresRestart,
    warmupStartedAt: iso(row.warmupStartedAt),
    lastConnectedAt: iso(row.lastConnectedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TransitionResult {
  row: SessionRow
  from: SessionState
  to: SessionState
  changed: boolean
}

export interface TransitionOptions {
  /** Campos extras gravados junto com o estado. */
  set?: Partial<Pick<SessionRow, 'warmupStartedAt' | 'lastConnectedAt' | 'requiresRestart'>>
}

export class SessionStore {
  constructor(readonly db: Database) {}

  async create(input: CreateSessionInput): Promise<SessionRow> {
    if (!E164_REGEX.test(input.phone)) throw new SessionError('VALIDATION_ERROR', 'phone must be E.164 (e.g. +5511999999999)')
    const proxyId = input.proxyId ?? null
    try {
      return await this.db.transaction(async (tx) => {
        if (proxyId) {
          const [proxy] = await tx.select({ id: proxies.id }).from(proxies).where(eq(proxies.id, proxyId)).for('update')
          if (!proxy) throw new SessionError('PROXY_NOT_FOUND', `proxy ${proxyId} not found`)
          const [owner] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, proxyId))
          if (owner) throw new SessionError('PROXY_IN_USE', `proxy ${proxyId} is already assigned to another session`)
          await tx.update(proxies).set({ lastChangedAt: new Date(), updatedAt: new Date() }).where(eq(proxies.id, proxyId))
        }
        const [row] = await tx
          .insert(sessions)
          .values({ name: input.name, phone: input.phone, proxyId, note: input.note ?? null, status: 'NEW' })
          .returning()
        return row!
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new SessionError('PROXY_IN_USE', `proxy ${proxyId} is already assigned to another session`)
      throw err
    }
  }

  async list(): Promise<SessionRow[]> {
    return this.db.select().from(sessions).orderBy(desc(sessions.createdAt))
  }

  async find(id: string): Promise<SessionRow | undefined> {
    if (!UUID_RE.test(id)) return undefined
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id))
    return row
  }

  async get(id: string): Promise<SessionRow> {
    const row = await this.find(id)
    if (!row) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
    return row
  }

  /**
   * Muda o estado validando a SPEC 3.2 contra o valor atual no banco (linha travada).
   * `to === estado atual` é no-op (`changed: false`) quando `allowSame`; senão INVALID_TRANSITION.
   */
  async transition(id: string, to: SessionState, opts: TransitionOptions & { allowSame?: boolean } = {}): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update')
      if (!current) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
      const from = current.status
      if (from === to) {
        if (!opts.allowSame) throw new InvalidTransitionError(from, to)
        if (!opts.set) return { row: current, from, to, changed: false }
        const [row] = await tx.update(sessions).set({ ...opts.set, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
        return { row: row!, from, to, changed: false }
      }
      assertTransition(from, to)
      const [row] = await tx
        .update(sessions)
        .set({ ...opts.set, status: to, updatedAt: new Date() })
        .where(eq(sessions.id, id))
        .returning()
      return { row: row!, from, to, changed: true }
    })
  }

  async update(id: string, set: Partial<Pick<SessionRow, 'warmupStartedAt' | 'lastConnectedAt' | 'requiresRestart'>>): Promise<SessionRow> {
    const [row] = await this.db.update(sessions).set({ ...set, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
    if (!row) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
    return row
  }

  async recordHealthEvent(sessionId: string, type: string, detail?: Record<string, unknown>): Promise<void> {
    await this.db.insert(healthEvents).values({ sessionId, type, detail: detail ?? null })
  }

  async hasCredentials(sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(sessionCredentials)
      .where(eq(sessionCredentials.sessionId, sessionId))
      .limit(1)
    return row !== undefined
  }

  /** Sessões a reconectar no boot (AC-T05-04): com credenciais e estado ≠ DISCONNECTED (PAUSED reconecta e segue PAUSED). */
  async listResumable(): Promise<SessionRow[]> {
    const withCreds = sql`exists (select 1 from ${sessionCredentials} where ${sessionCredentials.sessionId} = ${sessions.id})`
    return this.db
      .select()
      .from(sessions)
      .where(and(sql`${sessions.status} <> 'DISCONNECTED'`, withCreds))
      .orderBy(sessions.createdAt)
  }
}
