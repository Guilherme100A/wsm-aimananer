// AC-T12-02: a home exibe os 8 cards (conectadas, desconectadas, em warm-up, com risco elevado,
// enviadas, recebidas, falhas e último evento).
import { beforeAll, describe, expect, it } from 'vitest'
import { createSession, go, insertHealthEvent, insertMessages, setStatus, tid, useDashboard } from './shared'

const CARDS = ['card-connected', 'card-disconnected', 'card-warming', 'card-risk', 'card-sent', 'card-received', 'card-failed', 'card-last-event']

describe('T12 — home', () => {
  const ctx = useDashboard()

  it('AC-T12-02 os 8 cards aparecem mesmo sem dados', async () => {
    const page = await ctx.newPage()
    await go(ctx, page, '/')
    for (const c of CARDS) {
      await page.locator(tid(c)).waitFor({ state: 'visible' })
      await expect(page.locator(`${tid(c)} ${tid('card-value')}`).count(), `${c} sem card-value`).resolves.toBe(1)
    }
    expect(((await page.locator(`${tid('card-last-event')} ${tid('card-value')}`).textContent()) ?? '').trim()).toBe('—')
  })

  describe('com dados', () => {
    beforeAll(async () => {
      const states = ['WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'NEW', 'DISCONNECTED']
      const ids: Record<string, string> = {}
      for (const st of states) {
        const s = await createSession(ctx)
        if (st !== 'NEW') setStatus(ctx, s.id, st)
        ids[st] = s.id
      }
      // sinais na sessão DEGRADED (já conta como risco); demais sessões ficam Good
      insertMessages(ctx, ids.DEGRADED!, 2, 'sent')
      insertMessages(ctx, ids.DEGRADED!, 1, 'delivered')
      insertMessages(ctx, ids.DEGRADED!, 2, 'failed')
      insertMessages(ctx, ids.DEGRADED!, 4, 'read', 'inbound')
      insertMessages(ctx, ids.DEGRADED!, 3, 'queued')
      insertHealthEvent(ctx, ids.STABLE!, 'connected')
    })

    it('AC-T12-02 contagens por estado: conectadas, desconectadas, em warm-up e risco elevado', async () => {
      const page = await ctx.newPage()
      await go(ctx, page, '/')
      const value = (c: string) => page.locator(`${tid(c)} ${tid('card-value')}`).textContent().then((t: string | null) => (t ?? '').trim())
      await expect.poll(() => value('card-connected'), { timeout: 15_000 }).toBe('4')
      await expect.poll(() => value('card-disconnected'), { timeout: 15_000 }).toBe('2')
      await expect.poll(() => value('card-warming'), { timeout: 15_000 }).toBe('1')
      await expect.poll(() => value('card-risk'), { timeout: 15_000 }).toBe('1')
    })

    it('AC-T12-02 enviadas, recebidas, falhas e último evento', async () => {
      const page = await ctx.newPage()
      await go(ctx, page, '/')
      const value = (c: string) => page.locator(`${tid(c)} ${tid('card-value')}`).textContent().then((t: string | null) => (t ?? '').trim())
      await expect.poll(() => value('card-sent'), { timeout: 15_000 }).toBe('3')
      await expect.poll(() => value('card-received'), { timeout: 15_000 }).toBe('4')
      await expect.poll(() => value('card-failed'), { timeout: 15_000 }).toBe('2')
      await expect.poll(() => value('card-last-event'), { timeout: 15_000 }).not.toBe('—')
      expect(await value('card-last-event')).toMatch(/\d/)
    })
  })
})
