// AC-T17-04: PATCH /api/sessions/:id { name?, note?, proxy?: {…} | null }. Trocar/remover proxy marca
// requires_restart, gera auditoria e apaga o proxy antigo sem uso; inexistente → 404.
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { lit, sqlOk } from '../helpers/pg'
import { api, randomPhone, useSessions } from '../T05/shared'

const proxyInput = (extra: Record<string, unknown> = {}) => ({
  protocol: 'http',
  host: `172.16.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  port: 3128,
  username: 'op',
  password: `pw-${randomBytes(6).toString('hex')}`,
  ...extra,
})

describe('T17 — PATCH /api/sessions/:id', () => {
  const ctx = useSessions()
  const proxyExists = (id: string) => Number(sqlOk(ctx.tempDb.url, `SELECT count(*) FROM proxies WHERE id = ${lit(id)};`)[0]![0]) === 1
  const requiresRestart = (id: string) => sqlOk(ctx.tempDb.url, `SELECT requires_restart FROM sessions WHERE id = ${lit(id)};`)[0]![0] === 't'
  const audits = (id: string) =>
    sqlOk(ctx.tempDb.url, `SELECT action, coalesce(detail::text, '{}') FROM audit_logs WHERE target_id = ${lit(id)} ORDER BY id;`).map(([action, detail]) => ({ action: action!, detail: JSON.parse(detail!) }))

  async function sessionWithProxy(p = proxyInput()) {
    const res = await api(ctx, 'POST', '/api/sessions', { name: `patch-${randomBytes(3).toString('hex')}`, phone: randomPhone(), proxy: p })
    expect(res.status, res.text).toBe(201)
    return { s: res.body as Record<string, any>, p }
  }
  const patch = (id: string, body: unknown) => api(ctx, 'PATCH', `/api/sessions/${id}`, body)

  it('AC-T17-04 editar só nome e observação não mexe no proxy nem em requires_restart', async () => {
    const { s } = await sessionWithProxy()
    const res = await patch(s.id, { name: 'novo nome', note: 'nova observação' })
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ id: s.id, name: 'novo nome', note: 'nova observação', requiresRestart: false })
    expect(res.body.proxy).toEqual(s.proxy)
    expect(requiresRestart(s.id)).toBe(false)
  })

  it('AC-T17-04 trocar o proxy: novo proxy vinculado, requires_restart, auditoria e proxy antigo apagado', async () => {
    const { s } = await sessionWithProxy()
    const oldId = s.proxy.id as string
    const next = proxyInput({ protocol: 'socks5', port: 1085 })
    const res = await patch(s.id, { proxy: next })
    expect(res.status, res.text).toBe(200)
    expect(res.body.proxy).toMatchObject({ protocol: 'socks5', host: next.host, port: 1085, username: 'op', hasPassword: true })
    expect(res.body.requiresRestart).toBe(true)
    expect(res.text).not.toContain(next.password)
    expect(requiresRestart(s.id)).toBe(true)
    expect(proxyExists(oldId), 'proxy antigo sem uso deveria ser apagado').toBe(false)
    expect(proxyExists(res.body.proxy.id)).toBe(true)
    const a = audits(s.id).filter((x) => x.action === 'session.update')
    expect(a.length, 'PATCH com troca de proxy deve ser auditado').toBeGreaterThan(0)
    expect(JSON.stringify(a)).not.toContain(next.password)
    expect(a.at(-1)!.detail).toMatchObject({ proxyChanged: true, previousProxyId: oldId, proxyId: res.body.proxy.id, requiresRestart: true })
  })

  it('AC-T17-04 remover o proxy (null): sessão sem proxy, requires_restart e proxy antigo apagado', async () => {
    const { s } = await sessionWithProxy()
    const res = await patch(s.id, { proxy: null })
    expect(res.status, res.text).toBe(200)
    expect(res.body.proxy).toBeNull()
    expect(res.body.proxyId ?? null).toBeNull()
    expect(res.body.requiresRestart).toBe(true)
    expect(proxyExists(s.proxy.id)).toBe(false)
    expect(audits(s.id).some((x) => x.action === 'session.update' && x.detail?.proxyChanged === true)).toBe(true)
  })

  it('AC-T17-04 adicionar proxy a uma sessão sem proxy marca requires_restart', async () => {
    const res0 = await api(ctx, 'POST', '/api/sessions', { name: `sem-${randomBytes(3).toString('hex')}`, phone: randomPhone() })
    expect(res0.status).toBe(201)
    const res = await patch(res0.body.id, { proxy: proxyInput({ username: undefined, password: undefined }) })
    expect(res.status, res.text).toBe(200)
    expect(res.body.proxy).toMatchObject({ protocol: 'http', port: 3128, hasPassword: false })
    expect(res.body.requiresRestart).toBe(true)
  })

  it('AC-T17-04 senha: chave ausente mantém, null remove, string troca', async () => {
    const { s, p } = await sessionWithProxy()
    const { password: _omit, ...withoutPassword } = p
    const keep = await patch(s.id, { proxy: { ...withoutPassword, port: 3129 } })
    expect(keep.status, keep.text).toBe(200)
    expect(keep.body.proxy).toMatchObject({ port: 3129, hasPassword: true })
    const drop = await patch(s.id, { proxy: { ...withoutPassword, port: 3129, password: null } })
    expect(drop.status, drop.text).toBe(200)
    expect(drop.body.proxy.hasPassword).toBe(false)
    const set = await patch(s.id, { proxy: { ...withoutPassword, port: 3129, password: 'nova-senha-proxy' } })
    expect(set.status, set.text).toBe(200)
    expect(set.body.proxy.hasPassword).toBe(true)
    expect(set.text).not.toContain('nova-senha-proxy')
  })

  it('AC-T17-04 sessão inexistente → 404 SESSION_NOT_FOUND', async () => {
    expectApiError(await patch(randomUUID(), { name: 'x' }), 'SESSION_NOT_FOUND', 404)
    expectApiError(await patch(randomUUID(), { proxy: proxyInput() }), 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T17-04 proxy inválido ou proxy + proxyId → 400 e nada muda', async () => {
    const { s } = await sessionWithProxy()
    for (const body of [{ proxy: { protocol: 'ftp', host: 'x.example.test', port: 21 } }, { proxy: { protocol: 'http', host: 'x.example.test', port: 99999 } }, { proxy: proxyInput(), proxyId: s.proxy.id }]) {
      expectApiError(await patch(s.id, body), 'VALIDATION_ERROR', 400)
    }
    const after = await api(ctx, 'GET', `/api/sessions/${s.id}`)
    expect(after.body.proxy).toEqual(s.proxy)
    expect(requiresRestart(s.id)).toBe(false)
    expect(proxyExists(s.proxy.id)).toBe(true)
  })
})
