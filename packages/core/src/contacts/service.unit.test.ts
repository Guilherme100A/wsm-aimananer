// Integração com o Postgres local (banco descartável por suíte).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLogs, contacts, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { canMessage } from './policy'
import { ContactError, ContactsService, toContactDto } from './service'

let tmp: TempDatabase
let db: Database
let service: ContactsService

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_contacts' })
  db = createDb(tmp.url, { max: 3 })
  service = new ContactsService(db)
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('ContactsService', () => {
  it('CRUD e DTO snake_case', async () => {
    const c = await service.create({ name: 'Ana', phone: '+5511910000001', consent: true, consentSource: 'site' })
    expect(c.consentAt).toBeInstanceOf(Date)
    expect(canMessage(c)).toEqual({ ok: true })
    const dto = toContactDto(c)
    expect(dto).toMatchObject({ phone: '+5511910000001', consent: true, opt_out: false, consent_source: 'site' })
    const { contact } = await service.update(c.id, { name: 'Ana B' })
    expect(contact.name).toBe('Ana B')
    expect((await service.list({ phone: '+5511910000001' })).map((x) => x.id)).toEqual([c.id])
    await service.delete(c.id)
    expect(await service.get(c.id)).toBeUndefined()
    await expect(service.delete(c.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('telefone duplicado ou inválido', async () => {
    await service.create({ phone: '+5511910000002' })
    await expect(service.create({ phone: '+5511910000002' })).rejects.toMatchObject({ code: 'duplicate_phone' })
    await expect(service.create({ phone: '11910000002' })).rejects.toBeInstanceOf(ContactError)
  })

  it('reverter opt-out exige novo consentimento completo', async () => {
    const c = await service.create({ phone: '+5511910000003', consent: true, consentSource: 'site', optOut: true })
    await expect(service.update(c.id, { optOut: false })).rejects.toMatchObject({ code: 'consent_required' })
    await expect(service.update(c.id, { optOut: false, consent: true, consentSource: 'x' })).rejects.toMatchObject({
      code: 'consent_required',
    })
    expect((await service.getOrThrow(c.id)).optOut).toBe(true)
    const at = new Date(Date.now() + 1000)
    const { contact, optOutReverted } = await service.update(c.id, {
      optOut: false,
      consent: true,
      consentAt: at,
      consentSource: 'manual',
    })
    expect(optOutReverted).toBe(true)
    expect(contact.optOut).toBe(false)
    expect(contact.consentAt?.getTime()).toBe(at.getTime())
  })

  it('recordOptOut marca, audita e é idempotente; cria contato desconhecido', async () => {
    const c = await service.create({ phone: '+5511910000004', consent: true, consentSource: 'site' })
    const r1 = await service.recordOptOut(c.phone, { keyword: 'SAIR', sessionId: 's1', messageId: 'm1' })
    expect(r1).toMatchObject({ changed: true, created: false })
    expect(r1.contact.optOut).toBe(true)
    expect(canMessage(r1.contact)).toEqual({ ok: false, reason: 'opt_out' })
    const r2 = await service.recordOptOut(c.phone, { keyword: 'STOP' })
    expect(r2.changed).toBe(false)
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, c.id))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'contact.opt_out', targetType: 'contact', actor: 'contact' })

    const r3 = await service.recordOptOut('+5511910000099', { keyword: 'PARAR' })
    expect(r3).toMatchObject({ created: true, changed: true })
    expect(r3.contact).toMatchObject({ optOut: true, consent: false })
  })

  it('importCsv rejeita linhas sem consentimento e telefones existentes', async () => {
    await service.create({ phone: '+5511910000005' })
    const csv = [
      'name,phone,consent,consent_at,consent_source',
      'A,+5511910000010,true,2026-01-01T00:00:00Z,site',
      'B,+5511910000011,false,2026-01-01T00:00:00Z,site',
      'C,+5511910000005,true,2026-01-01T00:00:00Z,site',
    ].join('\n')
    const r = await service.importCsv(csv)
    expect(r.imported).toBe(1)
    expect(r.created[0]).toMatchObject({ phone: '+5511910000010', consent: true, consentSource: 'site', optOut: false })
    expect(r.rejected.map((x) => [x.line, x.reason])).toEqual([
      [3, 'consent_not_true'],
      [4, 'phone_already_exists'],
    ])
    const [row] = await db.select().from(contacts).where(eq(contacts.phone, '+5511910000011'))
    expect(row).toBeUndefined()
  })
})
