// Setup comum do T05: banco descartável migrado + Redis + SessionManager (@wsm/worker) com
// FakeTransport injetado via transportFactory, e createApp({..., sessions: manager}) no mesmo processo.
// Contrato combinado com o Operário:
//   new SessionManager({ db, logger, transportFactory(sessionId), sleep(ms), backoff?(attempt), onConnected(sessionId) })
//   start(): reconecta sessões no boot · stop(): fecha transports sem mudar status (simula restart do worker)
import './env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import { FakeTransport } from '@wsm/core'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

/**
 * FakeTransport que imita o Baileys nos pontos que o SessionManager observa:
 * - com `pairingPhone`, emite o código de pareamento logo após o connect;
 * - `login()` dispara `saveCreds` (evento creds.update do Baileys) e abre a conexão.
 */
export class TestTransport extends (FakeTransport as any) {
  pairingCode = `PAIR${randomBytes(2).toString('hex').toUpperCase()}`
  logoutCalls = 0

  async connect(opts: any): Promise<void> {
    await super.connect(opts)
    if (opts?.pairingPhone) setTimeout(() => this.emitPairingCode(this.pairingCode), 20)
  }

  async login(): Promise<void> {
    await this.lastConnect?.saveCreds?.()
    this.open()
  }

  async logout(): Promise<void> {
    this.logoutCalls++
    await super.logout()
  }
}

export type TT = TestTransport & Record<string, any>

/** Factory de transporte que registra cada transport criado, por sessão. */
export function createTransportFactory() {
  const bySession = new Map<string, TT[]>()
  const calls: string[] = []
  const factory = (arg: any) => {
    const sessionId = typeof arg === 'string' ? arg : String(arg?.sessionId)
    calls.push(sessionId)
    const t = new TestTransport() as TT
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), t])
    return t
  }
  return {
    factory,
    calls,
    transports: (id: string) => bySession.get(id) ?? [],
    last: (id: string) => bySession.get(id)?.at(-1),
    /** Total de chamadas a connect (de todos os transports) para a sessão. */
    connectCount: (id: string) => (bySession.get(id) ?? []).reduce((n, t) => n + t.connectCalls.filter((c: any) => c.sessionId === id).length, 0),
  }
}

export type TransportFactory = ReturnType<typeof createTransportFactory>

export interface Ctx {
  tempDb: TempDb
  db: any
  redis: any
  logger: any
  token: string
  app: any
  manager: any
  tf: TransportFactory
  /** delays (ms) pedidos ao sleep injetado, em ordem */
  sleeps: number[]
  /** sessionIds recebidos pelo hook onConnected (monitoramento) */
  connected: string[]
  /** Para o SessionManager atual (idempotente; não muda status no banco). */
  stop(): Promise<void>
  /** Recria o SessionManager (e o app) com o mesmo banco: simula restart do worker. */
  restart(): Promise<void>
}

async function buildManager(ctx: Ctx) {
  const SessionManager = (worker as any).SessionManager
  if (typeof SessionManager !== 'function') throw new Error('@wsm/worker não exporta SessionManager')
  ctx.tf = createTransportFactory()
  ctx.manager = new SessionManager({
    db: ctx.db,
    logger: ctx.logger,
    transportFactory: ctx.tf.factory,
    sleep: async (ms: number) => {
      ctx.sleeps.push(ms)
    },
    onConnected: (sessionId: string) => {
      ctx.connected.push(sessionId)
    },
    pairingTimeoutMs: 5_000,
  })
  ctx.app = await (createApp as any)({ db: ctx.db, redis: ctx.redis, logger: ctx.logger, apiToken: ctx.token, sessions: ctx.manager })
  await ctx.manager.start()
}

export function useSessions(): Ctx {
  const ctx = { sleeps: [] as number[], connected: [] as string[] } as Ctx
  let stopped = false
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t05')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.logger = (await captureLogger()).logger
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.stop = async () => {
      if (stopped) return
      stopped = true
      await ctx.manager?.stop()
    }
    ctx.restart = async () => {
      await ctx.stop()
      await buildManager(ctx)
      stopped = false
    }
    await buildManager(ctx)
  })
  afterAll(async () => {
    try {
      await ctx.stop?.()
    } catch {
      /* ignora */
    }
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

// ---- helpers de API ---------------------------------------------------------

export const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

export const api = (ctx: Ctx, method: string, path: string, body?: unknown) => call(ctx.app, method, path, { token: ctx.token, body })

/** Cria a sessão pela API (falha o teste se não for 201). */
export async function createSession(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const body = { name: `sessao-${randomBytes(3).toString('hex')}`, phone: randomPhone(), ...extra }
  const res = await api(ctx, 'POST', '/api/sessions', body)
  expect(res.status, `POST /api/sessions → ${res.text}`).toBe(201)
  expect(res.body?.id, res.text).toBeTruthy()
  return res.body as Record<string, any>
}

/** Cria a sessão, inicia a conexão por QR e simula o login (open). Devolve { id, transport }. */
export async function connectedSession(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const s = await createSession(ctx, extra)
  const qr = await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
  expect(qr.status, `POST /qr → ${qr.text}`).toBe(202)
  await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
  const t = ctx.tf.last(s.id)!
  await t.login()
  await waitStatus(ctx, s.id, 'WARMING')
  return { id: s.id as string, session: s, transport: t }
}

// ---- leitura crua do banco -------------------------------------------------

export function sessionRow(ctx: Ctx, id: string): Record<string, any> | undefined {
  const r = sqlOk(ctx.tempDb.url, `SELECT row_to_json(t) FROM sessions t WHERE id = ${lit(id)};`)[0]
  return r ? JSON.parse(r[0]!) : undefined
}

export const statusOf = (ctx: Ctx, id: string) => sessionRow(ctx, id)?.status

export async function waitStatus(ctx: Ctx, id: string, status: string, timeout = 5_000) {
  await expect.poll(() => statusOf(ctx, id), { timeout, message: `sessão ${id} deveria chegar a ${status}` }).toBe(status)
}

export function healthEvents(ctx: Ctx, id: string): Array<{ type: string; detail: any }> {
  return sqlOk(ctx.tempDb.url, `SELECT type, coalesce(detail::text, 'null') FROM health_events WHERE session_id = ${lit(id)} ORDER BY id;`).map(([type, detail]) => ({
    type: type!,
    detail: JSON.parse(detail!),
  }))
}

export const healthTypes = (ctx: Ctx, id: string) => healthEvents(ctx, id).map((e) => e.type)

export const credentialCount = (ctx: Ctx, id: string) =>
  Number(sqlOk(ctx.tempDb.url, `SELECT count(*) FROM session_credentials WHERE session_id = ${lit(id)};`)[0]![0])

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Lista de sessões aceitando { items } ou array. */
export const listOf = (body: any): any[] => (Array.isArray(body) ? body : (body?.items ?? []))

/** Payload da API não pode expor credenciais nem campos cifrados (AC-T05-07). */
export function expectNoCredentials(payload: unknown) {
  const text = JSON.stringify(payload)
  const lower = text.toLowerCase()
  for (const needle of ['noisekey', 'signedidentitykey', 'signedprekey', 'advsecretkey', 'privkey', 'private', 'ciphertext', 'authtag', 'auth_tag', 'keyversion', 'key_version', '"iv"', '"creds"', '"credentials"', '"keys"'])
    expect(lower, `resposta expõe "${needle}": ${text.slice(0, 400)}`).not.toContain(needle)
}
