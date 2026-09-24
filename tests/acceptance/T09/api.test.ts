import {
  api,
  connectedSession,
  createContact,
  DAY,
  messageCount,
  pauseSession,
  randomPhone,
  relaxRateLimits,
  seedMessages,
  send,
  sentTexts,
  setWarmupStart,
  useQueue,
  waitMsgStatus,
} from './shared'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'

describe('T09 — POST /api/sessions/:id/messages passa pelo pipeline', () => {
  const ctx = useQueue()

  /** Rejeição: HTTP + código corretos e nenhuma linha criada em messages. */
  async function expectRejected(sessionId: string, phone: string, code: string, status: number) {
    const before = messageCount(ctx, sessionId)
    const res = await send(ctx, sessionId, phone)
    expectApiError(res, code, status)
    expect(messageCount(ctx, sessionId), 'rejeição não pode criar mensagem').toBe(before)
    return res
  }

  it('AC-T09-02 envio permitido → 202 com a mensagem queued, que segue pela fila até o transporte', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const text = `ola-${randomBytes(3).toString('hex')}`
    const res = await send(ctx, id, contact.phone, text)
    expect(res.status, res.text).toBe(202)
    expect(res.body).toMatchObject({ sessionId: id, phone: contact.phone, status: 'queued' })
    await waitMsgStatus(ctx, res.body.id, 'sent')
    expect(sentTexts(t)).toContain(text)
    expect(t.sent.at(-1).to).toContain(contact.phone.replace('+', ''))
  })

  it('AC-T09-02 sessão inexistente → 404 SESSION_NOT_FOUND', async () => {
    const contact = await createContact(ctx)
    const res = await send(ctx, '00000000-0000-4000-8000-000000000000', contact.phone)
    expectApiError(res, 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T09-02 sessão NEW (não conectada) → 409 SESSION_NOT_CONNECTED', async () => {
    const created = await api(ctx, 'POST', '/api/sessions', { name: 'nao-conectada', phone: randomPhone() })
    expect(created.status).toBe(201)
    const contact = await createContact(ctx)
    await expectRejected(created.body.id, contact.phone, 'SESSION_NOT_CONNECTED', 409)
  })

  it('AC-T09-02 sessão PAUSED → 409 SESSION_NOT_CONNECTED', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await pauseSession(ctx, id)
    await expectRejected(id, contact.phone, 'SESSION_NOT_CONNECTED', 409)
  })

  it('AC-T09-02 contato sem cadastro → 403 CONTACT_NOT_ALLOWED', async () => {
    const { id, t } = await connectedSession(ctx)
    await expectRejected(id, randomPhone(), 'CONTACT_NOT_ALLOWED', 403)
    expect(t.sent).toHaveLength(0)
  })

  it('AC-T09-02 contato sem consentimento → 403 CONTACT_NOT_ALLOWED', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx, { consent: false })
    await expectRejected(id, contact.phone, 'CONTACT_NOT_ALLOWED', 403)
  })

  it('AC-T09-02 contato com opt_out → 403 CONTACT_NOT_ALLOWED', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx, { opt_out: true })
    await expectRejected(id, contact.phone, 'CONTACT_NOT_ALLOWED', 403)
  })

  it('AC-T09-02 limite diário do warm-up atingido → 429 WARMUP_LIMIT (dia 0: 20 mensagens)', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await relaxRateLimits(ctx, id)
    setWarmupStart(ctx, id, 60 * 60 * 1000) // começou há 1h → dia 0
    seedMessages(ctx, id, 19, { agoMs: 30 * 60 * 1000 })
    const ok = await send(ctx, id, contact.phone)
    expect(ok.status, `20ª mensagem do dia deveria passar: ${ok.text}`).toBe(202)
    await expectRejected(id, contact.phone, 'WARMUP_LIMIT', 429)
  })

  it('AC-T09-02 WARMUP_LIMIT acompanha o cronograma: dia 2 permite round(20·1.8²) = 65', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await relaxRateLimits(ctx, id)
    setWarmupStart(ctx, id, 2 * DAY + 2 * 60 * 60 * 1000) // dia 2, começou há 2h
    // do dia 1 (antes do início do dia 2 e fora da janela rolante de 24h do rateLimit): não contam
    seedMessages(ctx, id, 50, { agoMs: 25 * 60 * 60 * 1000 })
    seedMessages(ctx, id, 64, { agoMs: 60 * 60 * 1000 })
    expect((await send(ctx, id, contact.phone)).status).toBe(202)
    await expectRejected(id, contact.phone, 'WARMUP_LIMIT', 429)
  })

  it('AC-T09-02 mensagens canceladas não contam para o limite de warm-up', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await relaxRateLimits(ctx, id)
    setWarmupStart(ctx, id, 60 * 60 * 1000)
    seedMessages(ctx, id, 19, { agoMs: 10 * 60 * 1000 })
    seedMessages(ctx, id, 30, { agoMs: 10 * 60 * 1000, status: 'cancelled' })
    const res = await send(ctx, id, contact.phone)
    expect(res.status, res.text).toBe(202)
  })

  it('AC-T09-02 warm-up concluído não aplica WARMUP_LIMIT', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await relaxRateLimits(ctx, id)
    setWarmupStart(ctx, id, 8 * DAY)
    seedMessages(ctx, id, 200, { agoMs: 2 * 60 * 60 * 1000 })
    const res = await send(ctx, id, contact.phone)
    expect(res.status, res.text).toBe(202)
  })

  it('AC-T09-02 limite de taxa por minuto atingido → 429 RATE_LIMIT (defaults conservadores)', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const { effective } = (await api(ctx, 'GET', `/api/sessions/${id}/limits`)).body
    expect(effective?.perMinute, 'limite por minuto efetivo').toBeGreaterThan(0)
    seedMessages(ctx, id, effective.perMinute, { agoMs: 5_000 })
    await expectRejected(id, contact.phone, 'RATE_LIMIT', 429)
  })

  it('AC-T09-02 janela por minuto é rolante: mensagens de mais de 1 min atrás não estouram o limite por minuto', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const { effective } = (await api(ctx, 'GET', `/api/sessions/${id}/limits`)).body
    seedMessages(ctx, id, effective.perMinute, { agoMs: 5 * 60 * 1000 })
    const res = await send(ctx, id, contact.phone)
    expect(res.status, res.text).toBe(202)
  })

  it('AC-T09-02 limite por hora atingido → 429 RATE_LIMIT', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const put = await api(ctx, 'PUT', `/api/sessions/${id}/limits`, { perMinute: 1000, perHour: 3, perDay: 1000 })
    expect(put.status, put.text).toBe(200)
    seedMessages(ctx, id, 3, { agoMs: 20 * 60 * 1000 })
    await expectRejected(id, contact.phone, 'RATE_LIMIT', 429)
  })

  it('AC-T09-02 a primeira falha decide: sessão não conectada E contato não permitido → SESSION_NOT_CONNECTED', async () => {
    const created = await api(ctx, 'POST', '/api/sessions', { name: 'dupla-falha', phone: randomPhone() })
    await expectRejected(created.body.id, randomPhone(), 'SESSION_NOT_CONNECTED', 409)
  })

  it('AC-T09-02 a primeira falha decide: contato não permitido E limite de warm-up estourado → CONTACT_NOT_ALLOWED', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx, { consent: false })
    await relaxRateLimits(ctx, id)
    setWarmupStart(ctx, id, 60 * 60 * 1000)
    seedMessages(ctx, id, 25, { agoMs: 10 * 60 * 1000 })
    await expectRejected(id, contact.phone, 'CONTACT_NOT_ALLOWED', 403)
  })

  it('AC-T09-02 a primeira falha decide: warm-up E taxa estourados → WARMUP_LIMIT (warmupLimit vem antes de rateLimit)', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    setWarmupStart(ctx, id, 60 * 60 * 1000)
    seedMessages(ctx, id, 25, { agoMs: 2_000 })
    await expectRejected(id, contact.phone, 'WARMUP_LIMIT', 429)
  })

  it('AC-T09-02 sem token → 401 UNAUTHORIZED e nada é enfileirado', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const before = messageCount(ctx, id)
    const res = await call(ctx.app, 'POST', `/api/sessions/${id}/messages`, { body: { phone: contact.phone, content: { text: 'x' } } })
    expectApiError(res, 'UNAUTHORIZED', 401)
    expect(messageCount(ctx, id)).toBe(before)
  })

  it('AC-T09-02 body inválido → 400 VALIDATION_ERROR (telefone fora do E.164, conteúdo vazio)', async () => {
    const { id } = await connectedSession(ctx)
    expectApiError(await api(ctx, 'POST', `/api/sessions/${id}/messages`, { phone: '11999990000', content: { text: 'x' } }), 'VALIDATION_ERROR', 400)
    const contact = await createContact(ctx)
    expectApiError(await api(ctx, 'POST', `/api/sessions/${id}/messages`, { phone: contact.phone, content: { text: '' } }), 'VALIDATION_ERROR', 400)
    expectApiError(await api(ctx, 'POST', `/api/sessions/${id}/messages`, { phone: contact.phone }), 'VALIDATION_ERROR', 400)
  })
})
