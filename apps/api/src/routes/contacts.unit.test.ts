// /api/contacts contra Postgres local (banco descartável por suíte).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLogs, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'contacts-token'
let tmp: TempDatabase
let db: Database
let app: ReturnType<typeof createApp>

const auth = { authorization: `Bearer ${TOKEN}` }
const json = (method: string, body: unknown) => ({
  method,
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_contacts' })
  db = createDb(tmp.url, { max: 3 })
  app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('/api/contacts', () => {
  it('exige token', async () => {
    expect((await app.request('/api/contacts')).status).toBe(401)
  })

  it('CRUD completo', async () => {
    const res = await app.request(
      '/api/contacts',
      json('POST', { name: 'Ana', phone: '+5511920000001', consent: true, consent_at: '2026-01-01T00:00:00Z', consent_source: 'site' }),
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as Record<string, unknown>
    expect(created).toMatchObject({
      name: 'Ana',
      phone: '+5511920000001',
      consent: true,
      consent_at: '2026-01-01T00:00:00.000Z',
      consent_source: 'site',
      opt_out: false,
      last_contact_at: null,
    })
    const id = created.id as string

    const list = (await (await app.request('/api/contacts', { headers: auth })).json()) as { id: string }[]
    expect(Array.isArray(list)).toBe(true)
    expect(list.map((c) => c.id)).toContain(id)

    const patched = await app.request(`/api/contacts/${id}`, json('PATCH', { last_contact_at: '2026-02-01T10:00:00Z' }))
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ name: 'Ana', last_contact_at: '2026-02-01T10:00:00.000Z' })

    expect((await app.request(`/api/contacts/${id}`, { method: 'DELETE', headers: auth })).status).toBe(204)
    const gone = await app.request(`/api/contacts/${id}`, { headers: auth })
    expect(gone.status).toBe(404)
  })

  it('valida telefone e duplicidade', async () => {
    const bad = await app.request('/api/contacts', json('POST', { phone: '11999' }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    await app.request('/api/contacts', json('POST', { phone: '+5511920000002' }))
    expect((await app.request('/api/contacts', json('POST', { phone: '+5511920000002' }))).status).toBe(400)
  })

  it('reverter opt-out só com novo consentimento completo', async () => {
    const res = await app.request('/api/contacts', json('POST', { phone: '+5511920000003', consent: true, consent_source: 'site', opt_out: true }))
    const { id, consent_at: oldAt } = (await res.json()) as { id: string; consent_at: string }

    const denied = await app.request(`/api/contacts/${id}`, json('PATCH', { opt_out: false }))
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(await (await app.request(`/api/contacts/${id}`, { headers: auth })).json()).toMatchObject({ opt_out: true })

    const noAuth = await app.request(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opt_out: false }),
    })
    expect(noAuth.status).toBe(401)

    const newAt = new Date(Date.now() + 60_000).toISOString()
    const ok = await app.request(
      `/api/contacts/${id}`,
      json('PATCH', { opt_out: false, consent: true, consent_at: newAt, consent_source: 'manual_reconsent' }),
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { opt_out: boolean; consent_at: string }
    expect(body.opt_out).toBe(false)
    expect(body.consent_at).toBe(newAt)
    expect(body.consent_at).not.toBe(oldAt)

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetId, id), eq(auditLogs.action, 'contact.opt_out_reverted')))
    expect(audits).toHaveLength(1)
  })

  it('import CSV (text/csv) aceita só linhas com consentimento completo', async () => {
    const csv = [
      'name,phone,consent,consent_at,consent_source',
      'A,+5511920000010,true,2026-01-01T00:00:00Z,site',
      'B,+5511920000011,false,2026-01-01T00:00:00Z,site',
      'C,+5511920000012,true,,site',
      'D,+5511920000013,true,2026-01-01T00:00:00Z,',
    ].join('\n')
    const res = await app.request('/api/contacts/import', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/csv' },
      body: csv,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { imported: number; rejected: { line: number; phone: string; reason: string }[] }
    expect(body.imported).toBe(1)
    expect(body.rejected.map((r) => [r.line, r.phone, r.reason])).toEqual([
      [3, '+5511920000011', 'consent_not_true'],
      [4, '+5511920000012', 'missing_consent_at'],
      [5, '+5511920000013', 'missing_consent_source'],
    ])
  })

  it('import via multipart e CSV sem coluna phone', async () => {
    const form = new FormData()
    form.append('file', new File(['phone,consent,consent_at,consent_source\n+5511920000020,true,2026-01-01,site\n'], 'c.csv'))
    const res = await app.request('/api/contacts/import', { method: 'POST', headers: auth, body: form })
    expect(await res.json()).toMatchObject({ imported: 1, rejected: [] })

    const bad = await app.request('/api/contacts/import', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/csv' },
      body: 'name\nAna',
    })
    expect(bad.status).toBe(400)
  })
})
