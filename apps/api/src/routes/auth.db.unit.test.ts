// /api/auth + bearer com token de login (T17) sobre Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { auditLogs, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import type { AuthOptions } from '../auth'
import { captureLogger, fakeRedis } from '../test-utils'

const API_TOKEN = 'integration-token'
let tmp: TempDatabase
let db: Database
let now: Date

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_auth' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(auditLogs)
  now = new Date('2026-03-01T12:00:00Z')
})

function setup(auth: AuthOptions = {}) {
  const log = captureLogger()
  const app = createApp({
    db,
    redis: fakeRedis(),
    logger: log.logger,
    apiToken: API_TOKEN,
    auth: { secret: 'shared-secret-0123456789', password: 'nimda', now: () => now, trustProxy: true, ...auth },
  })
  const req = (method: string, path: string, opts: { body?: unknown; token?: string; ip?: string } = {}) =>
    app.request(path, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  const login = async (username = 'admin', password = 'nimda', ip = '10.0.0.1') => req('POST', '/api/auth/login', { body: { username, password }, ip })
  return { app, req, login, lines: log.lines }
}

const errCode = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error

describe('POST /api/auth/login', () => {
  it('é público; credenciais certas → 200 {token, expiresAt, user}; auditado sem a senha', async () => {
    const { login } = setup()
    const res = await login()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; expiresAt: string; user: unknown }
    expect(body.user).toEqual({ username: 'admin', role: 'admin' })
    expect(body.expiresAt).toBe(new Date(now.getTime() + 12 * 3600_000).toISOString())
    expect(body.token).toMatch(/^wsm1\./)
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.login'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'admin', detail: expect.objectContaining({ username: 'admin', success: true }) })
    expect(JSON.stringify(rows)).not.toContain('nimda')
  })

  it('usuário ou senha errados → 401 UNAUTHORIZED com a mesma mensagem; falha auditada sem senha', async () => {
    const { login } = setup()
    const a = await login('admin', 'wrong-pass')
    const b = await login('nobody', 'nimda')
    expect([a.status, b.status]).toEqual([401, 401])
    const [ea, eb] = [await errCode(a), await errCode(b)]
    expect(ea).toEqual({ code: 'UNAUTHORIZED', message: 'invalid username or password' })
    expect(eb).toEqual(ea)
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.login'))
    expect(rows.map((r) => (r.detail as { success: boolean }).success)).toEqual([false, false])
    expect(JSON.stringify(rows)).not.toContain('wrong-pass')
  })

  it('5 falhas pelo mesmo IP → 429 RATE_LIMIT (mesmo com a senha certa); outro IP não é afetado', async () => {
    const { login } = setup()
    for (let i = 0; i < 5; i++) expect((await login('admin', 'x', '7.7.7.7')).status).toBe(401)
    const blocked = await login('admin', 'nimda', '7.7.7.7')
    expect(blocked.status).toBe(429)
    expect((await errCode(blocked)).code).toBe('RATE_LIMIT')
    expect((await login('admin', 'nimda', '7.7.7.8')).status).toBe(200)
    now = new Date(now.getTime() + 15 * 60_000)
    expect((await login('admin', 'nimda', '7.7.7.7')).status).toBe(200)
  })

  it('body inválido → 400 VALIDATION_ERROR', async () => {
    const { req } = setup()
    const res = await req('POST', '/api/auth/login', { body: { username: 'admin' } })
    expect(res.status).toBe(400)
    expect((await errCode(res)).code).toBe('VALIDATION_ERROR')
  })
})

describe('bearer em /api/*', () => {
  it('aceita token de login e API_TOKEN; sem token/lixo → 401', async () => {
    const { req, login } = setup()
    const { token } = (await (await login()).json()) as { token: string }
    expect((await req('GET', '/api/webhooks', { token })).status).toBe(200)
    expect((await req('GET', '/api/webhooks', { token: API_TOKEN })).status).toBe(200)
    expect((await req('GET', '/api/webhooks')).status).toBe(401)
    expect((await req('GET', '/api/webhooks', { token: 'wsm1.lixo.lixo' })).status).toBe(401)
  })

  it('actor da auditoria é o usuário logado', async () => {
    const { req, login } = setup()
    const { token } = (await (await login()).json()) as { token: string }
    await req('POST', '/api/webhooks', { token, body: { name: 'd', channel: 'discord', url: 'https://example.com/x' } })
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'webhook.create'))
    expect(row?.actor).toBe('admin')
  })

  it('expirado, adulterado ou de outro segredo → 401; mesmo segredo em outro app → aceito', async () => {
    const { req, login } = setup({ sessionTtlMs: 60_000 })
    const { token } = (await (await login()).json()) as { token: string }
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    expect((await req('GET', '/api/auth/me', { token: tampered })).status).toBe(401)
    expect((await setup().req('GET', '/api/auth/me', { token })).status).toBe(200)
    expect((await setup({ secret: 'different-secret-000000' }).req('GET', '/api/auth/me', { token })).status).toBe(401)
    now = new Date(now.getTime() + 60_000)
    expect((await req('GET', '/api/auth/me', { token })).status).toBe(401)
  })
})

