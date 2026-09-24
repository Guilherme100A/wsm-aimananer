import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { contactOf, contactRow, e164, expectSameInstant, listOf, useApp } from './shared'

describe('T07 — CRUD /api/contacts', () => {
  const ctx = useApp()
  const auth = () => ({ token: ctx.token })

  const newContact = () => ({
    name: 'Contato Teste',
    phone: e164(),
    consent: true,
    consent_at: '2026-09-01T12:00:00.000Z',
    consent_source: 'formulario-site',
    opt_out: false,
    last_contact_at: '2026-09-10T08:30:00.000Z',
  })

  async function create(body = newContact()) {
    const res = await call(ctx.app, 'POST', '/api/contacts', { ...auth(), body })
    expect(res.status, res.text).toBe(201)
    const c = contactOf(res.body)
    expect(c.id, `POST sem id: ${res.text}`).toBeTruthy()
    return { input: body, created: c }
  }

  it('AC-T07-01 POST /api/contacts cria contato com name, phone, consent, consent_at, consent_source, opt_out e last_contact_at', async () => {
    const { input, created } = await create()
    expect(created.name).toBe(input.name)
    expect(created.phone).toBe(input.phone)
    expect(created.consent).toBe(true)
    expectSameInstant(created.consent_at, input.consent_at)
    expect(created.consent_source).toBe(input.consent_source)
    expect(created.opt_out).toBe(false)
    expectSameInstant(created.last_contact_at, input.last_contact_at)

    const row = contactRow(ctx.tempDb.url, input.phone)
    expect(row, 'contato não persistido em contacts').toBeDefined()
    expect(row!.consent_source).toBe(input.consent_source)
    expect(row!.opt_out).toBe(false)
  })

  it('AC-T07-01 GET /api/contacts/:id devolve todos os campos do contato', async () => {
    const { input, created } = await create()
    const res = await call(ctx.app, 'GET', `/api/contacts/${created.id}`, auth())
    expect(res.status, res.text).toBe(200)
    const c = contactOf(res.body)
    expect(c.id).toBe(created.id)
    expect(c.name).toBe(input.name)
    expect(c.phone).toBe(input.phone)
    expect(c.consent).toBe(true)
    expectSameInstant(c.consent_at, input.consent_at)
    expect(c.consent_source).toBe(input.consent_source)
    expect(c.opt_out).toBe(false)
    expectSameInstant(c.last_contact_at, input.last_contact_at)
  })

  it('AC-T07-01 GET /api/contacts lista os contatos criados', async () => {
    const a = await create()
    const b = await create()
    const res = await call(ctx.app, 'GET', '/api/contacts', auth())
    expect(res.status, res.text).toBe(200)
    const phones = listOf(res.body).map((c) => c.phone)
    expect(phones).toContain(a.input.phone)
    expect(phones).toContain(b.input.phone)
  })

  it('AC-T07-01 PATCH /api/contacts/:id atualiza campos do contato', async () => {
    const { input, created } = await create()
    const patch = { name: 'Nome Atualizado', last_contact_at: '2026-09-20T10:00:00.000Z', consent_source: 'atendimento' }
    const res = await call(ctx.app, 'PATCH', `/api/contacts/${created.id}`, { ...auth(), body: patch })
    expect(res.status, res.text).toBe(200)

    const got = contactOf((await call(ctx.app, 'GET', `/api/contacts/${created.id}`, auth())).body)
    expect(got.name).toBe(patch.name)
    expect(got.consent_source).toBe(patch.consent_source)
    expectSameInstant(got.last_contact_at, patch.last_contact_at)
    expect(got.phone).toBe(input.phone)

    const row = contactRow(ctx.tempDb.url, input.phone)
    expect(row!.name).toBe(patch.name)
  })

  it('AC-T07-01 DELETE /api/contacts/:id remove o contato', async () => {
    const { input, created } = await create()
    const res = await call(ctx.app, 'DELETE', `/api/contacts/${created.id}`, auth())
    expect([200, 204], res.text).toContain(res.status)

    const after = await call(ctx.app, 'GET', `/api/contacts/${created.id}`, auth())
    expect(after.status, after.text).toBe(404)
    expect(contactRow(ctx.tempDb.url, input.phone)).toBeUndefined()
  })

  it('AC-T07-01 CRUD exige autenticação (sem token → 401)', async () => {
    const res = await call(ctx.app, 'POST', '/api/contacts', { token: null, body: newContact() })
    expect(res.status).toBe(401)
    expect(res.body?.error?.code).toBe('UNAUTHORIZED')
  })

  it('AC-T07-01 POST /api/contacts com phone fora do E.164 → 400 VALIDATION_ERROR', async () => {
    const res = await call(ctx.app, 'POST', '/api/contacts', { ...auth(), body: { ...newContact(), phone: 'abc123' } })
    expect(res.status, res.text).toBe(400)
    expect(res.body?.error?.code).toBe('VALIDATION_ERROR')
  })
})
