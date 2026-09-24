import { describe, expect, it } from 'vitest'
import { callRaw, contactRow, e164, useApp } from './shared'

describe('T07 — importação CSV', () => {
  const ctx = useApp()

  it('AC-T07-02 POST /api/contacts/import importa só linhas com consent=true, consent_at e consent_source; as demais voltam em rejected[] com motivo', async () => {
    const ok1 = e164()
    const ok2 = e164()
    const noConsent = e164()
    const noConsentAt = e164()
    const noSource = e164()
    const csv = [
      'name,phone,consent,consent_at,consent_source',
      `Ana,${ok1},true,2026-09-01T12:00:00Z,formulario`,
      `Bia,${noConsent},false,2026-09-01T12:00:00Z,formulario`,
      `Caio,${noConsentAt},true,,formulario`,
      `Duda,${noSource},true,2026-09-01T12:00:00Z,`,
      `Enzo,${ok2},true,2026-09-02T09:15:00Z,evento`,
    ].join('\n')

    const res = await callRaw(ctx.app, 'POST', '/api/contacts/import', csv, 'text/csv', ctx.token)
    expect([200, 201], res.text).toContain(res.status)

    const imported = res.body?.imported
    expect(Array.isArray(imported) ? imported.length : imported, res.text).toBe(2)

    const rejected = res.body?.rejected
    expect(Array.isArray(rejected), `rejected[] ausente: ${res.text}`).toBe(true)
    expect(rejected.length, res.text).toBe(3)
    for (const r of rejected) {
      expect(typeof r.reason, `rejeição sem motivo: ${JSON.stringify(r)}`).toBe('string')
      expect(r.reason.trim().length).toBeGreaterThan(0)
    }
    // Cada rejeição identifica a linha: pelo telefone ou pelo número da linha
    // (linha do arquivo com cabeçalho = 3,4,5; ou índice da linha de dados = 2,3,4).
    const rejectedText = JSON.stringify(rejected)
    const byPhone = [noConsent, noConsentAt, noSource].every((p) => rejectedText.includes(p))
    const lines = rejected.map((r: any) => Number(r.line ?? r.row)).sort()
    const byLine = JSON.stringify(lines) === '[3,4,5]' || JSON.stringify(lines) === '[2,3,4]'
    expect(byPhone || byLine, `linhas rejeitadas não identificadas: ${rejectedText}`).toBe(true)

    expect(contactRow(ctx.tempDb.url, ok1)?.consent).toBe(true)
    expect(contactRow(ctx.tempDb.url, ok1)?.consent_source).toBe('formulario')
    expect(contactRow(ctx.tempDb.url, ok2)).toBeDefined()
    for (const p of [noConsent, noConsentAt, noSource]) expect(contactRow(ctx.tempDb.url, p), `${p} não deveria ser importado`).toBeUndefined()
  })

  it('AC-T07-02 CSV só com linhas sem consentimento não importa nada', async () => {
    const a = e164()
    const b = e164()
    const csv = ['name,phone,consent,consent_at,consent_source', `X,${a},false,,`, `Y,${b},,,`].join('\n')
    const res = await callRaw(ctx.app, 'POST', '/api/contacts/import', csv, 'text/csv', ctx.token)
    expect([200, 201], res.text).toContain(res.status)
    const imported = res.body?.imported
    expect(Array.isArray(imported) ? imported.length : imported, res.text).toBe(0)
    expect(res.body?.rejected?.length, res.text).toBe(2)
    expect(contactRow(ctx.tempDb.url, a)).toBeUndefined()
    expect(contactRow(ctx.tempDb.url, b)).toBeUndefined()
  })

  it('AC-T07-02 importação exige autenticação (sem token → 401)', async () => {
    const csv = ['name,phone,consent,consent_at,consent_source', `Z,${e164()},true,2026-09-01T12:00:00Z,f`].join('\n')
    const res = await callRaw(ctx.app, 'POST', '/api/contacts/import', csv, 'text/csv', null)
    expect(res.status).toBe(401)
  })
})
