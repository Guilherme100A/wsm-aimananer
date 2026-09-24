import { ENV_AI } from './env'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeProviderFactory, newKey } from './shared'
import { api, C, connectedSession, createContact, jidOf, suggestions, uniq, useQueue, W } from '../T13/shared'

describe('T19 — worker aplica a configuração nova sem restart', () => {
  const ctx = useQueue() as any
  const provider = fakeProviderFactory()
  let ai: { stop(): unknown; idle(): Promise<void> }
  let assistant: any

  beforeAll(async () => {
    const settings = new C.AiSettingsService({ db: ctx.db, env: { ...ENV_AI } })
    assistant = new C.AiAssistant({ settings, providerFactory: provider.factory, refreshMs: 0, logger: ctx.logger })
    ai = await W.attachAi(ctx.manager, { db: ctx.db, assistant, logger: ctx.logger })
  })
  afterAll(async () => {
    await ai?.stop()
  })

  const put = async (body: Record<string, unknown>) => {
    const r = await api(ctx, 'PUT', '/api/ai/settings', body)
    expect(r.status, `PUT /api/ai/settings → ${r.text}`).toBe(200)
    return r.body
  }

  /** Mensagem recebida real (FakeTransport) → sugestão gravada para ela; devolve a sugestão. */
  async function inbound(sessionId: string, t: any, phone: string, text: string) {
    t.receive({ from: jidOf(phone), text })
    await ai.idle()
    const list = await suggestions(ctx, { sessionId })
    const mine = list.filter((s: any) => s.inboundText === text)
    expect(mine.length, `nenhuma sugestão para "${text}"`).toBeGreaterThanOrEqual(1)
    return mine[0]
  }

  it('AC-T19-03 com chave e modelos salvos no banco, a IA usa o provedor com essa chave e o modelo pequeno do banco', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const key = newKey()
    await put({ apiKey: key, modelSmall: 'db-pequeno-A', modelLarge: 'db-grande-A', enabled: true })
    const calls = provider.calls.length
    await inbound(id, t, contact.phone, uniq('quanto custa'))
    const mine = provider.calls.slice(calls)
    expect(mine.length, 'provedor não foi chamado').toBeGreaterThanOrEqual(1)
    expect(mine[0]).toMatchObject({ apiKey: key, model: 'db-pequeno-A' })
  })

  it('AC-T19-03 trocar o modelo pela API vale na próxima mensagem, sem restart, e invalida o cache de classificação', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await put({ apiKey: newKey(), modelSmall: 'db-pequeno-B', enabled: true })
    const text = uniq('qual o horário de atendimento')
    await inbound(id, t, contact.phone, text)
    // mesmo texto de novo com o mesmo modelo: vem do cache (sem nova chamada)
    const beforeSame = provider.calls.length
    await inbound(id, t, contact.phone, text)
    expect(provider.calls.length, 'mesmo texto e mesmo modelo deveria vir do cache do T13').toBe(beforeSame)

    await put({ modelSmall: 'db-pequeno-C' })
    const before = provider.calls.length
    await inbound(id, t, contact.phone, text)
    const after = provider.calls.slice(before)
    expect(after.length, 'depois de trocar o modelo, o cache deveria ter sido invalidado').toBeGreaterThanOrEqual(1)
    expect(after[0]!.model).toBe('db-pequeno-C')
  })

  it('AC-T19-03 trocar a chave recria o provedor com a chave nova', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const k1 = newKey()
    const k2 = newKey()
    await put({ apiKey: k1, enabled: true })
    await inbound(id, t, contact.phone, uniq('oi'))
    await put({ apiKey: k2 })
    const before = provider.calls.length
    await inbound(id, t, contact.phone, uniq('bom dia'))
    expect(provider.created).toContain(k2)
    expect(provider.calls.slice(before)[0]?.apiKey).toBe(k2)
  })

  it('AC-T19-03 enabled=false → nenhuma chamada ao provedor, só o fallback determinístico', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await put({ apiKey: newKey(), enabled: false })
    const before = provider.calls.length
    const text = uniq('quero agendar um horário')
    await inbound(id, t, contact.phone, text)
    expect(provider.calls.length, 'IA desativada não pode chamar o provedor').toBe(before)
    const direct = await assistant.suggest(uniq('outro texto'))
    expect(direct.source).toBe('fallback')
    expect(direct.model).toBe('fallback')
    const list = await suggestions(ctx, { sessionId: id })
    expect(list.length, 'fallback ainda gera sugestão para a mensagem recebida').toBeGreaterThanOrEqual(1)
    expect(list.every((s: any) => (s.model ?? 'fallback') === 'fallback')).toBe(true)

    // reativar volta a chamar o provedor, ainda sem restart
    await put({ enabled: true })
    const b2 = provider.calls.length
    await inbound(id, t, contact.phone, uniq('voltou?'))
    expect(provider.calls.length).toBeGreaterThan(b2)
  })

  it('AC-T19-03 sem chave (removida pela API) → só fallback, sem chamar o provedor', async () => {
    await put({ apiKey: null, enabled: true })
    const before = provider.calls.length
    const r = await assistant.suggest(uniq('sem chave'))
    expect(r.source).toBe('fallback')
    expect(provider.calls.length).toBe(before)
  })

  it('AC-T19-03 refresh() força a releitura quando o cache de configuração é longo', async () => {
    const settings = new C.AiSettingsService({ db: ctx.db, env: { ...ENV_AI } })
    const slow = new C.AiAssistant({ settings, providerFactory: provider.factory, refreshMs: 60_000, logger: ctx.logger })
    await put({ apiKey: newKey(), modelSmall: 'db-lento-1', enabled: true })
    await slow.suggest(uniq('primeira'))
    expect(provider.calls.at(-1)!.model).toBe('db-lento-1')
    await put({ modelSmall: 'db-lento-2' })
    await slow.refresh()
    await slow.suggest(uniq('segunda'))
    expect(provider.calls.at(-1)!.model).toBe('db-lento-2')
  })

  it('AC-T19-03 o construtor antigo do T13 (config estática) continua funcionando', async () => {
    const legacy = new C.AiAssistant({ provider: provider.factory('chave-legada'), config: { smallModel: 'legado-p', largeModel: 'legado-g', confidenceThreshold: 0.5, maxTokens: 100, timeoutMs: 2_000 } })
    const r = await legacy.suggest(uniq('legado'))
    expect(r.source).toBe('provider')
    expect(r.model).toBe('legado-p')
  })
})
