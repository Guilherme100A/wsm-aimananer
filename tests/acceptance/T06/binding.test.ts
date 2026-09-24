import { bindProxy, createProxy, createSession, loadProxyCore, proxyRow, proxyUrl, sessionRow, useApp } from './shared'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { lit, sqlOk } from '../helpers/pg'
import { fakeAuthState } from '../helpers/transport'

const auditCount = (url: string) => Number(sqlOk(url, 'SELECT count(*) FROM audit_logs;')[0]![0])

/** Compara URLs de proxy por partes (o transporte recebe a senha em claro). */
function expectSameProxy(actual: string | undefined, expected: string) {
  expect(actual, 'proxyUrl ausente no connect').toBeTruthy()
  const a = new URL(actual!)
  const e = new URL(expected)
  expect({ protocol: a.protocol, host: a.hostname, port: a.port, user: decodeURIComponent(a.username), pass: decodeURIComponent(a.password) }).toEqual({
    protocol: e.protocol,
    host: e.hostname,
    port: e.port,
    user: decodeURIComponent(e.username),
    pass: decodeURIComponent(e.password),
  })
}

describe('T06 — vínculo proxy ↔ sessão', () => {
  const ctx = useApp()

  it('AC-T06-02 vincular a uma sessão um proxy já vinculado a outra → 409 PROXY_IN_USE', async () => {
    const proxy = await createProxy(ctx, proxyUrl().url)
    const s1 = createSession(ctx)
    const s2 = createSession(ctx)

    const first = await bindProxy(ctx, proxy.id, s1)
    expect(first.status, first.text).toBe(200)
    expect(sessionRow(ctx, s1).proxy_id).toBe(proxy.id)

    const second = await bindProxy(ctx, proxy.id, s2)
    expectApiError(second, 'PROXY_IN_USE', 409)
    expect(sessionRow(ctx, s2).proxy_id, 'sessão 2 não pode ter recebido o proxy').toBeNull()
    expect(sessionRow(ctx, s1).proxy_id, 'sessão 1 perdeu o proxy').toBe(proxy.id)

    const get = await call(ctx.app, 'GET', `/api/proxies/${proxy.id}`, { token: ctx.token })
    expect(get.body.sessionId).toBe(s1)
  })

  it('AC-T06-02 vínculos concorrentes do mesmo proxy a duas sessões: exatamente um vence, o outro → 409 PROXY_IN_USE', async () => {
    const proxy = await createProxy(ctx, proxyUrl().url)
    const s1 = createSession(ctx)
    const s2 = createSession(ctx)
    const results = await Promise.all([bindProxy(ctx, proxy.id, s1), bindProxy(ctx, proxy.id, s2)])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses, results.map((r) => r.text).join('\n')).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)!.body?.error?.code).toBe('PROXY_IN_USE')
    const bound = [s1, s2].filter((s) => sessionRow(ctx, s).proxy_id === proxy.id)
    expect(bound).toHaveLength(1)
  })

  it('AC-T06-02 revincular o proxy à mesma sessão é idempotente (200)', async () => {
    const proxy = await createProxy(ctx, proxyUrl().url)
    const s = createSession(ctx)
    expect((await bindProxy(ctx, proxy.id, s)).status).toBe(200)
    const again = await bindProxy(ctx, proxy.id, s)
    expect(again.status, again.text).toBe(200)
    expect(sessionRow(ctx, s).proxy_id).toBe(proxy.id)
  })

  it('AC-T06-02 remover um proxy vinculado → 409 PROXY_IN_USE (a sessão nunca fica sem proxy por efeito colateral)', async () => {
    const proxy = await createProxy(ctx, proxyUrl().url)
    const s = createSession(ctx)
    expect((await bindProxy(ctx, proxy.id, s)).status).toBe(200)
    const del = await call(ctx.app, 'DELETE', `/api/proxies/${proxy.id}`, { token: ctx.token })
    expectApiError(del, 'PROXY_IN_USE', 409)
    expect(sessionRow(ctx, s).proxy_id).toBe(proxy.id)
    expect(proxyRow(ctx, proxy.id)).toBeDefined()
  })

  it('AC-T06-02 sessão inexistente → 404 SESSION_NOT_FOUND', async () => {
    const proxy = await createProxy(ctx, proxyUrl().url)
    const res = await bindProxy(ctx, proxy.id, '00000000-0000-4000-8000-000000000000')
    expectApiError(res, 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T06-03 trocar o proxy de uma sessão atualiza last_changed_at, grava audit_logs e marca requires_restart (estado não muda)', async () => {
    const a = await createProxy(ctx, proxyUrl().url)
    const b = await createProxy(ctx, proxyUrl().url)
    const s = createSession(ctx, { status: 'STABLE' })
    expect((await bindProxy(ctx, a.id, s)).status).toBe(200)
    // simula que a sessão já reiniciou com o proxy A
    sqlOk(ctx.tempDb.url, `UPDATE sessions SET requires_restart = false WHERE id = ${lit(s)};`)
    const bBefore = proxyRow(ctx, b.id).last_changed_at
    const audits = auditCount(ctx.tempDb.url)
    const t0 = Date.now()

    const res = await bindProxy(ctx, b.id, s)
    expect(res.status, res.text).toBe(200)

    const sess = sessionRow(ctx, s)
    expect(sess.proxy_id).toBe(b.id)
    expect(sess.requires_restart, 'sessão deveria ficar marcada como "requer restart"').toBe(true)
    expect(sess.status, 'trocar proxy não muda o estado da sessão').toBe('STABLE')

    const changed = proxyRow(ctx, b.id).last_changed_at
    expect(changed, 'last_changed_at não preenchido').toBeTruthy()
    expect(changed).not.toBe(bBefore)
    expect(Date.parse(changed)).toBeGreaterThanOrEqual(t0 - 5_000)

    await expect.poll(() => auditCount(ctx.tempDb.url), { timeout: 5_000 }).toBeGreaterThan(audits)

    // o proxy antigo ficou livre
    const oldOne = await call(ctx.app, 'GET', `/api/proxies/${a.id}`, { token: ctx.token })
    expect(oldOne.body.sessionId ?? null).toBeNull()
  })

  it('AC-T06-03 a troca só vale após restart: conexão ativa segue no proxy antigo; a próxima conexão usa o novo', async () => {
    const { connectSession, FakeTransport } = await loadProxyCore()
    const urlA = proxyUrl()
    const urlB = proxyUrl()
    const a = await createProxy(ctx, urlA.url)
    const b = await createProxy(ctx, urlB.url)
    const s = createSession(ctx)
    expect((await bindProxy(ctx, a.id, s)).status).toBe(200)

    const transport = new FakeTransport()
    await connectSession({ db: ctx.db, sessionId: s, transport, auth: fakeAuthState() })
    expect(transport.connectCalls).toHaveLength(1)
    expectSameProxy(transport.lastConnect.proxyUrl, urlA.url)

    expect((await bindProxy(ctx, b.id, s)).status).toBe(200)
    expect(sessionRow(ctx, s).requires_restart).toBe(true)
    // nada reconecta sozinho: a conexão em curso continua com A
    await new Promise((r) => setTimeout(r, 200))
    expect(transport.connectCalls, 'a troca de proxy não pode reconectar a sessão sem restart').toHaveLength(1)

    // "restart": nova conexão resolve o proxy B
    const restarted = new FakeTransport()
    await connectSession({ db: ctx.db, sessionId: s, transport: restarted, auth: fakeAuthState() })
    expect(restarted.connectCalls).toHaveLength(1)
    expectSameProxy(restarted.lastConnect.proxyUrl, urlB.url)
  })

  it('AC-T06-03 alterar a URL de um proxy vinculado também atualiza last_changed_at, grava audit e marca requires_restart', async () => {
    const p = await createProxy(ctx, proxyUrl().url)
    const s = createSession(ctx)
    expect((await bindProxy(ctx, p.id, s)).status).toBe(200)
    sqlOk(ctx.tempDb.url, `UPDATE sessions SET requires_restart = false WHERE id = ${lit(s)}; UPDATE proxies SET last_changed_at = now() - interval '1 day' WHERE id = ${lit(p.id)};`)
    const before = proxyRow(ctx, p.id).last_changed_at
    const audits = auditCount(ctx.tempDb.url)

    const res = await call(ctx.app, 'PATCH', `/api/proxies/${p.id}`, { token: ctx.token, body: { url: proxyUrl().url } })
    expect(res.status, res.text).toBe(200)
    expect(sessionRow(ctx, s).requires_restart).toBe(true)
    expect(proxyRow(ctx, p.id).last_changed_at).not.toBe(before)
    await expect.poll(() => auditCount(ctx.tempDb.url), { timeout: 5_000 }).toBeGreaterThan(audits)
  })
})
