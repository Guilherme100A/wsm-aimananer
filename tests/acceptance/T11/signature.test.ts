// AC-T11-03: webhook HTTP genérico envia x-wsm-signature = HMAC-SHA256 do body com o segredo do webhook.
import { createHmac, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, disableAllWebhooks, httpWebhook, sessionId, sign, useAlerts } from './shared'

const hmac = (body: string, secret: string) => createHmac('sha256', secret).update(body, 'utf8').digest('hex')
const sig = (h: string | string[] | undefined) => String(h ?? '').replace(/^sha256=/, '')

describe('T11 — assinatura HMAC do webhook genérico', () => {
  const ctx = useAlerts()
  beforeEach(() => disableAllWebhooks(ctx))

  it('AC-T11-03 signWebhookBody calcula HMAC-SHA256 hex do body com o segredo', () => {
    const body = '{"event":"forbidden_403","sessionId":"abc"}'
    expect(sign(body, 'segredo')).toBe(hmac(body, 'segredo'))
    expect(sign(body, 'outro')).not.toBe(sign(body, 'segredo'))
    expect(sign(`${body} `, 'segredo')).not.toBe(sign(body, 'segredo'))
  })

  it('AC-T11-03 header x-wsm-signature confere com o HMAC-SHA256 do body cru recebido', async () => {
    const { received, secret } = await httpWebhook(ctx)
    await ctx.service().notify({ type: 'forbidden_403', sessionId: sessionId(), detail: { statusCode: 403, nota: 'acentuação ✓' } })
    const [req] = received()
    expect(req, 'webhook não recebeu').toBeTruthy()
    const header = req!.headers['x-wsm-signature']
    expect(header, 'header x-wsm-signature ausente').toBeTruthy()
    expect(sig(header)).toBe(hmac(req!.raw, secret))
    expect(sig(header)).not.toBe(hmac(req!.raw, `${secret}x`))
  })

  it('AC-T11-03 cada webhook assina com o próprio segredo; trocar o segredo (PATCH) muda a assinatura', async () => {
    const a = await httpWebhook(ctx)
    const b = await httpWebhook(ctx)
    const alerts = ctx.service()
    await alerts.notify({ type: 'health_degraded', sessionId: sessionId() })
    const ra = a.received()[0]!
    const rb = b.received()[0]!
    expect(sig(ra.headers['x-wsm-signature'])).toBe(hmac(ra.raw, a.secret))
    expect(sig(rb.headers['x-wsm-signature'])).toBe(hmac(rb.raw, b.secret))

    const rotated = `rot_${randomBytes(10).toString('hex')}`
    const p = await api(ctx, 'PATCH', `/api/webhooks/${a.wh.id}`, { secret: rotated })
    expect(p.status, p.text).toBe(200)
    await alerts.notify({ type: 'health_degraded', sessionId: sessionId() })
    const ra2 = a.received()[1]!
    expect(ra2, 'segunda entrega não recebida').toBeTruthy()
    expect(sig(ra2.headers['x-wsm-signature'])).toBe(hmac(ra2.raw, rotated))
  })
})
