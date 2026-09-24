// AC-T11-05: falha de entrega é logada e reenviada (máx. 3 tentativas) sem derrubar o worker.
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { deadPort } from '../helpers/mocks'
import { createWebhook, disableAllWebhooks, httpWebhook, sessionId, useAlerts } from './shared'

describe('T11 — falhas de entrega', () => {
  const ctx = useAlerts()
  beforeEach(() => {
    disableAllWebhooks(ctx)
    ctx.http.reset()
    ctx.sleeps.length = 0
    ctx.failed.length = 0
  })

  const logsWith = (needle: string) => ctx.logs.filter((l) => l.includes(needle))

  it('AC-T11-05 falha temporária (500, 500, 200) é reenviada com backoff e entregue na 3ª tentativa', async () => {
    const { received } = await httpWebhook(ctx)
    ctx.http.queue.push(500, 503)
    const r = await ctx.service().notify({ type: 'forbidden_403', sessionId: sessionId() })
    expect(received().length).toBe(3)
    expect(r.deliveries[0]).toMatchObject({ ok: true, attempts: 3 })
    expect(ctx.sleeps.length, 'backoff entre tentativas').toBe(2)
    expect(ctx.sleeps[1]!, 'backoff crescente').toBeGreaterThan(ctx.sleeps[0]!)
    const bodies = received().map((x) => x.raw)
    expect(new Set(bodies).size, 'reenvio deve repetir o mesmo alerta').toBe(1)
  })

  it('AC-T11-05 falha permanente: no máximo 3 tentativas, erro logado e delivery_failed emitido', async () => {
    const { wh, received, secret } = await httpWebhook(ctx)
    ctx.http.defaultStatus = 500
    const sid = sessionId()
    const r = await ctx.service().notify({ type: 'health_degraded', sessionId: sid })
    await new Promise((res) => setTimeout(res, 100))
    expect(received().length, 'máx. 3 tentativas').toBe(3)
    expect(r.deliveries[0]).toMatchObject({ webhookId: wh.id, ok: false, attempts: 3 })
    expect(typeof r.deliveries[0].error).toBe('string')

    const lines = logsWith(wh.id)
    expect(lines.length, 'falha de entrega deve ser logada com o webhookId').toBeGreaterThan(0)
    expect(lines.some((l) => /"level":(40|50)/.test(l)), `log warn/error esperado:\n${lines.join('\n')}`).toBe(true)
    expect(ctx.logs.join('\n'), 'segredo do webhook vazou no log').not.toContain(secret)

    expect(ctx.failed.some((f) => f.webhookId === wh.id && f.event === 'health_degraded' && f.attempts === 3), JSON.stringify(ctx.failed)).toBe(true)
  })

  it('AC-T11-05 destino inacessível (conexão recusada) não lança e não derruba o processo', async () => {
    const port = await deadPort()
    const token = `9:${randomBytes(6).toString('hex')}`
    const dead = await createWebhook(ctx, { channel: 'http', url: `http://127.0.0.1:${port}/nada`, secret: 's' })
    const deadTg = await createWebhook(ctx, { channel: 'telegram', url: `http://127.0.0.1:${port}`, secret: token, config: { chatId: '1' } })
    const deadMail = await createWebhook(ctx, { channel: 'email', url: `smtp://127.0.0.1:${port}`, config: { to: 'x@example.test' } })
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUnhandled)
    try {
      const alerts = ctx.service()
      const r = await alerts.notify({ type: 'disconnected', sessionId: sessionId() })
      const byId = new Map(r.deliveries.map((d: any) => [d.webhookId, d]))
      for (const w of [dead, deadTg, deadMail]) expect(byId.get(w.id), `${w.channel}`).toMatchObject({ ok: false, attempts: 3 })
      await alerts.whenIdle?.()
      await new Promise((res) => setTimeout(res, 200))
      expect(unhandled, 'erro não tratado escapou').toEqual([])
      expect(ctx.logs.join('\n')).not.toContain(token)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUnhandled)
    }
  })

  it('AC-T11-05 um webhook com falha não impede a entrega aos outros, e o serviço segue funcionando', async () => {
    const port = await deadPort()
    await createWebhook(ctx, { channel: 'http', url: `http://127.0.0.1:${port}/nada`, secret: 's' })
    const ok = await httpWebhook(ctx)
    const alerts = ctx.service()
    const r1 = await alerts.notify({ type: 'error_burst', sessionId: sessionId() })
    expect(r1.deliveries.filter((d: any) => d.ok).length).toBe(1)
    expect(ok.received().length).toBe(1)
    const r2 = await alerts.notify({ type: 'warmup_paused', sessionId: sessionId() })
    expect(r2.deliveries.filter((d: any) => d.ok).length).toBe(1)
    expect(ok.received().length).toBe(2)
  })

  it('AC-T11-05 timeout do destino conta como falha e é reenviado (sem pendurar)', async () => {
    const net = await import('node:net')
    const hang = net.createServer((s) => s.on('error', () => {})) // aceita e nunca responde
    await new Promise<void>((res) => hang.listen(0, '127.0.0.1', res))
    const port = (hang.address() as any).port
    try {
      const wh = await createWebhook(ctx, { channel: 'http', url: `http://127.0.0.1:${port}/lento`, secret: 's' })
      const started = Date.now()
      const r = await ctx.service({ timeoutMs: 300 }).notify({ type: 'forbidden_403', sessionId: sessionId() })
      expect(r.deliveries.find((d: any) => d.webhookId === wh.id)).toMatchObject({ ok: false, attempts: 3 })
      expect(Date.now() - started, 'notify pendurou').toBeLessThan(20_000)
    } finally {
      hang.close()
    }
  })
})
