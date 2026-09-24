// AC-T08-01 — uma fila BullMQ por sessão (session:<id>) com concorrência 1.
import { describe, expect, it } from 'vitest'
import { connectedSession, enqueue, msgEvents, useQueue, waitMsgStatus } from './shared'

describe('T08 — fila por sessão com concorrência 1', () => {
  const ctx = useQueue()

  it('AC-T08-01 a fila da sessão chama-se session:<id> e vive no Redis (BullMQ)', async () => {
    const { id } = await connectedSession(ctx)
    expect(ctx.queue.queueName(id)).toBe(`session:${id}`)
    const m = await enqueue(ctx, id)
    await waitMsgStatus(ctx, m.id, 'sent')
    const keys: string[] = await ctx.redis.keys(`${ctx.prefix}*`)
    expect(keys.some((k) => k.includes(`session:${id}`)), `chaves do prefixo: ${keys.slice(0, 20).join(', ')}`).toBe(true)
  })

  it('AC-T08-01 duas mensagens da mesma sessão nunca são processadas ao mesmo tempo', async () => {
    const { id, t } = await connectedSession(ctx)
    t.sendDelayMs = 150
    const msgs = []
    for (let i = 0; i < 5; i++) msgs.push(await enqueue(ctx, id))
    for (const m of msgs) await waitMsgStatus(ctx, m.id, 'sent', 20_000)

    // no transporte: nunca mais de um envio em andamento para a sessão
    expect(t.sendCalls).toHaveLength(5)
    expect(t.maxInFlight).toBe(1)

    // no ciclo de vida: janelas processing→sent não se sobrepõem
    const windows = msgs
      .map((m) => {
        const ev = msgEvents(ctx, m.id)
        const start = ev.find((e) => e.to === 'processing')?.at
        const end = ev.find((e) => e.to === 'sent')?.at
        expect(start, `evento processing de ${m.id}`).toBeDefined()
        expect(end, `evento sent de ${m.id}`).toBeDefined()
        return { start: start!, end: end! }
      })
      .sort((a, b) => a.start - b.start)
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.end)
  })

  it('AC-T08-01 filas de sessões diferentes são independentes (uma sessão lenta não segura a outra)', async () => {
    const a = await connectedSession(ctx)
    const b = await connectedSession(ctx)
    a.t.sendDelayMs = 2_000
    const ma = await enqueue(ctx, a.id)
    await expect.poll(() => a.t.inFlight, { timeout: 10_000 }).toBe(1)
    const mb = await enqueue(ctx, b.id)
    await waitMsgStatus(ctx, mb.id, 'sent', 10_000)
    // B terminou enquanto A ainda estava enviando
    expect(a.t.inFlight).toBe(1)
    await waitMsgStatus(ctx, ma.id, 'sent', 10_000)
  })
})
