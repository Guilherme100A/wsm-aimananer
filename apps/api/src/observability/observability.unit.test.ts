// /metrics público e logs JSON com session_id (sem banco real: fakes do test-utils).
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createMetrics } from '@wsm/core'
import { createApp } from '../app'
import { fakeDb, fakeRedis } from '../test-utils'
import { createApiLogger } from './logger'
import { sessionIdFromRequest } from './session-context'

const TOKEN = 'obs-token'
const SID = '11111111-2222-4333-8444-555555555555'

function capture() {
  const lines: Record<string, unknown>[] = []
  const raw: string[] = []
  const destination = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) {
        raw.push(l)
        lines.push(JSON.parse(l) as Record<string, unknown>)
      }
      cb()
    },
  })
  return { lines, raw, destination }
}

describe('GET /metrics', () => {
  it('público (sem token), formato Prometheus, com as métricas das deps', async () => {
    const metrics = createMetrics()
    metrics.messagesSent.inc({ session: SID })
    metrics.setSessionState(SID, 'STABLE')
    const app = createApp({ db: fakeDb().db, redis: fakeRedis(), logger: createApiLogger({ destination: capture().destination }), apiToken: TOKEN, metrics })
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/)
    const text = await res.text()
    expect(text).toContain(`wsm_messages_sent_total{session="${SID}"} 1`)
    expect(text).toContain(`wsm_session_state{session="${SID}",state="STABLE"} 1`)
    expect(text).toContain('# TYPE wsm_send_latency_seconds histogram')
  })

  it('sem metrics nas deps responde com registry próprio', async () => {
    const app = createApp({ db: fakeDb().db, redis: fakeRedis(), logger: createApiLogger({ destination: capture().destination }), apiToken: TOKEN })
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('# TYPE wsm_messages_sent_total counter')
  })
})

describe('logs da API', () => {
  it('JSON, service api, session_id nas requisições da sessão (uma vez por linha) e redação', async () => {
    const { lines, raw, destination } = capture()
    const logger = createApiLogger({ destination, level: 'debug' })
    const app = createApp({ db: fakeDb().db, redis: fakeRedis(), logger, apiToken: TOKEN })
    await app.request(`/api/sessions/${SID}/nao-existe`, { headers: { authorization: `Bearer ${TOKEN}` } })
    await app.request('/health')
    logger.info({ session_id: SID, creds: { noiseKey: 'k' }, authorization: 'Bearer x' }, 'manual')

    const completed = lines.filter((l) => l.msg === 'request completed')
    expect(completed[0]).toMatchObject({ service: 'api', session_id: SID, path: `/api/sessions/${SID}/nao-existe` })
    expect(completed[1]).not.toHaveProperty('session_id')
    for (const l of raw) expect((l.match(/"session_id"/g) ?? []).length).toBeLessThanOrEqual(1)
    expect(lines.at(-1)).toMatchObject({ session_id: SID, creds: '[Redacted]', authorization: '[Redacted]' })
  })

  it('extrai session_id do caminho ou de ?sessionId', () => {
    const q = (v?: string) => () => v
    expect(sessionIdFromRequest(`/api/sessions/${SID}`, q())).toBe(SID)
    expect(sessionIdFromRequest(`/api/sessions/${SID.toUpperCase()}/pause`, q())).toBe(SID)
    expect(sessionIdFromRequest('/api/messages', q(SID))).toBe(SID)
    expect(sessionIdFromRequest('/api/messages', q('lixo'))).toBeUndefined()
    expect(sessionIdFromRequest('/api/sessions', q())).toBeUndefined()
  })
})
