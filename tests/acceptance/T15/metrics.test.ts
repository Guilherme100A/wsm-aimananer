// AC-T15-01 — GET /metrics (Prometheus) com as séries da SPEC, alimentadas pelos eventos da fila e do SessionManager.
import { describe, expect, it } from 'vitest'
import * as core from '@wsm/core'
import { importFrom } from '../helpers/app'
import {
  connectedSession,
  enqueue,
  metricType,
  pauseSession,
  resumeSession,
  sample,
  samples,
  scrape,
  scrapeText,
  useObservability,
  waitMsgStatus,
} from './shared'

const STATES = ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED']

describe('T15 — métricas Prometheus', () => {
  const ctx = useObservability()

  it('AC-T15-01 GET /metrics responde sem autenticação, em formato Prometheus, com todas as séries da SPEC', async () => {
    const { id } = await connectedSession(ctx as any)
    const m = await enqueue(ctx as any, id)
    await waitMsgStatus(ctx as any, m.id, 'sent')

    const res = await scrape(ctx)
    expect(res.status, res.text.slice(0, 300)).toBe(200)
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/plain|application\/openmetrics-text/)
    const text = res.text
    expect(metricType(text, 'wsm_messages_sent_total') ?? metricType(text, 'wsm_messages_sent')).toBe('counter')
    expect(metricType(text, 'wsm_messages_failed_total') ?? metricType(text, 'wsm_messages_failed')).toBe('counter')
    expect(metricType(text, 'wsm_disconnects_total') ?? metricType(text, 'wsm_disconnects')).toBe('counter')
    expect(metricType(text, 'wsm_queue_depth')).toBe('gauge')
    expect(metricType(text, 'wsm_send_latency_seconds')).toBe('histogram')
    expect(metricType(text, 'wsm_session_state')).toBe('gauge')
    for (const name of ['wsm_messages_sent_total', 'wsm_queue_depth', 'wsm_session_state'])
      expect(samples(text, name, { session: id }).length, `${name}{session="${id}"}`).toBeGreaterThan(0)
  })

  it('AC-T15-01 /metrics fica fora do auth: token inválido não bloqueia; /api continua exigindo token', async () => {
    const { call } = await import('../helpers/app')
    const res = await call(ctx.app, 'GET', '/metrics', { token: 'token-errado' })
    expect(res.status).toBe(200)
    const api = await call(ctx.app, 'GET', '/api/sessions')
    expect(api.status).toBe(401)
  })

  it('AC-T15-01 wsm_messages_sent_total{session} e wsm_send_latency_seconds contam os envios', async () => {
    const { id } = await connectedSession(ctx as any)
    const before = await scrapeText(ctx)
    const countBefore = sample(before, 'wsm_send_latency_seconds_count') ?? 0
    const m1 = await enqueue(ctx as any, id)
    const m2 = await enqueue(ctx as any, id)
    await waitMsgStatus(ctx as any, m1.id, 'sent')
    await waitMsgStatus(ctx as any, m2.id, 'sent')

    await expect.poll(async () => sample(await scrapeText(ctx), 'wsm_messages_sent_total', { session: id }), { timeout: 5_000 }).toBe(2)
    const text = await scrapeText(ctx)
    expect(sample(text, 'wsm_send_latency_seconds_count')).toBeGreaterThanOrEqual(countBefore + 2)
    expect(sample(text, 'wsm_send_latency_seconds_sum')).toBeGreaterThanOrEqual(0)
    const inf = samples(text, 'wsm_send_latency_seconds_bucket').find((s) => s.labels.le === '+Inf')
    expect(inf?.value).toBe(sample(text, 'wsm_send_latency_seconds_count'))
    expect(samples(text, 'wsm_send_latency_seconds_bucket').length).toBeGreaterThan(1)
  })

  it('AC-T15-01 wsm_messages_failed_total{session} conta mensagens que esgotaram as tentativas', async () => {
    const { id, t } = await connectedSession(ctx as any)
    for (let i = 0; i < 3; i++) t.failNextSend(new Error(`falha ${i}`))
    const m = await enqueue(ctx as any, id)
    await waitMsgStatus(ctx as any, m.id, 'failed')
    await expect.poll(async () => sample(await scrapeText(ctx), 'wsm_messages_failed_total', { session: id }), { timeout: 5_000 }).toBe(1)
    expect(sample(await scrapeText(ctx), 'wsm_messages_sent_total', { session: id }) ?? 0).toBe(0)
  })

  it('AC-T15-01 wsm_queue_depth{session} reflete as mensagens na fila', async () => {
    const { id } = await connectedSession(ctx as any)
    await pauseSession(ctx as any, id)
    const msgs = [await enqueue(ctx as any, id), await enqueue(ctx as any, id), await enqueue(ctx as any, id)]
    await expect.poll(async () => sample(await scrapeText(ctx), 'wsm_queue_depth', { session: id }), { timeout: 5_000 }).toBe(3)
    await resumeSession(ctx as any, id)
    for (const m of msgs) await waitMsgStatus(ctx as any, m.id, 'sent')
    await expect.poll(async () => sample(await scrapeText(ctx), 'wsm_queue_depth', { session: id }), { timeout: 5_000 }).toBe(0)
  })

  it('AC-T15-01 wsm_session_state{session,state} marca 1 no estado atual e 0 nos demais', async () => {
    const { id } = await connectedSession(ctx as any)
    const stateOf = (text: string) => Object.fromEntries(samples(text, 'wsm_session_state', { session: id }).map((s) => [s.labels.state, s.value]))

    await expect.poll(async () => stateOf(await scrapeText(ctx)).WARMING, { timeout: 5_000 }).toBe(1)
    let st = stateOf(await scrapeText(ctx))
    expect(Object.keys(st).sort()).toEqual([...STATES].sort())
    for (const s of STATES) if (s !== 'WARMING') expect(st[s], s).toBe(0)

    await pauseSession(ctx as any, id)
    await expect.poll(async () => stateOf(await scrapeText(ctx)).PAUSED, { timeout: 5_000 }).toBe(1)
    st = stateOf(await scrapeText(ctx))
    for (const s of STATES) if (s !== 'PAUSED') expect(st[s], s).toBe(0)
  })

  it('AC-T15-01 wsm_disconnects_total{session} conta quedas reais da conexão', async () => {
    const { id, t } = await connectedSession(ctx as any)
    expect(sample(await scrapeText(ctx), 'wsm_disconnects_total', { session: id }) ?? 0).toBe(0)
    await t.close('forbidden', 403)
    await expect.poll(async () => sample(await scrapeText(ctx), 'wsm_disconnects_total', { session: id }), { timeout: 5_000 }).toBe(1)
  })

  it('AC-T15-01 cada createMetrics() tem registry próprio (isolável) e não usa o registry global do prom-client', async () => {
    const createMetrics = (core as any).createMetrics
    const a = createMetrics()
    const b = createMetrics() // não pode lançar "already registered"
    expect(a.registry).not.toBe(b.registry)
    const promClient = await importFrom<any>('packages/core', 'prom-client')
    const globalRegistry = promClient.register ?? promClient.default?.register
    expect(globalRegistry.getSingleMetric('wsm_messages_sent_total')).toBeUndefined()
    expect(a.registry).not.toBe(globalRegistry)

    a.messagesSent.inc({ session: 'isolada' })
    expect(sample(await a.render(), 'wsm_messages_sent_total', { session: 'isolada' })).toBe(1)
    expect(sample(await b.render(), 'wsm_messages_sent_total', { session: 'isolada' })).toBeUndefined()
  })
})
