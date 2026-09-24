import { api, connectedSession, createSession, credentialCount, expectNoCredentials, listOf, useSessions } from './shared'
import { describe, expect, it } from 'vitest'

describe('T05 — API nunca expõe credenciais', () => {
  const ctx = useSessions()

  it('AC-T05-07 GET /api/sessions/:id de sessão autenticada não retorna credenciais nem campos cifrados', async () => {
    const { id, transport } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    const res = await api(ctx, 'GET', `/api/sessions/${id}`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.id).toBe(id)
    expectNoCredentials(res.body)
    // nenhum material de chave do auth state aparece em nenhuma codificação usual
    const pub = Buffer.from(transport.lastConnect.auth.creds.noiseKey.public)
    expect(res.text).not.toContain(pub.toString('base64'))
    expect(res.text).not.toContain(pub.toString('hex'))
  })

  it('AC-T05-07 GET /api/sessions lista as sessões sem credenciais nem campos cifrados', async () => {
    const { id, transport } = await connectedSession(ctx)
    await createSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    const res = await api(ctx, 'GET', '/api/sessions')
    expect(res.status, res.text).toBe(200)
    const items = listOf(res.body)
    expect(items.length).toBeGreaterThanOrEqual(2)
    expect(items.map((s) => s.id)).toContain(id)
    expectNoCredentials(res.body)
    const pub = Buffer.from(transport.lastConnect.auth.creds.noiseKey.public)
    expect(res.text).not.toContain(pub.toString('base64'))
  })

  it('AC-T05-07 respostas de criação e de ações também não carregam credenciais', async () => {
    const created = await api(ctx, 'POST', '/api/sessions', { name: 'sem-creds', phone: '+5511988887777' })
    expect(created.status, created.text).toBe(201)
    expectNoCredentials(created.body)
    const { id } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    for (const a of ['pause', 'resume', 'restart']) {
      const res = await api(ctx, 'POST', `/api/sessions/${id}/${a}`)
      expect(res.status, `${a}: ${res.text}`).toBe(200)
      expectNoCredentials(res.body)
    }
  })

  it('AC-T05-07 proxy da sessão aparece só como id (sem senha do proxy)', async () => {
    const pass = `pw-${Date.now()}`
    const p = await api(ctx, 'POST', '/api/proxies', { url: `http://wsm:${pass}@10.254.7.7:${7000 + Math.floor(Math.random() * 1000)}` })
    expect(p.status, p.text).toBe(201)
    const s = await createSession(ctx, { proxyId: p.body.id })
    const get = await api(ctx, 'GET', `/api/sessions/${s.id}`)
    expect(get.text).not.toContain(pass)
    const list = await api(ctx, 'GET', '/api/sessions')
    expect(list.text).not.toContain(pass)
  })
})
