// AC-T17-03: POST /api/sessions aceita proxy inline (criado com senha cifrada e vinculado na mesma transação).
// AC-T17-05: GET /api/sessions e /:id trazem proxy { id, protocol, host, port, username, hasPassword } | null, nunca a senha.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { lit, sql, sqlOk } from '../helpers/pg'
import { api, listOf, randomPhone, useSessions } from '../T05/shared'

const count = (url: string, table: string, where = 'true') => Number(sqlOk(url, `SELECT count(*) FROM ${table} WHERE ${where};`)[0]![0])

const newProxy = (extra: Record<string, unknown> = {}) => ({
  protocol: 'socks5',
  host: `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  port: 1080 + Math.floor(Math.random() * 1000),
  username: `u${randomBytes(2).toString('hex')}`,
  password: `pw-${randomBytes(8).toString('hex')}`,
  ...extra,
})

describe('T17 — sessão com proxy inline', () => {
  const ctx = useSessions()
  const create = (body: Record<string, unknown>) => api(ctx, 'POST', '/api/sessions', { name: `s-${randomBytes(3).toString('hex')}`, phone: randomPhone(), ...body })

  it('AC-T17-03 POST com proxy inline cria o proxy (senha cifrada) e vincula à sessão', async () => {
    const p = newProxy()
    const res = await create({ note: 'com proxy', proxy: p })
    expect(res.status, res.text).toBe(201)
    expect(res.body.proxy).toEqual({ id: expect.any(String), protocol: p.protocol, host: p.host, port: p.port, username: p.username, hasPassword: true })
    expect(res.body.proxyId).toBe(res.body.proxy.id)
    expect(res.text, 'senha do proxy na resposta').not.toContain(p.password)

    const row = sqlOk(ctx.tempDb.url, `SELECT row_to_json(p)::text FROM proxies p WHERE id = ${lit(res.body.proxy.id)};`)[0]?.[0] ?? ''
    expect(row, 'proxy não gravado').not.toBe('')
    expect(row, 'senha do proxy em texto puro no banco').not.toContain(p.password)
    expect(sqlOk(ctx.tempDb.url, `SELECT proxy_id FROM sessions WHERE id = ${lit(res.body.id)};`)[0]![0]).toBe(res.body.proxy.id)
  })

  it('AC-T17-03 proxy sem usuário/senha e protocolos http/https/socks5', async () => {
    for (const protocol of ['http', 'https', 'socks5']) {
      const p = { protocol, host: `proxy-${protocol}.example.test`, port: 8080 }
      const res = await create({ proxy: p })
      expect(res.status, `${protocol}: ${res.text}`).toBe(201)
      expect(res.body.proxy).toMatchObject({ protocol, host: p.host, port: 8080, hasPassword: false })
      expect(res.body.proxy.username ?? null).toBeNull()
    }
  })

  it('AC-T17-03 sem proxy a sessão é criada sem proxy (como antes)', async () => {
    const res = await create({})
    expect(res.status, res.text).toBe(201)
    expect(res.body.proxy).toBeNull()
    expect(res.body.proxyId ?? null).toBeNull()
  })

  it('AC-T17-03 proxy inválido → 400 VALIDATION_ERROR e nada é gravado', async () => {
    const invalid = [
      { protocol: 'ftp', host: 'h.example.test', port: 21 },
      { protocol: 'http', host: '', port: 8080 },
      { protocol: 'http', host: 'h.example.test', port: 0 },
      { protocol: 'http', host: 'h.example.test', port: 70000 },
      { protocol: 'http', host: 'h.example.test', port: 80.5 },
      { protocol: 'http', host: 'h.example.test' },
      { protocol: 'socks5', port: 1080 },
    ]
    for (const proxy of invalid) {
      const name = `invalida-${randomBytes(3).toString('hex')}`
      const proxiesBefore = count(ctx.tempDb.url, 'proxies')
      const res = await api(ctx, 'POST', '/api/sessions', { name, phone: randomPhone(), proxy })
      expectApiError(res, 'VALIDATION_ERROR', 400)
      expect(count(ctx.tempDb.url, 'sessions', `name = ${lit(name)}`), `sessão criada com proxy ${JSON.stringify(proxy)}`).toBe(0)
      expect(count(ctx.tempDb.url, 'proxies'), `proxy criado: ${JSON.stringify(proxy)}`).toBe(proxiesBefore)
    }
  })

  it('AC-T17-03 proxy junto com proxyId → 400', async () => {
    const existing = await api(ctx, 'POST', '/api/proxies', { url: 'http://127.0.0.1:18111' })
    expect(existing.status, existing.text).toBe(201)
    const name = `ambos-${randomBytes(3).toString('hex')}`
    const res = await api(ctx, 'POST', '/api/sessions', { name, phone: randomPhone(), proxyId: existing.body.id, proxy: newProxy() })
    expectApiError(res, 'VALIDATION_ERROR', 400)
    expect(count(ctx.tempDb.url, 'sessions', `name = ${lit(name)}`)).toBe(0)
  })

  it('AC-T17-03 mesma transação: se gravar a sessão falhar, o proxy não fica no banco', async () => {
    const tag = `boom-${randomBytes(3).toString('hex')}`
    sqlOk(
      ctx.tempDb.url,
      `CREATE OR REPLACE FUNCTION t17_fail_session() RETURNS trigger AS $$ BEGIN IF NEW.name LIKE 'boom-%' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
       DROP TRIGGER IF EXISTS t17_fail_session ON sessions;
       CREATE TRIGGER t17_fail_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION t17_fail_session();`,
    )
    try {
      const p = newProxy()
      const res = await api(ctx, 'POST', '/api/sessions', { name: tag, phone: randomPhone(), proxy: p })
      expect(res.status, res.text).toBeGreaterThanOrEqual(400)
      expect(count(ctx.tempDb.url, 'proxies', `host = ${lit(p.host)} AND port = ${p.port}`), 'proxy órfão ficou gravado (sem transação)').toBe(0)
    } finally {
      sqlOk(ctx.tempDb.url, `DROP TRIGGER IF EXISTS t17_fail_session ON sessions;`)
    }
  })

  it('AC-T17-03 mesma transação: se gravar o proxy falhar, a sessão não é criada', async () => {
    const host = `boom-${randomBytes(3).toString('hex')}.example.test`
    sqlOk(
      ctx.tempDb.url,
      `CREATE OR REPLACE FUNCTION t17_fail_proxy() RETURNS trigger AS $$ BEGIN IF NEW.host LIKE 'boom-%' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
       DROP TRIGGER IF EXISTS t17_fail_proxy ON proxies;
       CREATE TRIGGER t17_fail_proxy BEFORE INSERT ON proxies FOR EACH ROW EXECUTE FUNCTION t17_fail_proxy();`,
    )
    try {
      const name = `sem-proxy-${randomBytes(3).toString('hex')}`
      const res = await api(ctx, 'POST', '/api/sessions', { name, phone: randomPhone(), proxy: { protocol: 'http', host, port: 3128 } })
      expect(res.status, res.text).toBeGreaterThanOrEqual(400)
      expect(count(ctx.tempDb.url, 'sessions', `name = ${lit(name)}`), 'sessão criada apesar da falha no proxy').toBe(0)
    } finally {
      sql(ctx.tempDb.url, `DROP TRIGGER IF EXISTS t17_fail_proxy ON proxies;`)
    }
  })

  it('AC-T17-05 GET lista e GET /:id trazem o proxy resumido, nunca a senha (nem cifrada)', async () => {
    const p = newProxy()
    const created = await create({ proxy: p })
    const plain = await create({})
    const one = await api(ctx, 'GET', `/api/sessions/${created.body.id}`)
    expect(one.status, one.text).toBe(200)
    expect(one.body.proxy).toEqual({ id: created.body.proxy.id, protocol: p.protocol, host: p.host, port: p.port, username: p.username, hasPassword: true })
    const list = await api(ctx, 'GET', '/api/sessions')
    expect(list.status).toBe(200)
    const items = listOf(list.body)
    expect(items.find((s: any) => s.id === created.body.id)?.proxy).toEqual(one.body.proxy)
    expect(items.find((s: any) => s.id === plain.body.id)?.proxy).toBeNull()
    for (const text of [one.text, list.text, created.text]) {
      expect(text).not.toContain(p.password)
      const lower = text.toLowerCase()
      for (const needle of ['"password"', 'password_', 'ciphertext', 'authtag', 'auth_tag', '"iv"']) expect(lower, `resposta expõe ${needle}`).not.toContain(needle)
    }
  })

  it('AC-T17-05 /api/proxies continua funcionando (compatibilidade) e enxerga o proxy criado inline', async () => {
    const p = newProxy()
    const created = await create({ proxy: p })
    const got = await api(ctx, 'GET', `/api/proxies/${created.body.proxy.id}`)
    expect(got.status, got.text).toBe(200)
    expect(got.text).toContain(p.host)
    expect(got.text).not.toContain(p.password)
    const legacy = await api(ctx, 'POST', '/api/proxies', { url: 'http://127.0.0.1:18112', name: 'legado' })
    expect(legacy.status, legacy.text).toBe(201)
    const withId = await create({ proxyId: legacy.body.id })
    expect(withId.status, withId.text).toBe(201)
    expect(withId.body.proxy).toMatchObject({ id: legacy.body.id, host: '127.0.0.1', port: 18112, protocol: 'http', hasPassword: false })
  })
})
