// /api/webhooks com Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateCredentialsKey, resetCredentialsCrypto, type DeliveryResult } from '@wsm/core'
import { createDb, createTempDatabase, webhooks, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'
import type { WebhookTester } from './webhooks'

const TOKEN = 'wh-token'
let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY
const delivered: Array<{ id: string; secret: string | null; type: string }> = []

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_webhooks' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

beforeEach(async () => {
  await db.delete(webhooks)
  delivered.length = 0
})

const tester: WebhookTester = {
  deliver: async (w, e): Promise<DeliveryResult> => {
    delivered.push({ id: w.id, secret: w.secret, type: e.type })
    return w.name === 'broken'
      ? { webhookId: w.id, channel: w.channel, ok: false, attempts: 1, error: 'HTTP 500' }
      : { webhookId: w.id, channel: w.channel, ok: true, attempts: 1 }
  },
}

function api() {
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, alertDelivery: tester })
  return (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
}

const httpHook = { name: 'h', channel: 'http', url: 'https://example.com/hook', secret: 'plain-secret', events: ['forbidden_403'] }

describe('/api/webhooks', () => {
  it('CRUD completo sem nunca devolver o segredo', async () => {
    const req = api()
    const created = await req('POST', '/api/webhooks', httpHook)
    expect(created.status).toBe(201)
    const w = (await created.json()) as Record<string, unknown>
    expect(w).toMatchObject({ name: 'h', channel: 'http', url: 'https://example.com/hook', events: ['forbidden_403'], enabled: true, hasSecret: true, config: {} })
    expect(Object.keys(w).sort()).toEqual(['channel', 'config', 'createdAt', 'enabled', 'events', 'hasSecret', 'id', 'name', 'updatedAt', 'url'])

    const list = (await (await req('GET', '/api/webhooks')).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain('plain-secret')

    const patched = await req('PATCH', `/api/webhooks/${w.id}`, { enabled: false, secret: 'new-secret' })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ enabled: false, hasSecret: true })

    const [row] = await db.select().from(webhooks)
    expect(JSON.stringify(row)).not.toContain('new-secret')
    expect(JSON.stringify(row)).not.toContain('plain-secret')

    expect((await req('GET', `/api/webhooks/${w.id}`)).status).toBe(200)
    expect((await req('DELETE', `/api/webhooks/${w.id}`)).status).toBe(204)
    const gone = await req('GET', `/api/webhooks/${w.id}`)
    expect(gone.status).toBe(404)
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it.each([
    [{ ...httpHook, channel: 'sms' }],
    [{ ...httpHook, url: 'not-a-url' }],
    [{ ...httpHook, events: ['banana'] }],
    [{ ...httpHook, secret: undefined }],
    [{ name: 't', channel: 'telegram', url: 'https://api.telegram.org', secret: 'tok' }],
    [{ name: 'e', channel: 'email', url: 'smtp://h:25' }],
  ])('400 VALIDATION_ERROR: %o', async (body) => {
    const res = await api()('POST', '/api/webhooks', body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 para id inexistente/inválido e 401 sem token', async () => {
    const req = api()
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      expect((await req('GET', `/api/webhooks/${id}`)).status).toBe(404)
      expect((await req('PATCH', `/api/webhooks/${id}`, { name: 'x' })).status).toBe(404)
      expect((await req('DELETE', `/api/webhooks/${id}`)).status).toBe(404)
    }
    expect((await req('GET', '/api/webhooks', undefined, null)).status).toBe(401)
  })

  it('POST /:id/test entrega um alerta de teste com o segredo decifrado só em memória', async () => {
    const req = api()
    const w = (await (await req('POST', '/api/webhooks', httpHook)).json()) as { id: string }
    const res = await req('POST', `/api/webhooks/${w.id}/test`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, attempts: 1 })
    expect(delivered).toEqual([{ id: w.id, secret: 'plain-secret', type: 'health_degraded' }])
    const b = (await (await req('POST', '/api/webhooks', { ...httpHook, name: 'broken' })).json()) as { id: string }
    expect(await (await req('POST', `/api/webhooks/${b.id}/test`)).json()).toEqual({ ok: false, attempts: 1, error: 'HTTP 500' })
  })
})
