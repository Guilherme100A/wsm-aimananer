// AC-T13-03 roteador de modelos (small por padrão, large só abaixo do limiar; limite de tokens configurável)
// AC-T13-04 cache por hash do texto normalizado · AC-T13-05 fallback determinístico em erro/timeout.
// Sem banco: o AiAssistant é testado pelo contrato público com um provedor fake (nunca a API real).
import { describe, expect, it } from 'vitest'
import { assistant, C, FakeProvider, FALLBACK_INTENTS, LARGE, SMALL } from './shared'

describe('T13 — roteador de modelos', () => {
  it('AC-T13-03 confiança alta: só o modelo pequeno é chamado', async () => {
    const p = new FakeProvider()
    p.behavior = async (req) => ({ intent: 'pricing', confidence: 0.9, text: `small:${req.text}` })
    const r = await assistant(p).suggest('quanto custa o plano?')
    expect(p.calls.map((c) => c.model)).toEqual([SMALL])
    expect(r).toMatchObject({ model: SMALL, intent: 'pricing', source: 'provider', text: 'small:quanto custa o plano?' })
    expect(r.confidence).toBeCloseTo(0.9)
  })

  it('AC-T13-03 confiança abaixo do limiar: escala para o modelo grande e usa a resposta dele', async () => {
    const p = new FakeProvider()
    p.behavior = async (req) =>
      req.model === SMALL ? { intent: 'other', confidence: 0.3, text: 'small' } : { intent: 'support', confidence: 0.85, text: 'resposta do grande' }
    const r = await assistant(p).suggest('meu pedido não chegou e ninguém responde')
    expect(p.calls.map((c) => c.model)).toEqual([SMALL, LARGE])
    expect(r).toMatchObject({ model: LARGE, intent: 'support', text: 'resposta do grande', source: 'provider' })
  })

  it('AC-T13-03 limiar configurável: com limiar menor que a confiança, não escala', async () => {
    const p = new FakeProvider()
    p.behavior = async () => ({ intent: 'question', confidence: 0.3, text: 'ok' })
    await assistant(p, { confidenceThreshold: 0.2 }).suggest('pergunta um')
    expect(p.calls.map((c) => c.model)).toEqual([SMALL])
    await assistant(p, { confidenceThreshold: 0.5 }).suggest('pergunta dois')
    expect(p.calls.map((c) => c.model)).toEqual([SMALL, SMALL, LARGE])
  })

  it('AC-T13-03 limite de tokens configurável é repassado ao provedor em todas as chamadas', async () => {
    const p = new FakeProvider()
    p.behavior = async (req) => ({ intent: 'other', confidence: req.model === SMALL ? 0.1 : 0.9, text: 'x' })
    await assistant(p, { maxTokens: 77 }).suggest('texto qualquer')
    expect(p.calls.map((c) => c.maxTokens)).toEqual([77, 77])
  })

  it('AC-T13-03 aiConfigFromEnv lê AI_MODEL_SMALL, AI_MODEL_LARGE, AI_CONFIDENCE_THRESHOLD, AI_MAX_TOKENS e AI_TIMEOUT_MS', () => {
    const fn = C.aiConfigFromEnv
    expect(typeof fn, '@wsm/core deve exportar aiConfigFromEnv').toBe('function')
    const cfg = fn({ AI_MODEL_SMALL: 'm-small', AI_MODEL_LARGE: 'm-large', AI_CONFIDENCE_THRESHOLD: '0.75', AI_MAX_TOKENS: '300', AI_TIMEOUT_MS: '1500' })
    expect(cfg).toMatchObject({ smallModel: 'm-small', largeModel: 'm-large', confidenceThreshold: 0.75, maxTokens: 300, timeoutMs: 1500 })
    expect(cfg.apiKey ?? undefined).toBeUndefined()
    const def = fn({})
    expect(def.smallModel).toBe('claude-haiku-4-5-20251001')
    expect(def.largeModel).toBe('claude-sonnet-5')
    expect(def.confidenceThreshold).toBeGreaterThan(0)
    expect(def.confidenceThreshold).toBeLessThan(1)
    expect(def.maxTokens).toBeGreaterThan(0)
  })
})

