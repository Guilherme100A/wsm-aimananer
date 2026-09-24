// Setup comum do T19 (configurações do modelo de LLM).
// Contrato combinado com o Operário (Brasa):
//   DB: ai_settings, linha única, colunas nuláveis campo a campo (NULL = vale o env), chave só cifrada (T02).
//   API: GET /api/ai/settings → { provider, modelSmall, modelLarge, confidenceThreshold, maxTokens, timeoutMs, enabled,
//          hasApiKey, updatedAt|null, sources: { provider, apiKey, modelSmall, modelLarge, confidenceThreshold, maxTokens,
//          timeoutMs, enabled: 'db'|'env' } } — nunca a chave.
//        PUT /api/ai/settings (parcial, strict; omitido mantém; null volta ao env; apiKey null remove) → mesmo formato.
//          Limites: modelos trim 1..200 · limiar 0..1 · maxTokens int 1..8192 · timeoutMs int 500..120000 · apiKey 1..500.
//          Auditoria: action 'ai.settings.update', target_type 'ai_settings', detail { fields, apiKey: set|removed|unchanged, hasApiKey }.
//        POST /api/ai/settings/test (body opcional, não salva) → { ok, model, latencyMs, error? } · audita 'ai.settings.test'.
//        createApp({ ..., aiProviderFactory?: (apiKey) => AiProvider, aiEnv?: env })
//   @wsm/core: AiSettingsService({ db, env? }).get()/update()/resolve() → { config (AiConfig com apiKey), enabled, provider, sources }
//              new AiAssistant({ settings, providerFactory, refreshMs, logger }) + refresh()
//   Dashboard: rota #/ai, nav-ai, page-ai (h1 'IA / Modelo LLM'), testids ai-*.
import { ENV_AI } from './env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import * as core from '@wsm/core'
import { createDb } from '@wsm/db'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, migrate, sqlOk, type TempDb } from '../helpers/pg'

export { ENV_AI }
export const C = core as Record<string, any>
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export const newKey = () => `sk-ant-teste-${randomBytes(16).toString('hex')}`

export interface ProviderCall {
  apiKey: string
  model: string
  maxTokens: number
  text: string
}

/** Fábrica de provedores FAKE: registra a chave com que cada provedor foi criado e cada chamada. */
export function fakeProviderFactory() {
  const created: string[] = []
  const calls: ProviderCall[] = []
  let behavior: (req: ProviderCall) => Promise<{ intent: string; confidence: number; text: string }> = async (req) => ({
    intent: 'pricing',
    confidence: 0.95,
    text: `resposta (${req.model})`,
  })
  const factory = (apiKey: string) => {
    created.push(apiKey)
    return {
      generate: async (req: { model: string; maxTokens: number; text: string; signal?: AbortSignal }) => {
        const call = { apiKey, model: req.model, maxTokens: req.maxTokens, text: req.text }
        calls.push(call)
        return behavior(call)
      },
    }
  }
  return {
    factory,
    created,
    calls,
    setBehavior(fn: typeof behavior) {
      behavior = fn
    },
  }
}

export interface AiApiCtx {
  tempDb: TempDb
  db: any
  redis: any
  token: string
  app: any
  logLines: string[]
  provider: ReturnType<typeof fakeProviderFactory>
}

/** createApp com banco descartável, provedor falso injetado e o env de IA do teste. */
export function useAiApi(): AiApiCtx {
  const ctx = {} as AiApiCtx
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t19')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    const { logger, lines } = await captureLogger()
    ctx.logLines = lines
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.provider = fakeProviderFactory()
    ctx.app = await (createApp as any)({
      db: ctx.db,
      redis: ctx.redis,
      logger,
      apiToken: ctx.token,
      aiProviderFactory: ctx.provider.factory,
      aiEnv: { ...ENV_AI },
    })
  })
  afterAll(async () => {
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

export const api = (ctx: { app: any; token: string }, method: string, path: string, body?: unknown) => call(ctx.app, method, path, { token: ctx.token, body })

export async function getSettings(ctx: { app: any; token: string }) {
  const r = await api(ctx, 'GET', '/api/ai/settings')
  expect(r.status, `GET /api/ai/settings → ${r.text}`).toBe(200)
  return r.body as Record<string, any>
}

export async function putSettings(ctx: { app: any; token: string }, body: Record<string, unknown>) {
  const r = await api(ctx, 'PUT', '/api/ai/settings', body)
  expect(r.status, `PUT /api/ai/settings → ${r.text}`).toBe(200)
  return r.body as Record<string, any>
}

/** Volta tudo para o env (linha com todos os campos nulos ou removida). */
export const resetSettings = (ctx: { app: any; token: string }) =>
  putSettings(ctx, { apiKey: null, modelSmall: null, modelLarge: null, confidenceThreshold: null, maxTokens: null, timeoutMs: null, enabled: null })

export const aiSettingsRows = (url: string): string[] => sqlOk(url, 'SELECT row_to_json(t)::text FROM ai_settings t;').map((r) => r[0]!)

export const auditRows = (url: string) =>
  sqlOk(url, "SELECT row_to_json(t)::text FROM (SELECT actor, action, target_type, target_id, detail FROM audit_logs WHERE action LIKE 'ai.%' ORDER BY id) t;").map((r) => JSON.parse(r[0]!))

export const FIELDS = ['provider', 'apiKey', 'modelSmall', 'modelLarge', 'confidenceThreshold', 'maxTokens', 'timeoutMs', 'enabled'] as const

/** Nenhuma parte da resposta pode conter a chave (em claro, base64, hex) nem material cifrado. */
export function expectNoKey(payload: unknown, key: string) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  expect(text, 'resposta contém a chave').not.toContain(key)
  expect(text).not.toContain(Buffer.from(key).toString('base64'))
  expect(text).not.toContain(Buffer.from(key).toString('hex'))
  expect(text.toLowerCase()).not.toMatch(/ciphertext|auth_?tag|"iv"|key_?version/)
  // `sources.apiKey` ('db'|'env') é permitido; um campo apiKey no nível da configuração, não
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    expect(payload, 'resposta expõe o campo apiKey').not.toHaveProperty('apiKey')
    expect(payload).not.toHaveProperty('api_key')
  }
}
