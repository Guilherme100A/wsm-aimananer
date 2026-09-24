// AC-T19-05: página "IA / Modelo LLM" no dashboard. Mesmo harness do T12 (build do dashboard servido na mesma
// origem da API, chromium headless), com a API do T19 (provedor de IA falso injetado).
import { api, getSettings, newKey, putSettings, useAiApi } from './shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { doLogin, ensureBuild, go, hashOf, launchBrowser, serve, tid } from '../T12/shared'

describe('T19 — dashboard: página IA / Modelo LLM', () => {
  const ctx = useAiApi()
  const ui = { base: '', browser: undefined as any, contexts: [] as any[], errors: [] as string[] }
  let server: { url: string; close(): Promise<void> }

  beforeAll(async () => {
    ensureBuild()
    server = await serve(ctx.app)
    ui.base = server.url
    ui.browser = await launchBrowser()
  })
  afterAll(async () => {
    for (const c of ui.contexts) await c.close().catch(() => {})
    await ui.browser?.close().catch(() => {})
    await server?.close()
  })

  async function openAiPage() {
    const bc = await ui.browser.newContext()
    ui.contexts.push(bc)
    const page = await bc.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (e: Error) => ui.errors.push(e.message))
    await doLogin(ui as any, page)
    await go(ui as any, page, '/ai')
    await page.locator(tid('page-ai')).waitFor({ state: 'visible' })
    return page
  }

  const text = async (page: any, id: string) => ((await page.locator(tid(id)).first().textContent()) ?? '').trim()
  const valueOf = (page: any, id: string) => page.locator(tid(id)).first().inputValue()
  /** Todo o texto e os valores de input da página (para provar que a chave não está no DOM). */
  const domDump = async (page: any) =>
    `${await page.content()}\n${(await page.locator('input, textarea').evaluateAll((els: any[]) => els.map((e) => e.value))).join('\n')}`

  it('AC-T19-05 o menu tem o item da página e ela abre com o título "IA / Modelo LLM"', async () => {
    const bc = await ui.browser.newContext()
    ui.contexts.push(bc)
    const page = await bc.newPage()
    await doLogin(ui as any, page)
    await page.locator(tid('nav-ai')).click()
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toBe('#/ai')
    await page.locator(tid('page-ai')).waitFor({ state: 'visible' })
    expect(((await page.locator(`${tid('page-ai')} h1`).first().textContent()) ?? '').trim()).toBe('IA / Modelo LLM')
    expect(ui.errors, `erros de página: ${ui.errors.join('\n')}`).toEqual([])
  })

  it('AC-T19-05 mostra modelos, limiar, tokens, timeout e ativação com a origem de cada valor (env antes de salvar)', async () => {
    const s = await getSettings(ctx)
    const page = await openAiPage()
    await expect.poll(() => valueOf(page, 'ai-model-small')).toBe(s.modelSmall)
    expect(await valueOf(page, 'ai-model-large')).toBe(s.modelLarge)
    expect(Number(await valueOf(page, 'ai-threshold'))).toBe(s.confidenceThreshold)
    expect(Number(await valueOf(page, 'ai-max-tokens'))).toBe(s.maxTokens)
    expect(Number(await valueOf(page, 'ai-timeout'))).toBe(s.timeoutMs)
    expect(await page.locator(tid('ai-enabled')).isChecked()).toBe(s.enabled)
    for (const f of ['modelSmall', 'modelLarge', 'confidenceThreshold', 'maxTokens', 'timeoutMs', 'enabled', 'apiKey'])
      expect((await text(page, `ai-source-${f}`)).toLowerCase(), `origem de ${f}`).toContain('env')
  })

  it('AC-T19-05 chave mascarada: "não configurada" → substituir (campo password) → "configurada", sem a chave no DOM → remover', async () => {
    await putSettings(ctx, { apiKey: null })
    const page = await openAiPage()
    await expect.poll(() => text(page, 'ai-key-status')).toMatch(/não configurada/i)

    const key = newKey()
    await page.locator(tid('ai-key-replace')).click()
    const input = page.locator(tid('ai-key-input'))
    expect(await input.getAttribute('type')).toBe('password')
    await input.fill(key)
    await page.locator(tid('ai-key-save')).click()
    await expect.poll(() => text(page, 'ai-key-status')).toMatch(/^configurada$/i)
    await expect.poll(async () => (await getSettings(ctx)).hasApiKey).toBe(true)
    expect(await domDump(page), 'a chave ficou no DOM depois de salva').not.toContain(key)
    expect((await text(page, 'ai-source-apiKey')).toLowerCase()).toContain('banco')

    // recarregar a página também não traz a chave
    await page.reload()
    await page.locator(tid('page-ai')).waitFor({ state: 'visible' })
    await expect.poll(() => text(page, 'ai-key-status')).toMatch(/^configurada$/i)
    expect(await domDump(page)).not.toContain(key)

    page.once('dialog', (d: any) => d.accept())
    await page.locator(tid('ai-key-remove')).click()
    await expect.poll(() => text(page, 'ai-key-status')).toMatch(/não configurada/i)
    expect((await getSettings(ctx)).hasApiKey).toBe(false)
  })

  it('AC-T19-05 salvar modelos/limiar/tokens/timeout/ativação grava pela API e a origem passa a "banco"', async () => {
    const page = await openAiPage()
    await page.locator(tid('ai-model-small')).fill('ui-modelo-pequeno')
    await page.locator(tid('ai-model-large')).fill('ui-modelo-grande')
    await page.locator(tid('ai-threshold')).fill('0.35')
    await page.locator(tid('ai-max-tokens')).fill('640')
    await page.locator(tid('ai-timeout')).fill('7000')
    if (await page.locator(tid('ai-enabled')).isChecked()) await page.locator(tid('ai-enabled')).click()
    await page.locator(tid('ai-save')).click()

    await expect.poll(async () => (await getSettings(ctx)).modelSmall, { timeout: 10_000 }).toBe('ui-modelo-pequeno')
    const s = await getSettings(ctx)
    expect(s).toMatchObject({ modelLarge: 'ui-modelo-grande', confidenceThreshold: 0.35, maxTokens: 640, timeoutMs: 7000, enabled: false })
    await expect.poll(async () => (await text(page, 'ai-source-modelSmall')).toLowerCase()).toContain('banco')
    expect((await text(page, 'ai-source-enabled')).toLowerCase()).toContain('banco')
  })

  it('AC-T19-05 valor inválido mostra erro e não salva', async () => {
    const before = await getSettings(ctx)
    const page = await openAiPage()
    await page.locator(tid('ai-threshold')).fill('2')
    await page.locator(tid('ai-save')).click()
    await page.locator(tid('ai-error')).waitFor({ state: 'visible' })
    expect((await getSettings(ctx)).confidenceThreshold).toBe(before.confidenceThreshold)
  })

  it('AC-T19-05 "Testar conexão" mostra ok, modelo e latência; falha aparece sem a chave', async () => {
    const key = newKey()
    await putSettings(ctx, { apiKey: key, modelSmall: 'ui-modelo-teste', enabled: true })
    const page = await openAiPage()
    await page.locator(tid('ai-test')).click()
    await expect.poll(() => text(page, 'ai-test-result'), { timeout: 10_000 }).toMatch(/ui-modelo-teste/)
    const ok = await text(page, 'ai-test-result')
    expect(ok).toMatch(/ok|sucesso|conectad/i)
    expect(ok).toMatch(/\d+\s*ms/)

    ctx.provider.setBehavior(async (req) => {
      throw new Error(`invalid x-api-key ${req.apiKey}`)
    })
    try {
      await page.locator(tid('ai-test')).click()
      await expect.poll(() => text(page, 'ai-test-result'), { timeout: 10_000 }).toMatch(/erro|falh|invalid/i)
      expect(await domDump(page)).not.toContain(key)
    } finally {
      ctx.provider.setBehavior(async (req) => ({ intent: 'pricing', confidence: 0.95, text: `resposta (${req.model})` }))
    }
    const r = await api(ctx, 'GET', '/api/ai/settings')
    expect(r.text).not.toContain(key)
  })
})
