// Setup comum do T10: banco descartável migrado + Redis + HealthMonitor e SessionManager (@wsm/worker)
// com FakeTransport, e createApp({..., sessions, health}) no mesmo processo. Relógio injetável.
// Contrato combinado com o Operário (T10):
//   @wsm/core:   computeHealthScore(input) → {score,label} · healthLabel(score) · DEFAULT_WARMUP_SCHEDULE
//                computeWarmup({startedAt, now, schedule?}) → {percent, day, dailyLimit, complete}
//   @wsm/worker: new HealthMonitor({db, logger, now, schedule?, windowMs?, queueControl?})
//                  .onConnected/.onDisconnected/.resumeState (hooks do SessionManager) · .attach(manager)
//                  .evaluate(id) · .getHealth(id) · .stop() · evento 'alert' {type, sessionId, at, detail?}
//   contadores na janela (now-windowMs, now] por created_at: messages outbound sent|delivered|read → sent,
//   outbound failed → failed, inbound → received; health_events disconnected / forbidden_403.
import '../T05/env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import * as core from '@wsm/core'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'
import { createTransportFactory, type TransportFactory } from '../T05/shared'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const WINDOW_MS = DAY

export const coreApi = core as Record<string, any>
export const workerApi = worker as Record<string, any>

export interface Alert {
  type: string
  sessionId: string
  at: unknown
  detail?: any
}

export interface HCtx {
  tempDb: TempDb
  db: any
  redis: any
  logger: any
  token: string
  app: any
  manager: any
  monitor: any
  tf: TransportFactory
  /** deslocamento (ms) do relógio injetado em relação ao relógio real */
  offset: number
  now(): Date
  advance(ms: number): void
  alerts: Alert[]
  /** sessionIds recebidos por queueControl.pause */
  queuePaused: string[]
}

