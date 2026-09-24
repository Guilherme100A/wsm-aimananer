// Setup comum do T08: banco descartável migrado + Redis + SessionManager (T05) com FakeTransport
// injetado + MessageQueue (BullMQ, prefixo aleatório por suíte) ligada ao manager, e createApp no mesmo processo.
// Contrato combinado com o Operário (Cinzel):
//   @wsm/core: MessageQueue({ db, connection, prefix, getTransport, deliver?, backoffDelayMs?, maxAttempts?, holdDelayMs? })
//              .enqueue({ sessionId, phone, content }) → MessageView (queued) · queueName(id) · pause/resume (SessionQueueControl)
//              · cancel(id) · close();  deliver(transport, to, content) em send/deliver.ts;  phoneToJid(phone)
//   @wsm/worker: attachQueueToSessions(manager, queue) — state PAUSED → pause, saída de PAUSED → resume,
//              connected → startSession + receipts do transporte
//   @wsm/api:  createApp({ ..., sessions, messages }) · GET /api/messages/:id · POST /api/messages/:id/cancel
import './env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import * as core from '@wsm/core'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SendCall {
  to: string
  content: any
  /** Date.now() no início da chamada */
  at: number
  /** Date.now() ao terminar */
  end?: number
  ok?: boolean
}

/**
 * FakeTransport instrumentado: registra cada chamada a sendMessage (inclusive as que falham),
 * mede concorrência e permite atrasar o envio. `login()` persiste creds e abre a conexão.
 */
export class QueueTestTransport extends (core as any).FakeTransport {
  sendDelayMs = 0
  inFlight = 0
  maxInFlight = 0
  sendCalls: SendCall[] = []

  async login(): Promise<void> {
    await this.lastConnect?.saveCreds?.()
    this.open()
  }

  async sendMessage(to: string, content: any): Promise<{ messageId: string }> {
    const c: SendCall = { to, content, at: Date.now() }
    this.sendCalls.push(c)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.sendDelayMs > 0) await delay(this.sendDelayMs)
      const r = await super.sendMessage(to, content)
      c.ok = true
      return r
    } catch (e) {
      c.ok = false
      throw e
    } finally {
      c.end = Date.now()
      this.inFlight--
    }
  }
}

export type QT = QueueTestTransport & Record<string, any>

export function createTransportFactory() {
  const bySession = new Map<string, QT[]>()
  const factory = (arg: any) => {
    const sessionId = typeof arg === 'string' ? arg : String(arg?.sessionId)
    const t = new QueueTestTransport() as QT
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), t])
    return t
  }
  return {
    factory,
    last: (id: string) => bySession.get(id)?.at(-1),
    connectCount: (id: string) => (bySession.get(id) ?? []).reduce((n, t) => n + t.connectCalls.length, 0),
  }
}

export interface Ctx {
  tempDb: TempDb
  db: any
  redis: any
  logger: any
  token: string
  app: any
  manager: any
  queue: any
  prefix: string
  tf: ReturnType<typeof createTransportFactory>
}

export interface QueueSetup {
  /** opções extras para o construtor da MessageQueue (ex.: deliver espião) */
  queueOptions?: (ctx: Ctx) => Record<string, unknown>
}

export function messageQueueClass(): new (opts: any) => any {
  const Q = (core as any).MessageQueue ?? (worker as any).MessageQueue
  if (typeof Q !== 'function') throw new Error('@wsm/core não exporta MessageQueue')
  return Q
}

