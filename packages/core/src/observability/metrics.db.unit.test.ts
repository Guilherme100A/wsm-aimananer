// attachMetrics com Postgres local (banco descartável): estado inicial das sessões e profundidade exata da fila.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { attachMetrics, createMetrics, queueDepthFromDb } from './metrics'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_metrics' })
  db = createDb(tmp.url, { max: 3 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('attachMetrics com banco', () => {
  it('ready carrega session_state; queue_depth vem do banco a cada scrape', async () => {
    const [a] = await db.insert(sessions).values({ name: 'a', phone: '+5511900000101', status: 'STABLE' }).returning()
    const [b] = await db.insert(sessions).values({ name: 'b', phone: '+5511900000102', status: 'PAUSED' }).returning()
    const msg = (sessionId: string, status: 'queued' | 'retrying' | 'sent') => ({ sessionId, phone: '+5511988880000', content: { text: 'x' }, status })
    await db.insert(messages).values([msg(a!.id, 'queued'), msg(a!.id, 'retrying'), msg(a!.id, 'sent'), msg(b!.id, 'queued')])

    expect(await queueDepthFromDb(db)).toEqual({ [a!.id]: 2, [b!.id]: 1 })

    const m = createMetrics()
    const detach = attachMetrics({ metrics: m, db })
    await detach.ready
    let text = await m.render()
    expect(text).toContain(`wsm_session_state{session="${a!.id}",state="STABLE"} 1`)
    expect(text).toContain(`wsm_session_state{session="${b!.id}",state="PAUSED"} 1`)
    expect(text).toContain(`wsm_queue_depth{session="${a!.id}"} 2`)
    expect(text).toContain(`wsm_queue_depth{session="${b!.id}"} 1`)

    await db.delete(messages)
    text = await m.render()
    expect(text).toContain(`wsm_queue_depth{session="${a!.id}"} 0`)

    detach()
  })
})
