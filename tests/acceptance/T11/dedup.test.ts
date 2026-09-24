// AC-T11-04: o mesmo (evento, sessão) não é reenviado por 10 minutos (configurável).
import { beforeEach, describe, expect, it } from 'vitest'
import { disableAllWebhooks, httpWebhook, MIN, sessionId, useAlerts } from './shared'

describe('T11 — deduplicação de alertas', () => {
  const ctx = useAlerts()
  beforeEach(() => disableAllWebhooks(ctx))

  it('AC-T11-04 mesmo (evento, sessão) dentro de 10 min (default) não é reenviado; depois de 10 min é', async () => {
    const { received } = await httpWebhook(ctx)
    const alerts = ctx.service()
    const sid = sessionId()
    const first = await alerts.notify({ type: 'forbidden_403', sessionId: sid })
    expect(first.deduped).toBe(false)
    expect(received().length).toBe(1)

    ctx.advance(9 * MIN)
    const again = await alerts.notify({ type: 'forbidden_403', sessionId: sid })
    expect(again.deduped, 'repetido em 9 min deveria ser deduplicado').toBe(true)
    expect(again.deliveries ?? []).toEqual([])
    expect(received().length).toBe(1)

    ctx.advance(1 * MIN + 1_000)
    const later = await alerts.notify({ type: 'forbidden_403', sessionId: sid })
    expect(later.deduped, 'depois de 10 min deveria reenviar').toBe(false)
    expect(received().length).toBe(2)
  })

  it('AC-T11-04 evento diferente ou sessão diferente não são deduplicados', async () => {
    const { received } = await httpWebhook(ctx)
    const alerts = ctx.service()
    const s1 = sessionId()
    const s2 = sessionId()
    await alerts.notify({ type: 'health_degraded', sessionId: s1 })
    await alerts.notify({ type: 'forbidden_403', sessionId: s1 })
    await alerts.notify({ type: 'health_degraded', sessionId: s2 })
    await alerts.notify({ type: 'health_degraded', sessionId: s1 })
    expect(received().map((r) => `${r.json.event}:${r.json.sessionId}`)).toEqual([`health_degraded:${s1}`, `forbidden_403:${s1}`, `health_degraded:${s2}`])
  })

  it('AC-T11-04 janela configurável (dedupMs)', async () => {
    const { received } = await httpWebhook(ctx)
    const alerts = ctx.service({ dedupMs: 30_000 })
    const sid = sessionId()
    await alerts.notify({ type: 'disconnected', sessionId: sid })
    ctx.advance(20_000)
    expect((await alerts.notify({ type: 'disconnected', sessionId: sid })).deduped).toBe(true)
    ctx.advance(11_000)
    expect((await alerts.notify({ type: 'disconnected', sessionId: sid })).deduped, 'janela de 30s já passou').toBe(false)
    expect(received().length).toBe(2)

    const long = ctx.service({ dedupMs: 60 * MIN })
    const sid2 = sessionId()
    await long.notify({ type: 'disconnected', sessionId: sid2 })
    ctx.advance(30 * MIN)
    expect((await long.notify({ type: 'disconnected', sessionId: sid2 })).deduped, 'janela de 60 min').toBe(true)
  })

  it('AC-T11-04 deduplicação vale para todos os canais: um alerta repetido não gera nenhuma entrega', async () => {
    const a = await httpWebhook(ctx)
    const b = await httpWebhook(ctx)
    const alerts = ctx.service()
    const sid = sessionId()
    await alerts.notify({ type: 'error_burst', sessionId: sid })
    await alerts.notify({ type: 'error_burst', sessionId: sid })
    await alerts.notify({ type: 'error_burst', sessionId: sid })
    expect(a.received().length).toBe(1)
    expect(b.received().length).toBe(1)
  })
})
