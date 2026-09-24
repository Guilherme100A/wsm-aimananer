// Configurações do LLM (T19) com Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiSettings, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { DEFAULT_AI_CONFIG } from './config'
import type { AiProvider } from './provider'
import { AiAssistant } from './router'
import {
  AiSettingsService,
  applyAiSettingsInput,
  InvalidAiSettingsError,
  resolveAiSettings,
  sanitizeAiError,
  testAiProvider,
  toAiSettingsView,
} from './settings'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY
const KEY = 'sk-ant-api03-SEGREDO-DE-TESTE'

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_aisettings' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

beforeEach(async () => {
  await db.delete(aiSettings)
})

const env = { AI_MODEL_SMALL: 'env-small', AI_PROVIDER_API_KEY: 'env-key', AI_MAX_TOKENS: '300' }

describe('resolveAiSettings (função pura)', () => {
  it('sem linha: tudo do ambiente (defaults do T13 contam como env)', () => {
    const r = resolveAiSettings(undefined, env)
    expect(r.config).toMatchObject({ smallModel: 'env-small', largeModel: DEFAULT_AI_CONFIG.largeModel, maxTokens: 300, apiKey: 'env-key' })
    expect(r.enabled).toBe(true)
    expect(new Set(Object.values(r.sources))).toEqual(new Set(['env']))
    expect(resolveAiSettings(undefined, { AI_ENABLED: 'false' }).enabled).toBe(false)
  })

  it('banco vence campo a campo; view nunca tem a chave', () => {
    const r = resolveAiSettings({ modelLarge: 'db-large', enabled: false, maxTokens: null }, env, 'db-key')
    expect(r.config).toMatchObject({ smallModel: 'env-small', largeModel: 'db-large', maxTokens: 300, apiKey: 'db-key' })
    expect(r.sources).toMatchObject({ modelSmall: 'env', modelLarge: 'db', maxTokens: 'env', enabled: 'db', apiKey: 'db' })
    const view = toAiSettingsView(r)
    expect(view.hasApiKey).toBe(true)
    expect(JSON.stringify(view)).not.toContain('db-key')
    expect(Object.keys(view)).not.toContain('apiKey')
  })

  it('applyAiSettingsInput: mescla sem salvar; null volta ao ambiente', () => {
    const r = resolveAiSettings({ modelSmall: 'db-small' }, env)
    const n = applyAiSettingsInput(r, { modelSmall: null, modelLarge: 'x', apiKey: 'k2' }, env)
    expect(n.config).toMatchObject({ smallModel: 'env-small', largeModel: 'x', apiKey: 'k2' })
    expect(n.sources).toMatchObject({ modelSmall: 'env', modelLarge: 'db', apiKey: 'db' })
    expect(r.config.smallModel).toBe('db-small')
  })
})

describe('AiSettingsService', () => {
  it('update grava a chave só cifrada; get não expõe; null remove; omitido mantém', async () => {
    const svc = new AiSettingsService({ db, env })
    const res = await svc.update({ apiKey: KEY, modelSmall: '  claude-x ', confidenceThreshold: 0.8, enabled: true })
    expect(res.apiKey).toBe('set')
    expect(res.fields.sort()).toEqual(['apiKey', 'confidenceThreshold', 'enabled', 'modelSmall'])
    expect(res.view).toMatchObject({ modelSmall: 'claude-x', confidenceThreshold: 0.8, hasApiKey: true, sources: { apiKey: 'db', modelSmall: 'db', modelLarge: 'env' } })
    expect(JSON.stringify(res.view)).not.toContain(KEY)
    const raw = await db.$client.query('select * from ai_settings')
    expect(JSON.stringify(raw.rows)).not.toContain('SEGREDO')
    expect((await svc.resolve()).config.apiKey).toBe(KEY)

    const kept = await svc.update({ maxTokens: 100 })
    expect(kept.apiKey).toBe('unchanged')
    expect((await svc.resolve()).config.apiKey).toBe(KEY)

    const removed = await svc.update({ apiKey: null })
    expect(removed.apiKey).toBe('removed')
    // sem chave no banco, a do ambiente volta a valer
    expect(removed.view).toMatchObject({ hasApiKey: true, sources: { apiKey: 'env' } })
    expect((await new AiSettingsService({ db, env: {} }).get()).hasApiKey).toBe(false)
  })

  it('valida limites', async () => {
    const svc = new AiSettingsService({ db, env })
    for (const bad of [{ modelSmall: ' ' }, { confidenceThreshold: 1.5 }, { maxTokens: 0 }, { maxTokens: 9000 }, { timeoutMs: 100 }, { maxTokens: 1.5 }]) {
      await expect(svc.update(bad)).rejects.toBeInstanceOf(InvalidAiSettingsError)
    }
  })
})

