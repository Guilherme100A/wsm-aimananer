import { addAudits, addParticipant, adminWithGroup, api, connectedSession, createSession, targetSession, useGroupsApp } from './shared'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { lit, sqlOk } from '../helpers/pg'

describe('T20 — POST /api/sessions/:id/groups/:groupId/participants', () => {
  const ctx = useGroupsApp()
  /** cada teste usa uma sessão admin nova; o freio é por sessão admin */

  it('AC-T20-02 GET /groups informa isAdmin por grupo', async () => {
    const s = await connectedSession(ctx)
    s.transport.setGroups([
      { id: '120363000000000001@g.us', name: 'Sou admin', participants: 3, announce: false, isAdmin: true, members: [] },
      { id: '120363000000000002@g.us', name: 'Não sou', participants: 9, announce: false, isAdmin: false, members: [] },
    ])
    const r = await api(ctx, 'GET', `/api/sessions/${s.id}/groups`)
    expect(r.status, r.text).toBe(200)
    const byName = Object.fromEntries(r.body.items.map((g: any) => [g.name, g]))
    expect(byName['Sou admin'].isAdmin).toBe(true)
    expect(byName['Não sou'].isAdmin).toBe(false)
  })

  it('AC-T20-02 adiciona UM número (sessão do sistema) ao grupo em que a sessão é admin → 200 added', async () => {
    const admin = await adminWithGroup(ctx)
    const target = await targetSession(ctx)
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id })
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ groupId: admin.groupId, targetSessionId: target.id, jid: target.jid, result: 'added' })
    expect(admin.transport.groupAdds).toEqual([{ groupId: admin.groupId, jid: target.jid }])
  })

  it('AC-T20-02 alvo já membro → 200 already_member (tentativa feita, nada muda no grupo)', async () => {
    const target = await targetSession(ctx)
    const admin = await adminWithGroup(ctx, { members: [target.jid] })
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id })
    expect(r.status, r.text).toBe(200)
    expect(r.body.result).toBe('already_member')
  })

  it('AC-T20-02 sem variante em lote: array, lista de alvos ou campo extra → 400 e nada chega ao transporte', async () => {
    const admin = await adminWithGroup(ctx)
    const a = await targetSession(ctx)
    const b = await targetSession(ctx)
    for (const body of [
      { targetSessionId: [a.id, b.id] },
      { targetSessionId: [a.id] },
      { targetSessionIds: [a.id, b.id] },
      [{ targetSessionId: a.id }, { targetSessionId: b.id }],
      { targetSessionId: a.id, extra: true },
      { targetSessionId: 'nao-e-uuid' },
      {},
    ]) {
      const r = await addParticipant(ctx, admin.id, admin.groupId, body)
      expectApiError(r, 'VALIDATION_ERROR', 400)
    }
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-02 alvo igual à própria sessão → 400', async () => {
    const admin = await adminWithGroup(ctx)
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: admin.id })
    expect(r.status, r.text).toBe(400)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-02 alvo inexistente → 404; sessão admin inexistente → 404 SESSION_NOT_FOUND', async () => {
    const admin = await adminWithGroup(ctx)
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: '00000000-0000-4000-8000-000000000000' })
    expect(r.status, r.text).toBe(404)
    const target = await targetSession(ctx)
    expectApiError(await addParticipant(ctx, '00000000-0000-4000-8000-000000000000', admin.groupId, { targetSessionId: target.id }), 'SESSION_NOT_FOUND', 404)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-02 alvo sem telefone → 400', async () => {
    const admin = await adminWithGroup(ctx)
    const target = await targetSession(ctx)
    // telefone é NOT NULL no schema: string vazia representa "sem telefone" (única forma sem mudar o schema)
    const cleared = sqlOk(ctx.tempDb.url, `UPDATE sessions SET phone = '' WHERE id = ${lit(target.id)} RETURNING id;`)
    expect(cleared).toHaveLength(1)
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id })
    expect(r.status, r.text).toBe(400)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-02 sessão admin fora de WARMING/STABLE → 409 SESSION_NOT_CONNECTED (NEW e PAUSED)', async () => {
    const target = await targetSession(ctx)
    const fresh = await createSession(ctx)
    expectApiError(await addParticipant(ctx, fresh.id, '120363000000000009@g.us', { targetSessionId: target.id }), 'SESSION_NOT_CONNECTED', 409)
    const admin = await adminWithGroup(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${admin.id}/pause`)).status).toBe(200)
    expectApiError(await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id }), 'SESSION_NOT_CONNECTED', 409)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-02 sessão que não é admin do grupo → 403 NOT_GROUP_ADMIN', async () => {
    const admin = await adminWithGroup(ctx, { isAdmin: false })
    const target = await targetSession(ctx)
    expectApiError(await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id }), 'NOT_GROUP_ADMIN', 403)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-02 grupo inexistente → 404 GROUP_NOT_FOUND', async () => {
    const admin = await adminWithGroup(ctx)
    const target = await targetSession(ctx)
    expectApiError(await addParticipant(ctx, admin.id, '120363999999999999@g.us', { targetSessionId: target.id }), 'GROUP_NOT_FOUND', 404)
  })

  it('AC-T20-02 número que não permite ser adicionado (privacidade) → 200 com result not_allowed', async () => {
    const admin = await adminWithGroup(ctx)
    const target = await targetSession(ctx)
    // o WhatsApp responde 403 para o participante (privacidade): o transporte normaliza para not_allowed
    admin.transport.addGroupParticipant = async (_groupId: string, jid: string) => [{ jid, status: 'not_allowed', code: 403 }]
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id })
    expect(r.status, r.text).toBe(200)
    expect(r.body.result).toBe('not_allowed')
  })

  it('AC-T20-02 exige autenticação (401) e nada chega ao transporte', async () => {
    const admin = await adminWithGroup(ctx)
    const target = await targetSession(ctx)
    expectApiError(await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id }, null), 'UNAUTHORIZED', 401)
    expectApiError(await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id }, 'token-errado'), 'UNAUTHORIZED', 401)
    expect(admin.transport.groupAdds).toEqual([])
    expect(addAudits(ctx, admin.id)).toEqual([])
  })
})
