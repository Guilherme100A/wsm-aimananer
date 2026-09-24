// POST /api/sessions/:id/messages (T09): validação e mapeamento das rejeições do pipeline (SPEC 3.4).
import { describe, expect, it, vi } from 'vitest'
import { SendRejectedError, type SendRequest } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'

const TOKEN = 't0k'
const SID = '11111111-1111-4111-8111-111111111111'

function setup(send: (req: SendRequest) => Promise<unknown>) {
  const { db, audits } = fakeDb()
  const pipeline = { send: vi.fn(send) }
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, pipeline: pipeline as never })
  const post = (body: unknown, token: string | null = TOKEN) =>
    app.request(`/api/sessions/${SID}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  return { post, pipeline, audits }
}

const body = { phone: '+5511988887777', content: { text: 'oi' } }

describe('POST /api/sessions/:id/messages', () => {
  it('202 com a mensagem queued; passa actor autenticado ao pipeline; audita', async () => {
    const { post, pipeline, audits } = setup(async () => ({ id: 'm1', sessionId: SID, status: 'queued' }))
    const res = await post(body)
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ id: 'm1', status: 'queued' })
    expect(pipeline.send).toHaveBeenCalledWith({ sessionId: SID, phone: body.phone, content: body.content, actor: expect.any(String) })
    expect(pipeline.send.mock.calls[0]![0].actor).toBeTruthy()
    expect(audits[0]).toMatchObject({ action: 'message.send', targetType: 'message', targetId: 'm1' })
  })

  it('cada rejeição vira o HTTP/código da 3.4', async () => {
    const cases = [
      ['SESSION_NOT_FOUND', 404],
      ['SESSION_NOT_CONNECTED', 409],
      ['CONTACT_NOT_ALLOWED', 403],
      ['WARMUP_LIMIT', 429],
      ['RATE_LIMIT', 429],
    ] as const
    for (const [code, status] of cases) {
      const { post, audits } = setup(async () => {
        const err = new SendRejectedError(code, 'x', { reason: 'r' })
        err.gate = 'rateLimit'
        throw err
      })
      const res = await post(body)
      expect(res.status, code).toBe(status)
      const json = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }
      expect(json.error.code).toBe(code)
      expect(json.error.details).toMatchObject({ gate: 'rateLimit', reason: 'r' })
      expect(audits).toHaveLength(0)
    }
  })

  it('400 VALIDATION_ERROR para phone/content inválidos; 401 sem token', async () => {
    const { post, pipeline } = setup(async () => ({}))
    for (const bad of [{ ...body, phone: '119' }, { ...body, content: {} }, { ...body, content: { text: '' } }, { phone: body.phone }]) {
      const res = await post(bad)
      expect(res.status).toBe(400)
    }
    expect((await post(body, null)).status).toBe(401)
    expect(pipeline.send).not.toHaveBeenCalled()
  })

  it('aceita mídia do OutgoingContent', async () => {
    const { post } = setup(async () => ({ id: 'm2', status: 'queued' }))
    expect((await post({ ...body, content: { image: { url: 'https://x/y.png' }, caption: 'c' } })).status).toBe(202)
  })
})
