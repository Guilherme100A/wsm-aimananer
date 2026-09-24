import { addAudits, addParticipant, adminWithGroup, ageRateWindow, targetSession, useGroupsApp } from './shared'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'

describe('T20 — freio de 1 adição por minuto e auditoria', () => {
  const ctx = useGroupsApp()

  it('AC-T20-03 segunda tentativa no mesmo minuto pela mesma sessão admin → 429 RATE_LIMIT, sem chegar ao transporte', async () => {
    const admin = await adminWithGroup(ctx)
    const a = await targetSession(ctx)
    const b = await targetSession(ctx)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: a.id })).status).toBe(200)
    ctx.advance(30_000)
    expectApiError(await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: b.id }), 'RATE_LIMIT', 429)
    expect(admin.transport.groupAdds).toHaveLength(1)
  })

  it('AC-T20-03 depois de 1 minuto libera de novo (relógio injetado)', async () => {
    const admin = await adminWithGroup(ctx)
    const a = await targetSession(ctx)
    const b = await targetSession(ctx)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: a.id })).status).toBe(200)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: b.id })).status).toBe(429)
    ctx.advance(61_000)
    const r = await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: b.id })
    expect(r.status, r.text).toBe(200)
    expect(r.body.result).toBe('added')
    expect(admin.transport.groupAdds).toHaveLength(2)
  })

  it('AC-T20-03 a janela é durável (audit_logs): recuar a auditoria em 61 s também libera', async () => {
    const admin = await adminWithGroup(ctx)
    const a = await targetSession(ctx)
    const b = await targetSession(ctx)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: a.id })).status).toBe(200)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: b.id })).status).toBe(429)
    ageRateWindow(ctx, admin.id)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: b.id })).status).toBe(200)
  })

  it('AC-T20-03 o limite é por sessão admin: outra sessão admin não é afetada', async () => {
    const a1 = await adminWithGroup(ctx)
    const a2 = await adminWithGroup(ctx)
    const t1 = await targetSession(ctx)
    expect((await addParticipant(ctx, a1.id, a1.groupId, { targetSessionId: t1.id })).status).toBe(200)
    expect((await addParticipant(ctx, a2.id, a2.groupId, { targetSessionId: t1.id })).status).toBe(200)
  })

  it('AC-T20-03 tentativa que falha no transporte (já membro) também conta; checagens prévias (403 não-admin) não contam', async () => {
    const t1 = await targetSession(ctx)
    const t2 = await targetSession(ctx)
    const admin = await adminWithGroup(ctx, { members: [t1.jid] })
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: t1.id })).body.result).toBe('already_member')
    expectApiError(await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: t2.id }), 'RATE_LIMIT', 429)

    const notAdmin = await adminWithGroup(ctx, { isAdmin: false })
    expect((await addParticipant(ctx, notAdmin.id, notAdmin.groupId, { targetSessionId: t1.id })).status).toBe(403)
    // o 403 prévio não consumiu o minuto: vira admin e já pode tentar
    notAdmin.transport.setGroups([{ id: notAdmin.groupId, name: notAdmin.groupName, participants: 3, announce: false, isAdmin: true, members: [] }])
    expect((await addParticipant(ctx, notAdmin.id, notAdmin.groupId, { targetSessionId: t2.id })).status).toBe(200)
  })

  it('AC-T20-03 requisições simultâneas da mesma sessão admin: só uma chega ao transporte', async () => {
    const admin = await adminWithGroup(ctx)
    const targets = await Promise.all([targetSession(ctx), targetSession(ctx), targetSession(ctx)])
    const results = await Promise.all(targets.map((t) => addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: t.id })))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses, results.map((r) => r.text).join('\n')).toEqual([200, 429, 429])
    expect(admin.transport.groupAdds).toHaveLength(1)
  })

  it('AC-T20-04 sucesso é auditado como group.participant.add com sessão admin, grupo, alvo, resultado e ator', async () => {
    const admin = await adminWithGroup(ctx)
    const target = await targetSession(ctx)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: target.id })).status).toBe(200)
    const rows = addAudits(ctx, admin.id)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row!.action).toBe('group.participant.add')
    expect(row!.target_type).toBe('session')
    expect(row!.target_id).toBe(admin.id)
    expect(row!.actor, 'ator autenticado').toBeTruthy()
    expect(row!.actor).not.toBe('anonymous')
    expect(row!.detail).toMatchObject({ groupId: admin.groupId, targetSessionId: target.id, result: 'added', attempted: true })
  })

  it('AC-T20-04 falhas também são auditadas: não admin, grupo inexistente, alvo inexistente, alvo = própria, não conectada e limite', async () => {
    const t1 = await targetSession(ctx)
    const t2 = await targetSession(ctx)

    const notAdmin = await adminWithGroup(ctx, { isAdmin: false })
    await addParticipant(ctx, notAdmin.id, notAdmin.groupId, { targetSessionId: t1.id })
    expect(addAudits(ctx, notAdmin.id).map((r) => r.detail)).toEqual([expect.objectContaining({ groupId: notAdmin.groupId, targetSessionId: t1.id, result: 'not_admin', attempted: false })])

    const admin = await adminWithGroup(ctx)
    await addParticipant(ctx, admin.id, '120363999999999998@g.us', { targetSessionId: t1.id })
    await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: '00000000-0000-4000-8000-000000000000' })
    await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: admin.id })
    await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: t1.id })
    await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: t2.id }) // 429
    const results = addAudits(ctx, admin.id).map((r) => r.detail.result)
    expect(results).toEqual(expect.arrayContaining(['group_not_found', 'target_not_found', 'invalid_target', 'added', 'rate_limited']))
    for (const r of addAudits(ctx, admin.id)) {
      expect(r.action).toBe('group.participant.add')
      expect(r.target_id).toBe(admin.id)
      expect(r.actor).toBeTruthy()
    }
    const attempted = addAudits(ctx, admin.id).filter((r) => r.detail.attempted === true)
    expect(attempted.map((r) => r.detail.result), 'só a tentativa que chegou ao transporte tem attempted=true').toEqual(['added'])
  })

  it('AC-T20-04 400 de schema (body inválido) não é auditado; 401 também não', async () => {
    const admin = await adminWithGroup(ctx)
    await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: ['x'] })
    await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: 'x' }, null)
    expect(addAudits(ctx, admin.id)).toEqual([])
  })
})
