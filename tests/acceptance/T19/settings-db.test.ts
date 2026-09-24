import { aiSettingsRows, C, ENV_AI, FIELDS, getSettings, newKey, putSettings, resetSettings, useAiApi } from './shared'
import { describe, expect, it } from 'vitest'
import { sqlOk } from '../helpers/pg'

describe('T19 — tabela ai_settings e precedência banco × env', () => {
  const ctx = useAiApi()

  it('AC-T19-01 existe a tabela ai_settings com os campos da configuração', () => {
    const cols = sqlOk(ctx.tempDb.url, "SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_settings';").map((r) => r[0]!)
    expect(cols.length, 'tabela ai_settings não existe').toBeGreaterThan(0)
    const joined = cols.join(' ')
    for (const re of [/provider/, /api_key/, /model_small/, /model_large/, /confidence_threshold/, /max_tokens/, /timeout_ms/, /enabled/, /updated_at/])
      expect(joined, `coluna ${re} ausente em ai_settings: ${joined}`).toMatch(re)
  })

  it('AC-T19-01 sem linha no banco, vale o env do T13 (AI_*) e toda origem é env', async () => {
    const s = await getSettings(ctx)
    expect(aiSettingsRows(ctx.tempDb.url)).toHaveLength(0)
    expect(s).toMatchObject({
      provider: 'anthropic',
      modelSmall: ENV_AI.AI_MODEL_SMALL,
      modelLarge: ENV_AI.AI_MODEL_LARGE,
      confidenceThreshold: Number(ENV_AI.AI_CONFIDENCE_THRESHOLD),
      maxTokens: Number(ENV_AI.AI_MAX_TOKENS),
      timeoutMs: Number(ENV_AI.AI_TIMEOUT_MS),
      enabled: true,
      hasApiKey: false,
      updatedAt: null,
    })
    for (const f of FIELDS) expect(s.sources?.[f], `origem de ${f}`).toBe('env')
  })

  it('AC-T19-01 com linha, o banco vence campo a campo; o resto continua vindo do env', async () => {
    const s = await putSettings(ctx, { modelSmall: 'db-modelo-pequeno', maxTokens: 777 })
    expect(s.modelSmall).toBe('db-modelo-pequeno')
    expect(s.maxTokens).toBe(777)
    expect(s.sources.modelSmall).toBe('db')
    expect(s.sources.maxTokens).toBe('db')
    expect(s.modelLarge).toBe(ENV_AI.AI_MODEL_LARGE)
    expect(s.sources.modelLarge).toBe('env')
    expect(s.sources.timeoutMs).toBe('env')
    expect(s.updatedAt).toBeTruthy()
    const again = await getSettings(ctx)
    expect(again.modelSmall).toBe('db-modelo-pequeno')
    expect(again.sources.confidenceThreshold).toBe('env')
  })

  it('AC-T19-01 a tabela tem uma linha só, mesmo depois de vários PUTs', async () => {
    await putSettings(ctx, { modelLarge: 'db-grande-1' })
    await putSettings(ctx, { modelLarge: 'db-grande-2', confidenceThreshold: 0.4 })
    await putSettings(ctx, { enabled: false })
    expect(aiSettingsRows(ctx.tempDb.url)).toHaveLength(1)
    const s = await getSettings(ctx)
    expect(s).toMatchObject({ modelLarge: 'db-grande-2', confidenceThreshold: 0.4, enabled: false })
    expect(s.sources.enabled).toBe('db')
  })

  it('AC-T19-01 null num campo volta a usar o env', async () => {
    await putSettings(ctx, { modelSmall: 'db-x', timeoutMs: 9000 })
    const s = await putSettings(ctx, { modelSmall: null })
    expect(s.modelSmall).toBe(ENV_AI.AI_MODEL_SMALL)
    expect(s.sources.modelSmall).toBe('env')
    expect(s.timeoutMs).toBe(9000)
    expect(s.sources.timeoutMs).toBe('db')
  })

  it('AC-T19-01 a chave fica só cifrada no banco (cripto do T02): o texto da chave não aparece em nenhuma coluna', async () => {
    const key = newKey()
    const s = await putSettings(ctx, { apiKey: key })
    expect(s.hasApiKey).toBe(true)
    expect(s.sources.apiKey).toBe('db')
    const rows = aiSettingsRows(ctx.tempDb.url)
    expect(rows).toHaveLength(1)
    expect(rows[0], 'chave em claro no banco').not.toContain(key)
    expect(rows[0]).not.toContain(key.slice(-16))
    expect(rows[0]).not.toContain(Buffer.from(key).toString('base64'))
    // colunas bytea saem como \x<hex> no JSON: a chave gravada crua apareceria em hex
    expect(rows[0], 'chave gravada sem cifra (bytea em claro)').not.toContain(Buffer.from(key).toString('hex'))
  })

  it('AC-T19-01 AiSettingsService.resolve() decifra a chave para o worker e aplica a precedência com o env informado', async () => {
    await resetSettings(ctx)
    const key = newKey()
    await putSettings(ctx, { apiKey: key, modelSmall: 'db-small-resolve' })
    const svc = new C.AiSettingsService({ db: ctx.db, env: { ...ENV_AI, AI_MODEL_LARGE: 'outro-env-grande' } })
    const r = await svc.resolve()
    expect(r.config.apiKey).toBe(key)
    expect(r.config.smallModel).toBe('db-small-resolve')
    expect(r.config.largeModel).toBe('outro-env-grande')
    expect(r.enabled).toBe(true)
    expect(r.sources.modelSmall).toBe('db')
    expect(r.sources.modelLarge).toBe('env')
  })

  it('AC-T19-01 chave removida do banco com AI_PROVIDER_API_KEY no env → a do env volta a valer (origem env)', async () => {
    const envKey = newKey()
    await putSettings(ctx, { apiKey: newKey() })
    await putSettings(ctx, { apiKey: null })
    const svc = new C.AiSettingsService({ db: ctx.db, env: { ...ENV_AI, AI_PROVIDER_API_KEY: envKey } })
    const r = await svc.resolve()
    expect(r.config.apiKey).toBe(envKey)
    expect(r.sources.apiKey).toBe('env')
    const view = await svc.get()
    expect(view.hasApiKey).toBe(true)
    expect(JSON.stringify(view)).not.toContain(envKey)
  })
})
