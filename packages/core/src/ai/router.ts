// Roteador de modelos da IA assistiva (T13, AC-T13-03/04/05).
// small por padrão; large só quando a confiança do small < limiar. Cache por hash do texto normalizado.
// Erro/timeout do provedor → fallback determinístico. `suggest` nunca lança.
import { resolveAiConfig, type AiConfig } from './config'
import { fallbackClassify, FALLBACK_MODEL, type Classification } from './fallback'
import type { AiProvider } from './provider'
import { hashAiText } from './text'

export type SuggestionSource = 'provider' | 'cache' | 'fallback'

export interface AiSuggestion extends Classification {
  model: string
  source: SuggestionSource
}

export interface AiLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export interface AiAssistantOptions {
  provider?: AiProvider
  config?: Partial<AiConfig>
  logger?: AiLogger
  /** Máximo de entradas no cache (LRU simples). Default 1000. */
  cacheSize?: number
}

export class AiTimeoutError extends Error {
  constructor(ms: number) {
    super(`provider timeout after ${ms}ms`)
    this.name = 'AiTimeoutError'
  }
}

/** Modelo a usar: small, ou large quando a confiança do small ficou abaixo do limiar. */
export function chooseModel(config: Pick<AiConfig, 'smallModel' | 'largeModel' | 'confidenceThreshold'>, smallConfidence?: number): string {
  return smallConfidence !== undefined && smallConfidence < config.confidenceThreshold ? config.largeModel : config.smallModel
}

type CacheEntry = Omit<AiSuggestion, 'source'>

export class AiAssistant {
  readonly config: AiConfig
  private readonly provider: AiProvider | undefined
  private readonly log: AiLogger | undefined
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<AiSuggestion>>()
  private readonly cacheSize: number

  constructor(opts: AiAssistantOptions = {}) {
    this.config = resolveAiConfig(opts.config)
    this.provider = opts.provider
    this.log = opts.logger
    this.cacheSize = opts.cacheSize ?? 1000
  }

  /** Classifica e sugere uma resposta para o texto recebido. Nunca lança. */
  async suggest(text: string): Promise<AiSuggestion> {
    try {
      const key = hashAiText(text)
      const cached = this.cache.get(key)
      if (cached) {
        this.cache.delete(key)
        this.cache.set(key, cached)
        return { ...cached, source: 'cache' }
      }
      const pending = this.inflight.get(key)
      if (pending) {
        const r = await pending
        return r.source === 'provider' ? { ...r, source: 'cache' } : r
      }
      const run = this.compute(text, key)
      this.inflight.set(key, run)
      try {
        return await run
      } finally {
        this.inflight.delete(key)
      }
    } catch (err) {
      this.log?.warn({ err: errMessage(err) }, 'ai suggest failed; using fallback')
      return fallback(text)
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  private async compute(text: string, key: string): Promise<AiSuggestion> {
    if (!this.provider) return fallback(text)
    const { smallModel, largeModel } = this.config
    let result: CacheEntry
    try {
      result = { ...(await this.call(smallModel, text)), model: smallModel }
    } catch (err) {
      this.log?.warn({ model: smallModel, err: errMessage(err) }, 'ai provider failed; using fallback')
      return fallback(text)
    }
    if (chooseModel(this.config, result.confidence) === largeModel) {
      try {
        result = { ...(await this.call(largeModel, text)), model: largeModel }
      } catch (err) {
        // O large falhou: fica o resultado do small.
        this.log?.warn({ model: largeModel, err: errMessage(err) }, 'ai large model failed; keeping small result')
      }
    }
    this.remember(key, result)
    this.log?.info({ model: result.model, intent: result.intent, confidence: result.confidence }, 'ai suggestion generated')
    return { ...result, source: 'provider' }
  }

  private async call(model: string, text: string): Promise<Classification> {
    const { maxTokens, timeoutMs } = this.config
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new AiTimeoutError(timeoutMs))
      }, timeoutMs)
    })
    try {
      const out = await Promise.race([this.provider!.generate({ model, maxTokens, text, signal: controller.signal }), timeout])
      return validate(out)
    } finally {
      clearTimeout(timer)
    }
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry)
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

function fallback(text: string): AiSuggestion {
  return { ...fallbackClassify(text), model: FALLBACK_MODEL, source: 'fallback' }
}

/** Resposta do provedor precisa de intent e text não vazios; confidence é limitada a 0..1. */
function validate(out: unknown): Classification {
  const o = out as Partial<Classification> | null | undefined
  const intent = typeof o?.intent === 'string' ? o.intent.trim().toLowerCase().slice(0, 50) : ''
  const text = typeof o?.text === 'string' ? o.text.trim() : ''
  const confidence = typeof o?.confidence === 'number' && Number.isFinite(o.confidence) ? Math.min(1, Math.max(0, o.confidence)) : NaN
  if (!intent || !text || Number.isNaN(confidence)) throw new Error('invalid provider output')
  return { intent, confidence, text }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
