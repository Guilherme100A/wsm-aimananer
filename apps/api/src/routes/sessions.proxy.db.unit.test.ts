// T17: /api/sessions com proxy inline e PATCH sobre Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { generateCredentialsKey, resetCredentialsCrypto } from '@wsm/core'
import { auditLogs, createDb, createTempDatabase, proxies, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'sess-token'
let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_sessions_proxy' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(proxies)
  await db.delete(auditLogs)
})

function api() {
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, auth: { password: 'x', secret: 'y' } })
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : undefined } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

const proxy = { protocol: 'socks5', host: '10.0.0.5', port: 1080, username: 'u', password: 'sup3r-s3cret' }
const newSession = (over: Record<string, unknown> = {}) => ({ name: 'Comercial', phone: '+5511999990001', note: 'obs', proxy, ...over })

describe('POST /api/sessions com proxy inline', () => {
  it('201 com a view + proxy (sem senha em lugar nenhum da resposta)', async () => {
    const req = api()
    const r = await req('POST', '/api/sessions', newSession())
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ name: 'Comercial', note: 'obs', requiresRestart: false })
    expect(r.json!.proxy).toEqual({ id: r.json!.proxyId, protocol: 'socks5', host: '10.0.0.5', port: 1080, username: 'u', hasPassword: true })
    expect(r.text).not.toContain('sup3r-s3cret')
    expect(r.text).not.toMatch(/ciphertext|authTag|password_/i)
  })

  it('sem proxy → proxy null; proxy + proxyId → 400; proxy inválido → 400 e nada gravado', async () => {
    const req = api()
    expect((await req('POST', '/api/sessions', newSession({ proxy: undefined }))).json).toMatchObject({ proxy: null, proxyId: null })
    const both = await req('POST', '/api/sessions', newSession({ proxyId: '00000000-0000-4000-8000-000000000000' }))
    expect(both.status).toBe(400)
    expect(both.json!.error.code).toBe('VALIDATION_ERROR')
    for (const bad of [
      { ...proxy, protocol: 'ftp' },
      { ...proxy, host: '' },
      { ...proxy, port: 0 },
      { ...proxy, port: 70000 },
      { ...proxy, port: 12.5 },
      { ...proxy, host: 'a b' },
    ]) {
      const r = await req('POST', '/api/sessions', newSession({ phone: '+5511999990002', proxy: bad }))
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(r.json!.error.code).toBe('VALIDATION_ERROR')
    }
    expect(await db.select().from(sessions)).toHaveLength(1)
    expect(await db.select().from(proxies)).toHaveLength(0)
  })

  it('GET lista e GET /:id trazem o proxy', async () => {
    const req = api()
    const created = (await req('POST', '/api/sessions', newSession())).json!
    await req('POST', '/api/sessions', newSession({ phone: '+5511999990002', proxy: undefined }))
    const list = (await req('GET', '/api/sessions')).json!.items as Array<{ id: string; proxy: unknown }>
    expect(list.find((s) => s.id === created.id)!.proxy).toMatchObject({ host: '10.0.0.5', hasPassword: true })
    expect(list.filter((s) => s.proxy === null)).toHaveLength(1)
    const one = await req('GET', `/api/sessions/${created.id}`)
    expect(one.json!.proxy).toMatchObject({ protocol: 'socks5', port: 1080 })
    expect(one.text).not.toContain('sup3r-s3cret')
  })
})

describe('PATCH /api/sessions/:id', () => {
  it('troca o proxy: requiresRestart, proxy antigo apagado e auditoria session.update', async () => {
    const req = api()
    const s = (await req('POST', '/api/sessions', newSession())).json!
    const r = await req('PATCH', `/api/sessions/${s.id}`, { proxy: { protocol: 'http', host: '10.0.0.9', port: 3128, username: 'u' } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ id: s.id, requiresRestart: true, proxy: { protocol: 'http', host: '10.0.0.9', port: 3128, hasPassword: true } })
    expect(r.json!.proxyId).not.toBe(s.proxyId)
    expect(await db.select().from(proxies).where(eq(proxies.id, s.proxyId))).toHaveLength(0)
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'session.update'))
    expect(audit).toMatchObject({ targetType: 'session', targetId: s.id })
    expect(audit!.detail).toMatchObject({ proxyChanged: true, previousProxyId: s.proxyId, requiresRestart: true })
  })

  it('só nome/nota não marca restart; remover proxy (null) marca', async () => {
    const req = api()
    const s = (await req('POST', '/api/sessions', newSession())).json!
    expect((await req('PATCH', `/api/sessions/${s.id}`, { name: 'Novo', note: null })).json).toMatchObject({ name: 'Novo', note: null, requiresRestart: false })
    const r = await req('PATCH', `/api/sessions/${s.id}`, { proxy: null })
    expect(r.json).toMatchObject({ proxy: null, proxyId: null, requiresRestart: true })
    expect(await db.select().from(proxies)).toHaveLength(0)
  })

  it('404 SESSION_NOT_FOUND; 400 para proxy inválido, proxyId, corpo vazio', async () => {
    const req = api()
    const s = (await req('POST', '/api/sessions', newSession())).json!
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      const r = await req('PATCH', `/api/sessions/${id}`, { name: 'x' })
      expect(r.status).toBe(404)
      expect(r.json!.error.code).toBe('SESSION_NOT_FOUND')
    }
    for (const body of [{ proxy: { ...proxy, port: -1 } }, { proxyId: s.proxyId }, {}, { name: '' }]) {
      const r = await req('PATCH', `/api/sessions/${s.id}`, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect((await req('GET', `/api/sessions/${s.id}`)).json).toMatchObject({ name: 'Comercial', proxyId: s.proxyId, requiresRestart: false })
  })

  it('rotas /api/proxies continuam funcionando', async () => {
    const req = api()
    const s = (await req('POST', '/api/sessions', newSession())).json!
    const list = await req('GET', '/api/proxies')
    expect(list.status).toBe(200)
    expect((list.json!.items as Array<{ id: string; sessionId: string }>)[0]).toMatchObject({ id: s.proxyId, sessionId: s.id })
  })
})
