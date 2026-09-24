import { describe, expect, it } from 'vitest'
import { aiConfigFromEnv, DEFAULT_AI_CONFIG } from './config'
import { AI_INTENTS, fallbackClassify } from './fallback'
import type { AiGenerateRequest, AiProvider } from './provider'
import { AiAssistant, chooseModel } from './router'
import { hashAiText, normalizeAiText } from './text'

type Reply = { intent: string; confidence: number; text: string } | Error | 'hang'

/** Provedor fake: registra as chamadas e responde por modelo. */
function fakeProvider(replies: Record<string, Reply | Reply[]>) {
  const calls: AiGenerateRequest[] = []
  const provider: AiProvider = {
    generate: async (req) => {
      calls.push(req)
      const r = replies[req.model]
      const reply = Array.isArray(r) ? r.shift() : r
      if (reply === undefined) throw new Error(`no reply for ${req.model}`)
      if (reply === 'hang') return new Promise(() => {})
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { provider, calls }
}

const config = { smallModel: 'small-m', largeModel: 'large-m', confidenceThreshold: 0.6, maxTokens: 256, timeoutMs: 200 }
const sure = { intent: 'pricing', confidence: 0.9, text: 'Vou verificar os valores.' }
const unsure = { intent: 'other', confidence: 0.3, text: 'Recebemos.' }
const better = { intent: 'support', confidence: 0.8, text: 'Pode detalhar o problema?' }

describe('texto normalizado (cache)', () => {
  it('normalizeAiText: trim, lowercase e espaços colapsados', () => {
    expect(normalizeAiText('  Olá   MUNDO \n tudo\tbem ')).toBe('olá mundo tudo bem')
    expect(hashAiText('Oi  Tudo')).toBe(hashAiText(' oi tudo '))
    expect(hashAiText('oi')).not.toBe(hashAiText('oi!'))
    expect(hashAiText('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('roteador de modelos (AC-T13-03)', () => {
  it('small por padrão, com o limite de tokens configurado', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': sure })
    const r = await new AiAssistant({ provider, config }).suggest('quanto custa?')
    expect(r).toEqual({ ...sure, model: 'small-m', source: 'provider' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'small-m', maxTokens: 256, text: 'quanto custa?' })
  })

  it('large só quando a confiança do small fica abaixo do limiar', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': unsure, 'large-m': better })
    const r = await new AiAssistant({ provider, config }).suggest('está dando erro')
    expect(r).toEqual({ ...better, model: 'large-m', source: 'provider' })
    expect(calls.map((c) => [c.model, c.maxTokens])).toEqual([
      ['small-m', 256],
      ['large-m', 256],
    ])
  })

  it('confiança igual ao limiar não escala', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': { ...sure, confidence: 0.6 } })
    await new AiAssistant({ provider, config }).suggest('x')
    expect(calls.map((c) => c.model)).toEqual(['small-m'])
    expect(chooseModel(config, 0.59)).toBe('large-m')
    expect(chooseModel(config, 0.6)).toBe('small-m')
    expect(chooseModel(config)).toBe('small-m')
  })

  it('large falhando mantém o resultado do small', async () => {
    const { provider } = fakeProvider({ 'small-m': unsure, 'large-m': new Error('boom') })
    expect(await new AiAssistant({ provider, config }).suggest('x')).toEqual({ ...unsure, model: 'small-m', source: 'provider' })
  })
})

describe('cache (AC-T13-04)', () => {
  it('texto que normaliza igual não chama o provedor de novo', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': [sure, { ...sure, text: 'outra' }] })
    const ai = new AiAssistant({ provider, config })
    const first = await ai.suggest('Quanto  custa?')
    const second = await ai.suggest('  quanto custa? ')
    expect(calls).toHaveLength(1)
    expect(second).toEqual({ ...first, source: 'cache' })
  })

  it('chamadas simultâneas do mesmo texto fazem uma só chamada', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': sure })
    const ai = new AiAssistant({ provider, config })
    const [a, b] = await Promise.all([ai.suggest('oi'), ai.suggest('OI')])
    expect(calls).toHaveLength(1)
    expect([a.source, b.source].sort()).toEqual(['cache', 'provider'])
  })

  it('fallback não entra no cache', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': [new Error('down'), sure] })
    const ai = new AiAssistant({ provider, config })
    expect((await ai.suggest('preço')).source).toBe('fallback')
    expect((await ai.suggest('preço')).source).toBe('provider')
    expect(calls).toHaveLength(2)
  })

  it('cache limitado (LRU)', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': Array.from({ length: 10 }, () => sure) })
    const ai = new AiAssistant({ provider, config, cacheSize: 2 })
    await ai.suggest('a')
    await ai.suggest('b')
    await ai.suggest('c')
    await ai.suggest('a')
    expect(calls).toHaveLength(4)
  })
})

