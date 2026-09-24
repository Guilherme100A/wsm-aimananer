// AC-T11-01: eventos alertáveis forbidden_403, disconnected, error_burst, proxy_unavailable, warmup_paused, health_degraded.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startHttpMock, deadPort, type HttpMock } from '../helpers/mocks'
import { api as healthApi, connectedSession, useHealth } from '../T10/shared'
import { ALERTABLE, coreApi, disableAllWebhooks, httpWebhook, sessionId, useAlerts, workerApi } from './shared'

describe('T11 — eventos alertáveis', () => {
  const ctx = useAlerts()
  beforeEach(() => disableAllWebhooks(ctx))

  it('AC-T11-01 ALERT_EVENTS lista exatamente os 6 eventos alertáveis', () => {
    expect(Array.isArray(coreApi.ALERT_EVENTS), '@wsm/core deve exportar ALERT_EVENTS').toBe(true)
    expect([...coreApi.ALERT_EVENTS].sort()).toEqual([...ALERTABLE].sort())
  })

  it('AC-T11-01 cada evento alertável é entregue ao webhook com event, sessionId, at e detail', async () => {
    const { received } = await httpWebhook(ctx)
    const alerts = ctx.service()
    const sid = sessionId()
    for (const type of ALERTABLE) {
      const r = await alerts.notify({ type, sessionId: sid, detail: { source: 'teste' } })
      expect(r.deduped, type).toBe(false)
      expect(r.deliveries.length, `${type}: uma entrega`).toBe(1)
      expect(r.deliveries[0].ok, `${type}: ${JSON.stringify(r.deliveries[0])}`).toBe(true)
    }
    const got = received()
    expect(got.map((r) => r.json?.event)).toEqual([...ALERTABLE])
    for (const r of got) {
      expect(r.method).toBe('POST')
      expect(r.json.sessionId).toBe(sid)
      expect(Number.isNaN(Date.parse(r.json.at)), `at ISO: ${r.json.at}`).toBe(false)
      expect(r.json.detail).toMatchObject({ source: 'teste' })
    }
  })

  it('AC-T11-01 evento fora da lista não é entregue e notify não lança', async () => {
    const { received } = await httpWebhook(ctx)
    const alerts = ctx.service()
    for (const type of ['session_created', 'message_sent', '', 'FORBIDDEN_403']) {
      const r = await alerts.notify({ type, sessionId: sessionId() })
      expect(r.deliveries, `tipo ${type || '(vazio)'}`).toEqual([])
    }
    expect(received()).toEqual([])
  })

  it('AC-T11-01 webhook com filtro de eventos só recebe os eventos listados; desabilitado não recebe', async () => {
    const only = await httpWebhook(ctx, { events: ['forbidden_403'] })
    const off = await httpWebhook(ctx, { enabled: false })
    const alerts = ctx.service()
    const sid = sessionId()
    await alerts.notify({ type: 'health_degraded', sessionId: sid })
    await alerts.notify({ type: 'forbidden_403', sessionId: sid })
    expect(only.received().map((r) => r.json.event)).toEqual(['forbidden_403'])
    expect(off.received()).toEqual([])
  })
})

describe('T11 — integração com o HealthMonitor (T10) e o verificador de proxies (T06)', () => {
  const ctx = useHealth()
  let mock: HttpMock
  let alerts: any
  let path: string

  beforeAll(async () => {
    mock = await startHttpMock()
    path = `/hook/${randomBytes(4).toString('hex')}`
    const res = await healthApi(ctx, 'POST', '/api/webhooks', { name: 'integracao', channel: 'http', url: `${mock.url}${path}`, secret: 's3cr3t-integracao' })
    expect(res.status, res.text).toBe(201)
    const AlertService = workerApi.AlertService
    alerts = new AlertService({ db: ctx.db, logger: ctx.logger, now: ctx.now, backoff: () => 1, sleep: async () => {}, timeoutMs: 3_000 })
    alerts.attachHealthMonitor(ctx.monitor)
  })
  afterAll(async () => {
    await alerts?.stop?.()
    await mock?.close()
  })

  const events = () => mock.on(path).map((r) => r.json)

  it('AC-T11-01 alerta do HealthMonitor (403 na conexão) vira entrega forbidden_403 com o sessionId', async () => {
    const { id, transport } = await connectedSession(ctx)
    await transport.close('forbidden', 403)
    await expect.poll(() => events().some((e) => e.event === 'forbidden_403' && e.sessionId === id), { timeout: 10_000 }).toBe(true)
  })

  it('AC-T11-01 queda transitória da conexão vira entrega disconnected', async () => {
    const { id, transport } = await connectedSession(ctx)
    await transport.close('transient', 428)
    await expect.poll(() => events().some((e) => e.event === 'disconnected' && e.sessionId === id), { timeout: 10_000 }).toBe(true)
  })

  it('AC-T11-01 proxy indisponível (verificador do T06) vira entrega proxy_unavailable para a sessão vinculada', async () => {
    const port = await deadPort()
    const p = await healthApi(ctx, 'POST', '/api/proxies', { url: `http://127.0.0.1:${port}` })
    expect(p.status, p.text).toBe(201)
    const s = await healthApi(ctx, 'POST', '/api/sessions', { name: 'com-proxy', phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, proxyId: p.body.id })
    expect(s.status, s.text).toBe(201)
    const checker = coreApi.createProxyChecker({ db: ctx.db, probe: async () => Promise.reject(new Error('proxy fora do ar')) })
    alerts.attachProxyChecker(checker)
    await checker.checkAll()
    await expect.poll(() => events().find((e) => e.event === 'proxy_unavailable' && e.sessionId === s.body.id), { timeout: 10_000 }).toBeTruthy()
    const e = events().find((x) => x.event === 'proxy_unavailable' && x.sessionId === s.body.id)
    expect(e.detail?.proxyId).toBe(p.body.id)
  })
})
