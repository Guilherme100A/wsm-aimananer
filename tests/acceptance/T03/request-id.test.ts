import { beforeAll, describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { useApp } from './shared'

describe('T03 — logs JSON (pino) com request_id e header x-request-id', () => {
  const ctx = useApp()

  beforeAll(() => {
    ctx.app.post('/api/__acceptance/items', (c: any) => c.json({ ok: true }, 201))
  })

  const parsedLogs = () =>
    ctx.logLines.map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        throw new Error(`linha de log não é JSON: ${l}`)
      }
    })

  const waitLog = async (requestId: string) => {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      if (parsedLogs().some((o) => o.request_id === requestId)) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  it('AC-T03-05 toda resposta devolve o header x-request-id, único por requisição', async () => {
    const a = await call(ctx.app, 'GET', '/health', { token: null })
    const b = await call(ctx.app, 'GET', '/health', { token: null })
    const idA = a.headers.get('x-request-id')
    const idB = b.headers.get('x-request-id')
    expect(idA, 'x-request-id ausente').toBeTruthy()
    expect(idB, 'x-request-id ausente').toBeTruthy()
    expect(idA).not.toBe(idB)
  })

  it('AC-T03-05 respostas de erro (401) e de rotas /api também trazem x-request-id', async () => {
    const unauth = await call(ctx.app, 'GET', '/api/__acceptance/ping', { token: null })
    expect(unauth.status).toBe(401)
    expect(unauth.headers.get('x-request-id')).toBeTruthy()
    const ok = await call(ctx.app, 'POST', '/api/__acceptance/items', { token: ctx.token, body: { a: 1 } })
    expect(ok.status, ok.text).toBe(201)
    expect(ok.headers.get('x-request-id')).toBeTruthy()
  })

  it('AC-T03-05 o logger pino injetado recebe logs em JSON com request_id igual ao header', async () => {
    ctx.logLines.length = 0
    const res = await call(ctx.app, 'POST', '/api/__acceptance/items', { token: ctx.token, body: { a: 1 } })
    const id = res.headers.get('x-request-id')!
    expect(id).toBeTruthy()
    const found = await waitLog(id)
    expect(ctx.logLines.length, 'nenhum log emitido pelo logger injetado').toBeGreaterThan(0)
    expect(found, `nenhum log com request_id=${id}; logs:\n${ctx.logLines.join('\n').slice(0, 2000)}`).toBe(true)
    for (const o of parsedLogs()) expect(typeof o.level, 'log sem campo level (formato pino)').toBe('number')
  })

})