describe('fallback determinístico (AC-T13-05)', () => {
  it('sem provedor', async () => {
    const r = await new AiAssistant({ config }).suggest('Bom dia!')
    expect(r).toEqual({ ...fallbackClassify('Bom dia!'), model: 'fallback', source: 'fallback' })
    expect(r.intent).toBe('greeting')
  })

  it('erro do provedor', async () => {
    const { provider } = fakeProvider({ 'small-m': new Error('500') })
    const r = await new AiAssistant({ provider, config }).suggest('quanto custa o plano?')
    expect(r).toMatchObject({ intent: 'pricing', model: 'fallback', source: 'fallback' })
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('timeout do provedor (aborta a chamada)', async () => {
    const { provider, calls } = fakeProvider({ 'small-m': 'hang' })
    const t0 = Date.now()
    const r = await new AiAssistant({ provider, config: { ...config, timeoutMs: 50 } }).suggest('oi')
    expect(r.source).toBe('fallback')
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(calls[0]!.signal?.aborted).toBe(true)
  })

  it('resposta inválida do provedor', async () => {
    const { provider } = fakeProvider({ 'small-m': { intent: '', confidence: 2, text: '' } })
    expect((await new AiAssistant({ provider, config }).suggest('oi')).source).toBe('fallback')
  })

  it('confiança fora de 0..1 é limitada', async () => {
    const { provider } = fakeProvider({ 'small-m': { ...sure, confidence: 7 } })
    expect((await new AiAssistant({ provider, config }).suggest('x')).confidence).toBe(1)
  })

  it('provedor que lança síncrono também cai no fallback', async () => {
    const provider: AiProvider = {
      generate: () => {
        throw new Error('sync')
      },
    }
    expect((await new AiAssistant({ provider, config }).suggest('x')).source).toBe('fallback')
  })

  it.each([
    ['Oi, tudo bem?', 'greeting'],
    ['Qual o PREÇO do plano?', 'pricing'],
    ['Quero agendar um horário', 'scheduling'],
    ['Não consigo acessar, dá erro', 'support'],
    ['Péssimo atendimento, meu pedido veio errado', 'complaint'],
    ['Muito obrigado!', 'thanks'],
    ['Vocês abrem sábado?', 'question'],
    ['ok', 'other'],
  ])('%s → %s', (text, intent) => {
    const a = fallbackClassify(text)
    expect(a.intent).toBe(intent)
    expect(AI_INTENTS).toContain(a.intent)
    expect(a.text).toBeTruthy()
    expect(fallbackClassify(text)).toEqual(a)
  })
})

describe('aiConfigFromEnv', () => {
  it('defaults e leitura do ambiente', () => {
    expect(aiConfigFromEnv({})).toEqual({ ...DEFAULT_AI_CONFIG, apiKey: undefined })
    expect(
      aiConfigFromEnv({
        AI_MODEL_SMALL: 's',
        AI_MODEL_LARGE: 'l',
        AI_CONFIDENCE_THRESHOLD: '0.75',
        AI_MAX_TOKENS: '300',
        AI_TIMEOUT_MS: '2500',
        AI_PROVIDER_API_KEY: 'k',
      }),
    ).toEqual({ smallModel: 's', largeModel: 'l', confidenceThreshold: 0.75, maxTokens: 300, timeoutMs: 2500, apiKey: 'k' })
    expect(aiConfigFromEnv({ AI_CONFIDENCE_THRESHOLD: '7', AI_MAX_TOKENS: 'x', AI_PROVIDER_API_KEY: ' ' })).toMatchObject({
      confidenceThreshold: 0.6,
      maxTokens: 512,
      apiKey: undefined,
    })
  })
})