describe('T13 — cache', () => {
  it('AC-T13-04 normalizeAiText: trim, minúsculas e espaços colapsados', () => {
    expect(typeof C.normalizeAiText, '@wsm/core deve exportar normalizeAiText').toBe('function')
    expect(C.normalizeAiText('  Olá   MUNDO\t\n bom  dia ')).toBe('olá mundo bom dia')
  })

  it('AC-T13-04 texto repetido (após normalização) não chama o provedor de novo', async () => {
    const p = new FakeProvider()
    const a = assistant(p)
    const first = await a.suggest('Qual o   HORÁRIO de atendimento?')
    const second = await a.suggest('  qual o horário de atendimento?  ')
    expect(p.calls.length).toBe(1)
    expect(second.source).toBe('cache')
    expect(second).toMatchObject({ text: first.text, intent: first.intent, model: first.model })
    await a.suggest('outra pergunta diferente')
    expect(p.calls.length, 'texto diferente chama o provedor').toBe(2)
  })

  it('AC-T13-04 resultado escalado para o grande também é cacheado', async () => {
    const p = new FakeProvider()
    p.behavior = async (req) => ({ intent: 'support', confidence: req.model === SMALL ? 0.2 : 0.9, text: `r-${req.model}` })
    const a = assistant(p)
    await a.suggest('Preciso de ajuda')
    const again = await a.suggest('preciso de ajuda')
    expect(p.calls.length).toBe(2)
    expect(again).toMatchObject({ source: 'cache', model: LARGE, text: `r-${LARGE}` })
  })
})

describe('T13 — fallback determinístico', () => {
  const unhandled: unknown[] = []

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    const h = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', h)
    try {
      const r = await fn()
      await new Promise((res) => setTimeout(res, 50))
      return r
    } finally {
      process.off('unhandledRejection', h)
    }
  }

  it('AC-T13-05 erro do provedor → fallback por regra/template, sem lançar', async () => {
    const p = new FakeProvider()
    p.behavior = async () => {
      throw new Error('provedor fora do ar')
    }
    const r = await guarded(() => assistant(p).suggest('Oi, bom dia!'))
    expect(r.source).toBe('fallback')
    expect(r.model).toBe('fallback')
    expect(FALLBACK_INTENTS).toContain(r.intent)
    expect(typeof r.text).toBe('string')
    expect(r.text.trim().length).toBeGreaterThan(0)
    expect(unhandled).toEqual([])
  })

  it('AC-T13-05 timeout do provedor → fallback dentro do prazo configurado', async () => {
    const p = new FakeProvider()
    p.behavior = () => new Promise(() => {}) // nunca responde
    const started = Date.now()
    const r = await guarded(() => assistant(p, { timeoutMs: 150 }).suggest('quanto custa?'))
    expect(Date.now() - started, 'suggest pendurou além do timeout').toBeLessThan(5_000)
    expect(r.source).toBe('fallback')
    expect(unhandled).toEqual([])
  })

  it('AC-T13-05 sem provedor configurado usa direto o fallback', async () => {
    const r = await assistant(undefined).suggest('obrigado!')
    expect(r).toMatchObject({ source: 'fallback', model: 'fallback' })
  })

  it('AC-T13-05 fallback é determinístico: mesmo texto → mesma resposta; intents por regra', async () => {
    const texts = ['Oi, tudo bem?', 'Quanto custa o plano anual?', 'Quero agendar uma visita amanhã', 'Muito obrigado!', 'Estou insatisfeito, péssimo atendimento']
    const a1 = assistant(undefined)
    const a2 = assistant(undefined)
    for (const t of texts) {
      const x = await a1.suggest(t)
      const y = await a2.suggest(t)
      expect(y, t).toEqual(x)
      expect(FALLBACK_INTENTS, t).toContain(x.intent)
    }
    expect(new Set(await Promise.all(texts.map(async (t) => (await a1.suggest(t)).intent))).size, 'regras deveriam distinguir intenções').toBeGreaterThan(1)
  })

  it('AC-T13-05 fallback não é cacheado: quando o provedor volta, a mesma mensagem usa o provedor', async () => {
    const p = new FakeProvider()
    p.behavior = async () => {
      throw new Error('instável')
    }
    const a = assistant(p)
    expect((await a.suggest('horário de funcionamento?')).source).toBe('fallback')
    p.behavior = async () => ({ intent: 'question', confidence: 0.9, text: 'das 9h às 18h' })
    const r = await a.suggest('horário de funcionamento?')
    expect(r).toMatchObject({ source: 'provider', text: 'das 9h às 18h' })
  })
})
