import { beforeAll, describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { useApp } from './shared'

describe('T03 — autenticação em /api/*', () => {
  const ctx = useApp()
  let hits = 0

  beforeAll(() => {
    // Rotas de teste registradas depois do createApp (contrato: middlewares no app raiz).
    ctx.app.get('/api/__acceptance/ping', (c: any) => c.json({ pong: true }))
    ctx.app.post('/api/__acceptance/items', (c: any) => {
      hits++
      return c.json({ ok: true }, 201)
    })
  })

  it('AC-T03-02 rota /api/* sem Authorization → 401 UNAUTHORIZED', async () => {
    const res = await call(ctx.app, 'GET', '/api/__acceptance/ping', { token: null })
    expectApiError(res, 'UNAUTHORIZED', 401)
  })

  it('AC-T03-02 Bearer com token errado → 401 UNAUTHORIZED', async () => {
    const res = await call(ctx.app, 'GET', '/api/__acceptance/ping', { token: `${ctx.token}x` })
    expectApiError(res, 'UNAUTHORIZED', 401)
  })

  it('AC-T03-02 esquema diferente de Bearer ou Bearer vazio → 401 UNAUTHORIZED', async () => {
    for (const authorization of [`Basic ${ctx.token}`, ctx.token, 'Bearer', 'Bearer ', `Token ${ctx.token}`]) {
      const res = await call(ctx.app, 'GET', '/api/__acceptance/ping', { token: null, headers: { authorization } })
      expect(res.status, `Authorization: "${authorization}" → ${res.text}`).toBe(401)
      expect(res.body?.error?.code).toBe('UNAUTHORIZED')
    }
  })

  it('AC-T03-02 rota /api/* inexistente sem token também → 401 (auth antes do roteamento)', async () => {
    const res = await call(ctx.app, 'GET', '/api/sessions', { token: null })
    expectApiError(res, 'UNAUTHORIZED', 401)
  })

  it('AC-T03-02 requisição mutante sem token → 401 e o handler não executa', async () => {
    const before = hits
    const res = await call(ctx.app, 'POST', '/api/__acceptance/items', { token: null, body: { label: 'x' } })
    expectApiError(res, 'UNAUTHORIZED', 401)
    expect(hits).toBe(before)
  })

  it('AC-T03-02 Bearer <API_TOKEN> válido (o apiToken injetado) passa pela auth', async () => {
    const res = await call(ctx.app, 'GET', '/api/__acceptance/ping', { token: ctx.token })
    expect(res.status, res.text).toBe(200)
    expect(res.body).toEqual({ pong: true })

    const missing = await call(ctx.app, 'GET', '/api/__acceptance/nao-existe', { token: ctx.token })
    expect(missing.status, missing.text).not.toBe(401)
  })
})
