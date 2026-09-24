// Handler de opt-out plugado no FakeTransport, contra Postgres local (banco descartável).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ContactsService, FakeTransport, type IncomingMessage } from '@wsm/core'
import { auditLogs, contacts, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { createOptOutHandler } from './index'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_optout' })
  db = createDb(tmp.url, { max: 3 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

let seq = 0
const msg = (from: string, text: string | undefined, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `m${++seq}`,
  from,
  fromMe: false,
  timestamp: Date.now(),
  text,
  type: 'conversation',
  ...extra,
})

const optOutOf = async (phone: string) => (await db.select().from(contacts).where(eq(contacts.phone, phone)))[0]?.optOut

describe('createOptOutHandler', () => {
  it('palavra de opt-out marca opt_out=true e audita', async () => {
    const c = await new ContactsService(db).create({ phone: '+5511930000001', consent: true, consentSource: 'site' })
    const handle = createOptOutHandler({ db, sessionId: 's-1' })
    const r = await handle(msg('5511930000001@s.whatsapp.net', '  Sáir! '))
    expect(r).toMatchObject({ handled: true, keyword: 'SAIR', changed: true })
    expect(await optOutOf('+5511930000001')).toBe(true)
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.targetId, c.id))
    expect(audit).toMatchObject({ action: 'contact.opt_out', targetType: 'contact' })
    expect(audit?.detail).toMatchObject({ session_id: 's-1', keyword: 'SAIR' })
  })

  it('ignora fromMe, texto comum e grupos', async () => {
    await new ContactsService(db).create({ phone: '+5511930000002', consent: true })
    const handle = createOptOutHandler({ db })
    expect(await handle(msg('5511930000002@s.whatsapp.net', 'STOP', { fromMe: true }))).toMatchObject({ handled: false, reason: 'from_me' })
    expect(await handle(msg('5511930000002@s.whatsapp.net', 'quero parar de receber?'))).toMatchObject({ handled: false })
    expect(await handle(msg('120363000000000000@g.us', 'STOP'))).toMatchObject({ handled: false, reason: 'no_phone' })
    expect(await optOutOf('+5511930000002')).toBe(false)
  })

  it('palavras configuráveis e integração com FakeTransport', async () => {
    await new ContactsService(db).create({ phone: '+5511930000003', consent: true })
    const transport = new FakeTransport()
    const handle = createOptOutHandler({ db, keywords: ['DESCADASTRAR'] })
    const done: Promise<unknown>[] = []
    transport.on('message', (m) => done.push(handle(m)))
    transport.receive(msg('5511930000003@s.whatsapp.net', 'sair'))
    transport.receive(msg('5511930000003@s.whatsapp.net', 'descadastrar'))
    await Promise.all(done)
    expect(done).toHaveLength(2)
    expect(await optOutOf('+5511930000003')).toBe(true)
  })

  it('nunca reverte opt-out', async () => {
    await new ContactsService(db).create({ phone: '+5511930000004', consent: true, optOut: true })
    const handle = createOptOutHandler({ db })
    await handle(msg('5511930000004@s.whatsapp.net', 'oi, quero voltar'))
    await handle(msg('5511930000004@s.whatsapp.net', 'SAIR'))
    expect(await optOutOf('+5511930000004')).toBe(true)
  })
})
