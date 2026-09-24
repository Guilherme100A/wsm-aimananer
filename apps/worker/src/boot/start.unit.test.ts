// Boot completo do worker (T16) com Postgres local (banco descartável) e o Redis local, isolado por prefixo.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { contacts, createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import type { TransportFactory } from '../sessions'
import { loadWorkerConfig } from './config'
import { startWorker, type WorkerHandle } from './start'

let tmp: TempDatabase
let db: Database
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

function env(extra: Record<string, string> = {}) {
  return {
    DATABASE_URL: tmp.url,
    REDIS_URL,
    CREDENTIALS_KEY: randomBytes(32).toString('base64'),
    INTERNAL_TOKEN: 'itok',
    WORKER_HEALTH_PORT: '0',
    WORKER_INTERNAL_PORT: '0',
    WORKER_INTERNAL_HOST: '127.0.0.1',
    QUEUE_PREFIX: `wsmtest${randomBytes(4).toString('hex')}`,
    ANTIBAN_MODE: 'passthrough',
    LOG_LEVEL: 'silent',
    ...extra,
  }
}

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: false, prefix: 'wsm_worker_boot' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

/** Campos usados pelos testes nas respostas da ponte. */
interface RpcResult {
  id: string
  status: string
  qr: string
  transportMessageId: string
}

