// T20 — POST /api/sessions/:id/groups/:groupId/participants com Postgres local e FakeTransport.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { FakeTransport, GroupAddError, SessionStore } from '@wsm/core'
import { auditLogs, createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'
import { dbOnlySessions, type SessionsControl } from './sessions'

const TOKEN = 't0k'
let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_groupadd' })
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

async function world() {
  const [admin] = await db.insert(sessions).values({ name: 'admin', phone: '+5511999990001', status: 'STABLE' }).returning()
  const [target] = await db.insert(sessions).values({ name: 'alvo', phone: '+5511988887777', status: 'STABLE' }).returning()
  const t = new FakeTransport()
  t.open()
  t.setGroups([
    { id: 'adm@g.us', name: 'Adm', participants: 2, announce: false, isAdmin: true },
    { id: 'mem@g.us', name: 'Mem', participants: 5, announce: false, isAdmin: false },
  ])
  let now = Date.now()
  const control: SessionsControl = { ...dbOnlySessions(new SessionStore(db)), getTransport: (id) => (id === admin!.id ? t : undefined) }
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, sessions: control, groupAddNow: () => now })
  const add = (groupId: string, body: unknown, id = admin!.id, token: string | null = TOKEN) =>
    app.request(`/api/sessions/${id}/groups/${encodeURIComponent(groupId)}/participants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  return { admin: admin!.id, target: target!.id, t, add, app, advance: (ms: number) => (now += ms) }
}

const audits = (adminId: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.action, 'group.participant.add'), eq(auditLogs.targetId, adminId)))
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

describe('POST /api/sessions/:id/groups/:groupId/participants', () => {
  it('adiciona UM número, audita e aplica o freio de 1/min', async () => {
    const w = await world()
    const res = await w.add('adm@g.us', { targetSessionId: w.target })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: 'added', groupId: 'adm@g.us', targetSessionId: w.target, jid: '5511988887777@s.whatsapp.net', code: 200 })
    const [a] = await audits(w.admin)
    expect(a).toMatchObject({ targetType: 'session', actor: expect.any(String) })
    expect(a!.detail).toMatchObject({ groupId: 'adm@g.us', targetSessionId: w.target, result: 'added', attempted: true })

    const limited = await w.add('adm@g.us', { targetSessionId: w.target })
    expect(limited.status).toBe(429)
    expect(await code(limited)).toBe('RATE_LIMIT')
    expect((await audits(w.admin)).map((r) => (r.detail as { result: string }).result)).toEqual(['added', 'rate_limited'])

    w.advance(61_000)
    const again = await w.add('adm@g.us', { targetSessionId: w.target })
    expect(await again.json()).toMatchObject({ result: 'already_member' })
    expect(w.t.groupAdds).toHaveLength(2)
  })

  it('erros: não admin 403, grupo 404, alvo 404/400, conexão 409, body 400, sem token 401 — todos auditados (menos o schema)', async () => {
    const w = await world()
    const cases: Array<[Response | Promise<Response>, number, string]> = [
      [await w.add('mem@g.us', { targetSessionId: w.target }), 403, 'NOT_GROUP_ADMIN'],
      [await w.add('nope@g.us', { targetSessionId: w.target }), 404, 'GROUP_NOT_FOUND'],
      [await w.add('adm@g.us', { targetSessionId: '00000000-0000-4000-8000-000000000000' }), 404, 'SESSION_NOT_FOUND'],
      [await w.add('adm@g.us', { targetSessionId: w.admin }), 400, 'VALIDATION_ERROR'],
    ]
    for (const [res, status, c] of cases) {
      const r = await res
      expect(r.status, c).toBe(status)
      expect(await code(r)).toBe(c)
    }
    expect((await audits(w.admin)).map((r) => (r.detail as { result: string }).result)).toEqual(['not_admin', 'group_not_found', 'target_not_found', 'invalid_target'])

    // schema: array, campo extra, uuid inválido → 400 e sem auditoria nem transporte
    for (const bad of [{ targetSessionId: [w.target] }, [w.target], { targetSessionId: w.target, extra: 1 }, { targetSessionId: 'x' }]) {
      expect((await w.add('adm@g.us', bad)).status).toBe(400)
    }
    expect(await audits(w.admin)).toHaveLength(4)
    expect(w.t.groupAdds).toHaveLength(0)

    await db.update(sessions).set({ status: 'PAUSED' }).where(eq(sessions.id, w.admin))
    const paused = await w.add('adm@g.us', { targetSessionId: w.target })
    expect(paused.status).toBe(409)
    expect(await code(paused)).toBe('SESSION_NOT_CONNECTED')
    expect((await w.add('adm@g.us', { targetSessionId: w.target }, w.admin, null)).status).toBe(401)
    expect((await w.add('adm@g.us', { targetSessionId: w.target }, 'nao-uuid')).status).toBe(404)
  })

  it('pela ponte: usa sessions.addGroupParticipant e mapeia GroupAddError', async () => {
    const calls: string[][] = []
    const control: SessionsControl = {
      ...dbOnlySessions(new SessionStore(db)),
      addGroupParticipant: async (a, g, t) => {
        calls.push([a, g, t])
        if (g === 'mem@g.us') throw new GroupAddError('NOT_GROUP_ADMIN', 'not admin', { result: 'not_admin', attempted: false, jid: null })
        return { groupId: g, targetSessionId: t, jid: 'j', result: 'added', attempted: true, attemptId: 'x', clockAt: 0 }
      },
    }
    const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, sessions: control })
    const post = (g: string) =>
      app.request(`/api/sessions/11111111-1111-4111-8111-111111111111/groups/${g}/participants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ targetSessionId: '22222222-2222-4222-8222-222222222222' }),
      })
    expect((await post('adm@g.us')).status).toBe(200)
    expect((await post('mem@g.us')).status).toBe(403)
    expect(calls).toEqual([
      ['11111111-1111-4111-8111-111111111111', 'adm@g.us', '22222222-2222-4222-8222-222222222222'],
      ['11111111-1111-4111-8111-111111111111', 'mem@g.us', '22222222-2222-4222-8222-222222222222'],
    ])
  })

  it('GET /groups inclui isAdmin', async () => {
    const w = await world()
    const res = await w.app.request(`/api/sessions/${w.admin}/groups`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const body = (await res.json()) as { items: Array<{ id: string; isAdmin: boolean }> }
    expect(body.items.map((g) => [g.id, g.isAdmin])).toEqual([
      ['adm@g.us', true],
      ['mem@g.us', false],
    ])
  })
})
