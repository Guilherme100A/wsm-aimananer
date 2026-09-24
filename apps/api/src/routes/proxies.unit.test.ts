// /api/proxies contra Postgres local (banco descartável).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { generateCredentialsKey, resetCredentialsCrypto } from '@wsm/core'
import { auditLogs, createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp, type App } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'proxy-token'
let tmp: TempDatabase
let db: Database
let app: App
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_proxies' })
  db = createDb(tmp.url, { max: 3 })
  app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : undefined }
}

async function newSession(name: string) {
  const [s] = await db.insert(sessions).values({ name, phone: '+5511900000000' }).returning()
  return s!.id
}

describe('/api/proxies', () => {
  it('CRUD com URL mascarada e sem senha na resposta', async () => {
    const created = await call('POST', '/api/proxies', { url: 'http://joe:TOPSECRET@1.2.3.4:8080', name: 'p' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ url: 'http://joe:***@1.2.3.4:8080', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'joe', sessionId: null })
    expect(created.text).not.toContain('TOPSECRET')
    const id = created.body.id as string

    const list = await call('GET', '/api/proxies')
    expect(list.status).toBe(200)
    expect(list.body.items.map((p: { id: string }) => p.id)).toContain(id)
    expect(list.text).not.toContain('TOPSECRET')

    const patched = await call('PATCH', `/api/proxies/${id}`, { url: 'socks5://joe:NEWSECRET@5.6.7.8:1080' })
    expect(patched.status).toBe(200)
    expect(patched.body.url).toBe('socks5://joe:***@5.6.7.8:1080')

    expect((await call('GET', `/api/proxies/${id}`)).status).toBe(200)
    expect((await call('DELETE', `/api/proxies/${id}`)).status).toBe(204)
    const gone = await call('GET', `/api/proxies/${id}`)
    expect(gone.status).toBe(404)
    expect(gone.body.error.code).toBe('NOT_FOUND')
    expect((await call('GET', '/api/proxies/not-a-uuid')).status).toBe(404)
  })

  it('URL inválida → 400 VALIDATION_ERROR no campo url', async () => {
    const r = await call('POST', '/api/proxies', { url: 'ftp://h:21' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('VALIDATION_ERROR')
    expect(r.body.error.details.issues[0].path).toBe('url')
  })

  it('vínculo, conflito 409 PROXY_IN_USE e troca auditada com requires_restart', async () => {
    const [p1, p2] = [
      (await call('POST', '/api/proxies', { url: 'http://h1:1' })).body.id as string,
      (await call('POST', '/api/proxies', { url: 'http://h2:2' })).body.id as string,
    ]
    const [s1, s2] = [await newSession('s1'), await newSession('s2')]

    const bound = await call('PUT', `/api/proxies/${p1}/session`, { sessionId: s1 })
    expect(bound.status).toBe(200)
    expect(bound.body).toMatchObject({ sessionId: s1, requiresRestart: true })

    const conflict = await call('PUT', `/api/proxies/${p1}/session`, { sessionId: s2 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('PROXY_IN_USE')
    expect((await call('DELETE', `/api/proxies/${p1}`)).body.error.code).toBe('PROXY_IN_USE')

    await db.update(sessions).set({ requiresRestart: false }).where(eq(sessions.id, s1))
    const swap = await call('PUT', `/api/proxies/${p2}/session`, { sessionId: s1 })
    expect(swap.status).toBe(200)
    expect(swap.body.lastChangedAt).toBeTruthy()
    const [s] = await db.select().from(sessions).where(eq(sessions.id, s1))
    expect(s).toMatchObject({ proxyId: p2, requiresRestart: true, status: 'NEW' })

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, s1))
    expect(audits.map((a) => a.action)).toEqual(['session.proxy_change', 'session.proxy_change'])
    expect(audits[1]?.detail).toMatchObject({ proxyId: p2, previousProxyId: p1 })

    const missing = await call('PUT', `/api/proxies/${p1}/session`, { sessionId: '00000000-0000-4000-8000-000000000000' })
    expect(missing.body.error.code).toBe('SESSION_NOT_FOUND')

    const unbound = await call('DELETE', `/api/proxies/${p2}/session`)
    expect(unbound.status).toBe(200)
    expect(unbound.body.sessionId).toBeNull()
  })

  it('exige auth', async () => {
    expect((await app.request('/api/proxies')).status).toBe(401)
  })
})
