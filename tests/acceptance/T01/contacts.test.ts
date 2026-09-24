import { describe, expect, it } from 'vitest'
import { columns, insertRow } from '../helpers/pg'
import { useMigratedDb } from './shared'

const e164 = () => `+55999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

describe('T01 — contacts', () => {
  const ctx = useMigratedDb()

  it('AC-T01-05 contacts.phone é único: segundo contato com o mesmo telefone E.164 falha no banco', () => {
    const phone = e164()
    const row = insertRow(ctx.db.url, 'contacts', { phone })
    expect(row.phone).toBe(phone)
    expect(() => insertRow(ctx.db.url, 'contacts', { phone })).toThrow(/23505/)
  })

  it('AC-T01-05 opt_out é boolean com default false', () => {
    const optOut = columns(ctx.db.url, 'contacts').find((c) => c.name === 'opt_out')
    expect(optOut, 'coluna opt_out ausente').toBeDefined()
    expect(optOut!.dataType).toBe('boolean')

    const row = insertRow(ctx.db.url, 'contacts', { phone: e164() })
    expect(row.opt_out).toBe('false')
  })

  it('AC-T01-05 contacts tem consent, consent_at, consent_source e last_contact_at', () => {
    const names = columns(ctx.db.url, 'contacts').map((c) => c.name)
    for (const c of ['consent', 'consent_at', 'consent_source', 'last_contact_at']) expect(names, `coluna ${c} ausente`).toContain(c)

    const types = Object.fromEntries(columns(ctx.db.url, 'contacts').map((c) => [c.name, c.dataType]))
    expect(types.consent_at).toMatch(/^timestamp/)
    expect(types.last_contact_at).toMatch(/^timestamp/)
  })
})
