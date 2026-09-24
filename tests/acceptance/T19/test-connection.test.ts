import { api, auditRows, getSettings, newKey, putSettings, useAiApi } from './shared'
import { describe, expect, it } from 'vitest'

describe('T19 — POST /api/ai/settings/test (provedor falso injetado)', () => {
  const ctx = useAiApi()
  const test = (body?: Record<string, unknown>) => api(ctx, 'POST', '/api/ai/settings/test', body ?? {})

  it('AC-T19-04 sem chave configurada → ok:false com erro, sem chamar o provedor', async () => {
    const calls = ctx.provider.calls.length
    const r = await test()
    expect(r.status, r.text).toBe(200)
    expect(r.body.ok).toBe(false)
    expect(typeof r.body.error).toBe('string')
    expect(ctx.provider.calls.length).toBe(calls)
  })

  it('AC-T19-04 com a configuração salva: chamada mínima ao provedor com a chave e o modelo pequeno → { ok, model, latencyMs }', async () => {
    const key = newKey()
    await putSettings(ctx, { apiKey: key, modelSmall: 'db-modelo-teste', maxTokens: 500 })
    const r = await test()
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ ok: true, model: 'db-modelo-teste' })
    expect(typeof r.body.latencyMs).toBe('number')
    expect(r.body.latencyMs).toBeGreaterThanOrEqual(0)
    const last = ctx.provider.calls.at(-1)!
    expect(last.apiKey).toBe(key)
    expect(last.model).toBe('db-modelo-teste')
    expect(last.maxTokens, 'chamada mínima').toBeLessThanOrEqual(64)
    expect(r.text).not.toContain(key)
  })

  it('AC-T19-04 com a configuração enviada no body: usa-a sem salvar', async () => {
    const saved = await getSettings(ctx)
    const tempKey = newKey()
    const r = await test({ apiKey: tempKey, modelSmall: 'modelo-so-no-teste' })
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ ok: true, model: 'modelo-so-no-teste' })
    expect(ctx.provider.calls.at(-1)).toMatchObject({ apiKey: tempKey, model: 'modelo-so-no-teste' })
    const after = await getSettings(ctx)
    expect(after.modelSmall, '/test não pode salvar').toBe(saved.modelSmall)
    expect(after.updatedAt).toBe(saved.updatedAt)
    expect(r.text).not.toContain(tempKey)
  })

  it('AC-T19-04 erro do provedor volta sanitizado: ok:false, sem a chave (mesmo que a mensagem original a contenha)', async () => {
    const key = newKey()
    await putSettings(ctx, { apiKey: key })
    ctx.provider.setBehavior(async (req) => {
      throw Object.assign(new Error(`401 invalid x-api-key: ${req.apiKey} (request id abc)`), { status: 401 })
    })
    try {
      const r = await test()
      expect(r.status, r.text).toBe(200)
      expect(r.body.ok).toBe(false)
      expect(typeof r.body.error).toBe('string')
      expect(r.body.error.length).toBeGreaterThan(0)
      expect(r.body.error.length).toBeLessThanOrEqual(300)
      expect(r.text, 'erro devolveu a chave').not.toContain(key)
      expect(r.text).not.toContain(key.slice(-12))
      expect(ctx.logLines.join('\n')).not.toContain(key)
    } finally {
      ctx.provider.setBehavior(async (req) => ({ intent: 'pricing', confidence: 0.95, text: `resposta (${req.model})` }))
    }
  })

  it('AC-T19-04 timeout do provedor respeita o timeout efetivo e volta ok:false', async () => {
    await putSettings(ctx, { apiKey: newKey(), timeoutMs: 500 })
    ctx.provider.setBehavior(() => new Promise(() => {}))
    try {
      const t0 = Date.now()
      const r = await test()
      expect(r.status, r.text).toBe(200)
      expect(r.body.ok).toBe(false)
      expect(Date.now() - t0, 'deveria desistir pelo timeout efetivo').toBeLessThan(5_000)
    } finally {
      ctx.provider.setBehavior(async (req) => ({ intent: 'pricing', confidence: 0.95, text: `resposta (${req.model})` }))
      await putSettings(ctx, { timeoutMs: null })
    }
  })

  it('AC-T19-04 o teste de conexão é auditado sem a chave', async () => {
    const key = newKey()
    const before = auditRows(ctx.tempDb.url).length
    await test({ apiKey: key })
    const rows = auditRows(ctx.tempDb.url).slice(before)
    expect(rows.some((r) => r.action === 'ai.settings.test'), JSON.stringify(rows)).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(key)
  })

  it('AC-T19-04 body inválido no teste → 400 VALIDATION_ERROR', async () => {
    const r = await test({ maxTokens: -1 })
    expect(r.status, r.text).toBe(400)
    expect(r.body?.error?.code).toBe('VALIDATION_ERROR')
  })
})