export function useHealth(): HCtx {
  const ctx = { offset: 0, alerts: [] as Alert[], queuePaused: [] as string[] } as HCtx
  ctx.now = () => new Date(Date.now() + ctx.offset)
  ctx.advance = (ms: number) => {
    ctx.offset += ms
  }
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t10')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.logger = (await captureLogger()).logger
    ctx.token = `tok_${randomBytes(16).toString('hex')}`

    const { HealthMonitor, SessionManager } = workerApi
    if (typeof HealthMonitor !== 'function') throw new Error('@wsm/worker não exporta HealthMonitor')
    if (typeof SessionManager !== 'function') throw new Error('@wsm/worker não exporta SessionManager')
    ctx.monitor = new HealthMonitor({
      db: ctx.db,
      logger: ctx.logger,
      now: ctx.now,
      windowMs: WINDOW_MS,
      queueControl: {
        pause: (sessionId: string) => {
          ctx.queuePaused.push(sessionId)
        },
      },
    })
    ctx.monitor.on('alert', (a: Alert) => ctx.alerts.push(a))
    ctx.tf = createTransportFactory()
    ctx.manager = new SessionManager({
      db: ctx.db,
      logger: ctx.logger,
      transportFactory: ctx.tf.factory,
      sleep: async () => {},
      now: ctx.now,
      onConnected: ctx.monitor.onConnected,
      onDisconnected: ctx.monitor.onDisconnected,
      resumeState: ctx.monitor.resumeState,
      pairingTimeoutMs: 5_000,
    })
    ctx.monitor.attach(ctx.manager)
    ctx.app = await (createApp as any)({
      db: ctx.db,
      redis: ctx.redis,
      logger: ctx.logger,
      apiToken: ctx.token,
      sessions: ctx.manager,
      health: ctx.monitor,
    })
    await ctx.manager.start()
  })
  afterAll(async () => {
    try {
      await ctx.monitor?.stop?.()
    } catch {
      /* ignora */
    }
    try {
      await ctx.manager?.stop()
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

export const api = (ctx: HCtx, method: string, path: string, body?: unknown) => call(ctx.app, method, path, { token: ctx.token, body })

export async function createSession(ctx: HCtx) {
  const res = await api(ctx, 'POST', '/api/sessions', { name: `sessao-${randomBytes(3).toString('hex')}`, phone: randomPhone() })
  expect(res.status, `POST /api/sessions → ${res.text}`).toBe(201)
  return res.body as Record<string, any>
}

/** Cria a sessão, inicia a conexão (QR) e simula o login: estado WARMING, warm-up iniciado em now(). */
export async function connectedSession(ctx: HCtx) {
  const s = await createSession(ctx)
  const qr = await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
  expect(qr.status, `POST /qr → ${qr.text}`).toBe(202)
  await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
  const t = ctx.tf.last(s.id)!
  await t.login()
  await waitStatus(ctx, s.id, 'WARMING')
  await ctx.manager.whenIdle?.()
  return { id: s.id as string, transport: t }
}

// ---- banco -------------------------------------------------------------------------

export const statusOf = (ctx: HCtx, id: string) => sqlOk(ctx.tempDb.url, `SELECT status FROM sessions WHERE id = ${lit(id)};`)[0]?.[0]

export async function waitStatus(ctx: HCtx, id: string, status: string, timeout = 5_000) {
  await expect.poll(() => statusOf(ctx, id), { timeout, message: `sessão ${id} deveria chegar a ${status}` }).toBe(status)
}

export const healthTypes = (ctx: HCtx, id: string) =>
  sqlOk(ctx.tempDb.url, `SELECT type FROM health_events WHERE session_id = ${lit(id)} ORDER BY id;`).map((r) => r[0]!)

/** Instante (ISO) `agoMs` antes do relógio injetado. */
export const at = (ctx: HCtx, agoMs = 60_000) => new Date(ctx.now().getTime() - agoMs).toISOString()

/** Insere `n` mensagens com o status/direção dados e created_at = `ts`. */
export function insertMessages(ctx: HCtx, id: string, n: number, status: string, direction: 'outbound' | 'inbound' = 'outbound', ts = at(ctx)) {
  if (n <= 0) return
  sqlOk(
    ctx.tempDb.url,
    `INSERT INTO messages (session_id, direction, phone, content, status, created_at)
       SELECT ${lit(id)}, ${lit(direction)}::message_direction, '+5599900000001', '{"text":"t"}'::jsonb, ${lit(status)}::message_status, ${lit(ts)}::timestamptz
         FROM generate_series(1, ${n});`,
  )
}

export function insertHealthEvents(ctx: HCtx, id: string, type: string, n = 1, ts = at(ctx)) {
  if (n <= 0) return
  sqlOk(
    ctx.tempDb.url,
    `INSERT INTO health_events (session_id, type, detail, created_at)
       SELECT ${lit(id)}, ${lit(type)}, '{}'::jsonb, ${lit(ts)}::timestamptz FROM generate_series(1, ${n});`,
  )
}

// ---- score ---------------------------------------------------------------------------

export interface ScoreInput {
  sent: number
  received: number
  failed: number
  disconnects: number
  forbidden403: number
  errorTrend?: number
}

export function score(input: ScoreInput): { score: number; label: string } {
  const fn = coreApi.computeHealthScore
  if (typeof fn !== 'function') throw new Error('@wsm/core não exporta computeHealthScore')
  return fn(input)
}

/**
 * Menor número de falhas (com `sent` envios e `sent` respostas, todas recentes) cujo score cai em
 * [min, max]. Usa a própria função pura do contrato, sem depender dos pesos internos.
 */
export function failuresFor(sent: number, min: number, max: number): number {
  for (let f = 1; f <= 500; f++) {
    const s = score({ sent, received: sent, failed: f, disconnects: 0, forbidden403: 0, errorTrend: f }).score
    if (s >= min && s <= max) return f
  }
  throw new Error(`nenhum número de falhas leva o score a [${min}, ${max}] (sent=${sent})`)
}
