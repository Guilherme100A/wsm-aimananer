import {
  api,
  C,
  connectedSession,
  createContact,
  DAY,
  forbiddenError,
  getLimits,
  putLimits,
  seedMessages,
  send,
  setStatus,
  setWarmupStart,
  spyAdapter,
  useQueue,
} from './shared'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { sqlOk } from '../helpers/pg'

const auditCount = (url: string) => Number(sqlOk(url, 'SELECT count(*) FROM audit_logs;')[0]![0])

describe('T09 — limites por sessão (configuráveis, só reduzem automaticamente)', () => {
  const ctx = useQueue()

  it('AC-T09-05 defaults conservadores (≤ os defaults do baileys-antiban: 8/min, 200/h, 1500/dia) e effective.perDay ≤ cronograma do warm-up', async () => {
    const { id } = await connectedSession(ctx)
    const l = await getLimits(ctx, id)
    expect(l.defaults.perMinute).toBeGreaterThanOrEqual(1)
    expect(l.defaults.perMinute).toBeLessThanOrEqual(8)
    expect(l.defaults.perHour).toBeLessThanOrEqual(200)
    expect(l.defaults.perDay).toBeLessThanOrEqual(1500)
    expect(l.configured).toEqual(l.defaults)
    expect(l.reductionFactor).toBe(1)
    expect(l.warmupDailyLimit, 'dia 0 do cronograma padrão do T10').toBe(20)
    expect(l.effective.perDay).toBeLessThanOrEqual(20)
    expect(l.effective.perMinute).toBe(l.defaults.perMinute)
  })

  it('AC-T09-05 PUT /limits configura por sessão (200, auditado) e vale só para aquela sessão', async () => {
    const a = await connectedSession(ctx)
    const b = await connectedSession(ctx)
    const audits = auditCount(ctx.tempDb.url)
    const res = await putLimits(ctx, a.id, { perMinute: 2, perHour: 30, perDay: 10 })
    expect(res.status, res.text).toBe(200)
    expect(res.body.configured).toEqual({ perMinute: 2, perHour: 30, perDay: 10 })
    expect(res.body.effective).toMatchObject({ perMinute: 2, perHour: 30, perDay: 10 })
    expect(auditCount(ctx.tempDb.url)).toBeGreaterThan(audits)

    const lb = await getLimits(ctx, b.id)
    expect(lb.configured).toEqual(lb.defaults)

    // o limite configurado é o que o gate usa
    const contact = await createContact(ctx)
    seedMessages(ctx, a.id, 2, { agoMs: 5_000 })
    expectApiError(await send(ctx, a.id, contact.phone), 'RATE_LIMIT', 429)
    seedMessages(ctx, b.id, 2, { agoMs: 5_000 })
    expect((await send(ctx, b.id, contact.phone)).status).toBe(202)
  })

  it('AC-T09-05 PUT acima do cronograma é aceito, mas o effective nunca passa do limite diário do warm-up', async () => {
    const { id } = await connectedSession(ctx)
    const res = await putLimits(ctx, id, { perMinute: 5, perHour: 100, perDay: 5000 })
    expect(res.status, res.text).toBe(200)
    expect(res.body.configured.perDay).toBe(5000)
    expect(res.body.warmupDailyLimit).toBe(20)
    expect(res.body.effective.perDay).toBe(20)

    setWarmupStart(ctx, id, 3 * DAY + 60_000) // dia 3 → round(20·1.8³) = 117
    const l = await getLimits(ctx, id)
    expect(l.warmupDailyLimit).toBe(117)
    expect(l.effective.perDay).toBe(117)
  })

  it('AC-T09-05 PUT com valores inválidos → 400 VALIDATION_ERROR; sessão inexistente → 404', async () => {
    const { id } = await connectedSession(ctx)
    expectApiError(await putLimits(ctx, id, { perMinute: 0 }), 'VALIDATION_ERROR', 400)
    expectApiError(await putLimits(ctx, id, { perDay: -5 }), 'VALIDATION_ERROR', 400)
    expectApiError(await putLimits(ctx, id, { perHour: 1.5 }), 'VALIDATION_ERROR', 400)
    expectApiError(await api(ctx, 'GET', '/api/sessions/00000000-0000-4000-8000-000000000000/limits'), 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T09-05 redução automática (SessionLimitsService.reduce) diminui o effective; fator > 1 nunca aumenta', async () => {
    const { id } = await connectedSession(ctx)
    const put = await putLimits(ctx, id, { perMinute: 8, perHour: 100, perDay: 10 })
    expect(put.status, put.text).toBe(200)
    const limits = new C.SessionLimitsService({ db: ctx.db })

    await limits.reduce(id, 0.5, 'teste')
    const l1 = await getLimits(ctx, id)
    expect(l1.reductionFactor).toBeCloseTo(0.5)
    expect(l1.configured.perMinute, 'redução não altera o configurado').toBe(8)
    expect(l1.effective.perMinute).toBeLessThanOrEqual(4)
    expect(l1.effective.perDay).toBeLessThanOrEqual(5)

    try {
      await limits.reduce(id, 3, 'tentativa de aumentar')
    } catch {
      /* rejeitar também é aceitável */
    }
    const l2 = await getLimits(ctx, id)
    expect(l2.reductionFactor, 'reduce nunca aumenta').toBeLessThanOrEqual(l1.reductionFactor)
    expect(l2.effective.perMinute).toBeLessThanOrEqual(l1.effective.perMinute)
    expect(l2.effective.perDay).toBeLessThanOrEqual(l1.effective.perDay)
  })

  it('AC-T09-05 reduções acumulam com piso e nada volta a subir sozinho; só o PUT manual restaura', async () => {
    const { id } = await connectedSession(ctx)
    expect((await putLimits(ctx, id, { perMinute: 8, perHour: 100, perDay: 10 })).status).toBe(200)
    const limits = new C.SessionLimitsService({ db: ctx.db })
    for (let i = 0; i < 6; i++) await limits.reduce(id, 0.5, `queda ${i}`)
    const l = await getLimits(ctx, id)
    expect(l.reductionFactor).toBeGreaterThanOrEqual(0.1 - 1e-9)
    expect(l.reductionFactor).toBeLessThan(0.5)
    expect(l.effective.perMinute).toBeGreaterThanOrEqual(0)
    expect(l.effective.perMinute).toBeLessThanOrEqual(8)

    // o tempo passa (nova leitura) e o fator continua reduzido
    await new Promise((r) => setTimeout(r, 200))
    expect((await getLimits(ctx, id)).reductionFactor).toBe(l.reductionFactor)

    const restored = await putLimits(ctx, id, { perMinute: 8 })
    expect(restored.status, restored.text).toBe(200)
    expect(restored.body.reductionFactor).toBe(1)
  })

  it('AC-T09-05 sessão DEGRADED aplica redução no effective (sem gravar), e ela some ao sair de DEGRADED', async () => {
    const { id } = await connectedSession(ctx)
    expect((await putLimits(ctx, id, { perMinute: 8, perHour: 100, perDay: 10 })).status).toBe(200)
    const normal = await getLimits(ctx, id)
    setStatus(ctx, id, 'DEGRADED')
    const degraded = await getLimits(ctx, id)
    expect(degraded.effective.perMinute).toBeLessThan(normal.effective.perMinute)
    expect(degraded.effective.perDay).toBeLessThanOrEqual(normal.effective.perDay)
    expect(degraded.reductionFactor, 'DEGRADED não grava redução').toBe(1)
    setStatus(ctx, id, 'WARMING')
    expect((await getLimits(ctx, id)).effective).toEqual(normal.effective)
  })

  it('AC-T09-05 403 no envio reduz automaticamente os limites da sessão (e registra forbidden_403 no health)', async () => {
    const { id, t } = await connectedSession(ctx)
    expect((await putLimits(ctx, id, { perMinute: 8, perHour: 100, perDay: 10 })).status).toBe(200)
    const signals: any[] = []
    const deliver = C.createDeliver({
      antiban: spyAdapter(),
      sleep: async () => {},
      health: { recordSignal: async (...a: any[]) => void signals.push(a) },
      limits: new C.SessionLimitsService({ db: ctx.db }),
    })
    t.failNextSend(forbiddenError())
    await expect(deliver(t, '5511999990020@s.whatsapp.net', { text: 'x' })).rejects.toBeDefined()
    const l = await getLimits(ctx, id)
    expect(l.reductionFactor).toBeLessThan(1)
    expect(l.effective.perMinute).toBeLessThan(8)
    expect(signals.map((s) => s[1])).toContain('forbidden_403')
  })

  it('AC-T09-05 o gate de warm-up usa o effective reduzido: com fator 0,5 no dia 0, a 11ª mensagem já é barrada', async () => {
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    expect((await putLimits(ctx, id, { perMinute: 10_000, perHour: 10_000, perDay: 10_000 })).status).toBe(200)
    await new C.SessionLimitsService({ db: ctx.db }).reduce(id, 0.5, 'teste')
    setWarmupStart(ctx, id, 60 * 60 * 1000)
    const l = await getLimits(ctx, id)
    expect(l.effective.perDay).toBeLessThanOrEqual(10)
    seedMessages(ctx, id, l.effective.perDay, { agoMs: 10 * 60 * 1000 })
    const res = await send(ctx, id, contact.phone)
    expect(res.status, res.text).toBe(429)
    expect(['WARMUP_LIMIT', 'RATE_LIMIT']).toContain(res.body?.error?.code)
  })
})
