// /api/ai/settings (T19): configuração do LLM da IA assistiva. Nunca devolve a chave (nem cifrada).
// O worker relê a configuração do banco sozinho (cache curto), sem restart.
import { Hono } from 'hono'
import { z } from 'zod'
import {
  AI_PROVIDERS,
  AI_SETTINGS_LIMITS as L,
  AiSettingsService,
  applyAiSettingsInput,
  createAiProvider,
  InvalidAiSettingsError,
  testAiProvider,
  type AiProviderFactory,
  type AiSettingsInput,
} from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

declare module '../types' {
  interface AppDeps {
    /** Cria o provedor a partir da chave (T19). Default: createAiProvider (SDK da Anthropic). Testes injetam um falso. */
    aiProviderFactory?: AiProviderFactory
    /** Ambiente usado como fallback das configurações de IA (default process.env). */
    aiEnv?: Record<string, string | undefined>
  }
}

const model = z.string().trim().min(L.model.min).max(L.model.max).nullable().optional()
const fields = {
  provider: z.enum(AI_PROVIDERS).nullable().optional(),
  apiKey: z.string().trim().min(L.apiKey.min).max(L.apiKey.max).nullable().optional(),
  modelSmall: model,
  modelLarge: model,
  confidenceThreshold: z.number().min(L.confidenceThreshold.min).max(L.confidenceThreshold.max).nullable().optional(),
  maxTokens: z.number().int().min(L.maxTokens.min).max(L.maxTokens.max).nullable().optional(),
  timeoutMs: z.number().int().min(L.timeoutMs.min).max(L.timeoutMs.max).nullable().optional(),
  enabled: z.boolean().nullable().optional(),
}

export const updateAiSettingsSchema = z
  .object(fields)
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'nothing to update' })
export const testAiSettingsSchema = z.object(fields).strict()

const input = (b: z.infer<typeof testAiSettingsSchema>): AiSettingsInput =>
  Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as AiSettingsInput

export function aiSettingsRoutes(deps: Pick<AppDeps, 'db' | 'aiProviderFactory' | 'aiEnv'>) {
  const env = deps.aiEnv ?? process.env
  const service = new AiSettingsService({ db: deps.db, env })
  const factory = deps.aiProviderFactory ?? createAiProvider

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof InvalidAiSettingsError) {
        throw new ApiError('VALIDATION_ERROR', err.message, { issues: [{ path: err.field, message: err.message, code: 'custom' }] })
      }
      throw err
    }
  }

  return new Hono<AppEnv>()
    .get('/api/ai/settings', async (c) => c.json(await run(() => service.get())))
    .put('/api/ai/settings', validate('json', updateAiSettingsSchema), async (c) => {
      const res = await run(() => service.update(input(c.req.valid('json'))))
      setAudit(c, {
        action: 'ai.settings.update',
        targetType: 'ai_settings',
        targetId: 'singleton',
        detail: { fields: res.fields, apiKey: res.apiKey, hasApiKey: res.view.hasApiKey },
      })
      return c.json(res.view)
    })
    .post('/api/ai/settings/test', async (c) => {
      const raw = await c.req.text()
      const body = testAiSettingsSchema.parse(raw.trim() ? JSON.parse(raw) : {})
      const settings = applyAiSettingsInput(await run(() => service.resolve()), input(body), env)
      const result = await testAiProvider(settings, factory)
      setAudit(c, {
        action: 'ai.settings.test',
        targetType: 'ai_settings',
        targetId: 'singleton',
        detail: { ok: result.ok, model: result.model, override: Object.keys(input(body)) },
      })
      return c.json(result)
    })
}
