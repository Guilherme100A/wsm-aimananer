import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateCredentialsKey, resetCredentialsCrypto, ProxyService, type ProxyUnavailableEvent } from '@wsm/core'
import { createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { startProxyMonitor } from './index'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_proxy' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

describe('startProxyMonitor', () => {
  it('roda a checagem ao iniciar e repassa proxy_unavailable', async () => {
    const p = await new ProxyService(db).create({ url: 'http://h:1' })
    const events: ProxyUnavailableEvent[] = []
    const got = new Promise<void>((resolve) => {
      const monitor = startProxyMonitor({
        db,
        intervalMs: 60_000,
        probe: async () => Promise.reject(new Error('refused')),
        onUnavailable: (e) => {
          events.push(e)
          monitor.stop()
          resolve()
        },
      })
    })
    await got
    expect(events[0]).toMatchObject({ proxyId: p.id, error: 'refused', errorCount: 1 })
  })
})
