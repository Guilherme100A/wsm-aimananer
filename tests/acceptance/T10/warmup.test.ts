// AC-T10-01: progresso do warm-up = f(idade da sessão, cronograma baseado no baileys-antiban);
// limite diário acompanha o cronograma; em 100% a sessão vai WARMING → STABLE.
import { describe, expect, it } from 'vitest'
import { api, connectedSession, coreApi, DAY, HOUR, statusOf, useHealth, waitStatus } from './shared'

function warmup(startedAt: Date | null, now: Date, schedule?: Record<string, number>) {
  const fn = coreApi.computeWarmup
  if (typeof fn !== 'function') throw new Error('@wsm/core não exporta computeWarmup')
  return fn(schedule ? { startedAt, now, schedule } : { startedAt, now }) as { percent: number; day: number; dailyLimit: number | null; complete: boolean }
}

const T0 = new Date('2026-01-01T00:00:00.000Z')
const after = (ms: number) => new Date(T0.getTime() + ms)

describe('T10 — warm-up (função pura)', () => {
  it('AC-T10-01 cronograma padrão configurado com os parâmetros do baileys-antiban', () => {
    const s = coreApi.DEFAULT_WARMUP_SCHEDULE
    expect(s, '@wsm/core deve exportar DEFAULT_WARMUP_SCHEDULE').toBeTruthy()
    expect(s.warmUpDays).toBeGreaterThan(0)
    expect(s.day1Limit).toBeGreaterThan(0)
    expect(s.growthFactor).toBeGreaterThanOrEqual(1)
  })

  it('AC-T10-01 progresso 0–100% em função da idade da sessão (cronograma padrão)', () => {
    const days = coreApi.DEFAULT_WARMUP_SCHEDULE.warmUpDays as number
    const total = days * DAY
    expect(warmup(null, T0).percent, 'sem warm-up iniciado → 0%').toBe(0)
    expect(warmup(T0, T0)).toMatchObject({ percent: 0, day: 0, complete: false })
    expect(warmup(T0, after(total / 4)).percent).toBe(25)
    expect(warmup(T0, after(total / 2)).percent).toBe(50)
    expect(warmup(T0, after(total - HOUR)).percent, 'antes do fim não pode dar 100%').toBeLessThan(100)
    expect(warmup(T0, after(total - HOUR)).complete).toBe(false)
    expect(warmup(T0, after(total))).toMatchObject({ percent: 100, complete: true })
    expect(warmup(T0, after(total * 5)).percent, 'limitado a 100%').toBe(100)
    let last = -1
    for (let h = 0; h <= days * 24 + 48; h += 7) {
      const p = warmup(T0, after(h * HOUR)).percent
      expect(p, `progresso não pode regredir (h=${h})`).toBeGreaterThanOrEqual(last)
      last = p
    }
  })

  it('AC-T10-01 cronograma configurável: a duração define o progresso', () => {
    const schedule = { warmUpDays: 4, day1Limit: 10, growthFactor: 2 }
    expect(warmup(T0, after(DAY), schedule).percent).toBe(25)
    expect(warmup(T0, after(2 * DAY), schedule).percent).toBe(50)
    expect(warmup(T0, after(4 * DAY), schedule)).toMatchObject({ percent: 100, complete: true })
    expect(warmup(T0, after(2 * DAY), { warmUpDays: 10, day1Limit: 10, growthFactor: 2 }).percent).toBe(20)
  })

  it('AC-T10-01 limite diário acompanha o cronograma (day1Limit · growthFactor^dia) e deixa de valer em 100%', () => {
    const schedule = { warmUpDays: 5, day1Limit: 10, growthFactor: 2 }
    const expected = [10, 20, 40, 80, 160]
    expected.forEach((limit, day) => {
      const w = warmup(T0, after(day * DAY + 2 * HOUR), schedule)
      expect(w.day, `dia ${day}`).toBe(day)
      expect(w.dailyLimit, `limite do dia ${day}`).toBe(limit)
    })
    expect(warmup(T0, after(5 * DAY), schedule).dailyLimit, 'warm-up concluído: sem limite de warm-up').toBeNull()

    const d = coreApi.DEFAULT_WARMUP_SCHEDULE
    for (let day = 0; day < d.warmUpDays; day++) {
      const w = warmup(T0, after(day * DAY + HOUR))
      expect(w.dailyLimit, `limite padrão do dia ${day}`).toBe(Math.round(d.day1Limit * d.growthFactor ** day))
    }
  })
})

describe('T10 — warm-up na sessão (HealthMonitor + SessionManager)', () => {
  const ctx = useHealth()

  it('AC-T10-01 sessão recém-conectada fica WARMING com warm-up proporcional à idade; em 100% vai WARMING → STABLE', async () => {
    const days = coreApi.DEFAULT_WARMUP_SCHEDULE.warmUpDays as number
    const { id } = await connectedSession(ctx)

    let h = await ctx.monitor.evaluate(id)
    expect(h.state).toBe('WARMING')
    expect(h.warmupPercent).toBeLessThan(5)

    ctx.advance((days * DAY) / 2)
    h = await ctx.monitor.evaluate(id)
    expect(statusOf(ctx, id), 'na metade do warm-up continua WARMING').toBe('WARMING')
    expect(h.warmupPercent).toBeGreaterThanOrEqual(49)
    expect(h.warmupPercent).toBeLessThanOrEqual(51)

    ctx.advance((days * DAY) / 2 + HOUR)
    h = await ctx.monitor.evaluate(id)
    await waitStatus(ctx, id, 'STABLE')
    expect(h.warmupPercent).toBe(100)

    const res = await api(ctx, 'GET', `/api/sessions/${id}/health`)
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ state: 'STABLE', warmupPercent: 100 })
  })

  it('AC-T10-01 resume manual volta a WARMING (warm-up incompleto) ou STABLE (warm-up completo)', async () => {
    const days = coreApi.DEFAULT_WARMUP_SCHEDULE.warmUpDays as number
    const { id } = await connectedSession(ctx)

    expect((await api(ctx, 'POST', `/api/sessions/${id}/pause`)).status).toBe(200)
    ctx.advance(HOUR)
    let res = await api(ctx, 'POST', `/api/sessions/${id}/resume`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.status).toBe('WARMING')

    ctx.advance(days * DAY + HOUR)
    expect((await api(ctx, 'POST', `/api/sessions/${id}/pause`)).status).toBe(200)
    res = await api(ctx, 'POST', `/api/sessions/${id}/resume`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.status, 'warm-up já completo: resume volta a STABLE').toBe('STABLE')
    await ctx.manager.whenIdle?.()
  })
})
