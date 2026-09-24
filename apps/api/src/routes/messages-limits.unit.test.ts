// /api/sessions/:id/limits (T09) com Postgres local (banco descartável).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 't0k'
let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_limits' })
  db = createDb(tmp.url, { max: 4 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

function setup() {
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN })
  return (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
}

describe('/api/sessions/:id/limits', () => {
  it('GET defaults; PUT manual auditado; efetivo limitado pelo warm-up', async () => {
    const req = setup()
    const [s] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', status: 'WARMING', warmupStartedAt: new Date() }).returning()
    const id = s!.id
    const get = await req('GET', `/api/sessions/${id}/limits`)
    expect(get.status).toBe(200)
    expect(await get.json()).toMatchObject({
      configured: { perMinute: 5, perHour: 100, perDay: 800 },
      reductionFactor: 1,
      effective: { perDay: 20, warmupDailyLimit: 20 },
      warmup: { day: 0, dailyLimit: 20 },
    })

    const put = await req('PUT', `/api/sessions/${id}/limits`, { perDay: 5000 })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ configured: { perDay: 5000 }, effective: { perDay: 20 } })
    const audits = await db.select().from(auditLogs)
    expect(audits.at(-1)).toMatchObject({ action: 'session.limits_update', targetType: 'session', targetId: id })
  })

  it('validação e 404', async () => {
    const req = setup()
    const [s] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001' }).returning()
    expect((await req('PUT', `/api/sessions/${s!.id}/limits`, { perDay: 0 })).status).toBe(400)
    expect((await req('PUT', `/api/sessions/${s!.id}/limits`, {})).status).toBe(400)
    expect((await req('PUT', `/api/sessions/${s!.id}/limits`, { perDay: 1.5 })).status).toBe(400)
    expect((await req('GET', '/api/sessions/abc/limits')).status).toBe(404)
    const res = await req('GET', '/api/sessions/00000000-0000-4000-8000-000000000000/limits')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SESSION_NOT_FOUND')
  })
})
