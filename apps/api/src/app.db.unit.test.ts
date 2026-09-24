// Integração com Postgres/Redis locais (SPEC INFRA): auditoria gravada de verdade em audit_logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { Redis } from 'ioredis'
import { createApp } from './app'
import { captureLogger } from './test-utils'

const TOKEN = 'db-token'
let tmp: TempDatabase
let db: Database
let redis: Redis

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_unit' })
  db = createDb(tmp.url, { max: 2 })
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
})

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await tmp?.drop()
})

describe('createApp com infra real', () => {
  it('/health reporta db e redis ok', async () => {
    const app = createApp({ db, redis, logger: captureLogger().logger, apiToken: TOKEN })
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok', db: 'ok', redis: 'ok' })
  })

  it('/health reporta down para banco inacessível em ~1s', async () => {
    const dead = createDb('postgres://wsm:wsm@127.0.0.1:1/none', { max: 1 })
    const app = createApp({ db: dead, redis, logger: captureLogger().logger, apiToken: TOKEN })
    const t0 = Date.now()
    expect(await (await app.request('/health')).json()).toMatchObject({ db: 'down', redis: 'ok' })
    expect(Date.now() - t0).toBeLessThan(2500)
    await dead.$client.end()
  })

  it('grava audit_logs para mutação bem-sucedida', async () => {
    const app = createApp({ db, redis, logger: captureLogger().logger, apiToken: TOKEN })
    app.post('/api/widgets/:id', (c) => c.json({ ok: true }, 201))
    const res = await app.request('/api/widgets/w-7', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(201)
    const rows = await db.select().from(auditLogs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'api_token', action: 'POST /api/widgets/w-7', targetType: 'widgets', targetId: 'w-7' })
    expect(rows[0]?.createdAt).toBeInstanceOf(Date)
  })
})
