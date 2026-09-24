// AC-T08-04 — POST /api/messages/:id/cancel: queued → cancelled (nunca chega ao transporte); sent → 409.
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { api, connectedSession, delay, enqueue, eventTypes, msgStatus, sentTexts, useQueue, waitMsgStatus } from './shared'

describe('T08 — cancelamento', () => {
  const ctx = useQueue()

  it('AC-T08-04 cancelar mensagem queued → cancelled e ela nunca chega ao transporte', async () => {
    const { id, t } = await connectedSession(ctx)
    t.sendDelayMs = 1_500
    const first = await enqueue(ctx, id)
    await expect.poll(() => t.inFlight, { timeout: 10_000 }).toBe(1) // primeira ocupa a fila
    const victim = await enqueue(ctx, id)
    const after = await enqueue(ctx, id)
    expect(msgStatus(ctx, victim.id)).toBe('queued')

    const res = await api(ctx, 'POST', `/api/messages/${victim.id}/cancel`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(msgStatus(ctx, victim.id)).toBe('cancelled')

    t.sendDelayMs = 0
    await waitMsgStatus(ctx, first.id, 'sent')
    await waitMsgStatus(ctx, after.id, 'sent')
    await delay(500)

    expect(sentTexts(t)).toEqual([first.text, after.text])
    expect(t.sendCalls.map((c: any) => c.content?.text)).not.toContain(victim.text)
    expect(msgStatus(ctx, victim.id)).toBe('cancelled')
    const types = eventTypes(ctx, victim.id)
    expect(types).toEqual(['queued', 'cancelled'])
  })

  it('AC-T08-04 cancelar mensagem já sent → 409', async () => {
    const { id } = await connectedSession(ctx)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')
    const res = await api(ctx, 'POST', `/api/messages/${m.id}/cancel`)
    expectApiError(res as any, 'INVALID_TRANSITION', 409)
    expect(msgStatus(ctx, m.id)).toBe('sent')
  })

  it('AC-T08-04 cancelar mensagem inexistente → 404', async () => {
    const res = await api(ctx, 'POST', `/api/messages/00000000-0000-4000-8000-000000000000/cancel`)
    expect(res.status, res.text).toBe(404)
    expect(typeof res.body?.error?.code).toBe('string')
  })

  it('AC-T08-04 cancel exige autenticação', async () => {
    const { call } = await import('../helpers/app')
    const res = await call(ctx.app, 'POST', `/api/messages/00000000-0000-4000-8000-000000000000/cancel`)
    expect(res.status).toBe(401)
  })
})
