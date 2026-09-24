// attachQueueToSessions com Postgres/Redis locais, SessionManager real e FakeTransport.
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateCredentialsKey, MessageQueue, resetCredentialsCrypto } from '@wsm/core'
import { createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { SessionManager } from '../sessions/manager'
import { createFakeTransportFactory, type FakeTransportFactory } from '../sessions/transport-factory'
import { attachQueueToSessions } from './attach'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_queue' })
  db = createDb(tmp.url, { max: 6 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

let fakes: FakeTransportFactory
let manager: SessionManager
let queue: MessageQueue
let detach: () => void

beforeEach(() => {
  fakes = createFakeTransportFactory()
  manager = new SessionManager({ db, transportFactory: fakes.factory, sleep: async () => {}, logger: { debug() {}, info() {}, warn() {}, error() {} } })
  queue = new MessageQueue({ db, prefix: `wsm_test_${randomBytes(4).toString('hex')}`, backoffDelayMs: 50, holdDelayMs: 50 })
  detach = attachQueueToSessions(manager, queue)
})

afterEach(async () => {
  detach()
  await manager.stop()
  await queue.close()
})

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function connectedSession(): Promise<string> {
  const s = await manager.create({ name: 'q', phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` })
  await manager.startQr(s.id)
  fakes.last(s.id)!.open()
  await manager.whenIdle()
  return s.id
}

describe('attachQueueToSessions', () => {
  it('entrega pelo transporte da sessão e aplica receipts do transporte', async () => {
    const id = await connectedSession()
    const msg = await queue.enqueue({ sessionId: id, phone: '+5511988887777', content: { text: 'olá' } })
    const sent = await waitFor(() => queue.get(msg.id), (m) => m.status === 'sent')
    const t = fakes.last(id)!
    expect(t.sent[0]).toMatchObject({ to: '5511988887777@s.whatsapp.net', messageId: sent.transportMessageId })
    t.receipt(sent.transportMessageId!, 'delivered')
    await waitFor(() => queue.get(msg.id), (m) => m.status === 'delivered')
    t.receipt(sent.transportMessageId!, 'read')
    await waitFor(() => queue.get(msg.id), (m) => m.status === 'read')
  })

  it('pause da sessão pausa a fila (jobs queued); resume retoma em ordem', async () => {
    const id = await connectedSession()
    await manager.pause(id)
    await waitFor(() => queue.isPaused(id), (p) => p)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await queue.enqueue({ sessionId: id, phone: '+5511988887777', content: { text: `m${i}` } })).id)
    await new Promise((r) => setTimeout(r, 200))
    for (const mid of ids) expect((await queue.get(mid)).status).toBe('queued')
    expect(fakes.last(id)!.sent).toHaveLength(0)
    await manager.resume(id)
    await waitFor(() => queue.list({ sessionId: id, status: 'sent' }), (l) => l.length === 3)
    expect(fakes.last(id)!.sent.map((s) => (s.content as { text: string }).text)).toEqual(['m0', 'm1', 'm2'])
  })

  it('sessão sem conexão não recebe envio', async () => {
    const s = await manager.create({ name: 'n', phone: '+5511900000001' })
    const msg = await queue.enqueue({ sessionId: s.id, phone: '+5511988887777', content: { text: 'x' } })
    await new Promise((r) => setTimeout(r, 200))
    expect((await queue.get(msg.id)).status).toBe('queued')
  })
})
