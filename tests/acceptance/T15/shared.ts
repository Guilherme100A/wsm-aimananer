// Setup comum do T15: banco descartável + Redis + SessionManager (T05) com FakeTransport + MessageQueue (T08)
// + métricas (createMetrics/attachMetrics) + loggers de produto (createApiLogger/createWorkerLogger) capturados,
// e createApp({..., metrics}) no mesmo processo.
// Contrato combinado com o Operário (Cinzel):
//   @wsm/core:   createMetrics({ registry?, collectDefaultMetrics?, latencyBuckets? }) → { registry, contentType, render() }
//                attachMetrics(metrics, { queue?, sessions?, db? }) → detach() com detach.ready: Promise<void>
//   @wsm/api:    createApp({..., metrics}) · GET /metrics sem auth · createApiLogger({ destination, level })
//   @wsm/worker: createWorkerLogger({ destination, level }) · startObservabilityServer({ port, metrics }) → { url, close() }
import '../T08/env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import * as apiPkg from '@wsm/api'
import * as core from '@wsm/core'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, migrate, type TempDb } from '../helpers/pg'
import { REDIS_URL, createTransportFactory, delay, messageQueueClass } from '../T08/shared'

export * from '../T08/shared'

export interface CapturedLogger {
  logger: any
  lines: string[]
  /** linhas parseadas como JSON (lança se alguma não for JSON) */
  json(): any[]
}

/** Stream que captura cada linha escrita pelo pino. */
export function captureStream() {
  const lines: string[] = []
  const destination = { write: (s: string) => void lines.push(...String(s).split('\n').filter((l) => l.trim())) }
  return { lines, destination }
}

export function capture(factory: (opts: any) => any): CapturedLogger {
  const { lines, destination } = captureStream()
  const logger = factory({ destination, level: 'debug' })
  return { logger, lines, json: () => lines.map((l) => JSON.parse(l)) }
}

export interface Ctx {
  tempDb: TempDb
  db: any
  redis: any
  token: string
  prefix: string
  app: any
  manager: any
  queue: any
  metrics: any
  detachMetrics: any
  apiLog: CapturedLogger
  workerLog: CapturedLogger
  tf: ReturnType<typeof createTransportFactory>
}

/** Logger de produto se exportado; senão um pino capturado (os testes de AC-T15-03 exigem o de produto). */
async function productOrFallback(fn: unknown, workspace: string): Promise<CapturedLogger> {
  if (typeof fn === 'function') return capture(fn as any)
  const { logger, lines } = await captureLogger(workspace)
  return { logger, lines, json: () => lines.map((l) => JSON.parse(l)) }
}

export function useObservability(): Ctx {
  const ctx = {} as Ctx
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t15')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.prefix = `wsmt15${randomBytes(4).toString('hex')}`
    ctx.apiLog = await productOrFallback((apiPkg as any).createApiLogger, 'apps/api')
    ctx.workerLog = await productOrFallback((worker as any).createWorkerLogger, 'apps/worker')

    ctx.tf = createTransportFactory()
    ctx.manager = new (worker as any).SessionManager({
      db: ctx.db,
      logger: ctx.workerLog.logger,
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
      logger: ctx.workerLog.logger,
      backoffDelayMs: 50,
      holdDelayMs: 200,
    })
    await (worker as any).attachQueueToSessions(ctx.manager, ctx.queue)

    const createMetrics = (core as any).createMetrics
    const attachMetrics = (core as any).attachMetrics ?? (worker as any).attachMetrics
    if (typeof createMetrics !== 'function') throw new Error('@wsm/core não exporta createMetrics')
    if (typeof attachMetrics !== 'function') throw new Error('@wsm/core não exporta attachMetrics')
    ctx.metrics = createMetrics()
    ctx.detachMetrics = attachMetrics(ctx.metrics, { queue: ctx.queue, sessions: ctx.manager, db: ctx.db })
    await ctx.detachMetrics?.ready

    ctx.app = await (apiPkg.createApp as any)({
      db: ctx.db,
      redis: ctx.redis,
      logger: ctx.apiLog.logger,
      apiToken: ctx.token,
      sessions: ctx.manager,
      messages: ctx.queue,
      metrics: ctx.metrics,
    })
    await ctx.manager.start()
  })
  afterAll(async () => {
    try {
      if (typeof ctx.detachMetrics === 'function') ctx.detachMetrics()
    } catch {
      /* ignora */
    }
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

// ---- Prometheus ----------------------------------------------------------------------

export interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

/** Parse do formato de exposição texto do Prometheus (linhas de amostra; ignora # HELP/# TYPE). */
export function parseMetrics(text: string): Sample[] {
  const out: Sample[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line)
    if (!m) continue
    const labels: Record<string, string> = {}
    for (const l of (m[2] ?? '').matchAll(/([a-zA-Z_]\w*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!
    const v = m[3]!
    out.push({ name: m[1]!, labels, value: v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : Number(v) })
  }
  return out
}

/** Tipo declarado em `# TYPE name tipo`. */
export function metricType(text: string, name: string): string | undefined {
  return new RegExp(`^# TYPE ${name} (\\w+)`, 'm').exec(text)?.[1]
}

/** Valor da primeira série `name` cujos labels contêm `labels`. */
export function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  return parseMetrics(text).find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value
}

export function samples(text: string, name: string, labels: Record<string, string> = {}): Sample[] {
  return parseMetrics(text).filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
}

/** GET /metrics sem token. */
export async function scrape(ctx: Ctx) {
  return call(ctx.app, 'GET', '/metrics', { headers: { accept: 'text/plain' } })
}

export async function scrapeText(ctx: Ctx): Promise<string> {
  const r = await scrape(ctx)
  if (r.status !== 200) throw new Error(`GET /metrics → ${r.status}: ${r.text.slice(0, 300)}`)
  return r.text
}
