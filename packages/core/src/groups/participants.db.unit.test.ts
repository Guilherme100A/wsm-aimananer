// T20 — GroupParticipantService com Postgres local (banco descartável) e FakeTransport.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditLogs, createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { FakeTransport } from '../transport'
import { GROUP_ADD_AUDIT_ACTION, GroupAddError, GroupParticipantService, phoneToUserJid } from './participants'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_groupadd' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(auditLogs)
  await db.delete(sessions)
})

async function session(status: 'STABLE' | 'WARMING' | 'PAUSED' | 'NEW', phone: string) {
  const [row] = await db.insert(sessions).values({ name: `s${phone}`, phone, status }).returning()
  return row!.id
}

function setup(adminStatus: 'STABLE' | 'WARMING' | 'PAUSED' | 'NEW' = 'STABLE') {
  return (async () => {
    const admin = await session(adminStatus, '+5511999990001')
    const target = await session('STABLE', '+5511988887777')
    const t = new FakeTransport()
    t.open()
    t.setGroups([
      { id: 'adm@g.us', name: 'Adm', participants: 2, announce: false, isAdmin: true },
      { id: 'mem@g.us', name: 'Mem', participants: 5, announce: false, isAdmin: false },
    ])
    let now = Date.now()
    const svc = new GroupParticipantService({ db, getTransport: (id) => (id === admin ? t : undefined), now: () => now })
    return { admin, target, t, svc, advance: (ms: number) => (now += ms) }
  })()
}

/** Simula a auditoria gravada pela rota da API depois de cada tentativa. */
const audit = (adminId: string, extra: Record<string, unknown> = {}) =>
  db.insert(auditLogs).values({ actor: 'admin', action: GROUP_ADD_AUDIT_ACTION, targetType: 'session', targetId: adminId, detail: { attempted: true, ...extra } })

const err = (p: Promise<unknown>) => p.then(() => undefined, (e: GroupAddError) => e)

describe('GroupParticipantService', () => {
  it('adiciona o telefone da sessão alvo; um alvo por chamada', async () => {
    const { admin, target, t, svc } = await setup()
    const out = await svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })
    expect(out).toMatchObject({ groupId: 'adm@g.us', targetSessionId: target, jid: phoneToUserJid('+5511988887777'), result: 'added', attempted: true, code: 200 })
    expect(out.attemptId).toEqual(expect.any(String))
    expect(out.clockAt).toEqual(expect.any(Number))
    expect(t.groupAdds).toEqual([{ groupId: 'adm@g.us', jid: '5511988887777@s.whatsapp.net' }])
  })

  it('checagens antes do transporte (não contam no freio)', async () => {
    const { admin, target, t, svc } = await setup()
    const cases: Array<[() => Promise<unknown>, string, string, number]> = [
      [() => svc.add({ adminSessionId: 'x', groupId: 'adm@g.us', targetSessionId: target }), 'SESSION_NOT_FOUND', 'session_not_found', 404],
      [() => svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: admin }), 'VALIDATION_ERROR', 'invalid_target', 400],
      [() => svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: '00000000-0000-4000-8000-000000000000' }), 'SESSION_NOT_FOUND', 'target_not_found', 404],
      [() => svc.add({ adminSessionId: admin, groupId: 'nope@g.us', targetSessionId: target }), 'GROUP_NOT_FOUND', 'group_not_found', 404],
      [() => svc.add({ adminSessionId: admin, groupId: 'mem@g.us', targetSessionId: target }), 'NOT_GROUP_ADMIN', 'not_admin', 403],
    ]
    for (const [p, code, result, status] of cases) {
      const e = (await err(p()))!
      expect(e).toBeInstanceOf(GroupAddError)
      expect([e.code, e.details.result, e.status, e.details.attempted]).toEqual([code, result, status, false])
    }
    expect(t.groupAdds).toHaveLength(0)
  })

  it('sessão admin fora de WARMING/STABLE ou sem transporte → SESSION_NOT_CONNECTED', async () => {
    const { admin, target, svc } = await setup('PAUSED')
    expect(await err(svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target }))).toMatchObject({ code: 'SESSION_NOT_CONNECTED', status: 409 })
    const other = await session('STABLE', '+5511977776666')
    expect(await err(svc.add({ adminSessionId: other, groupId: 'adm@g.us', targetSessionId: target }))).toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
  })

  it('freio: tentativa auditada nos últimos 60 s → RATE_LIMIT; relógio avançado ou created_at recuado liberam', async () => {
    const { admin, target, svc, advance } = await setup()
    const first = await svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })
    await audit(admin, { attemptId: first.attemptId, clockAt: first.clockAt })
    const e = (await err(svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })))!
    expect(e).toMatchObject({ code: 'RATE_LIMIT', status: 429, details: { result: 'rate_limited', attempted: false } })
    expect(e.details.retryAfterMs).toBeGreaterThan(0)
    expect(e.details.retryAfterMs).toBeLessThanOrEqual(60_000)

    advance(61_000)
    const second = await svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })
    expect(second).toMatchObject({ result: 'already_member' })
    await audit(admin, { attemptId: second.attemptId, clockAt: second.clockAt })
    expect(await err(svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target }))).toMatchObject({ code: 'RATE_LIMIT' })
    await db.$client.query(`update audit_logs set created_at = created_at - interval '61 seconds'`)
    expect(await svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })).toMatchObject({ result: 'already_member' })
  })

  it('reserva: simultâneas não passam; e segue reservada até a auditoria da tentativa aparecer', async () => {
    const { admin, target, t, svc } = await setup()
    const orig = t.addGroupParticipant.bind(t)
    t.addGroupParticipant = async (g, j) => {
      await new Promise<void>((r) => setTimeout(r, 50))
      return orig(g, j)
    }
    const [a, b] = await Promise.all([
      svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target }),
      err(svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })),
    ])
    expect(a).toMatchObject({ result: 'added' })
    expect(b).toMatchObject({ code: 'RATE_LIMIT' })
    // tentativa concluída mas ainda sem auditoria: continua reservada
    expect(await err(svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target }))).toMatchObject({ code: 'RATE_LIMIT' })
    expect(t.groupAdds).toHaveLength(1)
  })

  it('falha inesperada do transporte → result failed (tentativa conta)', async () => {
    const { admin, target, t, svc } = await setup()
    t.failNextGroupAdd(new Error('boom'))
    expect(await svc.add({ adminSessionId: admin, groupId: 'adm@g.us', targetSessionId: target })).toMatchObject({ result: 'failed', attempted: true })
  })
})
