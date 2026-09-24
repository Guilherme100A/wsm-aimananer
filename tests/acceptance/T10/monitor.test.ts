// AC-T10-03: score < 70 → DEGRADED; score < 40 ou qualquer 403 → PAUSED automático, fila pausada,
// health_event + evento de alerta. Resume somente manual.
import { describe, expect, it } from 'vitest'
import {
  api,
  connectedSession,
  failuresFor,
  HOUR,
  healthTypes,
  insertHealthEvents,
  insertMessages,
  statusOf,
  useHealth,
  waitStatus,
  WINDOW_MS,
  type HCtx,
} from './shared'

const SENT = 20

/** Falhas que levam o score (pela função pura) ao intervalo; prefere o miolo da faixa. */
function failures(min: number, max: number, inner: [number, number]) {
  try {
    return failuresFor(SENT, inner[0], inner[1])
  } catch {
    return failuresFor(SENT, min, max)
  }
}

/** Sinais recentes: SENT envios, SENT respostas e `failed` falhas. */
function seed(ctx: HCtx, id: string, failed: number) {
  insertMessages(ctx, id, SENT, 'sent', 'outbound')
  insertMessages(ctx, id, SENT, 'read', 'inbound')
  insertMessages(ctx, id, failed, 'failed', 'outbound')
}

const alertsFor = (ctx: HCtx, id: string) => ctx.alerts.filter((a) => a.sessionId === id)
const ALERT_TYPES = ['forbidden_403', 'disconnected', 'error_burst', 'proxy_unavailable', 'warmup_paused', 'health_degraded']

