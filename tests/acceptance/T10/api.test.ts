// AC-T10-04: GET /api/sessions/:id/health.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { api, at, connectedSession, coreApi, createSession, insertHealthEvents, insertMessages, useHealth } from './shared'

const FIELDS = ['state', 'warmupPercent', 'score', 'label', 'sent', 'received', 'failed', 'disconnects', 'forbidden403', 'lastEventAt']

describe('T10 — GET /api/sessions/:id/health', () => {
  const ctx = useHealth()

  it('AC-T10-04 devolve { state, warmupPercent, score, label, sent, received, failed, disconnects, forbidden403, lastEventAt }', async () => {
    const { id } = await connectedSession(ctx)
    insertMessages(ctx, id, 2, 'sent')
    insertMessages(ctx, id, 1, 'delivered')
    insertMessages(ctx, id, 1, 'read')
    insertMessages(ctx, id, 1, 'failed')
    insertMessages(ctx, id, 3, 'queued') // ainda não enviadas: não contam
    insertMessages(ctx, id, 2, 'read', 'inbound')
    insertHealthEvents(ctx, id, 'disconnected', 2)

    const res = await api(ctx, 'GET', `/api/sessions/${id}/health`)
    expect(res.status, res.text).toBe(200)
    for (const f of FIELDS) expect(res.body, `campo ${f} ausente: ${res.text}`).toHaveProperty(f)
    expect(res.body).toMatchObject({ state: 'WARMING', sent: 4, received: 2, failed: 1, disconnects: 2, forbidden403: 0 })
    expect(Number.isInteger(res.body.score)).toBe(true)
    expect(res.body.score).toBeGreaterThanOrEqual(0)
    expect(res.body.score).toBeLessThanOrEqual(100)
    expect(res.body.label).toBe(coreApi.healthLabel(res.body.score))
    expect(typeof res.body.warmupPercent).toBe('number')
    expect(res.body.warmupPercent).toBeGreaterThanOrEqual(0)
    expect(res.body.warmupPercent).toBeLessThan(100)
    expect(typeof res.body.lastEventAt, 'lastEventAt deve ser ISO').toBe('string')
    expect(Number.isNaN(Date.parse(res.body.lastEventAt))).toBe(false)
  })

  it('AC-T10-04 conta eventos 403 e ignora sinais fora da janela', async () => {
    const { id } = await connectedSession(ctx)
    insertHealthEvents(ctx, id, 'forbidden_403', 1)
    insertMessages(ctx, id, 5, 'failed', 'outbound', at(ctx, 3 * 24 * 3_600_000)) // 3 dias atrás
    insertHealthEvents(ctx, id, 'disconnected', 4, at(ctx, 3 * 24 * 3_600_000))
    const res = await api(ctx, 'GET', `/api/sessions/${id}/health`)
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ forbidden403: 1, failed: 0, disconnects: 0 })
  })

  it('AC-T10-04 sessão NEW sem atividade: zeros, warm-up 0% e lastEventAt nulo', async () => {
    const s = await createSession(ctx)
    const res = await api(ctx, 'GET', `/api/sessions/${s.id}/health`)
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ state: 'NEW', warmupPercent: 0, sent: 0, received: 0, failed: 0, disconnects: 0, forbidden403: 0, lastEventAt: null, score: 100, label: 'Good' })
  })

  it('AC-T10-04 sessão inexistente → 404 SESSION_NOT_FOUND; sem token → 401', async () => {
    expectApiError(await api(ctx, 'GET', `/api/sessions/${randomUUID()}/health`), 'SESSION_NOT_FOUND', 404)
    expectApiError(await api(ctx, 'GET', `/api/sessions/nao-e-uuid/health`), 'SESSION_NOT_FOUND', 404)
    const s = await createSession(ctx)
    expectApiError(await call(ctx.app, 'GET', `/api/sessions/${s.id}/health`), 'UNAUTHORIZED', 401)
  })
})
