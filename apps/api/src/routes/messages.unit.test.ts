// /api/messages contra Postgres local (banco descartável) — implementação só com o banco.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { MessageStore } from '@wsm/core'
import { auditLogs, createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'messages-token'
let tmp: TempDatabase
let db: Database
let app: ReturnType<typeof createApp>
let store: MessageStore
let sessionId: string
const auth = { authorization: `Bearer ${TOKEN}` }

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_messages' })
  db = createDb(tmp.url, { max: 3 })
  app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN })
  store = new MessageStore(db)
  const [s] = await db.insert(sessions).values({ name: 's', phone: '+5511999990000', status: 'WARMING' }).returning()
  sessionId = s!.id
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const enqueue = () => store.create({ sessionId, phone: '+5511988880000', content: { text: 'oi' } })

describe('/api/messages', () => {
  it('exige token', async () => {
    expect((await app.request('/api/messages')).status).toBe(401)
  })

  it('GET por id, eventos e listagem filtrada', async () => {
    const m = await enqueue()
    const res = await app.request(`/api/messages/${m.id}`, { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: m.id, sessionId, status: 'queued', attempts: 0, lastError: null })
    const ev = (await (await app.request(`/api/messages/${m.id}/events`, { headers: auth })).json()) as { items: unknown[] }
    expect(ev.items).toEqual([expect.objectContaining({ from: null, to: 'queued' })])
    const list = (await (await app.request(`/api/messages?sessionId=${sessionId}&status=queued`, { headers: auth })).json()) as { items: { id: string }[] }
    expect(list.items.map((i) => i.id)).toContain(m.id)
    expect((await app.request('/api/messages?status=bogus', { headers: auth })).status).toBe(400)
  })

  it('cancel de queued → 200 cancelled com evento e auditoria', async () => {
    const m = await enqueue()
    const res = await app.request(`/api/messages/${m.id}/cancel`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: m.id, status: 'cancelled' })
    const events = await store.events(m.id)
    expect(events.map((e) => e.toStatus)).toEqual(['queued', 'cancelled'])
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'message.cancel'))
    expect(audits.some((a) => a.targetId === m.id)).toBe(true)
  })

  it('cancel de sent → 409 INVALID_TRANSITION', async () => {
    const m = await enqueue()
    await db.update(messages).set({ status: 'sent' }).where(eq(messages.id, m.id))
    const res = await app.request(`/api/messages/${m.id}/cancel`, { method: 'POST', headers: auth })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION')
  })

  it('inexistente ou id inválido → 404', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      const res = await app.request(`/api/messages/${id}/cancel`, { method: 'POST', headers: auth })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
      expect((await app.request(`/api/messages/${id}`, { headers: auth })).status).toBe(404)
    }
  })
})