export function useQueue(setup: QueueSetup = {}): Ctx {
  const ctx = {} as Ctx
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t08')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.logger = (await captureLogger()).logger
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.prefix = `wsmt08${randomBytes(4).toString('hex')}`

    const SessionManager = (worker as any).SessionManager
    if (typeof SessionManager !== 'function') throw new Error('@wsm/worker não exporta SessionManager')
    ctx.tf = createTransportFactory()
    ctx.manager = new SessionManager({
      db: ctx.db,
      logger: ctx.logger,
      transportFactory: ctx.tf.factory,
      sleep: async () => {},
      pairingTimeoutMs: 5_000,
    })

    const MessageQueue = messageQueueClass()
    ctx.queue = new MessageQueue({
      db: ctx.db,
      connection: { url: REDIS_URL },
      prefix: ctx.prefix,
      getTransport: (id: string) => ctx.manager.getTransport(id),
      logger: ctx.logger,
      backoffDelayMs: 200,
      holdDelayMs: 200,
      ...(setup.queueOptions?.(ctx) ?? {}),
    })
    const attach = (worker as any).attachQueueToSessions
    if (typeof attach !== 'function') throw new Error('@wsm/worker não exporta attachQueueToSessions')
    await attach(ctx.manager, ctx.queue)

    ctx.app = await (createApp as any)({
      db: ctx.db,
      redis: ctx.redis,
      logger: ctx.logger,
      apiToken: ctx.token,
      sessions: ctx.manager,
      messages: ctx.queue,
    })
    await ctx.manager.start()
  })
  afterAll(async () => {
    for (const fn of [() => ctx.queue?.close?.(), () => ctx.manager?.stop?.()]) {
      try {
        await Promise.race([fn(), delay(15_000)])
      } catch {
        /* ignora */
      }
    }
    try {
      const keys: string[] = ctx.redis && ctx.prefix ? await ctx.redis.keys(`${ctx.prefix}*`) : []
      if (keys.length) await ctx.redis.del(...keys)
    } catch {
      /* ignora */
    }
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

// ---- API ------------------------------------------------------------------------

export const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

export const api = (ctx: Ctx, method: string, path: string, body?: unknown) => call(ctx.app, method, path, { token: ctx.token, body })

/** Cria a sessão pela API, inicia o QR e simula o login. Devolve { id, t } com a sessão em WARMING. */
export async function connectedSession(ctx: Ctx) {
  const res = await api(ctx, 'POST', '/api/sessions', { name: `fila-${randomBytes(3).toString('hex')}`, phone: randomPhone() })
  expect(res.status, `POST /api/sessions → ${res.text}`).toBe(201)
  const id = res.body.id as string
  const qr = await api(ctx, 'POST', `/api/sessions/${id}/qr`)
  expect(qr.status, `POST /qr → ${qr.text}`).toBe(202)
  await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(1)
  const t = ctx.tf.last(id)!
  await t.login()
  await expect.poll(() => sessionStatus(ctx, id), { timeout: 5_000 }).toBe('WARMING')
  return { id, t }
}

export async function pauseSession(ctx: Ctx, id: string) {
  const r = await api(ctx, 'POST', `/api/sessions/${id}/pause`)
  expect(r.status, `POST /pause → ${r.text}`).toBe(200)
  await expect.poll(() => sessionStatus(ctx, id)).toBe('PAUSED')
}

export async function resumeSession(ctx: Ctx, id: string) {
  const r = await api(ctx, 'POST', `/api/sessions/${id}/resume`)
  expect(r.status, `POST /resume → ${r.text}`).toBe(200)
  await expect.poll(() => sessionStatus(ctx, id)).not.toBe('PAUSED')
}

// ---- fila -----------------------------------------------------------------------

let textSeq = 0

/** Enfileira uma mensagem de texto (contrato T08: queue.enqueue). Devolve { id, phone, text }. */
export async function enqueue(ctx: Ctx, sessionId: string, text = `msg-${++textSeq}-${randomBytes(3).toString('hex')}`) {
  const phone = randomPhone()
  const view = await ctx.queue.enqueue({ sessionId, phone, content: { text } })
  expect(view?.id, `enqueue devolveu ${JSON.stringify(view)}`).toBeTruthy()
  expect(view.status).toBe('queued')
  return { id: view.id as string, phone, text, view }
}

// ---- leitura crua do banco ----------------------------------------------------------

export function sessionStatus(ctx: Ctx, id: string): string | undefined {
  return sqlOk(ctx.tempDb.url, `SELECT status FROM sessions WHERE id = ${lit(id)};`)[0]?.[0]
}

export function msgRow(ctx: Ctx, id: string): Record<string, any> | undefined {
  const r = sqlOk(ctx.tempDb.url, `SELECT row_to_json(t) FROM messages t WHERE id = ${lit(id)};`)[0]
  return r ? JSON.parse(r[0]!) : undefined
}

export const msgStatus = (ctx: Ctx, id: string) => msgRow(ctx, id)?.status as string | undefined

export async function waitMsgStatus(ctx: Ctx, id: string, status: string, timeout = 15_000) {
  try {
    await expect.poll(() => msgStatus(ctx, id), { timeout, interval: 50 }).toBe(status)
  } catch {
    const diag = await queueDiagnostics(ctx, id)
    expect.fail(`mensagem ${id} deveria chegar a ${status}, está em ${msgStatus(ctx, id)}\ndiagnóstico: ${diag}`)
  }
}

/** Estado da fila BullMQ da sessão da mensagem (para mensagens de falha legíveis). */
export async function queueDiagnostics(ctx: Ctx, messageId: string): Promise<string> {
  try {
    const sessionId = msgRow(ctx, messageId)?.session_id as string
    const out: Record<string, unknown> = { sessionId, events: eventTypes(ctx, messageId) }
    try {
      out.isPaused = await ctx.queue.isPaused?.(sessionId)
    } catch (e) {
      out.isPaused = `erro: ${String(e)}`
    }
    const keys: string[] = await ctx.redis.keys(`${ctx.prefix}*${sessionId}*`)
    const lists: Record<string, unknown> = {}
    for (const k of keys) {
      const type = await ctx.redis.type(k)
      if (type === 'list') lists[k] = await ctx.redis.lrange(k, 0, 50)
      else if (type === 'zset') lists[k] = await ctx.redis.zrange(k, 0, 50, 'WITHSCORES')
      else if (type === 'hash' && (k.endsWith(':meta') || k.endsWith(messageId))) lists[k] = await ctx.redis.hgetall(k)
      else lists[k] = type
    }
    out.redis = lists
    return JSON.stringify(out)
  } catch (e) {
    return `falha ao coletar diagnóstico: ${String(e)}`
  }
}

export interface MsgEvent {
  from: string | null
  to: string
  at: number
  detail: any
}

export function msgEvents(ctx: Ctx, id: string): MsgEvent[] {
  return sqlOk(
    ctx.tempDb.url,
    `SELECT coalesce(from_status::text, ''), to_status::text, (extract(epoch from created_at) * 1000)::bigint, coalesce(detail::text, 'null')
       FROM message_events WHERE message_id = ${lit(id)} ORDER BY created_at, id;`,
  ).map(([from, to, at, detail]) => ({ from: from || null, to: to!, at: Number(at), detail: JSON.parse(detail!) }))
}

export const eventTypes = (ctx: Ctx, id: string) => msgEvents(ctx, id).map((e) => e.to)

/** Textos entregues com sucesso ao transporte, em ordem. */
export const sentTexts = (t: QT) => (t.sent as any[]).map((s) => s.content?.text)
