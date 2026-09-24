import { C, connectedSession, createContact, send, sentTexts, spyAdapter, useQueue, waitMsgStatus } from './shared'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

// Fila do T08 montada com deliver = createDeliver({ antiban: espião }): prova que o envio efetivo
// disparado pela API (pipeline → fila → deliver) passa pelo AntibanAdapter antes do transporte.
const adapter = spyAdapter((_key, _to, content: any) => (String(content?.text).startsWith('BLOQ') ? { allowed: false, delayMs: 0, reason: 'teste' } : { allowed: true, delayMs: 7 }))
const sleeps: number[] = []

describe('T09 — fila + AntibanAdapter', () => {
  const ctx = useQueue({
    queueOptions: () => ({
      deliver: C.createDeliver({ antiban: adapter, sleep: async (ms: number) => void sleeps.push(ms) }),
      maxAttempts: 1,
    }),
  })

  it('AC-T09-03 envio pela API → pipeline → fila → adapter.beforeSend (key = sessionId) → transporte → afterSend', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const text = `via-fila-${randomBytes(2).toString('hex')}`
    const res = await send(ctx, id, contact.phone, text)
    expect(res.status, res.text).toBe(202)
    await waitMsgStatus(ctx, res.body.id, 'sent')
    expect(sentTexts(t)).toContain(text)

    const mine = adapter.calls.filter((c) => c.args[0] === id)
    expect(mine.map((c) => c.fn)).toEqual(['beforeSend', 'afterSend'])
    expect(mine[0]!.args[2]).toMatchObject({ text })
    expect(sleeps).toContain(7)
  })

  it('AC-T09-03 adapter bloqueia → a mensagem nunca chega ao transporte e termina failed', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const res = await send(ctx, id, contact.phone, `BLOQ-${randomBytes(2).toString('hex')}`)
    expect(res.status, res.text).toBe(202)
    await waitMsgStatus(ctx, res.body.id, 'failed')
    expect(t.sent).toHaveLength(0)
    expect(adapter.calls.filter((c) => c.args[0] === id && c.fn === 'afterSend')).toHaveLength(0)
  })
})