const rpc = async (w: WorkerHandle, target: string, method: string, ...args: unknown[]) => {
  const res = await fetch(`${w.internal.url}/internal/rpc`, {
    method: 'POST',
    headers: { authorization: 'Bearer itok', 'content-type': 'application/json' },
    body: JSON.stringify({ target, method, args }),
  })
  return (await res.json()) as { result: RpcResult; error?: unknown }
}
const fakePost = (w: WorkerHandle, path: string, body: unknown = {}) =>
  fetch(`${w.internal.url}/internal/fake/sessions/${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer itok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('loadWorkerConfig', () => {
  it('exige variáveis e valida WA_TRANSPORT', () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL, REDIS_URL, CREDENTIALS_KEY, INTERNAL_TOKEN/)
    const base = { DATABASE_URL: 'x', REDIS_URL: 'y', CREDENTIALS_KEY: 'k', INTERNAL_TOKEN: 't' }
    expect(loadWorkerConfig(base)).toMatchObject({ transport: 'baileys', antibanMode: 'real', healthPort: 9464, internalPort: 9465 })
    expect(() => loadWorkerConfig({ ...base, WA_TRANSPORT: 'x' })).toThrow(/WA_TRANSPORT/)
    expect(() => loadWorkerConfig({ ...base, ANTIBAN_MODE: 'off' })).toThrow()
  })
})

describe('startWorker', () => {
  it('fake: migra, sobe servidores, fluxo QR → open → envio → sent e opt-out; stop fecha tudo', async () => {
    const w = await startWorker({ env: env({ WA_TRANSPORT: 'fake' }), healthIntervalMs: 0 })
    try {
      expect((await fetch(`${w.observability.url}/health`)).status).toBe(200)
      const created = await rpc(w, 'sessions', 'create', { name: 's', phone: '+5511999990001' })
      const id = created.result.id as string
      await rpc(w, 'sessions', 'startQr', id)
      expect((await fakePost(w, `${id}/qr`, { qr: 'Q' })).status).toBe(200)
      expect((await rpc(w, 'sessions', 'getQr', id)).result.qr).toMatch(/^data:image\/png/)
      await fakePost(w, `${id}/open`)
      await until(() => rpc(w, 'sessions', 'get', id), (r) => r.result?.status === 'WARMING')

      await db.insert(contacts).values({ phone: '+5511988887777', consent: true })
      const msg = (await rpc(w, 'messages', 'enqueue', { sessionId: id, phone: '+5511988887777', content: { text: 'oi' } })).result
      const sent = await until(() => rpc(w, 'messages', 'get', msg.id), (r) => r.result?.status === 'sent')
      const hist = (await (await fetch(`${w.internal.url}/internal/fake/sessions/${id}/sent-history`, { headers: { authorization: 'Bearer itok' } })).json()) as {
        items: { messageId: string; bootId: string }[]
      }
      expect(hist.items.map((h) => h.messageId)).toEqual([sent.result.transportMessageId])
      expect(hist.items[0]!.bootId).toBe(w.bootId)

      // receipt delivered pelo controle do fake
      await fakePost(w, `${id}/receipt`, { messageId: sent.result.transportMessageId, status: 'delivered' })
      await until(() => rpc(w, 'messages', 'get', msg.id), (r) => r.result?.status === 'delivered')

      // opt-out (T07) ligado no boot
      await fakePost(w, `${id}/receive`, { from: '5511988887777@s.whatsapp.net', text: 'SAIR' })
      await until(
        async () => (await db.select().from(contacts).where(eq(contacts.phone, '+5511988887777')))[0]!.optOut,
        (v) => v === true,
      )

      // inbound persistido pelo attachAi (T13)
      const inbound = await db.select().from(messages).where(eq(messages.direction, 'inbound'))
      expect(inbound).toHaveLength(1)
      expect(inbound[0]).toMatchObject({ sessionId: id, phone: '+5511988887777' })

      // 403 no envio → PAUSED (HealthMonitor) via deliver
      await fakePost(w, `${id}/fail-next-send`, { statusCode: 403 })
      await db.update(contacts).set({ optOut: false })
      await rpc(w, 'messages', 'enqueue', { sessionId: id, phone: '+5511988887777', content: { text: 'x' } })
      await until(() => rpc(w, 'sessions', 'get', id), (r) => r.result?.status === 'PAUSED')
    } finally {
      await w.stop()
    }
    await expect(fetch(`${w.internal.url}/internal/fake/boot`)).rejects.toThrow()
  })

  it('restart: reconcilia processing (sem marca → retrying e reenviada uma vez) e reconecta a sessão', async () => {
    const e = env({ WA_TRANSPORT: 'fake' })
    const w1 = await startWorker({ env: e, healthIntervalMs: 0 })
    let id: string
    try {
      id = (await rpc(w1, 'sessions', 'create', { name: 'r', phone: '+5511999990002' })).result.id
      await rpc(w1, 'sessions', 'startQr', id)
      await fakePost(w1, `${id}/open`)
      await until(() => rpc(w1, 'sessions', 'get', id), (r) => r.result?.status === 'WARMING')
    } finally {
      await w1.stop()
    }
    // simula um worker que caiu com uma mensagem em processing (nunca chegou ao transporte: sem marca)
    await db.insert(contacts).values({ phone: '+5511977776666', consent: true }).onConflictDoNothing()
    const [stuck] = await db
      .insert(messages)
      .values({ sessionId: id!, phone: '+5511977776666', content: { text: 'preso' }, status: 'processing', attempts: 1 })
      .returning()

    const w2 = await startWorker({ env: e, healthIntervalMs: 0 })
    try {
      expect(w2.reconciled.retrying).toEqual([stuck!.id])
      expect(w2.bootId).not.toBe(w1.bootId)
      const state = (await (await fetch(`${w2.internal.url}/internal/fake/sessions/${id!}/state`, { headers: { authorization: 'Bearer itok' } })).json()) as {
        exists: boolean
        connectCalls: number
      }
      expect(state).toMatchObject({ exists: true, connectCalls: 1 })
      await fakePost(w2, `${id!}/open`)
      await until(() => rpc(w2, 'messages', 'get', stuck!.id), (r) => r.result?.status === 'sent', 15_000)
      const hist = (await (await fetch(`${w2.internal.url}/internal/fake/sessions/${id!}/sent-history`, { headers: { authorization: 'Bearer itok' } })).json()) as {
        items: { content: { text: string } }[]
      }
      expect(hist.items.filter((h) => h.content.text === 'preso')).toHaveLength(1)
    } finally {
      await w2.stop()
    }
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id!))
    expect(row!.status).toBe('WARMING')
  })

  it('baileys com banco sem sessões: nenhuma conexão e /internal/fake/* inexistente', async () => {
    const factory = vi.fn<TransportFactory>()
    await db.delete(sessions)
    const w = await startWorker({ env: env({ WA_TRANSPORT: 'baileys' }), transportFactory: factory, healthIntervalMs: 0 })
    try {
      expect(w.fake).toBeUndefined()
      expect(factory).not.toHaveBeenCalled()
      const res = await fetch(`${w.internal.url}/internal/fake/boot`, { headers: { authorization: 'Bearer itok' } })
      expect(res.status).toBe(404)
      expect((await fakePost(w, 'x/open')).status).toBe(404)
    } finally {
      await w.stop()
    }
  })
})
