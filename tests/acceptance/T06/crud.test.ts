import { createProxy, expectNoSecrets, listOf, proxyRow, proxyUrl, useApp } from './shared'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { sqlOk } from '../helpers/pg'

describe('T06 — CRUD /api/proxies', () => {
  const ctx = useApp()

  it('AC-T06-01 POST /api/proxies → 201 com URL mascarada (http://user:***@host:port), sem senha na resposta', async () => {
    const p = proxyUrl()
    const body = await createProxy(ctx, p.url, 'proxy-a')
    expect(body.url).toBe(`http://${p.user}:***@${p.host}:${p.port}`)
    expect(body).toMatchObject({ protocol: 'http', host: p.host, port: p.port, username: p.user })
    expectNoSecrets(body, p.pass!)
  })

  it('AC-T06-01 mascaramento vale para https e socks5', async () => {
    for (const protocol of ['https', 'socks5']) {
      const p = proxyUrl({ protocol })
      const body = await createProxy(ctx, p.url)
      expect(body.url).toBe(`${protocol}://${p.user}:***@${p.host}:${p.port}`)
      expectNoSecrets(body, p.pass!)
    }
  })

  it('AC-T06-01 a senha é armazenada cifrada: não aparece em nenhuma coluna da tabela proxies', async () => {
    const p = proxyUrl()
    const body = await createProxy(ctx, p.url)
    const raw = sqlOk(ctx.tempDb.url, `SELECT row_to_json(t)::text, encode(t.password_ciphertext, 'escape') FROM proxies t WHERE id = '${body.id}';`)[0]!
    expect(raw[0], 'senha em claro na linha de proxies').not.toContain(p.pass!)
    expect(raw[1] ?? '', 'password_ciphertext contém a senha em claro').not.toContain(p.pass!)
    const r = proxyRow(ctx, body.id)
    expect(r.password_ciphertext, 'password_ciphertext vazio').toBeTruthy()
    expect(r.password_iv, 'password_iv vazio').toBeTruthy()
    expect(r.password_auth_tag, 'password_auth_tag vazio').toBeTruthy()
    expect(r.password_key_version, 'password_key_version vazio').not.toBeNull()
    // nenhuma outra tabela recebeu a senha (ex.: audit_logs do POST)
    const dump = sqlOk(ctx.tempDb.url, `SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM audit_logs a;`)[0]?.[0] ?? ''
    expect(dump, 'senha em claro em audit_logs').not.toContain(p.pass!)
  })

  it('AC-T06-01 GET lista e GET por id devolvem URL mascarada e nunca a senha', async () => {
    const p = proxyUrl()
    const created = await createProxy(ctx, p.url)

    const one = await call(ctx.app, 'GET', `/api/proxies/${created.id}`, { token: ctx.token })
    expect(one.status, one.text).toBe(200)
    expect(one.body.id).toBe(created.id)
    expect(one.body.url).toBe(`http://${p.user}:***@${p.host}:${p.port}`)
    expectNoSecrets(one.body, p.pass!)

    const all = await call(ctx.app, 'GET', '/api/proxies', { token: ctx.token })
    expect(all.status, all.text).toBe(200)
    const items = listOf(all.body)
    expect(items.map((x) => x.id)).toContain(created.id)
    expect(all.text).toContain('***')
    expectNoSecrets(all.body, p.pass!)
  })

  it('AC-T06-01 proxy sem autenticação não ganha máscara', async () => {
    const p = proxyUrl({ user: null, pass: null })
    const body = await createProxy(ctx, p.url)
    expect(body.url).toBe(`http://${p.host}:${p.port}`)
  })

  it('AC-T06-01 PATCH atualiza o proxy; nova senha é recifrada e continua mascarada', async () => {
    const p = proxyUrl()
    const created = await createProxy(ctx, p.url)
    const before = proxyRow(ctx, created.id)

    const next = proxyUrl()
    const res = await call(ctx.app, 'PATCH', `/api/proxies/${created.id}`, { token: ctx.token, body: { url: next.url, name: 'renomeado' } })
    expect(res.status, res.text).toBe(200)
    expect(res.body.url).toBe(`http://${next.user}:***@${next.host}:${next.port}`)
    expect(res.body.name).toBe('renomeado')
    expectNoSecrets(res.body, next.pass!)

    const after = proxyRow(ctx, created.id)
    expect(after.host).toBe(next.host)
    expect(after.port).toBe(next.port)
    expect(after.password_ciphertext).not.toBe(before.password_ciphertext)
    expect(JSON.stringify(after)).not.toContain(next.pass!)
  })

  it('AC-T06-01 DELETE remove o proxy; GET depois → 404', async () => {
    const created = await createProxy(ctx, proxyUrl().url)
    const del = await call(ctx.app, 'DELETE', `/api/proxies/${created.id}`, { token: ctx.token })
    expect(del.status, del.text).toBe(204)
    const get = await call(ctx.app, 'GET', `/api/proxies/${created.id}`, { token: ctx.token })
    expect(get.status, get.text).toBe(404)
    expect(get.body?.error?.code).toBe('NOT_FOUND')
    expect(proxyRow(ctx, created.id)).toBeUndefined()
  })

  it('AC-T06-01 URL inválida ou protocolo não suportado → 400 VALIDATION_ERROR', async () => {
    for (const url of ['nao-e-url', 'ftp://u:p@10.0.0.1:21', 'http://10.0.0.1:99999']) {
      const res = await call(ctx.app, 'POST', '/api/proxies', { token: ctx.token, body: { url } })
      expect(res.status, `${url} → ${res.text}`).toBe(400)
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR')
    }
  })

  it('AC-T06-01 /api/proxies exige auth (401 sem token)', async () => {
    const res = await call(ctx.app, 'GET', '/api/proxies', { token: null })
    expect(res.status).toBe(401)
  })
})
