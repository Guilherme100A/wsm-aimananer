import { beforeAll, describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { uuid } from '../helpers/factories'
import { sqlOk } from '../helpers/pg'
import { useApp } from './shared'

const REQUIRED = ['actor', 'action', 'target_type', 'target_id', 'created_at'] as const

function auditRows(url: string): Record<string, unknown>[] {
  return sqlOk(url, 'SELECT row_to_json(a) FROM audit_logs a;').map((r) => JSON.parse(r[0]!) as Record<string, unknown>)
}

/** Linhas novas em audit_logs após `before` (espera até 5s: a gravação pode ser assíncrona). */
async function waitNewRows(url: string, before: Record<string, unknown>[], min = 1) {
  const seen = new Set(before.map((r) => JSON.stringify(r)))
  const deadline = Date.now() + 5_000
  let fresh: Record<string, unknown>[] = []
  do {
    fresh = auditRows(url).filter((r) => !seen.has(JSON.stringify(r)))
    if (fresh.length >= min) return fresh
    await new Promise((r) => setTimeout(r, 100))
  } while (Date.now() < deadline)
  return fresh
}

describe('T03 — auditoria de requisições mutantes', () => {
  const ctx = useApp()

  beforeAll(() => {
    const ok = (c: any) => c.json({ id: c.req.param('id') ?? null, ok: true })
    ctx.app.post('/api/__acceptance/items', (c: any) => c.json({ id: uuid(), ok: true }, 201))
    ctx.app.put('/api/__acceptance/items/:id', ok)
    ctx.app.patch('/api/__acceptance/items/:id', ok)
    ctx.app.delete('/api/__acceptance/items/:id', ok)
  })

  const cases: [string, () => string][] = [
    ['POST', () => '/api/__acceptance/items'],
    ['PUT', () => `/api/__acceptance/items/${uuid()}`],
    ['PATCH', () => `/api/__acceptance/items/${uuid()}`],
    ['DELETE', () => `/api/__acceptance/items/${uuid()}`],
  ]

  for (const [method, path] of cases) {
    it(`AC-T03-04 ${method} bem-sucedido grava em audit_logs (actor, action, target_type, target_id, created_at)`, async () => {
      const before = auditRows(ctx.tempDb.url)
      const res = await call(ctx.app, method, path(), { token: ctx.token, body: method === 'DELETE' ? undefined : { label: 'x' } })
      expect(res.status, res.text).toBeGreaterThanOrEqual(200)
      expect(res.status, res.text).toBeLessThan(300)

      const fresh = await waitNewRows(ctx.tempDb.url, before)
      expect(fresh.length, `nenhuma linha nova em audit_logs após ${method}`).toBeGreaterThanOrEqual(1)
      const row = fresh[0]!
      for (const col of REQUIRED) {
        expect(row, `coluna ${col} ausente em audit_logs: ${JSON.stringify(row)}`).toHaveProperty(col)
        expect(row[col], `audit_logs.${col} vazio: ${JSON.stringify(row)}`).not.toBeNull()
        expect(String(row[col]).trim(), `audit_logs.${col} vazio: ${JSON.stringify(row)}`).not.toBe('')
      }
      expect(Number.isNaN(Date.parse(String(row.created_at))), `created_at inválido: ${row.created_at}`).toBe(false)
    })
  }

  it('AC-T03-04 cada requisição mutante gera sua própria linha de auditoria', async () => {
    const before = auditRows(ctx.tempDb.url)
    for (let i = 0; i < 3; i++) {
      const res = await call(ctx.app, 'PATCH', `/api/__acceptance/items/${uuid()}`, { token: ctx.token, body: { i } })
      expect(res.status, res.text).toBe(200)
    }
    const fresh = await waitNewRows(ctx.tempDb.url, before, 3)
    expect(fresh.length).toBe(3)
  })
})
