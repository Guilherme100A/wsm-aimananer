import { api, auditRows, ENV_AI, expectNoKey, getSettings, newKey, putSettings, useAiApi } from './shared'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'

describe('T19 — GET/PUT /api/ai/settings', () => {
  const ctx = useAiApi()

  it('AC-T19-02 GET devolve a configuração efetiva com hasApiKey e a origem de cada campo', async () => {
    const s = await getSettings(ctx)
    for (const k of ['provider', 'modelSmall', 'modelLarge', 'confidenceThreshold', 'maxTokens', 'timeoutMs', 'enabled', 'hasApiKey', 'sources'])
      expect(s, `campo ${k} ausente`).toHaveProperty(k)
    expect(typeof s.hasApiKey).toBe('boolean')
    expect(Object.values(s.sources).every((v) => v === 'db' || v === 'env')).toBe(true)
  })

  it('AC-T19-02 nunca devolve a chave, nem cifrada: GET, PUT e logs', async () => {
    const key = newKey()
    const put = await api(ctx, 'PUT', '/api/ai/settings', { apiKey: key })
    expect(put.status, put.text).toBe(200)
    expectNoKey(put.body, key)
    expect(put.body.hasApiKey).toBe(true)
    const get = await api(ctx, 'GET', '/api/ai/settings')
    expectNoKey(get.body, key)
    expect(get.text).not.toContain(key)
    expect(ctx.logLines.join('\n'), 'chave vazou no log').not.toContain(key)
  })

  it('AC-T19-02 omitir apiKey mantém a chave; apiKey null remove', async () => {
    await putSettings(ctx, { apiKey: newKey() })
    const kept = await putSettings(ctx, { modelSmall: 'db-mantem-chave' })
    expect(kept.hasApiKey).toBe(true)
    expect(kept.sources.apiKey).toBe('db')
    const removed = await putSettings(ctx, { apiKey: null })
    expect(removed.hasApiKey, 'sem chave no env do teste, remover deixa hasApiKey=false').toBe(false)
    expect(removed.sources.apiKey).toBe('env')
    expect(removed.modelSmall, 'remover a chave não mexe nos outros campos').toBe('db-mantem-chave')
  })

  it('AC-T19-02 PUT é auditado sem a chave (fields alterados e apiKey set/removed/unchanged)', async () => {
    const key = newKey()
    const before = auditRows(ctx.tempDb.url).length
    await putSettings(ctx, { apiKey: key, modelLarge: 'db-grande-audit' })
    await putSettings(ctx, { maxTokens: 900 })
    await putSettings(ctx, { apiKey: null })
    const rows = auditRows(ctx.tempDb.url).slice(before)
    const updates = rows.filter((r) => r.action === 'ai.settings.update')
    expect(updates, JSON.stringify(rows)).toHaveLength(3)
    expect(JSON.stringify(rows), 'auditoria contém a chave').not.toContain(key)
    expect(updates[0].target_type).toBe('ai_settings')
    expect(updates[0].detail.apiKey).toBe('set')
    expect(updates[0].detail.fields).toEqual(expect.arrayContaining(['apiKey', 'modelLarge']))
    expect(updates[1].detail.apiKey).toBe('unchanged')
    expect(updates[1].detail.fields).toEqual(['maxTokens'])
    expect(updates[2].detail.apiKey).toBe('removed')
  })

  it.each([
    ['modelo vazio', { modelSmall: '' }],
    ['modelo só espaços', { modelLarge: '   ' }],
    ['modelo longo demais', { modelSmall: 'x'.repeat(201) }],
    ['limiar negativo', { confidenceThreshold: -0.1 }],
    ['limiar acima de 1', { confidenceThreshold: 1.5 }],
    ['maxTokens zero', { maxTokens: 0 }],
    ['maxTokens acima do limite', { maxTokens: 100_000 }],
    ['maxTokens fracionário', { maxTokens: 10.5 }],
    ['timeout baixo demais', { timeoutMs: 100 }],
    ['timeout alto demais', { timeoutMs: 10 * 60_000 }],
    ['apiKey vazia', { apiKey: '' }],
    ['provider desconhecido', { provider: 'openai' }],
    ['enabled não booleano', { enabled: 'sim' }],
    ['campo desconhecido', { temperature: 0.9 }],
    ['body vazio', {}],
  ])('AC-T19-02 PUT inválido (%s) → 400 VALIDATION_ERROR e nada muda', async (_label, body) => {
    const before = await getSettings(ctx)
    const res = await api(ctx, 'PUT', '/api/ai/settings', body)
    expectApiError(res, 'VALIDATION_ERROR', 400)
    const after = await getSettings(ctx)
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null })
  })

  it('AC-T19-02 limites seguros aceitos nas bordas (maxTokens 1 e 8192, timeoutMs 500 e 120000, limiar 0 e 1)', async () => {
    expect((await putSettings(ctx, { maxTokens: 1, timeoutMs: 500, confidenceThreshold: 0 })).maxTokens).toBe(1)
    const s = await putSettings(ctx, { maxTokens: 8192, timeoutMs: 120_000, confidenceThreshold: 1 })
    expect(s).toMatchObject({ maxTokens: 8192, timeoutMs: 120_000, confidenceThreshold: 1 })
  })

  it('AC-T19-02 rotas exigem autenticação (401)', async () => {
    expectApiError(await call(ctx.app, 'GET', '/api/ai/settings'), 'UNAUTHORIZED', 401)
    expectApiError(await call(ctx.app, 'PUT', '/api/ai/settings', { body: { modelSmall: 'x' } }), 'UNAUTHORIZED', 401)
    expectApiError(await call(ctx.app, 'POST', '/api/ai/settings/test', { body: {} }), 'UNAUTHORIZED', 401)
  })

  it('AC-T19-02 campo só no env e não enviado no PUT continua com origem env', async () => {
    const s = await putSettings(ctx, { enabled: true })
    expect(s.sources.enabled).toBe('db')
    expect(s.sources.timeoutMs === 'db' || s.timeoutMs === Number(ENV_AI.AI_TIMEOUT_MS)).toBe(true)
    const fresh = await putSettings(ctx, { timeoutMs: null })
    expect(fresh.sources.timeoutMs).toBe('env')
    expect(fresh.timeoutMs).toBe(Number(ENV_AI.AI_TIMEOUT_MS))
  })
})
