import { beforeAll, describe, expect, it } from 'vitest'
import { call, importFrom } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { useApp } from './shared'

describe('T03 — validação (zod) → 400 VALIDATION_ERROR', () => {
  const ctx = useApp()

  beforeAll(async () => {
    const zmod = await importFrom<any>('apps/api', 'zod')
    const z = zmod.z ?? zmod.default ?? zmod
    const schema = z.object({ label: z.string().min(1), quantity: z.number().int().positive() })
    // Contrato: ZodError lançado pelo handler é mapeado pelo onError do app.
    ctx.app.post('/api/__acceptance/validated', async (c: any) => {
      const body = schema.parse(await c.req.json())
      return c.json(body, 201)
    })
  })

  it('AC-T03-03 campo com tipo errado → 400 VALIDATION_ERROR com details indicando o campo', async () => {
    const res = await call(ctx.app, 'POST', '/api/__acceptance/validated', { token: ctx.token, body: { label: 'caixa', quantity: 'muitos' } })
    expectApiError(res, 'VALIDATION_ERROR', 400)
    expect(res.body.error.details, `details ausente: ${res.text}`).toBeDefined()
    const details = JSON.stringify(res.body.error.details)
    expect(details).toContain('quantity')
    expect(details).not.toContain('"label"')
  })

  it('AC-T03-03 campo obrigatório ausente → 400 VALIDATION_ERROR com details indicando o campo', async () => {
    const res = await call(ctx.app, 'POST', '/api/__acceptance/validated', { token: ctx.token, body: { quantity: 2 } })
    expectApiError(res, 'VALIDATION_ERROR', 400)
    expect(JSON.stringify(res.body.error.details ?? null)).toContain('label')
  })

  it('AC-T03-03 vários campos inválidos → details indica todos', async () => {
    const res = await call(ctx.app, 'POST', '/api/__acceptance/validated', { token: ctx.token, body: { label: '', quantity: -1 } })
    expectApiError(res, 'VALIDATION_ERROR', 400)
    const details = JSON.stringify(res.body.error.details ?? null)
    expect(details).toContain('label')
    expect(details).toContain('quantity')
  })

  it('AC-T03-03 JSON malformado → 400 VALIDATION_ERROR', async () => {
    const res = await call(ctx.app, 'POST', '/api/__acceptance/validated', { token: ctx.token, raw: '{"label": "x", quantity: ' })
    expectApiError(res, 'VALIDATION_ERROR', 400)
  })

  it('AC-T03-03 body válido passa pela validação', async () => {
    const res = await call(ctx.app, 'POST', '/api/__acceptance/validated', { token: ctx.token, body: { label: 'caixa', quantity: 3 } })
    expect(res.status, res.text).toBe(201)
    expect(res.body).toEqual({ label: 'caixa', quantity: 3 })
  })
})
