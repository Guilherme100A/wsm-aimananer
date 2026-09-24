// AC-T08-05 — sessão PAUSED: fila pausada, jobs continuam queued; no resume, retoma na ordem.
import { describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import {
  connectedSession,
  delay,
  enqueue,
  eventTypes,
  msgRow,
  msgStatus,
  pauseSession,
  resumeSession,
  sentTexts,
  useQueue,
  waitMsgStatus,
} from './shared'

describe('T08 — pausa da sessão', () => {
  const ctx = useQueue()

  it('AC-T08-05 sessão PAUSED: jobs ficam queued; no resume, são enviados na ordem', async () => {
    const { id, t } = await connectedSession(ctx)
    await pauseSession(ctx, id)

    const msgs = []
    for (let i = 0; i < 4; i++) msgs.push(await enqueue(ctx, id, `pausa-${i}`))
    await delay(1_500)
    expect(t.sendCalls).toHaveLength(0)
    for (const m of msgs) {
      expect(msgStatus(ctx, m.id)).toBe('queued')
      expect(eventTypes(ctx, m.id)).not.toContain('processing')
    }

    await resumeSession(ctx, id)
    for (const m of msgs) await waitMsgStatus(ctx, m.id, 'sent')
    expect(sentTexts(t)).toEqual(msgs.map((m) => m.text))
    const sentAt = msgs.map((m) => Date.parse(msgRow(ctx, m.id)!.sent_at))
    for (let i = 1; i < sentAt.length; i++) expect(sentAt[i]).toBeGreaterThanOrEqual(sentAt[i - 1]!)
  })

  it('AC-T08-05 pausar com fila em andamento: o restante fica queued e retoma na ordem', async () => {
    const { id, t } = await connectedSession(ctx)
    t.sendDelayMs = 300
    const msgs = []
    for (let i = 0; i < 5; i++) msgs.push(await enqueue(ctx, id, `meio-${i}`))
    await waitMsgStatus(ctx, msgs[0]!.id, 'sent')
    await pauseSession(ctx, id)

    // o envio em andamento (se houver) termina; depois disso nada mais sai
    await delay(800)
    const frozen = t.sendCalls.length
    await delay(1_200)
    expect(t.sendCalls.length).toBe(frozen)
    expect(frozen).toBeLessThan(msgs.length)
    const pending = msgs.filter((m) => msgStatus(ctx, m.id) !== 'sent')
    expect(pending.length).toBeGreaterThan(0)
    for (const m of pending) expect(msgStatus(ctx, m.id)).toBe('queued')

    t.sendDelayMs = 0
    await resumeSession(ctx, id)
    for (const m of msgs) await waitMsgStatus(ctx, m.id, 'sent')
    expect(sentTexts(t)).toEqual(msgs.map((m) => m.text))
  })

  it('AC-T08-05 SessionQueueControl.pause/resume pausa e retoma a fila da sessão', async () => {
    const { id, t } = await connectedSession(ctx)
    await ctx.queue.pause(id)
    const msgs = [await enqueue(ctx, id, 'ctl-0'), await enqueue(ctx, id, 'ctl-1')]
    await delay(1_000)
    expect(t.sendCalls).toHaveLength(0)
    for (const m of msgs) expect(msgStatus(ctx, m.id)).toBe('queued')
    await ctx.queue.resume(id)
    for (const m of msgs) await waitMsgStatus(ctx, m.id, 'sent')
    expect(sentTexts(t)).toEqual(['ctl-0', 'ctl-1'])
  })

  it('AC-T08-05 defesa: status PAUSED no banco (sem evento) impede a entrega; mensagem segue queued', async () => {
    const { id, t } = await connectedSession(ctx)
    sqlOk(ctx.tempDb.url, `UPDATE sessions SET status = 'PAUSED' WHERE id = ${lit(id)};`)
    const m = await enqueue(ctx, id, 'defesa')
    await delay(1_500)
    expect(t.sendCalls).toHaveLength(0)
    expect(msgStatus(ctx, m.id)).toBe('queued')

    // saída de PAUSED só por resume explícito (SPEC 3.2): status de volta + SessionQueueControl.resume
    sqlOk(ctx.tempDb.url, `UPDATE sessions SET status = 'WARMING' WHERE id = ${lit(id)};`)
    await ctx.queue.resume(id)
    await waitMsgStatus(ctx, m.id, 'sent')
    expect(sentTexts(t)).toEqual(['defesa'])
  })
})