describe('me / logout', () => {
  it('me devolve o usuário; logout revoga só aquele token (204)', async () => {
    const { req, login } = setup()
    const a = ((await (await login()).json()) as { token: string }).token
    const b = ((await (await login()).json()) as { token: string }).token
    const me = await req('GET', '/api/auth/me', { token: a })
    expect(await me.json()).toEqual({ user: { username: 'admin', role: 'admin' }, expiresAt: expect.any(String) })
    expect(await (await req('GET', '/api/auth/me', { token: API_TOKEN })).json()).toEqual({
      user: { username: 'api_token', role: 'integration' },
      expiresAt: null,
    })
    expect((await req('POST', '/api/auth/logout', { token: a })).status).toBe(204)
    expect((await req('GET', '/api/auth/me', { token: a })).status).toBe(401)
    expect((await req('GET', '/api/auth/me', { token: b })).status).toBe(200)
    expect((await req('POST', '/api/auth/logout')).status).toBe(401)
  })
})

describe('warns de configuração', () => {
  it('senha e segredo default geram um warn cada no createApp', () => {
    const prev = { p: process.env.ADMIN_PASSWORD, s: process.env.AUTH_SECRET }
    delete process.env.ADMIN_PASSWORD
    delete process.env.AUTH_SECRET
    try {
      const log = captureLogger()
      createApp({ db, redis: fakeRedis(), logger: log.logger, apiToken: API_TOKEN })
      const warns = log.lines.filter((l) => l.level === 40).map((l) => String(l.msg))
      expect(warns.filter((m) => m.includes('ADMIN_PASSWORD'))).toHaveLength(1)
      expect(warns.filter((m) => m.includes('AUTH_SECRET'))).toHaveLength(1)
      const quiet = captureLogger()
      createApp({ db, redis: fakeRedis(), logger: quiet.logger, apiToken: API_TOKEN, auth: { password: 'x', secret: 'y' } })
      expect(quiet.lines.filter((l) => l.level === 40)).toHaveLength(0)
    } finally {
      if (prev.p !== undefined) process.env.ADMIN_PASSWORD = prev.p
      if (prev.s !== undefined) process.env.AUTH_SECRET = prev.s
    }
  })
})

describe('IP do limite de tentativas (REJECT ciclo 1: x-forwarded-for só com TRUST_PROXY)', () => {
  it('trustProxy desligado: x-forwarded-for é ignorado; trocar o header não escapa do 429', async () => {
    const { login } = setup({ trustProxy: false })
    for (let i = 0; i < 5; i++) expect((await login('admin', 'x', `1.2.3.${i}`)).status).toBe(401)
    expect((await login('admin', 'nimda', '9.9.9.9')).status).toBe(429)
  })

  it('trustProxy ligado: vale o valor mais à direita (o escrito pelo proxy de confiança)', async () => {
    const { req } = setup()
    const attempt = (xff: string, password = 'x') =>
      req('POST', '/api/auth/login', { body: { username: 'admin', password }, ip: xff })
    // O cliente varia o prefixo; o proxy anexa o IP real (5.5.5.5) no fim.
    for (let i = 0; i < 5; i++) expect((await attempt(`spoof-${i}, 5.5.5.5`)).status).toBe(401)
    expect((await attempt('outro, 5.5.5.5', 'nimda')).status).toBe(429)
    expect((await attempt('5.5.5.5, 6.6.6.6', 'nimda')).status).toBe(200)
  })

  it('TRUST_PROXY vem do ambiente quando deps.auth não define', async () => {
    const prev = process.env.TRUST_PROXY
    try {
      process.env.TRUST_PROXY = 'true'
      const on = setup({ trustProxy: undefined })
      // IPs distintos pelo header: nenhum acumula 5 falhas.
      for (let i = 0; i < 6; i++) expect((await on.login('admin', 'x', `3.3.3.${i}`)).status).toBe(401)
      process.env.TRUST_PROXY = 'false'
      const off = setup({ trustProxy: undefined })
      for (let i = 0; i < 5; i++) expect((await off.login('admin', 'x', `4.4.4.${i}`)).status).toBe(401)
      expect((await off.login('admin', 'x', '4.4.4.99')).status).toBe(429)
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY
      else process.env.TRUST_PROXY = prev
    }
  })

  it('servidor HTTP real: sem TRUST_PROXY usa o IP da conexão (getConnInfo)', async () => {
    const { app } = setup({ trustProxy: false })
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((r) => server.once('listening', () => r()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const attempt = (i: number, password = 'x') =>
        fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}` },
          body: JSON.stringify({ username: 'admin', password }),
        })
      for (let i = 0; i < 5; i++) expect((await attempt(i)).status).toBe(401)
      expect((await attempt(99, 'nimda')).status).toBe(429)
      const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'auth.login'))
      expect(rows.map((r) => (r.detail as { ip: string }).ip)).toContain('127.0.0.1')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
