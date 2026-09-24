import { describe, expect, it } from 'vitest'
import { FakeTransport } from '@wsm/core'
import { createOptOutHandler } from '@wsm/worker'
import { call } from '../helpers/app'
import { insertRow } from '../helpers/pg'
import { contactRow, e164, expectSameInstant, jidOf, useApp } from './shared'

const OLD_CONSENT = '2026-01-01T00:00:00.000Z'

describe('T07 — reversão de opt-out', () => {
  const ctx = useApp()

  function optedOut() {
    const phone = e164()
    insertRow(ctx.tempDb.url, 'contacts', {
      phone,
      name: 'Contato',
      consent: 'true',
      consent_at: OLD_CONSENT,
      consent_source: 'formulario',
      opt_out: 'true',
    })
    return contactRow(ctx.tempDb.url, phone)!
  }

  it('AC-T07-05 reverter opt-out sem registrar novo consentimento é recusado e o contato continua em opt-out', async () => {
    const c = optedOut()
    const res = await call(ctx.app, 'PATCH', `/api/contacts/${c.id}`, { token: ctx.token, body: { opt_out: false } })
    expect(res.status, res.text).toBe(400)
    expect(res.body?.error?.code).toBe('VALIDATION_ERROR')
    expect(contactRow(ctx.tempDb.url, c.phone)!.opt_out).toBe(true)
  })

  it('AC-T07-05 reverter opt-out sem autenticação → 401 e o contato continua em opt-out', async () => {
    const c = optedOut()
    const body = { opt_out: false, consent: true, consent_at: new Date().toISOString(), consent_source: 'atendimento' }
    const res = await call(ctx.app, 'PATCH', `/api/contacts/${c.id}`, { token: null, body })
    expect(res.status).toBe(401)
    expect(contactRow(ctx.tempDb.url, c.phone)!.opt_out).toBe(true)
  })

  it('AC-T07-05 ação manual autenticada com novo consentimento reverte o opt-out e atualiza consent_at', async () => {
    const c = optedOut()
    const newConsentAt = '2026-09-20T15:45:00.000Z'
    const body = { opt_out: false, consent: true, consent_at: newConsentAt, consent_source: 'atendimento-telefone' }
    const res = await call(ctx.app, 'PATCH', `/api/contacts/${c.id}`, { token: ctx.token, body })
    expect(res.status, res.text).toBe(200)

    const row = contactRow(ctx.tempDb.url, c.phone)!
    expect(row.opt_out).toBe(false)
    expect(row.consent).toBe(true)
    expectSameInstant(row.consent_at, newConsentAt)
    expect(Date.parse(row.consent_at)).toBeGreaterThan(Date.parse(OLD_CONSENT))
    expect(row.consent_source).toBe('atendimento-telefone')
  })

  it('AC-T07-05 mensagem recebida nunca reverte opt-out (só ação manual)', async () => {
    const c = optedOut()
    const transport = new (FakeTransport as any)()
    const handler = (createOptOutHandler as any)({ db: ctx.db })
    const pending: Promise<unknown>[] = []
    transport.on('message', (m: unknown) => pending.push(Promise.resolve(handler(m))))
    for (const text of ['VOLTAR', 'quero receber de novo', 'SIM', 'START']) transport.receive({ from: jidOf(c.phone), text })
    await Promise.all(pending)
    const row = contactRow(ctx.tempDb.url, c.phone)!
    expect(row.opt_out).toBe(true)
    expectSameInstant(row.consent_at, OLD_CONSENT)
  })
})
