// AC-T08-03 — falha → retrying (máx. 3 tentativas, backoff exponencial); esgotadas → failed com last_error.
// A suíte usa backoffDelayMs=1000 (base): esperas de ~1000ms e ~2000ms entre as tentativas.
import { describe, expect, it } from 'vitest'
import { connectedSession, delay, enqueue, eventTypes, msgRow, msgStatus, useQueue, waitMsgStatus } from './shared'

describe('T08 — retentativas', () => {
  const ctx = useQueue({ queueOptions: () => ({ backoffDelayMs: 1_000 }) })

  it('AC-T08-03 falha no envio → retrying e nova tentativa até enviar', async () => {
    const { id, t } = await connectedSession(ctx)
    t.failNextSend(new Error('falha temporária 1'))
    t.failNextSend(new Error('falha temporária 2'))
    const m = await enqueue(ctx, id)

    // entre as tentativas a mensagem fica em retrying
    await waitMsgStatus(ctx, m.id, 'retrying', 10_000)
    await waitMsgStatus(ctx, m.id, 'sent')

    expect(t.sendCalls).toHaveLength(3)
    expect(t.sent).toHaveLength(1)
    const types = eventTypes(ctx, m.id)
    expect(types.filter((x) => x === 'retrying')).toHaveLength(2)
    expect(types[0]).toBe('queued')
    expect(types.at(-1)).toBe('sent')
    expect(msgRow(ctx, m.id)!.attempts).toBe(3)
  })

  it('AC-T08-03 esgotadas 3 tentativas → failed com last_error, sem 4ª tentativa', async () => {
    const { id, t } = await connectedSession(ctx)
    for (let i = 1; i <= 5; i++) t.failNextSend(new Error(`erro de envio ${i}`))
    const m = await enqueue(ctx, id)

    await waitMsgStatus(ctx, m.id, 'failed')
    await delay(3_000) // nenhuma tentativa extra depois de failed
    expect(t.sendCalls).toHaveLength(3)
    expect(t.sent).toHaveLength(0)
    expect(msgStatus(ctx, m.id)).toBe('failed')

    const row = msgRow(ctx, m.id)!
    expect(row.attempts).toBe(3)
    expect(String(row.error ?? '')).toContain('erro de envio 3')

    const types = eventTypes(ctx, m.id)
    expect(types.filter((x) => x === 'retrying')).toHaveLength(2)
    expect(types.filter((x) => x === 'processing')).toHaveLength(3)
    expect(types.at(-1)).toBe('failed')
  })

  it('AC-T08-03 o intervalo entre tentativas cresce exponencialmente', async () => {
    const { id, t } = await connectedSession(ctx)
    for (let i = 1; i <= 3; i++) t.failNextSend(new Error(`erro ${i}`))
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'failed')

    const [a, b, c] = t.sendCalls
    const gap1 = b!.at - a!.end!
    const gap2 = c!.at - b!.end!
    expect(gap1, `1ª espera ${gap1}ms`).toBeGreaterThanOrEqual(950)
    expect(gap2, `2ª espera ${gap2}ms`).toBeGreaterThanOrEqual(1_900)
    expect(gap2, `2ª espera (${gap2}ms) deveria ser ~2x a 1ª (${gap1}ms)`).toBeGreaterThan(gap1 * 1.4)
  })
})
