// /api/ai/settings (T19) com Postgres local (banco descartável) e provedor falso.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateCredentialsKey, resetCredentialsCrypto, type AiProvider } from '@wsm/core'
import { aiSettings, auditLogs, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 't0k'
const KEY = 'sk-ant-api03-CHAVE-SECRETA-XYZ'
let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_aisettings' })
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
  await db.delete(auditLogs)
})

/** Campos lidos pelos testes nas respostas (settings, erro da API ou resultado do /test). */
interface Body {
  sources: Record<string, string>
  error: { code: string } & string
}

function setup(factory?: (key: string) => AiProvider, aiEnv: Record<string, string> = { AI_MODEL_SMALL: 'env-small' }) {
  const { logger, lines } = captureLogger()
  const app = createApp({ db, redis: fakeRedis(), logger, apiToken: TOKEN, aiEnv, ...(factory ? { aiProviderFactory: factory } : {}) })
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, body: (text ? JSON.parse(text) : undefined) as Body | undefined }
  }
  return { req, lines }
}

describe('/api/ai/settings', () => {
  it('GET sem linha: valores do env, tudo com source env, sem chave', async () => {
    const { req } = setup()
    const res = await req('GET', '/api/ai/settings')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ provider: 'anthropic', modelSmall: 'env-small', enabled: true, hasApiKey: false, updatedAt: null })
    expect(new Set(Object.values(res.body!.sources))).toEqual(new Set(['env']))
  })

  it('PUT salva, audita sem a chave e nenhuma resposta/log contém a chave', async () => {
    const { req, lines } = setup()
    const put = await req('PUT', '/api/ai/settings', { apiKey: KEY, modelLarge: 'db-large', confidenceThreshold: 0.7, enabled: false })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ modelLarge: 'db-large', confidenceThreshold: expect.closeTo(0.7, 5), enabled: false, hasApiKey: true })
    expect(put.body!.sources).toMatchObject({ apiKey: 'db', modelLarge: 'db', modelSmall: 'env', enabled: 'db' })
    expect(put.text).not.toContain('CHAVE-SECRETA')
    expect((await req('GET', '/api/ai/settings')).text).not.toContain('CHAVE-SECRETA')
    const audits = await db.select().from(auditLogs)
    expect(audits.at(-1)).toMatchObject({ action: 'ai.settings.update', targetType: 'ai_settings', targetId: 'singleton' })
    expect(audits.at(-1)!.detail).toMatchObject({ apiKey: 'set', hasApiKey: true })
    expect(JSON.stringify(audits)).not.toContain('CHAVE-SECRETA')
    expect(JSON.stringify(lines)).not.toContain('CHAVE-SECRETA')

    // omitir mantém; null remove
    expect((await req('PUT', '/api/ai/settings', { maxTokens: 100 })).body).toMatchObject({ hasApiKey: true, maxTokens: 100 })
    expect((await req('PUT', '/api/ai/settings', { apiKey: null })).body).toMatchObject({ hasApiKey: false, sources: { apiKey: 'env' } })
  })

  it('PUT valida → 400 VALIDATION_ERROR', async () => {
    const { req } = setup()
    for (const bad of [{}, { modelSmall: '' }, { confidenceThreshold: 2 }, { maxTokens: 0 }, { maxTokens: 10000 }, { timeoutMs: 100 }, { provider: 'openai' }, { foo: 1 }, { enabled: 'yes' }]) {
      const res = await req('PUT', '/api/ai/settings', bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(res.body!.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('POST /test com provedor falso: salva nada, usa override do body e sanitiza o erro', async () => {
    const generate = vi.fn(async () => ({ intent: 'outro', confidence: 1, text: 'pong' }))
    const keys: string[] = []
    const { req } = setup((key) => {
      keys.push(key)
      return key === 'bad' ? { generate: async () => Promise.reject(new Error(`invalid key ${key}`)) } : { generate }
    })
    expect((await req('POST', '/api/ai/settings/test')).body).toMatchObject({ ok: false, error: 'no api key configured' })

    const ok = await req('POST', '/api/ai/settings/test', { apiKey: 'k-test', modelSmall: 'm-override' })
    expect(ok.body).toMatchObject({ ok: true, model: 'm-override', latencyMs: expect.any(Number) })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'm-override' }))
    expect((await req('GET', '/api/ai/settings')).body).toMatchObject({ hasApiKey: false, modelSmall: 'env-small' })

    const bad = await req('POST', '/api/ai/settings/test', { apiKey: 'bad' })
    expect(bad.body).toMatchObject({ ok: false })
    expect(bad.body!.error).toContain('[redacted]')
    expect(keys).toEqual(['k-test', 'bad'])
    expect((await req('POST', '/api/ai/settings/test', { maxTokens: -1 })).status).toBe(400)
  })

  it('exige auth', async () => {
    const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN })
    expect((await app.request('/api/ai/settings')).status).toBe(401)
  })
})
