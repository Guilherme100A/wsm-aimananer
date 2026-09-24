// Lógica da página "IA / Modelo LLM" (T19): cliente da API e conversão formulário ↔ payload.
// A chave de API nunca volta da API; o formulário só a envia quando o usuário substitui.
import { request } from '../lib/api'

export type AiSettingsSource = 'db' | 'env'
export type AiSettingsField = 'provider' | 'apiKey' | 'modelSmall' | 'modelLarge' | 'confidenceThreshold' | 'maxTokens' | 'timeoutMs' | 'enabled'

export interface AiSettings {
  provider: 'anthropic'
  modelSmall: string
  modelLarge: string
  confidenceThreshold: number
  maxTokens: number
  timeoutMs: number
  enabled: boolean
  hasApiKey: boolean
  updatedAt: string | null
  sources: Record<AiSettingsField, AiSettingsSource>
}

export interface AiSettingsPayload {
  apiKey?: string | null
  modelSmall?: string
  modelLarge?: string
  confidenceThreshold?: number
  maxTokens?: number
  timeoutMs?: number
  enabled?: boolean
}

export interface AiTestResult {
  ok: boolean
  model: string
  latencyMs: number
  error?: string
}

export const aiApi = {
  get: () => request<AiSettings>('/api/ai/settings'),
  update: (body: AiSettingsPayload) => request<AiSettings>('/api/ai/settings', { method: 'PUT', body }),
  test: (body: AiSettingsPayload = {}) => request<AiTestResult>('/api/ai/settings/test', { method: 'POST', body }),
}

/** Limites iguais aos da API (validação antecipada; a API valida de novo). */
export const AI_LIMITS = {
  maxTokens: { min: 1, max: 8192 },
  timeoutMs: { min: 500, max: 120_000 },
} as const

export interface AiForm {
  modelSmall: string
  modelLarge: string
  confidenceThreshold: string
  maxTokens: string
  timeoutMs: string
  enabled: boolean
}

export function formFromSettings(s: AiSettings): AiForm {
  return {
    modelSmall: s.modelSmall,
    modelLarge: s.modelLarge,
    confidenceThreshold: String(s.confidenceThreshold),
    maxTokens: String(s.maxTokens),
    timeoutMs: String(s.timeoutMs),
    enabled: s.enabled,
  }
}

export class AiFormError extends Error {
  constructor(
    readonly field: keyof AiForm,
    message: string,
  ) {
    super(message)
    this.name = 'AiFormError'
  }
}

/** Payload só com os campos alterados em relação ao carregado. Lança AiFormError se algum valor for inválido. */
export function payloadFromForm(form: AiForm, loaded: AiSettings): AiSettingsPayload {
  const out: AiSettingsPayload = {}
  const small = form.modelSmall.trim()
  const large = form.modelLarge.trim()
  if (!small) throw new AiFormError('modelSmall', 'Informe o modelo pequeno.')
  if (!large) throw new AiFormError('modelLarge', 'Informe o modelo grande.')
  const threshold = Number(form.confidenceThreshold.replace(',', '.'))
  if (!form.confidenceThreshold.trim() || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new AiFormError('confidenceThreshold', 'O limiar deve estar entre 0 e 1.')
  }
  const int = (field: 'maxTokens' | 'timeoutMs', label: string) => {
    const n = Number(form[field])
    const { min, max } = AI_LIMITS[field]
    if (!form[field].trim() || !Number.isInteger(n) || n < min || n > max) throw new AiFormError(field, `${label} deve ser um inteiro entre ${min} e ${max}.`)
    return n
  }
  const maxTokens = int('maxTokens', 'O limite de tokens')
  const timeoutMs = int('timeoutMs', 'O timeout (ms)')
  if (small !== loaded.modelSmall) out.modelSmall = small
  if (large !== loaded.modelLarge) out.modelLarge = large
  if (threshold !== loaded.confidenceThreshold) out.confidenceThreshold = threshold
  if (maxTokens !== loaded.maxTokens) out.maxTokens = maxTokens
  if (timeoutMs !== loaded.timeoutMs) out.timeoutMs = timeoutMs
  if (form.enabled !== loaded.enabled) out.enabled = form.enabled
  return out
}

export const sourceLabel = (s: AiSettingsSource | undefined) => (s === 'db' ? 'banco' : 'env')
export const keyStatusLabel = (hasApiKey: boolean) => (hasApiKey ? 'configurada' : 'não configurada')

export function testResultText(r: AiTestResult): string {
  return r.ok ? `OK · modelo ${r.model} · ${r.latencyMs} ms` : `Falhou · modelo ${r.model} · ${r.error ?? 'erro desconhecido'}`
}
