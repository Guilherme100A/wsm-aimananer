import { describe, expect, it } from 'vitest'
import { FakeTransport } from '@wsm/core'
import { createOptOutHandler } from '@wsm/worker'
import { insertRow } from '../helpers/pg'
import { auditRows, contactRow, e164, jidOf, useDb, waitFor } from './shared'

describe('T07 — opt-out por mensagem recebida', () => {
  const ctx = useDb()

  /** Contato com consentimento, criado direto no banco. */
  function consentedContact() {
    const phone = e164()
    insertRow(ctx.tempDb.url, 'contacts', {
      phone,
      name: 'Contato',
      consent: 'true',
      consent_at: '2026-09-01T12:00:00Z',
      consent_source: 'formulario',
      opt_out: 'false',
    })
    return contactRow(ctx.tempDb.url, phone)!
  }

  /** FakeTransport com o handler plugado; `deliver` emite a mensagem e aguarda o handler. */
  function wired(opts: Record<string, unknown> = {}) {
    const transport = new (FakeTransport as any)()
    const handler = (createOptOutHandler as any)({ db: ctx.db, ...opts })
    expect(typeof handler, 'createOptOutHandler deve devolver uma função (msg: IncomingMessage) => …').toBe('function')
    const pending: Promise<unknown>[] = []
    transport.on('message', (m: unknown) => pending.push(Promise.resolve(handler(m))))
    return {
      async deliver(phone: string, text: string, extra: Record<string, unknown> = {}) {
        transport.receive({ from: jidOf(phone), text, ...extra })
        await Promise.all(pending.splice(0))
      },
    }
  }

  const keywordCases: [string, string][] = [
    ['SAIR', 'SAIR'],
    ['PARAR', 'parar'],
    ['STOP', '  Stop  '],
    ['CANCELAR', 'Cancelar!'],
  ]

  for (const [keyword, text] of keywordCases) {
    it(`AC-T07-03 mensagem "${text}" (normalizada: ${keyword}) marca opt_out=true e grava auditoria`, async () => {
      const contact = consentedContact()
      const before = auditRows(ctx.tempDb.url).length
      await wired().deliver(contact.phone, text)

      const row = await waitFor(() => (contactRow(ctx.tempDb.url, contact.phone)?.opt_out ? contactRow(ctx.tempDb.url, contact.phone) : undefined), 'opt_out=true')
      expect(row.opt_out).toBe(true)

      const fresh = await waitFor(() => {
        const rows = auditRows(ctx.tempDb.url).slice(before).filter((r) => String(r.target_id) === String(contact.id))
        return rows.length ? rows : undefined
      }, 'linha em audit_logs para o contato')
      expect(fresh[0]!.action, JSON.stringify(fresh[0])).toMatch(/opt.?out/i)
      expect(fresh[0]!.target_type).toMatch(/contact/i)
    })
  }

  it('AC-T07-03 mensagem que não é só a palavra de opt-out não altera o contato', async () => {
    const contact = consentedContact()
    const before = auditRows(ctx.tempDb.url).length
    const w = wired()
    for (const t of ['quero sair amanhã', 'não pare', 'STOPPED', 'olá']) await w.deliver(contact.phone, t)
    expect(contactRow(ctx.tempDb.url, contact.phone)!.opt_out).toBe(false)
    expect(auditRows(ctx.tempDb.url).slice(before).filter((r) => String(r.target_id) === String(contact.id))).toEqual([])
  })

  it('AC-T07-03 lista de palavras de opt-out é configurável', async () => {
    const contact = consentedContact()
    const w = wired({ keywords: ['BASTA'] })
    await w.deliver(contact.phone, 'basta')
    const row = await waitFor(() => (contactRow(ctx.tempDb.url, contact.phone)?.opt_out ? contactRow(ctx.tempDb.url, contact.phone) : undefined), 'opt_out=true com palavra configurada')
    expect(row.opt_out).toBe(true)
  })

  it('AC-T07-03 mensagens enviadas pela própria sessão (fromMe) não marcam opt-out', async () => {
    const contact = consentedContact()
    await wired().deliver(contact.phone, 'SAIR', { fromMe: true })
    expect(contactRow(ctx.tempDb.url, contact.phone)!.opt_out).toBe(false)
  })
})
