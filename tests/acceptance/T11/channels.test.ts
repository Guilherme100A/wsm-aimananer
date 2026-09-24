// AC-T11-02: canais Discord, Telegram (bot API), email (SMTP) e webhook HTTP genérico, configurados na
// tabela webhooks (CRUD em /api/webhooks). Segredos cifrados e nunca devolvidos pela API.
import { randomBytes, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { api, createWebhook, disableAllWebhooks, httpWebhook, listOf, sessionId, useAlerts, webhookRow } from './shared'

const PUBLIC_FIELDS = ['id', 'name', 'channel', 'url', 'config', 'events', 'enabled', 'hasSecret', 'createdAt', 'updatedAt']

describe('T11 — CRUD /api/webhooks', () => {
  const ctx = useAlerts()

  it('AC-T11-02 POST cria webhook (201) sem devolver o segredo; GET lista e detalha', async () => {
    const secret = `whsec_${randomBytes(12).toString('hex')}`
    const res = await api(ctx, 'POST', '/api/webhooks', { name: 'ops', channel: 'http', url: `${ctx.http.url}/crud`, secret, events: ['forbidden_403'] })
    expect(res.status, res.text).toBe(201)
    for (const f of PUBLIC_FIELDS) expect(res.body, `campo ${f}`).toHaveProperty(f)
    expect(res.body).toMatchObject({ name: 'ops', channel: 'http', url: `${ctx.http.url}/crud`, events: ['forbidden_403'], enabled: true, hasSecret: true })
    expect(res.body).not.toHaveProperty('secret')
    expect(res.text).not.toContain(secret)

    const one = await api(ctx, 'GET', `/api/webhooks/${res.body.id}`)
    expect(one.status, one.text).toBe(200)
    expect(one.body).toMatchObject({ id: res.body.id, channel: 'http', hasSecret: true })
    expect(one.text).not.toContain(secret)

    const list = await api(ctx, 'GET', '/api/webhooks')
    expect(list.status, list.text).toBe(200)
    expect(listOf(list.body).map((w: any) => w.id)).toContain(res.body.id)
    expect(list.text).not.toContain(secret)
  })

  it('AC-T11-02 segredo e bot token ficam cifrados na tabela webhooks (nunca em texto puro)', async () => {
    const secret = `whsec_${randomBytes(12).toString('hex')}`
    const token = `123456:${randomBytes(12).toString('hex')}`
    const a = await createWebhook(ctx, { channel: 'http', url: `${ctx.http.url}/x`, secret })
    const b = await createWebhook(ctx, { channel: 'telegram', url: ctx.http.url, secret: token, config: { chatId: '-100123' } })
    for (const [id, plain] of [
      [a.id, secret],
      [b.id, token],
    ] as const) {
      const row = webhookRow(ctx, id)
      expect(row, 'linha do webhook').not.toBe('')
      expect(row, 'segredo em texto puro no banco').not.toContain(plain)
      expect(row, 'segredo em base64 simples no banco').not.toContain(Buffer.from(plain).toString('base64'))
    }
  })

  it('AC-T11-02 PATCH atualiza parcialmente (enabled, events, secret) e DELETE remove (204 → 404)', async () => {
    const wh = await createWebhook(ctx, { channel: 'discord', url: `${ctx.http.url}/discord-crud` })
    expect(wh.hasSecret).toBe(false)
    const newSecret = `rot_${randomBytes(8).toString('hex')}`
    const p = await api(ctx, 'PATCH', `/api/webhooks/${wh.id}`, { enabled: false, events: ['disconnected', 'error_burst'], secret: newSecret })
    expect(p.status, p.text).toBe(200)
    expect(p.body).toMatchObject({ id: wh.id, enabled: false, events: ['disconnected', 'error_burst'], hasSecret: true, channel: 'discord' })
    expect(p.text).not.toContain(newSecret)
    expect(webhookRow(ctx, wh.id)).not.toContain(newSecret)

    const d = await api(ctx, 'DELETE', `/api/webhooks/${wh.id}`)
    expect(d.status, d.text).toBe(204)
    expectApiError(await api(ctx, 'GET', `/api/webhooks/${wh.id}`), 'NOT_FOUND', 404)
    expectApiError(await api(ctx, 'PATCH', `/api/webhooks/${wh.id}`, { enabled: true }), 'NOT_FOUND', 404)
    expectApiError(await api(ctx, 'DELETE', `/api/webhooks/${randomUUID()}`), 'NOT_FOUND', 404)
  })

  it('AC-T11-02 validação: canal, URL e evento inválidos → 400 VALIDATION_ERROR; sem token → 401', async () => {
    const bad = [
      { name: 'x', channel: 'sms', url: `${ctx.http.url}/x` },
      { name: 'x', channel: 'http', url: 'nao-e-url', secret: 's' },
      { name: 'x', channel: 'http', url: `${ctx.http.url}/x`, secret: 's', events: ['message_sent'] },
      { channel: 'http', url: `${ctx.http.url}/x`, secret: 's' },
    ]
    for (const body of bad) expectApiError(await api(ctx, 'POST', '/api/webhooks', body), 'VALIDATION_ERROR', 400)
    expectApiError(await call(ctx.app, 'GET', '/api/webhooks'), 'UNAUTHORIZED', 401)
    expectApiError(await call(ctx.app, 'POST', '/api/webhooks', { body: { name: 'x', channel: 'discord', url: `${ctx.http.url}/x` } }), 'UNAUTHORIZED', 401)
  })
})

describe('T11 — entrega por canal', () => {
  const ctx = useAlerts()
  beforeEach(() => disableAllWebhooks(ctx))

  it('AC-T11-02 webhook HTTP genérico: POST JSON { event, sessionId, at, detail }', async () => {
    const { received } = await httpWebhook(ctx)
    const sid = sessionId()
    const r = await ctx.service().notify({ type: 'health_degraded', sessionId: sid, detail: { score: 55 } })
    expect(r.deliveries.map((d: any) => d.ok)).toEqual([true])
    const [req] = received()
    expect(req, 'webhook http não recebeu').toBeTruthy()
    expect(req!.headers['content-type']).toMatch(/application\/json/)
    expect(req!.json).toMatchObject({ event: 'health_degraded', sessionId: sid, detail: { score: 55 } })
  })

  it('AC-T11-02 Discord: POST na URL do webhook com { content } citando o evento e a sessão', async () => {
    const path = `/api/webhooks/123/discord-${randomBytes(3).toString('hex')}`
    await createWebhook(ctx, { channel: 'discord', url: `${ctx.http.url}${path}` })
    const sid = sessionId()
    const r = await ctx.service().notify({ type: 'forbidden_403', sessionId: sid })
    expect(r.deliveries.map((d: any) => d.ok), JSON.stringify(r)).toEqual([true])
    const [req] = ctx.http.on(path)
    expect(req, 'Discord não recebeu').toBeTruthy()
    expect(req!.method).toBe('POST')
    expect(typeof req!.json?.content).toBe('string')
    expect(req!.json.content).toContain('forbidden_403')
    expect(req!.json.content).toContain(sid)
  })

  it('AC-T11-02 Telegram: POST {base}/bot<token>/sendMessage com { chat_id, text }', async () => {
    const token = `4242:${randomBytes(8).toString('hex')}`
    await createWebhook(ctx, { channel: 'telegram', url: ctx.http.url, secret: token, config: { chatId: '-1009876' } })
    const sid = sessionId()
    const r = await ctx.service({ telegramBaseUrl: ctx.http.url }).notify({ type: 'warmup_paused', sessionId: sid })
    expect(r.deliveries.map((d: any) => d.ok), JSON.stringify(r)).toEqual([true])
    const [req] = ctx.http.on(`/bot${token}/sendMessage`)
    expect(req, `Telegram não recebeu; requisições: ${ctx.http.requests.map((x) => x.path).join(', ')}`).toBeTruthy()
    expect(req!.method).toBe('POST')
    expect(String(req!.json?.chat_id)).toBe('-1009876')
    expect(req!.json.text).toContain('warmup_paused')
    expect(req!.json.text).toContain(sid)
  })

  it('AC-T11-02 email (SMTP): mensagem para config.to com o evento no assunto e a sessão no texto', async () => {
    const to = `ops-${randomBytes(3).toString('hex')}@example.test`
    await createWebhook(ctx, { channel: 'email', url: ctx.smtp.url, config: { to } })
    const sid = sessionId()
    const r = await ctx.service({ smtpUrl: ctx.smtp.url }).notify({ type: 'error_burst', sessionId: sid })
    expect(r.deliveries.map((d: any) => d.ok), JSON.stringify(r)).toEqual([true])
    const mail = ctx.smtp.mails.find((m) => m.to.includes(to))
    expect(mail, 'SMTP não recebeu o email').toBeTruthy()
    expect(mail!.data).toMatch(/^Subject:.*error_burst/im)
    expect(mail!.data).toContain(sid)
  })

  it('AC-T11-02 um alerta chega a todos os canais habilitados de uma vez', async () => {
    const sid = sessionId()
    const token = `77:${randomBytes(6).toString('hex')}`
    const to = `all-${randomBytes(3).toString('hex')}@example.test`
    const h = await httpWebhook(ctx)
    const dpath = `/discord-all-${randomBytes(3).toString('hex')}`
    await createWebhook(ctx, { channel: 'discord', url: `${ctx.http.url}${dpath}` })
    await createWebhook(ctx, { channel: 'telegram', url: ctx.http.url, secret: token, config: { chatId: '1' } })
    await createWebhook(ctx, { channel: 'email', url: ctx.smtp.url, config: { to } })
    const r = await ctx.service({ telegramBaseUrl: ctx.http.url, smtpUrl: ctx.smtp.url }).notify({ type: 'disconnected', sessionId: sid })
    expect(r.deliveries.length).toBe(4)
    expect(r.deliveries.every((d: any) => d.ok), JSON.stringify(r.deliveries)).toBe(true)
    expect(h.received().length).toBe(1)
    expect(ctx.http.on(dpath).length).toBe(1)
    expect(ctx.http.on(`/bot${token}/sendMessage`).length).toBe(1)
    expect(ctx.smtp.mails.filter((m) => m.to.includes(to)).length).toBe(1)
  })
})
