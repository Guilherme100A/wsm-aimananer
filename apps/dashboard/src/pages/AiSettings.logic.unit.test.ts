import { afterEach, describe, expect, it } from 'vitest'
import { setFetch } from '../lib/api'
import { parseHash, routeHref } from '../lib/router'
import { aiApi, AiFormError, formFromSettings, keyStatusLabel, payloadFromForm, sourceLabel, testResultText, type AiSettings } from './AiSettings.logic'

const loaded: AiSettings = {
  provider: 'anthropic',
  modelSmall: 'small',
  modelLarge: 'large',
  confidenceThreshold: 0.6,
  maxTokens: 512,
  timeoutMs: 10_000,
  enabled: true,
  hasApiKey: false,
  updatedAt: null,
  sources: { provider: 'env', apiKey: 'env', modelSmall: 'env', modelLarge: 'env', confidenceThreshold: 'env', maxTokens: 'env', timeoutMs: 'env', enabled: 'env' },
}

afterEach(() => setFetch((input, init) => globalThis.fetch(input, init)))

describe('AiSettings — lógica', () => {
  it('sem mudanças → payload vazio; só os campos alterados vão', () => {
    const form = formFromSettings(loaded)
    expect(payloadFromForm(form, loaded)).toEqual({})
    expect(payloadFromForm({ ...form, modelSmall: ' novo ', confidenceThreshold: '0,8', enabled: false }, loaded)).toEqual({
      modelSmall: 'novo',
      confidenceThreshold: 0.8,
      enabled: false,
    })
  })

  it('valida antes de enviar', () => {
    const form = formFromSettings(loaded)
    const bad: Array<[Partial<typeof form>, string]> = [
      [{ modelSmall: ' ' }, 'modelSmall'],
      [{ modelLarge: '' }, 'modelLarge'],
      [{ confidenceThreshold: '1.2' }, 'confidenceThreshold'],
      [{ confidenceThreshold: '' }, 'confidenceThreshold'],
      [{ maxTokens: '0' }, 'maxTokens'],
      [{ maxTokens: '1.5' }, 'maxTokens'],
      [{ timeoutMs: '100' }, 'timeoutMs'],
    ]
    for (const [patch, field] of bad) {
      try {
        payloadFromForm({ ...form, ...patch }, loaded)
        throw new Error(`deveria rejeitar ${field}`)
      } catch (err) {
        expect(err).toBeInstanceOf(AiFormError)
        expect((err as AiFormError).field).toBe(field)
      }
    }
  })

  it('rótulos', () => {
    expect(sourceLabel('db')).toBe('banco')
    expect(sourceLabel('env')).toBe('env')
    expect(keyStatusLabel(true)).toBe('configurada')
    expect(keyStatusLabel(false)).toBe('não configurada')
    expect(testResultText({ ok: true, model: 'm', latencyMs: 12 })).toContain('12 ms')
    expect(testResultText({ ok: false, model: 'm', latencyMs: 1, error: 'boom' })).toContain('boom')
  })

  it('cliente: GET, PUT e POST /test nos caminhos certos', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    setFetch(async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, model: 'm', latencyMs: 1 } : loaded), { status: 200 })
    })
    await aiApi.get()
    await aiApi.update({ apiKey: null })
    await aiApi.test({ modelSmall: 'x' })
    expect(calls).toEqual([
      { url: '/api/ai/settings', method: 'GET', body: undefined },
      { url: '/api/ai/settings', method: 'PUT', body: { apiKey: null } },
      { url: '/api/ai/settings/test', method: 'POST', body: { modelSmall: 'x' } },
    ])
  })

  it('rota #/ai', () => {
    expect(parseHash('#/ai')).toEqual({ name: 'ai' })
    expect(routeHref({ name: 'ai' })).toBe('#/ai')
    expect(parseHash('#/ai/x').name).toBe('not-found')
  })
})
