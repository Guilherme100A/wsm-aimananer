// Rotas de grupos com Postgres local (banco descartável) e FakeTransport.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { FakeTransport, SessionStore } from '@wsm/core'
import { auditLogs, createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'
import { dbOnlySessions } from './sessions'

const TOKEN = 't0k'
let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_groups' })
  db = createDb(tmp.url, { max: 4 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

let transports: Map<string, FakeTransport>

beforeEach(async () => {
  await db.delete(auditLogs)
  await db.delete(sessions)
  transports = new Map()
})

function setup() {
  const sessionsControl = { ...dbOnlySessions(new SessionStore(db)), getTransport: (id: string) => transports.get(id) }
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, sessions: sessionsControl })
  const req = (method: string, path: string, token: string | null = TOKEN) =>
    app.request(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { req }
}

async function session(status: 'NEW' | 'WARMING' | 'STABLE' | 'PAUSED', withTransport = true) {
  const [row] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', status }).returning()
  if (withTransport) {
    const t = new FakeTransport()
    t.setGroups([
      { id: 'z@g.us', name: 'Zeta', participants: 2, announce: false },
      { id: 'a@g.us', name: 'Alpha', participants: 5, announce: true },
    ])
    t.open()
    transports.set(row!.id, t)
  }
  return row!.id
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

describe('/api/sessions/:id/groups', () => {
  it('lista {id,name,participants,status} e não audita leitura', async () => {
    const { req } = setup()
    const id = await session('STABLE')
    const res = await req('GET', `/api/sessions/${id}/groups`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([
      { id: 'a@g.us', name: 'Alpha', participants: 5, status: 'announce', announce: true, communityId: null, isAdmin: false },
      { id: 'z@g.us', name: 'Zeta', participants: 2, status: 'open', announce: false, communityId: null, isAdmin: false },
    ])
    expect(await db.select().from(auditLogs)).toHaveLength(0)
  })

  it('404 / 409 / 401', async () => {
    const { req } = setup()
    expect(await code(await req('GET', '/api/sessions/abc/groups'))).toBe('SESSION_NOT_FOUND')
    expect((await req('GET', '/api/sessions/00000000-0000-4000-8000-000000000000/groups')).status).toBe(404)
    for (const id of [await session('NEW'), await session('PAUSED'), await session('WARMING', false)]) {
      const res = await req('GET', `/api/sessions/${id}/groups`)
      expect(res.status).toBe(409)
      expect(await code(res)).toBe('SESSION_NOT_CONNECTED')
    }
    const closed = await session('WARMING')
    await transports.get(closed)!.close()
    expect((await req('GET', `/api/sessions/${closed}/groups`)).status).toBe(409)
    expect((await req('GET', `/api/sessions/${closed}/groups`, null)).status).toBe(401)
  })

  it('refresh manual é auditado; não existe rota de entrada em grupo', async () => {
    const { req } = setup()
    const id = await session('WARMING')
    const res = await req('POST', `/api/sessions/${id}/groups/refresh`)
    expect(res.status).toBe(200)
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.targetId, id))
    expect(audit).toMatchObject({ action: 'group.refresh', targetType: 'session', actor: expect.any(String) })
    expect(audit!.detail).toMatchObject({ count: 2 })
    expect((await req('POST', `/api/sessions/${id}/groups/join`)).status).toBe(404)
    expect((await req('POST', `/api/sessions/${id}/groups/refresh`, null)).status).toBe(401)
  })
})
