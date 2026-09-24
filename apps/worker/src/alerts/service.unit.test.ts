// AlertService com Postgres local (banco descartável): HealthMonitor (T10) e ProxyChecker (T06) como fontes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AlertDispatcher, createProxyChecker, generateCredentialsKey, ProxyService, resetCredentialsCrypto, WebhookService } from '@wsm/core'
import { createDb, createTempDatabase, proxies, sessions, webhooks, type Database, type TempDatabase } from '@wsm/db'
import { HealthMonitor } from '../health'
import { AlertService, attachAlerts } from './service'

let tmp: TempDatabase
let db: Database
let http: Server
let base: string
let received: Array<{ event: string; sessionId: string | null; detail: Record<string, unknown> }>
let failNext = 0
const prevKey = process.env.CREDENTIALS_KEY
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_alerts' })
  db = createDb(tmp.url, { max: 4 })
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (failNext > 0) {
        failNext--
        res.writeHead(503).end()
        return
      }
      received.push(JSON.parse(body))
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterAll(async () => {
  http?.close()
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

let clock: Date
beforeEach(async () => {
  await db.delete(webhooks)
  await db.delete(sessions)
  await db.delete(proxies)
  received = []
  failNext = 0
  clock = new Date()
  await new WebhookService(db).create({ name: 'h', channel: 'http', url: `${base}/hook`, secret: 's' })
})

const service = () => new AlertService({ db, logger: quiet, now: () => clock, sleep: async () => {} })

describe('AlertService (T11)', () => {
  it('consome alert do HealthMonitor e entrega; stop() remove a assinatura', async () => {
    const alerts = service()
    const monitor = new HealthMonitor({ db, logger: quiet, intervalMs: 0 })
    alerts.attachHealthMonitor(monitor)
    monitor.emit('alert', { type: 'forbidden_403', sessionId: 's1', at: clock, detail: { source: 'health' } })
    await alerts.whenIdle()
    expect(received).toEqual([{ event: 'forbidden_403', sessionId: 's1', at: clock.toISOString(), detail: { source: 'health' } }])
    alerts.stop()
    monitor.emit('alert', { type: 'health_degraded', sessionId: 's1', at: clock })
    await alerts.whenIdle()
    expect(received).toHaveLength(1)
  })

  it('proxy_unavailable: um alerta por sessão vinculada; sem sessão → sessionId null', async () => {
    const proxy = await new ProxyService(db).create({ url: 'http://127.0.0.1:1' })
    const orphan = await new ProxyService(db).create({ url: 'http://127.0.0.1:2' })
    const [s] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', proxyId: proxy.id }).returning()
    const alerts = service()
    const checker = createProxyChecker({ db, probe: async () => ({ ok: false, error: 'refused' }) })
    alerts.attachProxyChecker(checker)
    checker.emit('proxy_unavailable', { proxyId: proxy.id, error: 'refused', errorCount: 1, checkedAt: clock })
    await alerts.whenIdle()
    await alerts.onProxyUnavailable({ proxyId: orphan.id, error: 'timeout', errorCount: 2, checkedAt: clock })
    expect(received).toEqual([
      { event: 'proxy_unavailable', sessionId: s!.id, at: clock.toISOString(), detail: { proxyId: proxy.id, error: 'refused', errorCount: 1 } },
      { event: 'proxy_unavailable', sessionId: null, at: clock.toISOString(), detail: { proxyId: orphan.id, error: 'timeout', errorCount: 2 } },
    ])
    checker.stop()
  })

  it('dedup pelo relógio injetado e delivery_failed sem derrubar o processo', async () => {
    const alerts = service()
    const failures: unknown[] = []
    alerts.on('delivery_failed', (f) => failures.push(f))
    failNext = 3
    const r1 = await alerts.notify({ type: 'error_burst', sessionId: 'x' })
    expect(r1.deliveries[0]).toMatchObject({ ok: false, attempts: 3 })
    expect(failures).toHaveLength(1)
    expect((await alerts.notify({ type: 'error_burst', sessionId: 'x' })).deduped).toBe(true)
    clock = new Date(clock.getTime() + 10 * 60_000)
    expect((await alerts.notify({ type: 'error_burst', sessionId: 'x' })).deliveries[0]).toMatchObject({ ok: true })
  })

  it('notify nunca lança, mesmo com o banco fora', async () => {
    const broken = new AlertService({ db: { select: () => { throw new Error('db down') } } as unknown as Database, logger: quiet })
    await expect(broken.notify({ type: 'disconnected', sessionId: 'z' })).resolves.toEqual({ deduped: false, deliveries: [] })
    await expect(broken.onProxyUnavailable({ proxyId: 'p', error: 'e', errorCount: 1, checkedAt: new Date() })).resolves.toHaveLength(1)
  })

  it('attachAlerts liga as fontes a um dispatcher e expõe idle/stop', async () => {
    const dispatcher = new AlertDispatcher({ db, logger: quiet, now: () => clock })
    const monitor = new HealthMonitor({ db, logger: quiet, intervalMs: 0 })
    const handle = attachAlerts({ dispatcher, healthMonitor: monitor })
    monitor.emit('alert', { type: 'warmup_paused', sessionId: 'w', at: clock })
    await handle.idle()
    expect(received.map((r) => r.event)).toEqual(['warmup_paused'])
    handle.stop()
  })
})
