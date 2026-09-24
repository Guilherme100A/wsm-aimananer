// AC-T12-05: detalhe da sessão com o card (Connected, Warm-up, Health, Sent, Received, Failed, Disconnects,
// Pause/Restart/Logs) e os gráficos mensagens/hora, mensagens/dia, recebidas vs enviadas, falhas,
// desconexões, latência e estado.
import { describe, expect, it } from 'vitest'
import { connectedSession, go, insertHealthEvent, insertMessages, statusOf, tid, useDashboard } from './shared'

const CHARTS = ['chart-messages-hour', 'chart-messages-day', 'chart-received-sent', 'chart-failures', 'chart-disconnects', 'chart-latency', 'chart-state']

describe('T12 — detalhe da sessão', () => {
  const ctx = useDashboard()

  it('AC-T12-05 card da sessão com rótulos, valores do health e botões Pause/Restart/Logs', async () => {
    const { id } = await connectedSession(ctx)
    insertMessages(ctx, id, 3, 'sent')
    insertMessages(ctx, id, 1, 'failed')
    insertMessages(ctx, id, 2, 'read', 'inbound')
    insertHealthEvent(ctx, id, 'disconnected')
    const page = await ctx.newPage()
    await go(ctx, page, `/sessions/${id}`)
    const card = page.locator(tid('session-card'))
    await card.waitFor({ state: 'visible' })
    const text = (await card.textContent()) ?? ''
    for (const label of ['Connected', 'Warm-up', 'Health', 'Sent', 'Received', 'Failed', 'Disconnects']) expect(text, `rótulo ${label}`).toContain(label)
    const v = async (t: string) => ((await page.locator(tid(t)).textContent()) ?? '').trim()
    await expect.poll(() => v('detail-sent'), { timeout: 15_000 }).toMatch(/\b3\b/)
    await expect.poll(() => v('detail-received'), { timeout: 15_000 }).toMatch(/\b2\b/)
    await expect.poll(() => v('detail-failed'), { timeout: 15_000 }).toMatch(/\b1\b/)
    await expect.poll(() => v('detail-disconnects'), { timeout: 15_000 }).toMatch(/\b1\b/)
    expect(await v('detail-warmup')).toMatch(/\d+\s*%/)
    expect(await v('detail-health')).toMatch(/\d+.*(Good|Warning|Critical)/)
    expect(((await page.locator(tid('btn-pause')).textContent()) ?? '').trim()).toBe('Pause')
    expect(((await page.locator(tid('btn-restart')).textContent()) ?? '').trim()).toBe('Restart')
    expect(((await page.locator(tid('btn-logs')).textContent()) ?? '').trim()).toBe('Logs')
  })

  it('AC-T12-05 os 7 gráficos renderizam (svg com dados, ou "Sem dados")', async () => {
    const { id } = await connectedSession(ctx)
    insertMessages(ctx, id, 4, 'sent')
    insertMessages(ctx, id, 2, 'failed')
    insertMessages(ctx, id, 3, 'read', 'inbound')
    const page = await ctx.newPage()
    await go(ctx, page, `/sessions/${id}`)
    for (const c of CHARTS) {
      const el = page.locator(tid(c))
      await el.waitFor({ state: 'visible' })
      await expect
        .poll(async () => (await el.locator('svg').count()) > 0 || ((await el.textContent()) ?? '').includes('Sem dados'), { timeout: 15_000, message: `${c} sem svg nem estado vazio` })
        .toBe(true)
    }
    // com mensagens enviadas e recebidas, estes gráficos têm dados
    for (const c of ['chart-messages-hour', 'chart-messages-day', 'chart-received-sent', 'chart-failures', 'chart-latency', 'chart-state'])
      await expect.poll(() => page.locator(`${tid(c)} svg`).count(), { timeout: 15_000, message: `${c} deveria ter gráfico` }).toBeGreaterThan(0)
    expect(ctx.pageErrors, 'erros de página').toEqual([])
  })

  it('AC-T12-05 Pause pausa a sessão (vira Resume), Resume retoma, Restart reconecta e Logs abre o painel', async () => {
    const { id } = await connectedSession(ctx)
    insertMessages(ctx, id, 1, 'sent')
    const page = await ctx.newPage()
    await go(ctx, page, `/sessions/${id}`)
    await page.locator(tid('btn-pause')).click()
    await expect.poll(() => statusOf(ctx, id), { timeout: 10_000 }).toBe('PAUSED')
    await page.locator(tid('btn-resume')).waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator(tid('btn-resume')).click()
    await expect.poll(() => statusOf(ctx, id), { timeout: 10_000 }).toBe('WARMING')
    await page.locator(tid('btn-pause')).waitFor({ state: 'visible', timeout: 15_000 })

    const before = ctx.tf.connectCount(id)
    await page.locator(tid('btn-restart')).click()
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000, message: 'Restart não reconectou' }).toBeGreaterThan(before)

    await page.locator(tid('btn-logs')).click()
    await page.locator(tid('logs-panel')).waitFor({ state: 'visible' })
  })
})
