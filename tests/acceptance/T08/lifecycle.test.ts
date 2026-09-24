// AC-T08-02 — queued→processing→sent com message_events; receipts → delivered → read.
import { describe, expect, it } from 'vitest'
import * as core from '@wsm/core'
import { api, connectedSession, enqueue, eventTypes, msgEvents, msgRow, useQueue, waitMsgStatus } from './shared'

describe('T08 — ciclo de vida da mensagem', () => {
  const ctx = useQueue()

  it('AC-T08-02 queued → processing → sent grava message_events com timestamp', async () => {
    const { id, t } = await connectedSession(ctx)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')

    const ev = msgEvents(ctx, m.id)
    expect(ev.map((e) => e.to)).toEqual(['queued', 'processing', 'sent'])
    expect(ev.map((e) => e.from)).toEqual([null, 'queued', 'processing'])
    for (const e of ev) expect(Number.isFinite(e.at) && e.at > 0, `timestamp de ${e.to}`).toBe(true)
    for (let i = 1; i < ev.length; i++) expect(ev[i]!.at).toBeGreaterThanOrEqual(ev[i - 1]!.at)

    // chegou ao transporte com o JID do telefone e o conteúdo enfileirado
    expect(t.sent).toHaveLength(1)
    const sent = t.sent[0]
    expect(sent.to).toBe((core as any).phoneToJid(m.phone))
    expect(sent.to).toBe(`${m.phone.replace(/^\+/, '')}@s.whatsapp.net`)
    expect(sent.content).toEqual({ text: m.text })

    const row = msgRow(ctx, m.id)!
    expect(row.transport_message_id).toBe(sent.messageId)
    expect(row.sent_at).toBeTruthy()
    expect(row.attempts).toBe(1)
  })

  it('AC-T08-02 receipts do transporte levam a delivered e depois read', async () => {
    const { id, t } = await connectedSession(ctx)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')
    const transportId = t.sent[0].messageId

    t.receipt(transportId, 'delivered')
    await waitMsgStatus(ctx, m.id, 'delivered')
    expect(msgRow(ctx, m.id)!.delivered_at).toBeTruthy()

    t.receipt(transportId, 'read')
    await waitMsgStatus(ctx, m.id, 'read')
    const row = msgRow(ctx, m.id)!
    expect(row.read_at).toBeTruthy()

    const ev = msgEvents(ctx, m.id)
    expect(ev.map((e) => e.to)).toEqual(['queued', 'processing', 'sent', 'delivered', 'read'])
    expect(ev.at(-2)!.from).toBe('sent')
    expect(ev.at(-1)!.from).toBe('delivered')
  })

  it('AC-T08-02 receipt de outra mensagem não altera a mensagem', async () => {
    const { id, t } = await connectedSession(ctx)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')
    t.receipt('FAKE-OUT-desconhecido', 'read')
    await new Promise((r) => setTimeout(r, 500))
    expect(msgRow(ctx, m.id)!.status).toBe('sent')
    expect(eventTypes(ctx, m.id)).toEqual(['queued', 'processing', 'sent'])
  })

  it('AC-T08-02 GET /api/messages/:id expõe o status e GET /events o histórico', async () => {
    const { id, t } = await connectedSession(ctx)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')
    t.receipt(t.sent[0].messageId, 'delivered')
    await waitMsgStatus(ctx, m.id, 'delivered')

    const res = await api(ctx, 'GET', `/api/messages/${m.id}`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.id).toBe(m.id)
    expect(res.body.sessionId).toBe(id)
    expect(res.body.status).toBe('delivered')

    const evRes = await api(ctx, 'GET', `/api/messages/${m.id}/events`)
    expect(evRes.status, evRes.text).toBe(200)
    const items: any[] = Array.isArray(evRes.body) ? evRes.body : evRes.body.items
    expect(items.map((e) => e.toStatus ?? e.to_status ?? e.to)).toEqual(['queued', 'processing', 'sent', 'delivered'])
  })
})
