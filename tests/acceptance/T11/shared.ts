// Setup comum do T11: banco descartável migrado + createApp (CRUD /api/webhooks) + AlertService do worker,
// com mocks locais (HTTP para webhook/Discord/Telegram e SMTP mínimo), relógio e backoff injetados.
// Contrato combinado com o Operário (T11):
//   @wsm/core:   ALERT_EVENTS · signWebhookBody(body, secret) (alias signPayload) → HMAC-SHA256 hex
//   @wsm/worker: new AlertService({ db, logger, now, dedupMs?, maxAttempts? (3 no total), backoff, sleep, timeoutMs? })
//                  .notify({type, sessionId, at?, detail?}) → { deduped, deliveries:[{webhookId, ok, attempts, error?}] } (nunca lança)
//                  .attachHealthMonitor(m) · .attachProxyChecker(c) · .onProxyUnavailable(evt) · .whenIdle() · .stop()
//                  evento 'delivery_failed' { webhookId, channel, event, sessionId, attempts, error }
//   canais: http POST url {event, sessionId, at, detail} + x-wsm-signature · discord POST url {content}
//           telegram POST {url}/bot{secret}/sendMessage {chat_id, text} · email smtp url, config.to, subject '[WSM] <event>'
import '../T05/env'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import * as core from '@wsm/core'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { startHttpMock, startSmtpMock, type HttpMock, type SmtpMock } from '../helpers/mocks'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
export const MIN = 60_000

export const coreApi = core as Record<string, any>
export const workerApi = worker as Record<string, any>

export const ALERTABLE = ['forbidden_403', 'disconnected', 'error_burst', 'proxy_unavailable', 'warmup_paused', 'health_degraded'] as const

export function sign(body: string, secret: string): string {
  const fn = coreApi.signWebhookBody ?? coreApi.signPayload
  if (typeof fn !== 'function') throw new Error('@wsm/core não exporta signWebhookBody')
  return fn(body, secret)
}

export interface ACtx {
  tempDb: TempDb
  db: any
  redis: any
  logger: any
  logs: string[]
  token: string
  app: any
  http: HttpMock
  smtp: SmtpMock
  offset: number
  now(): Date
  advance(ms: number): void
  /** delays pedidos ao sleep injetado (backoff) */
  sleeps: number[]
  failed: any[]
  services: any[]
  /** AlertService com relógio/sleep/logger do contexto (opções extras sobrescrevem). */
  service(extra?: Record<string, unknown>): any
}

export function useAlerts(): ACtx {
  const ctx = { offset: 0, sleeps: [] as number[], failed: [] as any[], services: [] as any[] } as ACtx
  ctx.now = () => new Date(Date.now() + ctx.offset)
  ctx.advance = (ms) => {
    ctx.offset += ms
  }
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t11')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    const cap = await captureLogger()
    ctx.logger = cap.logger
    ctx.logs = cap.lines
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.app = await (createApp as any)({ db: ctx.db, redis: ctx.redis, logger: ctx.logger, apiToken: ctx.token })
    ctx.http = await startHttpMock()
    ctx.smtp = await startSmtpMock()
    ctx.service = (extra = {}) => {
      const AlertService = workerApi.AlertService
      if (typeof AlertService !== 'function') throw new Error('@wsm/worker não exporta AlertService')
      const s = new AlertService({
        db: ctx.db,
        logger: ctx.logger,
        now: ctx.now,
        backoff: (attempt: number) => 10 * 2 ** (attempt - 1),
        sleep: async (ms: number) => {
          ctx.sleeps.push(ms)
        },
        timeoutMs: 3_000,
        ...extra,
      })
      s.on?.('delivery_failed', (e: any) => ctx.failed.push(e))
      ctx.services.push(s)
      return s
    }
  })
  afterAll(async () => {
    for (const s of ctx.services) {
      try {
        await s.stop?.()
      } catch {
        /* ignora */
      }
    }
    await ctx.http?.close()
    await ctx.smtp?.close()
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

export const api = (ctx: ACtx, method: string, path: string, body?: unknown) => call(ctx.app, method, path, { token: ctx.token, body })

/** Cria um webhook pela API (falha o teste se não for 201). */
export async function createWebhook(ctx: ACtx, body: Record<string, unknown>) {
  const res = await api(ctx, 'POST', '/api/webhooks', { name: `wh-${randomBytes(3).toString('hex')}`, ...body })
  expect(res.status, `POST /api/webhooks → ${res.text}`).toBe(201)
  expect(res.body?.id, res.text).toBeTruthy()
  return res.body as Record<string, any>
}

/** Desliga todos os webhooks existentes (isola cada teste). */
export function disableAllWebhooks(ctx: ACtx) {
  sqlOk(ctx.tempDb.url, `UPDATE webhooks SET enabled = false;`)
}

/** Webhook HTTP genérico apontando para o mock, num caminho exclusivo. */
export async function httpWebhook(ctx: ACtx, extra: Record<string, unknown> = {}) {
  const path = `/hook/${randomBytes(4).toString('hex')}`
  const secret = `whsec_${randomBytes(12).toString('hex')}`
  const wh = await createWebhook(ctx, { channel: 'http', url: `${ctx.http.url}${path}`, secret, ...extra })
  return { wh, path, secret, received: () => ctx.http.on(path) }
}

export const sessionId = () => randomUUID()

export const webhookRow = (ctx: ACtx, id: string): string => sqlOk(ctx.tempDb.url, `SELECT row_to_json(w)::text FROM webhooks w WHERE id = ${lit(id)};`)[0]?.[0] ?? ''

export const listOf = (body: any): any[] => (Array.isArray(body) ? body : (body?.items ?? []))