describe('testAiProvider', () => {
  const settings = () => resolveAiSettings({ modelSmall: 'm-small' }, {}, KEY)

  it('ok com latência; chamada mínima com o modelo pequeno', async () => {
    const generate = vi.fn(async () => ({ intent: 'outro', confidence: 1, text: 'pong' }))
    let t = 0
    const res = await testAiProvider(settings(), () => ({ generate }), () => (t += 10))
    expect(res).toEqual({ ok: true, model: 'm-small', latencyMs: 10 })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'm-small', maxTokens: 64, text: 'ping' }))
  })

  it('erro sanitizado sem a chave; sem chave → erro claro', async () => {
    const provider: AiProvider = { generate: async () => Promise.reject(new Error(`401 invalid x-api-key ${KEY}`)) }
    const res = await testAiProvider(settings(), () => provider)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('[redacted]')
    expect(res.error).not.toContain('SEGREDO')
    expect(await testAiProvider(resolveAiSettings(undefined, {}), () => provider)).toMatchObject({ ok: false, error: 'no api key configured' })
    expect(sanitizeAiError('x'.repeat(500)).length).toBe(300)
  })
})

describe('AiAssistant com fonte dinâmica (AC-T19-03)', () => {
  it('troca modelo e chave sem restart, invalida o cache; enabled=false → só fallback', async () => {
    const svc = new AiSettingsService({ db, env: {} })
    await svc.update({ apiKey: 'k1', modelSmall: 'small-1', confidenceThreshold: 0 })
    const calls: string[] = []
    const factory = vi.fn((key: string): AiProvider => ({
      generate: async (req) => {
        calls.push(`${key}:${req.model}`)
        return { intent: 'duvida', confidence: 0.9, text: 'resposta' }
      },
    }))
    const ai = new AiAssistant({ settings: svc, providerFactory: factory, refreshMs: 0 })

    expect(await ai.suggest('olá')).toMatchObject({ model: 'small-1', source: 'provider' })
    expect(await ai.suggest('olá')).toMatchObject({ source: 'cache' })

    await svc.update({ modelSmall: 'small-2', apiKey: 'k2' })
    expect(await ai.suggest('olá')).toMatchObject({ model: 'small-2', source: 'provider' })
    expect(calls).toEqual(['k1:small-1', 'k2:small-2'])
    expect(ai.config.smallModel).toBe('small-2')

    await svc.update({ enabled: false })
    expect(await ai.suggest('outra')).toMatchObject({ model: 'fallback', source: 'fallback' })
    expect(ai.isEnabled).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('refreshMs: dentro da validade não relê; refresh() força', async () => {
    const svc = { resolve: vi.fn(async () => resolveAiSettings({ modelSmall: 'a' }, {}, 'k')) }
    let now = 0
    const ai = new AiAssistant({ settings: svc, providerFactory: () => ({ generate: async () => ({ intent: 'x', confidence: 1, text: 'y' }) }), refreshMs: 1000, now: () => now })
    await ai.suggest('1')
    await ai.suggest('2')
    expect(svc.resolve).toHaveBeenCalledTimes(1)
    now = 1500
    await ai.suggest('3')
    expect(svc.resolve).toHaveBeenCalledTimes(2)
    await ai.refresh()
    expect(svc.resolve).toHaveBeenCalledTimes(3)
  })

  it('fonte fora do ar: nunca lança; sem config lida → fallback', async () => {
    const ai = new AiAssistant({ settings: { resolve: async () => Promise.reject(new Error('db down')) }, refreshMs: 0 })
    expect(await ai.suggest('oi')).toMatchObject({ source: 'fallback' })
  })

  it('construtor antigo do T13 continua igual', async () => {
    const ai = new AiAssistant({ provider: { generate: async () => ({ intent: 'x', confidence: 1, text: 'y' }) }, config: { smallModel: 's' } })
    expect(await ai.suggest('oi')).toMatchObject({ model: 's', source: 'provider' })
  })
})