describe('T10 — Health Monitor (transições automáticas)', () => {
  const ctx = useHealth()

  it('AC-T10-03 score < 70 (Warning) → DEGRADED, com health_event e alerta health_degraded', async () => {
    const { id } = await connectedSession(ctx)
    seed(ctx, id, failures(40, 69, [45, 64]))
    const h = await ctx.monitor.evaluate(id)
    expect(h.score).toBeLessThan(70)
    expect(h.score).toBeGreaterThanOrEqual(40)
    expect(h.label).toBe('Warning')
    await waitStatus(ctx, id, 'DEGRADED')
    expect(healthTypes(ctx, id)).toContain('health_degraded')
    expect(alertsFor(ctx, id).map((a) => a.type)).toContain('health_degraded')
    expect(ctx.queuePaused, 'DEGRADED não pausa a fila').not.toContain(id)
  })

  it('AC-T10-03 DEGRADED com health recuperado (≥ 70) volta ao estado anterior; nunca vai a PAUSED sem sinal', async () => {
    const { id } = await connectedSession(ctx)
    seed(ctx, id, failures(40, 69, [45, 64]))
    await ctx.monitor.evaluate(id)
    await waitStatus(ctx, id, 'DEGRADED')

    ctx.advance(WINDOW_MS + HOUR) // sinais ruins saem da janela
    const h = await ctx.monitor.evaluate(id)
    expect(h.score).toBeGreaterThanOrEqual(70)
    expect(h.label).toBe('Good')
    await waitStatus(ctx, id, 'WARMING')
  })

  it('AC-T10-03 score < 40 (Critical) → PAUSED automático: fila pausada, health_event e alerta', async () => {
    const { id } = await connectedSession(ctx)
    seed(ctx, id, failures(0, 39, [0, 30]))
    const h = await ctx.monitor.evaluate(id)
    expect(h.score).toBeLessThan(40)
    expect(h.label).toBe('Critical')
    await waitStatus(ctx, id, 'PAUSED')
    await expect.poll(() => ctx.queuePaused.includes(id), { timeout: 5_000, message: 'queueControl.pause não chamado' }).toBe(true)
    expect(healthTypes(ctx, id)).toContain('auto_paused')
    const types = alertsFor(ctx, id).map((a) => a.type)
    expect(types, 'alerta de pausa por saúde crítica').toContain('health_degraded')
    expect(types, 'pausa durante o warm-up').toContain('warmup_paused')
    for (const a of alertsFor(ctx, id)) expect(ALERT_TYPES, `tipo de alerta desconhecido: ${a.type}`).toContain(a.type)
  })

  it('AC-T10-03 qualquer 403 (health_event forbidden_403) → PAUSED automático, mesmo com score alto', async () => {
    const { id } = await connectedSession(ctx)
    insertMessages(ctx, id, SENT, 'sent', 'outbound')
    insertMessages(ctx, id, SENT, 'read', 'inbound')
    insertHealthEvents(ctx, id, 'forbidden_403', 1)
    await ctx.monitor.evaluate(id)
    await waitStatus(ctx, id, 'PAUSED')
    await expect.poll(() => ctx.queuePaused.includes(id), { timeout: 5_000 }).toBe(true)
    expect(healthTypes(ctx, id)).toContain('auto_paused')
    expect(alertsFor(ctx, id).map((a) => a.type)).toContain('forbidden_403')
  })

  it('AC-T10-03 403 vindo da conexão (close forbidden) → PAUSED, fila pausada e alerta forbidden_403', async () => {
    const { id, transport } = await connectedSession(ctx)
    await transport.close('forbidden', 403)
    await waitStatus(ctx, id, 'PAUSED')
    await expect.poll(() => ctx.queuePaused.includes(id), { timeout: 5_000, message: 'queueControl.pause não chamado' }).toBe(true)
    await expect.poll(() => alertsFor(ctx, id).map((a) => a.type), { timeout: 5_000 }).toContain('forbidden_403')
    expect(healthTypes(ctx, id)).toContain('forbidden_403')
  })

  it('AC-T10-03 PAUSED automático: resume é somente manual (avaliações com saúde boa não despausam)', async () => {
    const { id } = await connectedSession(ctx)
    seed(ctx, id, failures(0, 39, [0, 30]))
    await ctx.monitor.evaluate(id)
    await waitStatus(ctx, id, 'PAUSED')

    ctx.advance(WINDOW_MS + HOUR) // saúde volta a 100
    for (let i = 0; i < 3; i++) {
      const h = await ctx.monitor.evaluate(id)
      expect(h.label).toBe('Good')
    }
    expect(statusOf(ctx, id), 'monitor não pode sair de PAUSED sozinho').toBe('PAUSED')

    const res = await api(ctx, 'POST', `/api/sessions/${id}/resume`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.status).toBe('WARMING')
    await ctx.manager.whenIdle?.()
  })

  it('AC-T10-03 após resume manual, o 403 anterior não re-pausa a sessão; um 403 novo pausa de novo', async () => {
    const { id } = await connectedSession(ctx)
    insertHealthEvents(ctx, id, 'forbidden_403', 1)
    await ctx.monitor.evaluate(id)
    await waitStatus(ctx, id, 'PAUSED')

    ctx.advance(60_000)
    const res = await api(ctx, 'POST', `/api/sessions/${id}/resume`)
    expect(res.status, res.text).toBe(200)
    await ctx.manager.whenIdle?.()
    ctx.advance(60_000)
    await ctx.monitor.evaluate(id)
    expect(statusOf(ctx, id), 'o 403 de antes do resume não deveria contar').toBe('WARMING')

    insertHealthEvents(ctx, id, 'forbidden_403', 1, new Date(ctx.now().getTime() - 1_000).toISOString())
    await ctx.monitor.evaluate(id)
    await waitStatus(ctx, id, 'PAUSED')
  })

  it('AC-T10-03 PAUSED manual não é alterado pelo monitor', async () => {
    const { id } = await connectedSession(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${id}/pause`)).status).toBe(200)
    seed(ctx, id, failures(40, 69, [45, 64]))
    await ctx.monitor.evaluate(id)
    expect(statusOf(ctx, id)).toBe('PAUSED')
  })
})
